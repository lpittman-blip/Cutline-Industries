# Codex brief — train Artemis and cut the gateway over to its own weights

Written 2026-10-11 for whoever drives this in Codex. Everything in the
**Verified** sections was checked today against the live systems, not inferred
from the repo. Everything in **Unverified** is explicitly not established.

Companion docs: `docs/TRAINING-HANDOFF.md` (the traps, the corpus numbers, the
architecture result), `docs/INFERENCE.md`, `docs/proto-moe-vs-dense.md`.

---

## 1. The job, in one paragraph

Artemis's own weights — the Prime Core and its ten routed experts in
`gateway/artemis/model.py` — do not exist yet beyond proto scale. The live site
talks to a working gateway, but that gateway is serving **Artemis 0**, an
external Azure AI Services model, behind an explicit bootstrap flag. The job is
to pretrain Artemis's own weights on the 8× H100 box, run curated chat SFT and
verified self-play on top, evaluate, and then change the **gateway's** serving
configuration so the site is answered by Artemis's own checkpoint. Not a status
flag. Not a relabelled provider. The weights.

---

## 2. Verified: the two hostnames are one deployment

The uploaded handoff flagged this as an open question and told you not to
assume. It is now settled — same machine, same process, one nginx server block:

```
api.cutline-industries.studio             A = 40.90.251.232
api.artemisai-bycutlineindustries.studio  A = 40.90.251.232

nginx:  server_name api.cutline-industries.studio api.artemisai-bycutlineindustries.studio;
```

Both return the same payload:

```
model=artemis0  provider=azure-ai-services  bootstrap=True  training_collection=False
```

So the root `vercel.json` rewrites — `/api/*` and `/v1/*` to
`api.cutline-industries.studio`, `/gateway/*` to
`api.artemisai-bycutlineindustries.studio` — reach the **same** gateway.
Changing the serving backend once changes both. There is no second deployment to
find, and no need to reconcile two configurations.

## 3. Verified: the gateway host

| | |
| --- | --- |
| Azure VM | `cutline-vps`, resource group `ARTM-RG` |
| public IP | `40.90.251.232` |
| size | `Standard_D2as_v4` — 2 vCPU, **no GPU** (`nvidia-smi: not found`) |
| OS | Ubuntu 22.04 (jammy) |
| state | running |
| systemd unit | `artemis-chat.service` — loaded, active |
| ExecStart | `/opt/artemis-chat/.venv/bin/python -m artemis.chat_app` |
| WorkingDirectory | `/opt/artemis-chat/gateway` |
| runs as | user `artemis` |
| env file | `/etc/artemis-chat.env` (mode 600, root-owned) |
| checked-out commit | `528046d` |

Env keys present in `/etc/artemis-chat.env` (names only — values stay on the
box):

```
ARTEMIS_ALLOWED_ORIGINS   ARTEMIS_BIND         ARTEMIS_BOOTSTRAP_AZURE
ARTEMIS_COOKIE_SECURE     ARTEMIS_DATABASE_URL PORT
AZURE_AI_DEPLOYMENT       AZURE_AI_ENDPOINT    AZURE_AI_KEY
```

**No `ARTEMIS_CHECKPOINT`, no `ARTEMIS_TOKENIZER`, no `VLLM_BASE_URL`, no
`ARTEMIS_INFERENCE_URL`.** That is the whole reason the site reports a bootstrap
model: the only backend it is configured for is the external one.

You have Azure CLI access on this subscription (`65c3f7b2-285e-47e3-84fe-2c77c16ad301`),
so you can read and change the box without SSH:

```bash
az vm run-command invoke -g ARTM-RG -n cutline-vps \
  --command-id RunShellScript --scripts '<shell>' --query "value[0].message" -o tsv
```

## 4. Verified: how the gateway picks a backend

`gateway/artemis/chat_app.py:main()` calls `build_app()` in
`gateway/artemis/server.py:64`. Precedence, first match wins:

1. `VLLM_BASE_URL` or `ARTEMIS_INFERENCE_URL` → `ArtemisServerBackend`
   (OpenAI-shaped HTTP; optional `VLLM_API_KEY` / `ARTEMIS_INFERENCE_KEY`,
   optional `VLLM_MODEL`)
