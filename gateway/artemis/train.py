"""Pretrain the Artemis model (Prime Core + experts) from random initialization.

Single process:   python -m artemis.train --size proto --data runs/data --out runs/proto
8 GPUs (1 VM):    torchrun --nproc_per_node 8 -m artemis.train --size 1b --data ... --out ...
Resumes automatically from the latest checkpoint in --out (same model config required).

Loss = next-token loss + balance_coef * load-balancing loss + router_z_coef * router z-loss
       + route_coef * routing-supervision loss (only on domain-labeled tokens; --route-coef 0 turns it off).
metrics.jsonl records each part, per-layer expert load, router entropy, and router/expert gradient norms.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.distributed as dist
import yaml

from . import checkpoint
from .data import TokenStream
from .evaluate import validation_loss
from .model import ArtemisLM, ModelConfig, parameter_groups

CONFIGS = Path(__file__).resolve().parent.parent / "configs" / "models.yaml"


def model_config(size: str) -> ModelConfig:
    return ModelConfig(**yaml.safe_load(CONFIGS.read_text())[size])


def lr_at(step: int, max_steps: int, peak: float, warmup: int) -> float:
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = (step - warmup) / max(1, max_steps - warmup)
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, progress))))


def optimizer_audit(model: ArtemisLM, opt) -> dict:
    """Proves the optimizer holds exactly the trainable parameters: every router, expert and Prime Core weight."""
    in_opt = {id(p) for g in opt.param_groups for p in g["params"]}
    params = dict(model.named_parameters())
    missing = [n for n, p in params.items() if p.requires_grad and id(p) not in in_opt]
    extra = len(in_opt - {id(p) for p in params.values()})
    if missing or extra:
        raise RuntimeError(f"optimizer does not match the model: missing {missing}, {extra} unknown tensors")
    groups = parameter_groups(model)
    return {"trainable_tensors": len(in_opt), "trainable_params": sum(p.numel() for p in params.values() if p.requires_grad),
            "groups": {g: {"tensors": len(n), "params": sum(params[k].numel() for k in n)} for g, n in groups.items()}}


def grad_norms(model: ArtemisLM) -> dict:
    params = dict(model.named_parameters())
    out = {}
    for g, names in parameter_groups(model).items():
        if g == "prime_core" or not names:
            continue
        sq = sum(float(params[n].grad.float().pow(2).sum()) for n in names if params[n].grad is not None)
        out[g] = round(math.sqrt(sq), 6)
    return out


def main(argv=None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="smoke")
    ap.add_argument("--data", required=True, help="directory with train.bin, val.bin, manifest.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=200, help="length of the run (sets the learning-rate schedule)")
    ap.add_argument("--stop-at", type=int, default=0, help="stop early at this step (resume later with the same --steps)")
    ap.add_argument("--batch", type=int, default=16, help="sequences per device per micro-step")
    ap.add_argument("--accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--warmup", type=int, default=20)
    ap.add_argument("--route-coef", type=float, default=0.1, help="routing supervision weight on domain-labeled tokens")
    ap.add_argument("--eval-every", type=int, default=50)
    ap.add_argument("--eval-batches", type=int, default=10)
    ap.add_argument("--ckpt-every", type=int, default=100)
    ap.add_argument("--amp-dtype", choices=("auto", "bf16", "fp16", "fp32"), default="auto",
                    help="autocast precision. auto picks bf16 on Ampere and newer, fp16 on Turing/Pascal "
                         "(which have no bf16). Force fp16 on a bf16-capable card to reproduce a T4 run.")
    ap.add_argument("--seed", type=int, default=1337)
    # DDP replicates the whole model on every GPU, so the largest model it can
    # train is the one that fits on ONE card -- with its gradients and its Adam
    # moments, which together cost about 16 bytes per parameter in mixed
    # precision. The 14B target (13.7B total) needs ~219 GB by that arithmetic
    # and cannot be trained with DDP on any single GPU that exists. FSDP shards
    # parameters, gradients and optimizer state across the world, so the per
    # GPU cost falls by roughly the world size.
    ap.add_argument("--shard", choices=("ddp", "fsdp"), default="ddp",
                    help="multi-process strategy: ddp replicates, fsdp shards "
                         "(required above ~1.5B parameters)")
    args = ap.parse_args(argv)

    distributed = int(os.environ.get("WORLD_SIZE", "1")) > 1
    if distributed:
        # Backend and device were hardcoded to nccl/cuda, so the entire
        # multi-process path could only be exercised on a multi-GPU box --
        # which is precisely the configuration that was never available to
        # test it. gloo on CPU runs the same code paths (sharding, gradient
        # sync, state-dict gathering) and is how the FSDP tests run here.
        dist.init_process_group("nccl" if torch.cuda.is_available() else "gloo")
        rank = dist.get_rank()
        if torch.cuda.is_available():
            device = torch.device("cuda", int(os.environ["LOCAL_RANK"]))
            torch.cuda.set_device(device)
        else:
            device = torch.device("cpu")
    else:
        rank = 0
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    fsdp = distributed and args.shard == "fsdp"
    ddp = distributed and not fsdp
    main_proc = rank == 0

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((Path(args.data) / "manifest.json").read_text())
    cfg = model_config(args.size)
    # The model is built from the SAME seed on every rank. DDP hides this by
    # broadcasting rank 0's parameters when it wraps the model, so `seed + rank`
    # was harmless there; FSDP does no such broadcast, and each rank would keep
    # its shard of its OWN random init -- the assembled model becoming a splice
    # of world_size different initialisations. Still random, so it would train
    # and never announce itself, which is what makes it worth being explicit
    # about. Per-rank variation belongs in the data, and lives there already:
    # TokenStream reseeds from [seed, rank, step] on every step.
    torch.manual_seed(args.seed)
    model = ArtemisLM(cfg).to(device)
    model.route_coef = args.route_coef
    if fsdp:
        # Shard each block, then the root. Per-block sharding is what lets FSDP
        # gather one block's parameters at a time instead of the whole model,
        # which is the difference between peak memory of one layer and peak
        # memory of all of them.
        from torch.distributed.fsdp import fully_shard
        for blk in model.blocks:
            fully_shard(blk)
        fully_shard(model)
    # The optimizer is built AFTER sharding on purpose. Adam keeps two moments
    # per parameter -- 8 bytes each in fp32, more than the parameters
    # themselves -- so an optimizer constructed over unsharded parameters keeps
    # the full optimizer state on every rank and throws away most of the saving.
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1, fused=device.type == "cuda")

    # Autocast was hardcoded to bfloat16 on CUDA, which silently restricted
    # this trainer to Ampere and newer. Turing and Pascal (T4, V100, P100) have
    # no bf16 at all, and those are the only cards on the two paths that cost
    # nothing or fit a small quota: every free Kaggle GPU, and NC4as_T4_v3 —
    # the one modern Azure GPU that fits under the 10-vCPU regional cap.
    # Pick the dtype the device actually has. fp16 carries ~3 fewer exponent
    # bits than bf16 and will overflow gradients to inf without loss scaling,
    # so it gets a GradScaler; bf16 and CPU do not need one.
    # is_bf16_supported() is the wrong predicate here: it returns True on a T4,
    # because PyTorch counts emulated bf16 as supported. Emulated bf16 is slower
    # than fp16 and buys nothing, so gate on the compute capability instead --
    # SM 8.0 (Ampere) is where the bf16 tensor cores actually appear.
    if args.amp_dtype == "auto":
        amp_dtype = (torch.bfloat16 if device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8
                     else torch.float16 if device.type == "cuda" else torch.float32)
    else:
        amp_dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[args.amp_dtype]
    use_amp = device.type == "cuda" and amp_dtype is not torch.float32
    # The scaler follows the dtype, not the device. Forcing --amp-dtype fp16 on
    # CPU leaves autocast off (CPU fp16 autocast is not worth relying on) but
    # still runs the scale/unscale/step sequence, so the ordering this file
    # depends on is testable without a Turing card in the room.
    scaler = torch.amp.GradScaler(device.type, enabled=amp_dtype is torch.float16)
    if main_proc and use_amp:
        print(f"autocast {str(amp_dtype).removeprefix('torch.')}"
              f"{' with loss scaling' if scaler.is_enabled() else ''} on {torch.cuda.get_device_name(device)}")

    step = 0
    latest = out / "latest.pt"
    if latest.exists():
        ck = checkpoint.read(latest, map_location=device)
        if ck["config"] != cfg.to_dict():
            raise SystemExit(f"{latest} was trained with a different model config; use a new --out or the same --size")
        if fsdp:
            # A checkpoint holds ONE full model. Each rank holds a shard. These
            # helpers scatter the full tensors back across ranks; a plain
            # load_state_dict here would either fail on DTensor or load the
            # whole model onto every rank and defeat the sharding.
            from torch.distributed.checkpoint.state_dict import (
                set_model_state_dict, set_optimizer_state_dict, StateDictOptions)
            o = StateDictOptions(full_state_dict=True, broadcast_from_rank0=True)
            set_model_state_dict(model, ck["model"], options=o)
            if ck.get("optim"):
                set_optimizer_state_dict(model, opt, ck["optim"], options=o)
        else:
            checkpoint.load_state(model, ck["model"], str(latest))
            if ck.get("optim"):
                opt.load_state_dict(ck["optim"])
        step = ck["step"]
        if ck.get("rng"):
            torch.set_rng_state(ck["rng"]["torch"].cpu())
            np.random.set_state(ck["rng"]["numpy"])
            random.setstate(ck["rng"]["python"])
        # The scale factor is part of the training state: restoring it keeps a
        # resumed fp16 run exact, instead of spending the first steps after
        # every resume re-discovering a scale it had already found. Absent when
        # the checkpoint came from a bf16 run, which needs no scaler.
        if ck.get("scaler") and scaler.is_enabled():
            scaler.load_state_dict(ck["scaler"])
        if main_proc:
            print(f"resumed from step {step}" + (" (migrated checkpoint)" if ck.get("migration") else ""))
    audit = optimizer_audit(model, opt)

    raw = model
    if ddp:
        # an expert that no token on this GPU picked has no gradient this step; DDP must allow for that
        model = torch.nn.parallel.DistributedDataParallel(model, device_ids=[device.index], find_unused_parameters=bool(cfg.moe_layers))
    # FSDP needs no wrapper: fully_shard modifies the module in place, so
    # `model` and `raw` are the same object and every existing use of `raw`
    # (last_stats, grad_norms, checkpointing) keeps working unchanged.

    train = TokenStream(Path(args.data) / "train.bin", manifest["dtype"], cfg.max_seq_len, seed=args.seed + rank + step)
    val = TokenStream(Path(args.data) / "val.bin", manifest["dtype"], cfg.max_seq_len, seed=0)
    log = open(out / "metrics.jsonl", "a") if main_proc else None
    if main_proc:
        (out / "run.json").write_text(json.dumps({"config": cfg.to_dict(), "params": cfg.param_count(),
                                                  "active_params": cfg.active_param_count(), "optimizer": audit,
                                                  "args": vars(args), "data_manifest": manifest,
                                                  "precision": {"autocast": str(amp_dtype).removeprefix("torch.") if use_amp else "fp32",
                                                                "loss_scaling": scaler.is_enabled(),
                                                                "device": torch.cuda.get_device_name(device) if use_amp else "cpu"}},
                                                 indent=2))
    tokens_per_step = args.batch * args.accum * cfg.max_seq_len * (dist.get_world_size() if distributed else 1)

    def full_state():
        """The whole model as ordinary tensors, on rank 0 -- or None under DDP.

        COLLECTIVE under FSDP: every rank must call it, because gathering a
        sharded parameter needs every shard. Calling it inside `if main_proc`
        hangs the other ranks at the next barrier, which is why the save below
        gathers first and writes second.
        """
        if not fsdp:
            return None
        from torch.distributed.checkpoint.state_dict import get_model_state_dict, StateDictOptions
        return get_model_state_dict(model, options=StateDictOptions(
            full_state_dict=True, cpu_offload=True))

    def full_optim():
        if not fsdp:
            return None
        from torch.distributed.checkpoint.state_dict import get_optimizer_state_dict, StateDictOptions
        return get_optimizer_state_dict(model, opt, options=StateDictOptions(
            full_state_dict=True, cpu_offload=True))
    t0 = time.time()
    end = min(args.stop_at, args.steps) if args.stop_at else args.steps
    while step < end:
        for g in opt.param_groups:
            g["lr"] = lr_at(step, args.steps, args.lr, args.warmup)
        total, parts = 0.0, {}
        train.rng = np.random.default_rng([args.seed, rank, step])  # batches depend only on the step, so resume is exact
        for micro in range(args.accum):
            x, y, d = train.batch(args.batch, with_domains=True)
            sync = not distributed or micro == args.accum - 1
            # Skipping the all-reduce on every micro-step but the last is what
            # makes accumulation cheap. DDP spells it no_sync(); FSDP2 spells
            # it set_requires_gradient_sync(). Calling no_sync() on an FSDP2
            # module raises, and simply omitting it would reduce gradients
            # accum times per step instead of once.
            if fsdp:
                model.set_requires_gradient_sync(sync)
                ctx = torch.enable_grad()
            else:
                ctx = model.no_sync() if ddp and not sync else torch.enable_grad()
            # backward stays inside ctx so DDP's no_sync still covers it, but
            # outside autocast: gradients are produced in fp32 regardless, and
            # scaling them is the scaler's job, not autocast's.
            with ctx:
                with torch.autocast(device.type, dtype=amp_dtype, enabled=use_amp):
                    _, loss = model(x.to(device), y.to(device), d.to(device) if cfg.moe_layers else None)
                scaler.scale(loss / args.accum).backward()
            total += loss.item() / args.accum
            for k in ("lm_loss", "balance_loss", "z_loss", "route_loss"):
                if k in raw.last_stats:
                    parts[k] = parts.get(k, 0.0) + float(raw.last_stats[k]) / args.accum
        if not math.isfinite(total):
            raise RuntimeError(f"non-finite loss at step {step}; stopping before the run is wasted")
        step += 1
        record_eval = step % args.eval_every == 0 or step == end
        # Unscale before anything reads a gradient. Under fp16 the gradients
        # are still multiplied by the scale factor (order 1e4) at this point,
        # so clipping to 1.0 would clip essentially everything to nothing and
        # both the reported grad_norm and the per-expert router norms would be
        # off by that factor — the router diagnostics the ablation relies on
        # would be meaningless.
        if scaler.is_enabled():
            scaler.unscale_(opt)
        # EVERY rank computes these, not just rank 0: under FSDP both read
        # sharded tensors and so are collective. Only rank 0 records them.
        norms = grad_norms(raw) if cfg.moe_layers and (record_eval or step == 1) else None
        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).item()
        # scaler.step skips the update when this step's gradients overflowed
        # and lowers the scale; with the scaler disabled it is just opt.step().
        scaler.step(opt)
        scaler.update()
        opt.zero_grad(set_to_none=True)
        # Collective, so outside the main_proc guard for the same reason.
        val_loss = (validation_loss(raw, val, args.batch, args.eval_batches, device)
                    if record_eval else None)
        if main_proc:
            rec = {"step": step, "loss": round(total, 4), **{k: round(v, 4) for k, v in parts.items()},
                   "lr": opt.param_groups[0]["lr"], "grad_norm": round(grad_norm, 3),
                   "tokens": step * tokens_per_step, "elapsed_s": round(time.time() - t0, 1)}
            if cfg.moe_layers and "load" in raw.last_stats:
                rec["expert_load"] = [[round(v, 3) for v in layer] for layer in raw.last_stats["load"].tolist()]
                rec["router_entropy"] = [round(v, 3) for v in raw.last_stats["entropy"].tolist()]
            if norms is not None:
                rec["router_expert_grad_norms"] = norms
            if record_eval:
                rec["val_loss"] = round(val_loss, 4)
                print(json.dumps({k: v for k, v in rec.items() if k not in ("expert_load", "router_expert_grad_norms")}), flush=True)
            log.write(json.dumps(rec) + "\n")
            log.flush()
        if step % args.ckpt_every == 0 or step == end:
            # Outside the main_proc guard: the gather is collective.
            state, optim_state = full_state(), full_optim()
            if main_proc:
                checkpoint.save(latest, raw, opt, step, vars(args),
                                extra={"scaler": scaler.state_dict()} if scaler.is_enabled() else None,
                                state=state, optim=optim_state)
    result = {}
    if main_proc:
        result = json.loads(open(out / "metrics.jsonl").read().strip().splitlines()[-1])
        log.close()
    if ddp:
        dist.destroy_process_group()
    return result


if __name__ == "__main__":
    main()
