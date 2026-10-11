# Training handoff — state as of 2026-10-11

Everything needed to start Artemis training, and the traps that already cost a
day. Written for whoever drives the next run.

## Start here

```
STAGE=1 SIZE=100m SHARDS=43 bash scripts/train/stages.sh    # ~1 hour, de-risk
STAGE=1 SIZE=1b  SHARDS=284 bash scripts/train/stages.sh    # ~20 hours, real
STAGE=2 bash scripts/train/stages.sh                        # self-improvement
```

Stage 2 refuses to run without a stage-1 checkpoint, deliberately:
self-improvement amplifies a signal and cannot create one. A model that never
solves a problem produces no training data and improves by exactly zero.

## The machine

| | |
| --- | --- |
| instance | `computeinstance-e00hf3ff9c9d3g63z1` (`artemis-8gpu`), **STOPPED** |
| hardware | 8× NVIDIA H100 80GB HBM3, NVSwitch, drivers loaded, Docker running |
| project | `project-e00yn51ypr007sqnbn1x9t` (eu-north1) |
| tenant | `tenant-e00wxvkryxs522aaxt` |
| security group | `vpcsecuritygroup-e00vajgc6qvb1kfmk6` (egress all, ingress tcp/22) |
| image | `ubuntu24.04-cuda13.0` |

**Known blocker:** service account `serviceaccount-e04nwdxcrjmat9y8q0` lost
write permission. Reads succeed, writes return `PermissionDenied`. Re-add it to
`admins`, or grant an editor role on the project.

## Five things that will waste your time if you do not know them

1. **`awscli` is not an apt package on Ubuntu 24.04.** `apt-get install awscli`
   fails with "no installation candidate". Use pip.
2. **PEP 668.** The system Python is externally managed, so *every* pip call
   needs `--break-system-packages` or it exits non-zero and `set -e` kills the
   script. Route them through one helper so the guard cannot be missed.
3. **Do not `pip install --upgrade pip`.** It tries to uninstall Debian's pip
   and fails with "RECORD file not found". pip 24.0 installs everything fine.
4. **cloud-init `runcmd` does not re-run on reboot.** Starting a stopped
   instance will not re-trigger setup. Use a systemd unit with
   `Restart=on-failure` that `git pull`s first — then a pushed fix is picked up
   by the retry instead of needing the instance rebuilt.
5. **There is no 4-GPU preset.** Nebius offers 1 or 8, nothing between.

## Watching a run without SSH

Outbound port 22 is blocked from Claude/Codex cloud containers, to every host.
Two channels work over HTTPS and both are proven:

```
# serial console, including cloud-init and systemd
nebius logging query '{syslog_facility=~".+"} |= "bootstrap"' \
  --project-id project-e00yn51ypr007sqnbn1x9t --since 1h

# status + checkpoints, synced every 120s by artemis-sync.service
aws --endpoint-url https://storage.eu-north1.nebius.cloud \
  s3 cp s3://artemis-train-logs/status.txt -
```

The serial log is what finally diagnosed four silent boot failures. Reach for
it before guessing.

## Corpus — measured, not estimated

`codeparrot/github-code-clean` is an Apache-2.0 *dataset* whose rows each carry
their origin repository's licence. On a real shard, **45,232 of 126,925 rows
(36%) are not permissive**, GPL among them. Artemis is being trained to be
sold, so `artemis.code_corpus` keeps only permissive rows and counts the
rejects. Do not skip this filter.

Measured with the real vocab-32000 tokenizer:

| | |
| --- | --- |
| tokens per character | 0.2918 |
| tokens per filtered shard | 70.4 M |
| shards for `1b` (~20B tokens) | 284 |
| all 880 shards | ~61.9 B tokens |

Domain labels come from file paths — `tests/` → `test`, CI and container files
→ `deploy`, other source → `build`. Weaker signals are left unlabelled, since a
wrong label is worse than none. This matters: the proto MoE lost to a
matched-compute dense baseline precisely because `domain_labels` was false and
`route_coef` had nothing to supervise.

## Architecture result worth knowing before you spend on 8b

At proto scale (8.2M params, 12.6M tokens of public-domain text), matched for
compute, data, seed and schedule:

| | MoE | dense |
| --- | --- | --- |
| final val loss | 3.9429 | **3.9397** |
| parameters | 8.24 M | **5.87 M** |
| wall clock | 3332 s | **2757 s** |

The dense baseline won, with 29% fewer parameters and 21% less time. The
caveat that limits this: routing supervision was inert, so the MoE's actual
premise was never tested. Re-run the comparison at `100m` **on labelled data**
before committing weeks of GPU time to an 8b MoE. Details in
`docs/proto-moe-vs-dense.md`.

## Provenance rules

- `gateway/artemis/selfplay.py` trains **Artemis's own weights** — no
  third-party base model, no LoRA.
- `artemis2/` is a bootstrap that fine-tunes **Qwen with a LoRA adapter**. It
  lives outside the package on purpose and labels its output as not-Artemis.
  Nothing under `gateway/` imports it.
- Training data must be human-written. No model-generated text in any corpus.

## Do not

- Deploy `site/` from a snapshot. The site now deploys from GitHub; a snapshot
  deploy is how production and `main` diverged in the first place.
- Re-add the `/chat` → `/artemisai/` redirect to the root `vercel.json`. It
  routes visitors off the orb interface, which only `site/chat/index.html`
  loads.
