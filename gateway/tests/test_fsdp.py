"""FSDP sharding, exercised for real on CPU with two gloo processes.

The 14B target cannot be trained with DDP, which replicates the whole model on
every GPU. The risk with FSDP is not that it fails loudly -- it is that it
trains happily and writes a checkpoint that nothing can load, or that silently
depends on being reloaded at the same world size. So the property under test is
end to end: train sharded across two ranks, then load the resulting checkpoint
into an ORDINARY unsharded ArtemisLM and run it.

gloo on CPU runs the same code paths as nccl on GPUs -- sharding, gradient
sync, state-dict gathering -- so this is a real test of the logic, though not
of CUDA kernels or of memory behaviour at scale.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

REPO = Path(__file__).resolve().parents[1]


def _corpus(tmp: Path, tokens: int = 60000) -> Path:
    """A tiny tokenised shard in the on-disk layout TokenStream expects."""
    d = tmp / "data"
    d.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    for split, n in (("train", tokens), ("val", tokens // 4)):
        rng.integers(0, 256, n, dtype=np.uint16).tofile(d / f"{split}.bin")
        rng.integers(0, 10, n, dtype=np.uint8).tofile(d / f"{split}.dom")
    (d / "manifest.json").write_text(json.dumps({"dtype": "uint16", "train_tokens": tokens,
                                                 "val_tokens": tokens // 4, "domain_labels": True}))
    return d


def _free_port() -> int:
    import socket
    with socket.socket() as s:                 # bind 0, read the port, release
        s.bind(("", 0))
        return s.getsockname()[1]


def _run(tmp: Path, data: Path, out: str, world: int, shard: str, steps: int = 4):
    train_args = ["--size", "smoke-moe", "--data", str(data), "--out", str(tmp / out),
                  "--steps", str(steps), "--batch", "1", "--accum", "2", "--lr", "1e-3",
                  "--warmup", "1", "--seed", "1337", "--eval-every", str(steps),
                  "--eval-batches", "1", "--ckpt-every", str(steps), "--shard", shard]
    if world > 1:
        cmd = [sys.executable, "-m", "torch.distributed.run",
               "--nproc_per_node", str(world), "--master_port", str(_free_port()),
               "-m", "artemis.train", *train_args]
    else:
        cmd = [sys.executable, "-m", "artemis.train", *train_args]
    env = {**os.environ, "OMP_NUM_THREADS": "1", "TOKENIZERS_PARALLELISM": "false"}
    p = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=900)
    assert p.returncode == 0, f"rc={p.returncode}\nSTDOUT:\n{p.stdout[-3000:]}\nSTDERR:\n{p.stderr[-3000:]}"
    return p


@pytest.fixture(scope="module")
def data(tmp_path_factory):
    return _corpus(tmp_path_factory.mktemp("fsdp"))


def test_fsdp_trains_across_two_ranks(tmp_path, data):
    _run(tmp_path, data, "fsdp", world=2, shard="fsdp")
    recs = [json.loads(l) for l in (tmp_path / "fsdp" / "metrics.jsonl").read_text().splitlines() if l.strip()]
    assert recs, "no metrics written"
    assert all(np.isfinite(r["loss"]) for r in recs), [r["loss"] for r in recs]


def test_the_sharded_checkpoint_loads_into_an_unsharded_model(tmp_path, data):
    """The property that matters: the file is a NORMAL checkpoint.

    If FSDP's DTensors reached disk, this raises -- either on load, or in the
    strict key/shape check inside load_model.
    """
    _run(tmp_path, data, "fsdp", world=2, shard="fsdp")
    sys.path.insert(0, str(REPO))
    from artemis import checkpoint
    model, ck = checkpoint.load_model(tmp_path / "fsdp" / "latest.pt")
    assert ck["step"] > 0
    for name, t in model.state_dict().items():
        assert isinstance(t, torch.Tensor) and not t.is_meta, name
        assert torch.isfinite(t).all(), f"{name} holds non-finite values"
    x = torch.randint(0, 256, (1, model.cfg.max_seq_len))
    logits, _ = model(x)
    assert logits.shape == (1, model.cfg.max_seq_len, model.cfg.vocab_size)
    assert torch.isfinite(logits).all()


def test_token_accounting_includes_every_rank(tmp_path, data):
    """tokens_per_step multiplied by world size only when `ddp` was true, so a
    sharded run under-reported its own throughput by the world size."""
    _run(tmp_path, data, "fsdp", world=2, shard="fsdp")
    _run(tmp_path, data, "one", world=1, shard="fsdp")
    two = [json.loads(l) for l in (tmp_path / "fsdp" / "metrics.jsonl").read_text().splitlines() if l.strip()]
    one = [json.loads(l) for l in (tmp_path / "one" / "metrics.jsonl").read_text().splitlines() if l.strip()]
    assert two[-1]["tokens"] == 2 * one[-1]["tokens"]


def test_a_sharded_run_resumes_from_its_own_checkpoint(tmp_path, data):
    _run(tmp_path, data, "fsdp", world=2, shard="fsdp", steps=4)
    p = _run(tmp_path, data, "fsdp", world=2, shard="fsdp", steps=8)
    assert "resumed from step 4" in p.stdout, p.stdout[-2000:]
    recs = [json.loads(l) for l in (tmp_path / "fsdp" / "metrics.jsonl").read_text().splitlines() if l.strip()]
    assert recs[-1]["step"] == 8
