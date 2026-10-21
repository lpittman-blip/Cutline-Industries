# Training Artemis on a machine you own

Costs nothing. No cloud account, no credit card, no invoice, no GPU quota
request, no procurement. If you have a desktop with an NVIDIA card, that is the
whole shopping list.

The training pipeline is bash and Linux: it calls `apt-get`, uses
`pip --break-system-packages`, and defaults `WORK` to `/mnt/artemis`. On
Windows it will not run natively. Pick the path that matches the machine.

---

## Option A — the fast one: run the agent ON the GPU box

Install Claude Code on the machine with the GPU and start a session there. The
agent then has direct access to the hardware, and can run the preflight, start
training, watch the loss, and fix whatever breaks — without a human relaying
command output back and forth.

This is strictly better than the options below, because every round trip of
"run this, paste the output" is a delay, and training runs produce a lot of
output worth reacting to. On Windows, install it inside WSL (Option C first,
then Claude Code inside the Ubuntu shell).

Point the session at this repo and say: *train the 100m model on this box.*

---

## Option B — Linux box, driving it yourself

```bash
git clone https://github.com/lpittman-g/Cutline-Industries.git ~/artemis-src
cd ~/artemis-src
mkdir -p ~/artemis-work

# Checks GPU, VRAM, disk and the token budget. Downloads nothing, trains
# nothing, costs nothing. RATE_PER_HOUR=0 stops it quoting rental prices at
# you for hardware you own.
WORK=$HOME/artemis-work REPO_DIR=$HOME/artemis-src RATE_PER_HOUR=0 \
  bash scripts/train/rent-gpu-run.sh --preflight
```

Send back what it prints — GPU model, VRAM, free disk, estimated hours. Then
the real run is the same line without `--preflight`.

The `WORK` and `REPO_DIR` overrides keep everything in your home directory, so
nothing needs `sudo` and nothing touches `/mnt` or `/opt`.

---

## Option C — Windows box

CUDA works inside WSL2, so this path is real, not a workaround. The Windows
NVIDIA driver provides the GPU to Linux; there is nothing to install on the
Linux side.

1. **Install WSL2** in PowerShell as Administrator, then reboot:

   ```powershell
   wsl --install -d Ubuntu
   ```

2. **Update the Windows NVIDIA driver** from nvidia.com if it is old. This is
   the step that makes the GPU visible inside WSL.

   **Do not install an NVIDIA driver inside Ubuntu.** It is the most common way
   to break CUDA-on-WSL: the Windows driver is already providing the device, and
   a Linux driver on top of it conflicts. Only the CUDA *toolkit* may be
   installed inside WSL, never the driver.

3. **Open the Ubuntu shell and confirm the GPU is there:**

   ```bash
   nvidia-smi
   ```

   If that prints your card, everything else follows. If it says "command not
   found" or shows no devices, stop — the driver step did not take, and nothing
   below will work.

4. **Then follow Option B**, unchanged.

A note on disk: WSL2 stores its filesystem in a virtual disk on `C:` by
default. The run needs real space (see below), so if `C:` is tight, either free
it up or move the WSL disk to another drive before starting.

---

## Disk, and how to need less

The preflight requires **150 GiB free** by default and refuses below it.

Corpus preparation downloads, filters and tokenises **one shard at a time and
deletes it before fetching the next**, so the raw parquet and the filtered JSONL
never accumulate. Peak disk for a full 43-shard run is about **10 GB**:

| | size |
| --- | --- |
| one shard in flight (parquet + filtered JSONL) | ~0.6 GB, reused and deleted |
| `train.bin` + `val.bin` (3.03B tokens, uint16) | ~6 GB |
| `train.dom` + `val.dom` (one label byte per token) | ~3 GB |
| dedup ledger (8 bytes per document) | ~30 MB |

So `MIN_FREE_GIB=150` carries a large margin, which is defensible on a rented
box where running out of disk eight hours in wastes real money. On your own
machine **30 GiB is ample for the full 43-shard run**, with room for
checkpoints:

```bash
MIN_FREE_GIB=30 WORK=$HOME/artemis-work REPO_DIR=$HOME/artemis-src \
  RATE_PER_HOUR=0 bash scripts/train/rent-gpu-run.sh --preflight
```

Preparation is also resumable: completed shards are recorded in
`$WORK/prep-state.json` and skipped, and a shard interrupted mid-write is
truncated away rather than counted twice. Closing the lid costs one shard.

If you have less than that, lower the pool as well:

```bash
SHARDS=20 MIN_FREE_GIB=80 WORK=$HOME/artemis-work REPO_DIR=$HOME/artemis-src \
  RATE_PER_HOUR=0 bash scripts/train/rent-gpu-run.sh --preflight
```

`SHARDS` sizes the token pool and the step budget is derived from it, so 20
shards is a smaller but still coherent run — 1.4B tokens instead of 3.0B.
Halving the pool halves the disk and roughly halves the time.

---

## What to expect

- **VRAM:** 100m at `batch 6 × seq 2048` fits comfortably in 12 GB. A 24 GB
  card has plenty of headroom; you could raise `BATCH` and lower `ACCUM`.
- **Hours:** derived from your actual card. Measured examples at 30% MFU:
  RTX 3090 ≈ 26 h, RTX 4090 ≈ 11 h, A100 ≈ 6 h. Plus a few hours of largely
  single-threaded data prep in front of training, which no GPU speeds up.
- **Precision:** bf16 on Ampere or newer (30-series and up). On a 20-series or
  T4 the trainer falls back to fp16 with loss scaling. That path is tested on
  CPU with the scaler forced, but has never run on real Turing silicon — if
  that is your card, say so, and the first few hundred steps should be watched
  for loss-scale thrashing before leaving it overnight.
- **Interruptions are fine.** Checkpoints land every 1000 steps and resume is
  exact, including the fp16 loss scale. Closing the lid does not lose the run.

## What success looks like

`metrics.jsonl` under `$WORK/runs/100m/` gains a line per step. Loss should
fall from ~10.4 (random init at vocab 32000) into the 2-4 range. `ROUTE_COEF`
defaults to 0, which is deliberate and measured — see
`docs/MOE-ROUTING-ABLATION.md`.
