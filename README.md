# Artemis

**AI for software delivery that never sends your code to someone else's model.**

Artemis is a mixture-of-experts transformer trained from random initialization —
not a fine-tune, not a wrapper — served by a gateway that runs entirely inside
your own infrastructure. One orchestrator brain manages ten specialist brains,
all trained in-house.

Built by **Cutline Industries** · [cutline-industries.studio](https://cutline-industries.studio) · [artemisai-bycutlineindustries.studio](https://artemisai-bycutlineindustries.studio)

---

## The rule the whole system is built on

**Artemis never calls an external LLM** — not in product code, not in Artemis's
own reasoning, not in training data. (Blueprint Decisions 5 and 12.)

This is a product requirement, not a limitation. It is what makes Artemis
sellable to teams for whom third-party model inference is disqualifying rather
than merely undesirable: regulated industries, defence suppliers, anyone under
source-code escrow.

Two deliberate, labelled exceptions:

| Exception | Where | Why it is allowed |
|---|---|---|
| Third-party models offered **to customers** | `configs/business.yaml` → `external: true` | An added service a plan may include, never a substitute for Artemis. The UI must say the request leaves our infrastructure. |
| `artemis2/` bootstrap loop | outside the `artemis` package | Trains a LoRA over a third-party base. Its output is **not** Artemis's weights and it labels itself as such everywhere. |

## Architecture

A dense decoder-only **Prime Core**, plus ten **additively routed** expert FFNs
at selected layers. Experts add to the dense feed-forward path rather than
replacing it, so the core always contributes:

```
h  ←  x  +  ffn(h)  +  Σ gₑ · expertₑ(h)
```

Each expert maps to one stage of software delivery, which makes routing
supervisable against the stage a task actually belongs to. From
[`gateway/artemis/model.py`](gateway/artemis/model.py):

```python
EXPERT_NAMES = ("intent", "architecture", "planning", "build", "test", "deploy",
                "memory", "security", "observability", "cost")
```

Routing is top-`experts_per_token` (default 2) with a load-balance loss
(`balance_coef` 0.01) and a router z-loss (`router_z_coef` 0.001). Attention is
grouped-query with RoPE.

### Configured sizes

From [`gateway/configs/models.yaml`](gateway/configs/models.yaml). *Active* =
weights one token actually passes through.

| Size | d_model | layers | heads (kv) | ctx | Total | Active |
|---|---|---|---|---|---|---|
| `smoke` / `smoke-moe` | 128 | 2 | 4 (2) | 128 | — | tests only |
| `proto` | 256 | 6 | 8 (2) | 256 | 8.2M | 5.9M |
| `proto-dense` | 256 | 6 | 8 (2) | 256 | 5.9M | 5.9M |
| `100m` | 768 | 12 | 12 (4) | 2048 | 153M | 111M |
| `1b` | 2048 | 20 | 16 (8) | 4096 | 1.31B | 1.06B |
| `3b` | 3072 | 28 | 24 (8) | 4096 | 4.17B | 3.38B |
| `8b` | 4096 | 36 | 32 (8) | 8192 | 10.2B | 8.4B |

`proto-dense` is the matched-compute dense baseline for `proto`: same depth,
width, attention and training budget, with a wider feed-forward so active
weights per token match (5.87M vs 5.88M). The routed architecture has to beat
it, or the experts aren't earning their parameters.

## The eleven brains

Separate from the MoE experts: `gateway/brains/*.yaml` defines an orchestrator
and ten specialists, each with its own system prompt and designated weights.

| Brain | Role |
|---|---|
| **Artemis** | Orchestrator. Reads every request, decides which specialists to involve, sends focused sub-tasks, has Venus audit the results, writes the final answer. |
| **Venus** | Perception and self-audit — checks every other brain's work for errors, unsupported claims and safety problems *before* Artemis answers. |
| **Saturn** | Writes, fixes, explains and tests code. |
| **Pluto** | Designs systems: infrastructure, data flows, scaling, cloud architecture. |
| **Neptune** | Deep research: gathers sources, compares evidence, writes cited summaries. |
| **Uranus** | Math, calculation, statistics, step-by-step logical reasoning. |
| **Mercury** | Memory and continuity — remembers users, projects and past decisions. |
| **Mars** | Execution and go/no-go: release checklists, readiness reviews, launch decisions. |
| **Apollo** | Roadmaps, planning, strategy, business direction. |
| **Jupiter** | Images, screenshots, charts and documents; reviews its own interpretation. |
| **Earth** | Voice and conversation: speech in and out, natural spoken answers, tone. |

```bash
python -m artemis.build_brains   # regenerate self-knowledge data, train every designated weight
```

## Repository layout

```
gateway/                 # The Artemis engine (Python)
├── artemis/             #   model, training, corpus, inference, chat, orchestrator, business
├── brains/              #   orchestrator + 10 specialist definitions (YAML)
├── configs/             #   engine.yaml, models.yaml, business.yaml
└── tests/               #   26 pytest modules
artemis-cli/             # Terminal coding agent + API server (TypeScript / Bun / Ink)
artemis2/                # Bootstrap self-improvement loop (LoRA over a third-party base)
artemis-data/            # Runtime data: conversations, knowledge, logs (seed files tracked)
site/                    # Static sites — Cutline marketing + /artemisai product site
pipeline/                # Artemis ingest service (systemd unit, watcher, upload)
api/                     # Serverless API entrypoint
infra/                   # AWS skeleton configs
docs/                    # Architecture, training, inference and business documentation
```

`inbox/`, `shorts_out/` and `uploaded/` are runtime I/O, tracked only as placeholders.

## Quick start

### Gateway (the Artemis API server)

```bash
cd gateway
pip install -r requirements.txt        # add -r requirements-test.txt for the suite
cp .env.example .env                   # server-only config; never ship to a browser bundle
python -m artemis.server               # $PORT, default 8080
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat` · `/v1/chat/stream` | Chat, streaming or buffered |
| `POST /v1/chat/completions` | OpenAI-compatible |
| `GET /v1/models` · `/v1/brains` · `/v1/plans` | Catalogue, brain roster, plan structure |
| `GET`/`POST` `/v1/memory` | Per-account persistent memory |
| `GET /v1/status` · `POST /v1/waitlist` | Health, signup |

`VLLM_BASE_URL` points at your own inference host. `ARTEMIS_ALLOWED_ORIGINS`
gates browser access; the gateway ships credentialed CORS and CSRF
double-submit. No request is forwarded to a third-party model provider.

```bash
python -m artemis.chat_app     # same-origin website gateway: login, histories, static UI
python -m artemis.preflight    # validate production wiring without printing secrets
python -m artemis.smoke_app    # real-deployment smoke check
```

### CLI

```bash
cd artemis-cli && bun install && bun link
artemis serve                  # local server on :7777, OpenAPI docs at /docs
artemis login --key art_...    # defaults to api.artemisai-bycutlineindustries.studio
```

Or from the repo root: `npm run artemis` · `npm run artemis:test`.

TypeScript on Bun (no build step), React + Ink terminal UI, Hono + `bun:sqlite`
backend, OpenAPI 3.1. Context retrieval is **agentic search** — the model drives
`glob`, `grep` and ranged `read_file`. No vector DB, no embeddings, no RAG.
Full reference: [`artemis-cli/README.md`](artemis-cli/README.md).

## Training

The whole path from raw text to a served model. Every step is a module you can
run on its own.

```bash
# 1. Corpus — domain-labelled, permissively licensed
python -m artemis.corpus            # prototype corpus, Artemis's own original text
python -m artemis.code_corpus       # permissively-licensed, domain-labelled code
python -m artemis.stream_corpus     # download → filter → tokenise → delete, one shard at a time
python -m artemis.stream_parallel   # same, every core, without weakening dedup
python -m artemis.prepare_lake      # lake-scale: stream from ADLS Gen2, write token shards back

# 2. Tokenizer + shards (byte-level BPE on Artemis's own corpus)
python -m artemis.pipeline tokenizer --files corpus/*.txt --vocab 32000 --out runs/tok.json
python -m artemis.pipeline prepare  --sources sources.yaml --tokenizer runs/tok.json --out runs/data

# 3. Pretrain from random initialization
python -m artemis.train --size 100m --data runs/data --out runs/100m

# 4. Measure, then specialise
python -m artemis.evaluate          # what each expert actually does, not what it's named
python -m artemis.sft               # supervised chat tuning, provenance enforced at the door
python -m artemis.specialize        # foundation → a specialist brain
python -m artemis.knowledge         # bake self-knowledge into the weights
python -m artemis.teachers          # synthetic SFT from open-weight teachers Artemis may learn from

# 5. Ship
python -m artemis.export            # vLLM layout + each brain adapter in PEFT layout
python -m artemis.infer             # run the checkpoint directly, stream, show expert routing
```

`stream_prepare` gives bounded-memory, bounded-disk, resumable preparation with
byte-offset rollback and SHA-256 dedup. Checkpoints are versioned and migrate
forward ([`checkpoint.py`](gateway/artemis/checkpoint.py)); resume is exact,
including the fp16 loss scale.

### Self-improvement

```bash
python -m artemis.selfplay --checkpoint runs/1b/latest.pt --tokenizer data/tokenizer.json
```

Artemis proposes a solution, a sandbox runs it against the problem's tests, and
**only solutions that actually pass become training data**. A round is kept only
if held-out pass@1 improves; otherwise the weights roll back. Nothing is graded
by opinion — every reward is a test that ran. This trains Artemis's own weights,
so no label exemption is needed.

`artemis2/` is the separate bootstrap variant that trains a LoRA over
Qwen2.5-Coder. Its output is not Artemis's weights, and it says so in the
dashboard and in the header of every file it exports.

### Decision engine

[`engine.py`](gateway/artemis/engine.py) chooses the next training experiment —
UCB over a search space of size, learning rate, code share and warmup fraction,
with a promotion margin a candidate must beat on held-out loss before it
replaces the current model. Ramp stages and budget live in
[`gateway/configs/engine.yaml`](gateway/configs/engine.yaml).

## Runtime capabilities

**Tools** ([`tools.py`](gateway/artemis/tools.py)) — web search, reading a web
page, and running Python in a sandbox. Per-plan, with a daily cap on tool calls.
URL fetching validates that the target is public before connecting.

**Memory** ([`memory.py`](gateway/artemis/memory.py)) — notes saved per account
in the database and retrieved back into the prompt.

**Conversations** ([`conversations.py`](gateway/artemis/conversations.py)) —
protected account and conversation records. SQLite locally, PostgreSQL in
production.

**Durable generation** ([`chat_jobs.py`](gateway/artemis/chat_jobs.py)) —
generation records with a bounded single-process worker pool and replayable
events, so a dropped connection doesn't lose a response.

**Business engine** ([`business.py`](gateway/artemis/business.py)) — plans
(`free`, `plus`, `pro`, `team`, `enterprise`), entitlements, usage limits, API
keys and metering, configured in
[`gateway/configs/business.yaml`](gateway/configs/business.yaml). Artemis's own
model is the product and is never gated away, whatever the config says.

## Tests

```bash
cd gateway && python -m pytest tests/ -q     # engine suite, 26 modules
cd artemis-cli && bun test                   # CLI
npm run verify                               # lint + typecheck + test (Node)
```

None require Postgres.

## Documentation

| Doc | Covers |
|---|---|
| [`docs/PLATFORM.md`](docs/PLATFORM.md) | Full platform architecture |
| [`docs/MODEL-SIZE-AND-BUDGET.md`](docs/MODEL-SIZE-AND-BUDGET.md) | Parameter and token budgets |
| [`docs/MOE-ROUTING-ABLATION.md`](docs/MOE-ROUTING-ABLATION.md) | Routing ablation vs. the matched-compute dense baseline |
| [`docs/PROTO-SPECIALISATION-117M.md`](docs/PROTO-SPECIALISATION-117M.md) | Expert specialisation results |
| [`docs/proto-moe-vs-dense.md`](docs/proto-moe-vs-dense.md) | MoE vs dense at prototype scale |
| [`docs/TRAIN-ON-YOUR-OWN-GPU.md`](docs/TRAIN-ON-YOUR-OWN-GPU.md) | Training on your own hardware |
| [`docs/PRETRAIN-BUDGET-80B.md`](docs/PRETRAIN-BUDGET-80B.md) | Large-run pretraining budget |
| [`docs/INFERENCE.md`](docs/INFERENCE.md) | Serving and inference |
| [`docs/DOMAIN-COVERAGE.md`](docs/DOMAIN-COVERAGE.md) | Corpus coverage across the ten domains |
| [`docs/ARCHITECTURE-AUDIT-14B.md`](docs/ARCHITECTURE-AUDIT-14B.md) | Architecture audit |
| [`docs/TRAINING-HANDOFF.md`](docs/TRAINING-HANDOFF.md) · [`docs/CODEX-HANDOFF-ARTEMIS.md`](docs/CODEX-HANDOFF-ARTEMIS.md) | Training handoffs |

## Configuration

| File | Holds |
|---|---|
| `gateway/.env` | Inference host, database URL, allowed origins, owner account, context/worker sizing |
| `gateway/configs/engine.yaml` | Budget, ramp stages, promotion margin, UCB search space |
| `gateway/configs/models.yaml` | Model sizes and their parameter counts |
| `gateway/configs/business.yaml` | Plans, entitlements, model catalogue, policies |
| `gateway/brains/*.yaml` | Orchestrator and specialist definitions |

## Thermal

Also in this monorepo: turn live-stream heat into monetized Shorts. It lives in
`src/`, `server/`, `scripts/`, `db/`, `apps/`, `public/`, `synthlang/` and
`tools/`, and shares nothing with the Artemis engine above.

```bash
npm install && cp .env.example .env
npm run start                # UI on :5173, Cutline API on :8787
npm run autopilot            # VOD → Shorts; drop .mp4 files in inbox/
npm run ai:pipeline          # faceless Shorts about Thermal/Cutline (pip install edge-tts)
```

Docs: [`docs/THERMAL.md`](docs/THERMAL.md) · [`docs/AI-VIDEO-PIPELINE.md`](docs/AI-VIDEO-PIPELINE.md) · [`docs/GOOGLE-OAUTH.md`](docs/GOOGLE-OAUTH.md) (YouTube + Gmail) · [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md)

Agent tooling — phone approval, voice print, email→Cursor — lives in `tools/`; see [`.cursor/README.md`](.cursor/README.md) and [`docs/CURSOR-PRIMARY.md`](docs/CURSOR-PRIMARY.md).

## Deploy

- **CI:** GitHub Actions on push to `main` — `ci.yml` (Node + Python), `codeql.yml`, `synthlang-pipeline.yml`, `deploy.yml`
- **Staging:** AWS Amplify (`staging.*.amplifyapp.com`)
- **Domains:** `cutline-industries.studio` · `artemisai-bycutlineindustries.studio`

## Secrets (never commit)

| File | Purpose |
|------|---------|
| `gateway/.env` | Artemis gateway server config |
| `.env` | Thermal runtime config |
| `client_secret.json` · `token.json` | Google OAuth client, YouTube + Gmail tokens |
| `tools/*/secrets/` | ntfy pair secret, device tokens |

Production secrets live in Azure Key Vault — never in source, logs, or command
arguments. Artemis never asks you to paste a token into a chat.

## Business docs

PDFs in [`docs/business/`](docs/business/): Blueprint · 4-Week Outreach Plan · Stripe Authorization Letter.

AI Application Card: [`docs/AI-APPLICATION-CARD-BLUEPRINT.md`](docs/AI-APPLICATION-CARD-BLUEPRINT.md) · printable [`docs/ai-application-card-blueprint.html`](docs/ai-application-card-blueprint.html)

---

**Artemis AI**, a product of **Cutline Industries**. Artemis exists because one
architectural decision — never call an external model — was treated as a product
requirement rather than a limitation. Everything else followed from it.