2. `ARTEMIS_CHECKPOINT` → `LocalBackend(ckpt, os.environ["ARTEMIS_TOKENIZER"])`
   — note `ARTEMIS_TOKENIZER` is read unguarded, so setting the checkpoint
   without the tokenizer is a `KeyError` at boot, not a fallback
3. `ARTEMIS_BOOTSTRAP_AZURE=1` → `AzureAIBackend` (requires
   `AZURE_AI_ENDPOINT`, `AZURE_AI_KEY`, `AZURE_AI_DEPLOYMENT`; `SystemExit` if
   any is missing)
4. otherwise `NotReadyBackend`

Two consequences worth knowing before you plan the cutover:

- An own-model backend **already wins** over the bootstrap. You do not have to
  remove `ARTEMIS_BOOTSTRAP_AZURE=1` to take effect — but remove it anyway, so
  a later typo in the inference URL fails loudly to `NotReadyBackend` instead of
  silently falling back to an external provider and reporting `quality:
  not-artemis` to customers.
- `AzureAIBackend.readiness()` reports `quality="not-artemis"` and stamps
  `external: True` on every reply's metadata. That is why public `/api/status`
  is trustworthy as a *negative* signal. It is **not** proof of which weights
  are loaded when it turns positive — verify identity server-side (§7).

## 5. Verified blocker: the GPU box cannot be started

| | |
| --- | --- |
| instance | `computeinstance-e00hf3ff9c9d3g63z1` (`artemis-8gpu`) |
| state | **STOPPED** — not billing |
| hardware | 8× NVIDIA H100 80GB HBM3, NVSwitch, drivers loaded, Docker running |
| project | `project-e00yn51ypr007sqnbn1x9t` (eu-north1) |
| tenant | `tenant-e00wxvkryxs522aaxt` |
| security group | `vpcsecuritygroup-e00vajgc6qvb1kfmk6` (egress all, ingress tcp/22) |
| image | `ubuntu24.04-cuda13.0` |

**Resolved 2026-10-11 — this section previously said writes were blocked.**
`serviceaccount-e04nwdxcrjmat9y8q0` is a member of `admins`
(`group-e00mqgga9j7vgnwcw7`) and writes were confirmed working. Permissions no
longer block anything.

You do not use that account. Codex has its own narrower identity,
`serviceaccount-e00vtzxm35ebf0zmm2` (`artemis-codex`), holding `editor` rather
than `admin`. Setup, verification results and the remaining owner steps are in
`docs/codex-nebius-handoff.md` — read it before touching the GPU box.

This instance costs roughly **$98/hour** while running. The owner's standing
rule is that it is never started without their explicit confirmation. Ask, every
time, even after permission is restored.

Nebius only offers 1-GPU and 8-GPU presets. There is no 4-GPU option.

## 6. Watching a run without SSH

Outbound port 22 is blocked from Claude and Codex cloud containers to **every**
host. This is not a security-group problem on the Nebius side; the serial console
log proved egress from the instance always worked. Two channels over HTTPS are
proven:

```bash
# serial console — cloud-init, systemd, the lot
nebius logging query '{syslog_facility=~".+"} |= "bootstrap"' \
  --project-id project-e00yn51ypr007sqnbn1x9t --since 1h

# status + checkpoints, synced every 120s by artemis-sync.service
aws --endpoint-url https://storage.eu-north1.nebius.cloud \
  s3 cp s3://artemis-train-logs/status.txt -
```

The serial log is what finally diagnosed four silent boot failures. Reach for it
before guessing. If you need an interactive shell on the GPU box, the access to
ask the owner for is **a Nebius-side exec/console path or a bastion on 443** —
not a private key, which must never be pasted into a conversation.

## 7. The cutover, concretely

The gateway VM has **no GPU and 2 vCPU**. That rules out `LocalBackend` in the
gateway process for anything but a toy model, so the real path is HTTP:

1. Serve the accepted checkpoint on the GPU host.
2. Set `ARTEMIS_INFERENCE_URL` (and a key) in `/etc/artemis-chat.env` on
   `cutline-vps`, remove `ARTEMIS_BOOTSTRAP_AZURE`, `systemctl restart
   artemis-chat`.

