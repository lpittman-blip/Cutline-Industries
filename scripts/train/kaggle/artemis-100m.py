"""Train Artemis 100m on Kaggle's free T4s. Designed to be interrupted.

Kaggle gives two T4s and roughly 30 GPU-hours a week, with a session limit
well under the ~10.5 hours this run needs on both cards. That is survivable
only because artemis.train resumes exactly -- step, RNG state and the fp16
loss scale all ride in the checkpoint -- so the run is deliberately built as
"do as much as the session allows, then stop cleanly".

HOW A SECOND SESSION CONTINUES: everything lands in /kaggle/working, which
Kaggle keeps as the notebook's output. Attach the previous version's output as
a dataset input and this script finds the checkpoint and the prepared corpus
under /kaggle/input and carries on instead of starting over.

T4 IS TURING, SO fp16 NOT bf16. The trainer already picks this and attaches a
GradScaler; nothing here needs to force it. That path exists in the codebase
precisely because free Kaggle GPUs and the one affordable Azure GPU are both
pre-Ampere.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = "https://github.com/lpittman-g/Cutline-Industries.git"
WORK = Path("/kaggle/working/artemis")
SRC = Path("/kaggle/working/source")
SHARDS = int(os.environ.get("ARTEMIS_SHARDS", "31"))     # ~2.2B tokens
SIZE = os.environ.get("ARTEMIS_SIZE", "100m")
# Stop before Kaggle kills the session, so the final checkpoint is written by
# us rather than lost to SIGKILL. Kaggle's ceiling is ~12h; leave a margin for
# the commit to flush /kaggle/working.
BUDGET_S = float(os.environ.get("ARTEMIS_BUDGET_S", str(10.5 * 3600)))


def run(cmd, **kw):
    print(f"$ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=True, **kw)


def find_prior():
    """A previous session's output, attached as an input dataset."""
    root = Path("/kaggle/input")
    if not root.exists():
        return None
    for d in sorted(root.iterdir()):
        if (d / "artemis" / "run" / "latest.pt").exists():
            return d / "artemis"
    return None


def main():
    t0 = time.time()
    WORK.mkdir(parents=True, exist_ok=True)

    print("=== GPUs ===", flush=True)
    subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.total",
                    "--format=csv,noheader"], check=False)

    run([sys.executable, "-m", "pip", "install", "-q",
         "tokenizers", "huggingface_hub", "pyarrow", "pyyaml"])

    if not SRC.exists():
        run(["git", "clone", "--quiet", REPO, str(SRC)])
    else:
        run(["git", "-C", str(SRC), "pull", "--ff-only", "--quiet"])
    gateway = SRC / "gateway"

    prior = find_prior()
    if prior:
        print(f"=== resuming from {prior} ===", flush=True)
        if not (WORK / "data").exists():
            run(["cp", "-r", str(prior / "data"), str(WORK / "data")])
        (WORK / "run").mkdir(parents=True, exist_ok=True)
        if not (WORK / "run" / "latest.pt").exists():
            run(["cp", str(prior / "run" / "latest.pt"), str(WORK / "run" / "latest.pt")])

    if not (WORK / "data" / "train.bin").exists():
        print("=== preparing corpus (one shard at a time; deleted as it goes) ===", flush=True)
        run([sys.executable, "-m", "artemis.stream_corpus",
             "--work", str(WORK), "--shards", str(SHARDS), "--vocab", "32000",
             "--tokenizer-shards", "2"], cwd=gateway)

    manifest = json.loads((WORK / "data" / "manifest.json").read_text())
    tokens = manifest["train_tokens"] + manifest["val_tokens"]
    print(f"=== corpus: {tokens:,} tokens ===", flush=True)

    # Steps follow the token budget, not the clock. The session may not reach
    # the end; --stop-at lets it stop cleanly where it is, and the next session
    # picks up from the same step count.
    batch, accum, seq = 6, 4, 2048
    ngpu = int(subprocess.run(["nvidia-smi", "--list-gpus"], capture_output=True,
                              text=True).stdout.count("GPU "))
    per_step = batch * accum * seq * max(ngpu, 1)
    steps = 2_215_111_680 // per_step
    print(f"=== {ngpu} GPU(s), {per_step:,} tokens/step, {steps:,} steps total ===", flush=True)

    args = ["--size", SIZE, "--data", str(WORK / "data"), "--out", str(WORK / "run"),
            "--steps", str(steps), "--batch", str(batch), "--accum", str(accum),
            "--lr", "3e-4", "--warmup", str(max(1, steps // 50)), "--seed", "1337",
            "--route-coef", "0", "--eval-every", "500", "--eval-batches", "20",
            "--ckpt-every", "250"]            # frequent: a lost session costs 250 steps

    remaining = BUDGET_S - (time.time() - t0)
    print(f"=== training, {remaining/3600:.1f} h of session budget left ===", flush=True)
    cmd = ([sys.executable, "-m", "torch.distributed.run", "--nproc_per_node", str(ngpu),
            "-m", "artemis.train"] if ngpu > 1 else [sys.executable, "-m", "artemis.train"])
    try:
        subprocess.run(cmd + args, cwd=gateway, check=True, timeout=max(60, remaining))
        print("=== RUN COMPLETE ===", flush=True)
    except subprocess.TimeoutExpired:
        print("=== session budget reached; checkpoint is current, resume next session ===",
              flush=True)

    m = WORK / "run" / "metrics.jsonl"
    if m.exists():
        last = [l for l in m.read_text().splitlines() if l.strip()][-1]
        print("last metrics:", last, flush=True)
    subprocess.run(["du", "-sh", str(WORK)], check=False)


if __name__ == "__main__":
    main()
