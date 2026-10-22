# Training Artemis on Kaggle's free T4s

Kaggle gives two NVIDIA T4s and roughly 30 GPU-hours a week at no cost. That
is enough to train the `100m` rung to its Chinchilla budget, which no hardware
on the Azure subscription can currently do: every NVIDIA and AMD GPU family
there sits at quota 0, verified across 36 regions and both subscriptions.

## Measured expectations

| | |
| --- | ---: |
| budget | 2,215,111,680 tokens (20 x 110,755,584 active params) |
| shards | 31 of `codeparrot/github-code-clean` at ~70.4M tokens each |
| token bins | ~6.6 GB (uint16 ids + uint8 domain labels) |
| 2x T4 @ 30% MFU | **~10.5 h** |
| 1x T4 | ~21 h |
| 1x P100 | ~72 h — pick T4 x2, not P100 |

The P100 figure is why the accelerator choice matters: P100 has no usable fp16
tensor throughput for this, and the same run takes three days instead of half
of one.

## Why interruption is safe

Kaggle's session ceiling is below the run length, so the script is built to be
killed. `artemis.train` resumes exactly: the step counter, the RNG state that
determines which batches are drawn, and the fp16 loss scale all live in the
checkpoint. A resumed run continues the same trajectory rather than restarting
one. Checkpoints are written every 250 steps, so a lost session costs minutes.

`--stop-at` is not used here; instead the script enforces its own budget and
lets the trainer exit cleanly before Kaggle's kill.

## fp16, not bf16

T4 is Turing and has no bf16 at all. The trainer detects this and attaches a
GradScaler automatically — nothing in this script forces it. Watch the first
few hundred steps for loss-scale thrashing (repeated halving of the scale with
skipped steps); that path is tested on CPU with the scaler forced, but has had
little exposure to real Turing silicon.

## Running it

1. Kaggle -> Settings -> API -> **Create New Token** (downloads `kaggle.json`).
2. Supply `KAGGLE_USERNAME` and `KAGGLE_KEY` as environment secrets. Never
   paste them into a conversation or commit them.
3. Put the username into `kernel-metadata.json` (`id` field).
4. Push and run:

```bash
kaggle kernels push -p scripts/train/kaggle
kaggle kernels status  <username>/artemis-100m
kaggle kernels output  <username>/artemis-100m -p ./artemis-out
```

In the Kaggle UI, set the accelerator to **GPU T4 x2** and internet to **on**
before the first run. The metadata enables a GPU but does not reliably pick
*which* one.

## Continuing in a later session

Attach the previous run's **output** as a dataset input. The script looks under
`/kaggle/input` for `artemis/run/latest.pt` and, finding it, reuses the prepared
corpus and resumes from that checkpoint instead of re-preparing 31 shards.

## Terms

Kaggle's free compute is provided for data science, competitions and learning.
Artemis is intended as a commercial product. Check Kaggle's current terms on
commercial use before relying on this for production weights — the question is
worth settling before the work is done, not after.