**There is a real gap in step 1, and you have to close it.** Neither existing
server loads an Artemis checkpoint:

- `scripts/serve/artemis-serve.py` calls
  `AutoModelForCausalLM.from_pretrained(MODEL_PATH)` — it is a *transformers*
  server. It will not load a Prime Core / MoE `.pt` from
  `gateway/artemis/model.py`.
- `scripts/serve/vllm-launch.py` is vLLM, which has no architecture
  registration for Artemis. The uploaded handoff is right: a custom Prime
  Core/MoE checkpoint is not automatically vLLM-compatible.
- `gateway/artemis/infer.py:LocalModel` **is** the real loader (`.generate`,
  `.stream`, `.info`), but it is in-process only.

So write a thin HTTP wrapper around `artemis.infer.LocalModel` that exposes
`POST /v1/chat/completions` with SSE streaming, and run it on the GPU host. Make
it match what `ArtemisServerBackend` actually sends (`gateway/artemis/backends.py:71`):
a `model` field, `max_tokens`, `messages`, `chat_template_kwargs: {brain: ...}`,
and for streaming `stream: true` plus `stream_options.include_usage`. The client
requires a terminating `data: [DONE]` — it raises `ModelUnavailable` on a stream
that ends without one. Don't reach for vLLM unless you implement and test
architecture registration, and if you do, say so explicitly in the report.

Record the prior serving configuration before you change anything: the current
`/etc/artemis-chat.env` key set (above), the commit on the box (`528046d`), and
the systemd unit. That triple is the rollback target.

## 8. Verify identity server-side, not from the status flag

A model label in public status is not evidence. `LocalModel.info()` exists for
this; `server.py:126` already surfaces it for `LocalBackend`. Bind the
evaluation report to the exact checkpoint and tokenizer **hashes**, and confirm
the loaded architecture and vocab size at the serving process, not at the edge.
Report those hashes.

## 9. Pipeline, and the five traps

```
STAGE=1 SIZE=100m SHARDS=43  STEPS=61589  bash scripts/train/stages.sh   # de-risk first
STAGE=1 SIZE=1b   SHARDS=284 STEPS=25424  bash scripts/train/stages.sh   # the real run
STAGE=2                                   bash scripts/train/stages.sh   # self-improvement
```

**Always pass STEPS.** `SHARDS` sizes the sampling pool; `STEPS` alone decides
how long the run is, and `stages.sh` defaults it to 60000 regardless of either
the pool or the GPU count. `artemis/train.py:137` computes
`tokens_per_step = batch * accum * max_seq_len * world_size`, so on the 8-GPU box
at 1b that default trains 47B tokens out of a 20B pool — every window seen about
2.4 times, which is memorisation, not a longer run. The figures above are one
pass over the pool: 11 hours for 1b on 8xH100, 1.4 hours for 100m on one.
`scripts/train/rent-gpu-run.sh` derives `STEPS` from `SHARDS` for you and prints
the ratio before it spends anything; prefer it over calling `stages.sh` directly.

Stage 2 refuses to run without a stage-1 checkpoint, deliberately:
self-improvement amplifies a signal and cannot create one. A model that never
solves a problem produces no training data and improves by exactly zero.

The traps, all of which already cost a day:

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

## 10. Corpus — measured, not estimated

`codeparrot/github-code-clean` is an Apache-2.0 *dataset* whose rows each carry
their origin repository's licence. On a real shard, **45,232 of 126,925 rows
(36%) are not permissive**, GPL among them. Artemis is being built to be sold,
so `artemis.code_corpus` keeps only permissive rows and counts the rejects. Do
not skip that filter.

Measured with the real vocab-32000 tokenizer:

| | |
| --- | --- |
| tokens per character | 0.2918 |
| tokens per filtered shard | 70.4 M |
| shards for `1b` (~20B tokens) | 284 |
| all 880 shards | ~61.9 B tokens |

Domain labels come from file paths — `tests/` → `test`, CI and container files
→ `deploy`, other source → `build`. Weaker signals are left unlabelled, because
a wrong label is worse than none.

Code self-play does not supply a general chat education. The 20B-token target
and the `1b` size are *configurations*, not evidence. Curated chat SFT on a
licensed, consented corpus is a separate step and the uploaded handoff is right
to insist on it.

## 11. Architecture result worth knowing before you spend on 8b

At proto scale (8.2M params, 12.6M tokens of public-domain text), matched for
compute, data, seed and schedule:

| | MoE | dense |
| --- | --- | --- |
| final val loss | 3.9429 | **3.9397** |
| parameters | 8.24 M | **5.87 M** |
| wall clock | 3332 s | **2757 s** |

The dense baseline won — 29% fewer parameters, 21% less time. The caveat that
limits the result: `domain_labels` was false in that run, so `route_coef` had
nothing to supervise and the MoE's actual premise was never tested. Re-run the
comparison at `100m` **on labelled data** before committing weeks of GPU time to
an 8b MoE. Details in `docs/proto-moe-vs-dense.md`.

## 12. Provenance rules — not negotiable

- `gateway/artemis/selfplay.py` trains **Artemis's own weights**. No third-party
  base model, no LoRA, no distillation.
- `artemis2/` is a bootstrap that fine-tunes **Qwen with a LoRA adapter**. It
  lives outside the package on purpose and labels its output as not-Artemis.
  Nothing under `gateway/` imports it. Keep it that way.
- **Pretraining** data must be human-written. No model-generated text in the
  pretraining corpus.
- **Chat SFT** may use an open-weight teacher whose licence grants the right to
  train on its output, run on our own hardware — amended 2026-10-11. Approved
  teachers are Apache-2.0/MIT only (`artemis.teachers.TEACHERS`), seeds must be
  human-written, and `artemis.sft.check_provenance` hard-fails any row that
  cannot name its origin. No hosted provider: every one of them forbids
  training a competing model on their output, and Artemis is sold. Details and
  the refusal list in `docs/sft-teachers.md`.
- Never call OpenAI, Claude, Grok, Gemini, Cohere, Ollama or any external LLM in
  product code or in Artemis decisions (Blueprint Decisions 5 and 12). The two
  exceptions in `backends.py` are deliberate, flagged, and both announce
  themselves as external.
- Secrets live in Azure Key Vault `artemis-kv-6b22c1`. Never in code, chat,
  tickets or logs. Never ask the owner to paste a key, token or password into a
  conversation.

## 13. Do not

- **Do not deploy `site/` from a snapshot.** The site deploys from GitHub now. A
  snapshot deploy is exactly how production and `main` diverged, leaving seven
  live files in no commit at all.
- **Do not re-add the `/chat` → `/artemisai/` redirect** to the root
  `vercel.json`. It routes visitors off the orb interface, which only
  `site/chat/index.html` loads. (Removed in `528046d`.)
- **Do not drop the `/gateway/status` and `/gateway/health` rewrites** from the
  root `vercel.json`. Losing them is what made the homepage's live panels show
  offline. (Restored in `32c7010`, PR #112.)
- **Do not change a status flag, relabel a provider, or substitute GPT-2 or any
  OpenAI weights** and call the result Artemis.
- **Do not put a training job in a Vercel request handler**, and do not infer
  serving capacity from CDN delivery.
- Preserve the website's UI, layout, moving themes, accounts, chat history and
  tabs. Touch frontend assets only for a specific integration defect, minimally.

## 14. Unverified — state these as open, don't assert them

- Chat **quality** of anything. Nothing has been evaluated end to end.
- Authentication correctness, account isolation, and cross-device history
  persistence. The gateway answers; that is all that was tested.
- Whether a `1b` Artemis checkpoint serves acceptable latency on the 8× H100 box
  under concurrency.
- Whether public coding benchmarks are contaminated by the pretraining corpus.
  They plausibly are — the corpus is GitHub. The self-play reserved split is
  reserved from *loop selection*; it is not evidence of absence from
  pretraining. Check separately.

## 15. What to report back

Exactly which tests, jobs and deployments ran, and their results. Accepted model
and tokenizer hashes. The gateway revision before and after, and the recorded
rollback target. Measured tokens and training steps. Any access or data blocker,
named precisely. No completion claim from mocked tests or from a status endpoint
alone.
