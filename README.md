# Cutline Industries Platform

Public site: [cutline-industries.studio](https://cutline-industries.studio)  
Company email: lpittman@cutline-industries.studio

This repository is the **full Cutline Industries monorepo**. It holds two products:

| Product | What it is | Lives in |
|---|---|---|
| **Artemis** | A self-hosted AI engine for software delivery — a mixture-of-experts transformer trained in-house, an inference gateway, and a terminal coding agent. Never calls an external model provider. | `gateway/` · `artemis-cli/` · `artemis2/` · `site/artemisai/` |
| **Thermal** | Turn live-stream heat into monetized Shorts — web app, VOD autopilot, and AI video pipeline. | `src/` · `server/` · `scripts/` · `db/` |

They share this repo, the Express API, and the business/infra tooling below.

## Repository layout

```
├── gateway/              # Artemis engine (Python): model, training, corpus, inference server
│   ├── artemis/          #   model.py, train.py, corpus pipeline, chat app, orchestrator
│   ├── brains/           #   planet-named orchestrator + specialist brain configs (YAML)
│   ├── configs/          #   engine, model catalogue, business config
│   └── tests/            #   pytest suite (training, corpus, chat, FSDP, tools)
├── artemis-cli/          # Artemis CLI — terminal coding agent (TypeScript/Bun + Ink) and API server
├── artemis2/             # Bootstrap self-improvement loop (LoRA over a third-party base model)
├── artemis-data/         # Artemis runtime data: conversations, knowledge, logs (seed files only)
├── src/                  # Thermal public site + Mission Control UI (/app)
├── server/               # Express API, Autopilot, AI video pipeline
├── site/                 # Static sites — Cutline marketing + /artemisai product site
├── apps/                 # Standalone side apps (e.g. data-detective)
├── api/                  # Serverless API entrypoint
├── pipeline/             # Artemis ingest service (systemd unit, watcher, upload)
├── scripts/              # Trend radar, AI scripts, AWS helpers, SynthLang verify
├── synthlang/            # Autonomous CI/autopilot config
├── tools/
│   ├── phone-approval-lite/    # Default: ntfy + /approve (no Apple Developer)
│   ├── phone-approval-apple/   # Archived — not used
│   ├── voice-print/            # Chat `print` → HP OfficeJet (local PC)
│   └── email-to-cursor/        # Email → Cursor Cloud Agent bridge
├── docs/                 # Product, training, pipeline, and business documentation
├── infra/                # AWS skeleton configs
├── db/                   # Thermal Postgres migrations
└── public/               # Static assets
```

`inbox/`, `shorts_out/` and `uploaded/` are runtime I/O directories, tracked only as placeholders.

See [`docs/PLATFORM.md`](docs/PLATFORM.md) for the full architecture.

**Workstreams** (keep separate): [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md) — A = Gaming/Thermal · B = Cursor AI layer / print / Excel MCP.

## Quick start — Thermal web + API

```bash
npm install
cp .env.example .env
npm run start          # UI + API
```

| URL | Purpose |
|-----|---------|
| http://127.0.0.1:5173 | Thermal site + `/os` command center |
| http://127.0.0.1:8787 | Cutline API |

## Quick start — Artemis

### Engine and gateway (Python)

```bash
cd gateway
pip install -r requirements.txt       # add -r requirements-test.txt to run the suite
cp .env.example .env                  # server-only config; never ship to a browser bundle
python -m artemis.server              # serves on $PORT (default 8080)
```

The gateway is server-side only. `VLLM_BASE_URL` points it at your own inference
host, `ARTEMIS_ALLOWED_ORIGINS` gates browser access, and no request is ever
forwarded to a third-party model provider.

### Architecture in one line

A dense decoder-only **Prime Core**, plus ten additively-routed expert FFNs —
one per stage of software delivery. The names live in
[`gateway/artemis/model.py`](gateway/artemis/model.py) as `EXPERT_NAMES`:

```
intent · architecture · planning · build · test
deploy · memory · security · observability · cost
```

Separately, `gateway/brains/*.yaml` configures the planet-named orchestrator
and specialist brains that route a request across those capabilities.

### CLI (TypeScript / Bun)

```bash
npm run artemis        # bun --cwd artemis-cli run src/cli.tsx
npm run artemis:test   # bun --cwd artemis-cli test
```

Details and the API-server reference: [`artemis-cli/README.md`](artemis-cli/README.md).

### Training and model docs

| Doc | Covers |
|---|---|
| [`docs/TRAIN-ON-YOUR-OWN-GPU.md`](docs/TRAIN-ON-YOUR-OWN-GPU.md) | Running a training job on your own hardware |
| [`docs/MODEL-SIZE-AND-BUDGET.md`](docs/MODEL-SIZE-AND-BUDGET.md) | Parameter/token budgets |
| [`docs/MOE-ROUTING-ABLATION.md`](docs/MOE-ROUTING-ABLATION.md) | Routing ablation vs. a matched-compute dense baseline |
| [`docs/PROTO-SPECIALISATION-117M.md`](docs/PROTO-SPECIALISATION-117M.md) | Expert specialisation results |
| [`docs/INFERENCE.md`](docs/INFERENCE.md) | Serving and inference |

## Checks

```bash
npm run verify                     # lint + typecheck + test (Node)
npm run lint                       # oxlint
npm run typecheck                  # tsc -b --noEmit
npm test                           # node --test

cd gateway && python -m pytest tests/ -q    # Artemis engine suite
```

None of these require Postgres.

## Content pipelines (Thermal)

### VOD Autopilot (gameplay → Shorts)

Drop `.mp4` files in `inbox/`:

```bash
npm run autopilot          # continuous
npm run autopilot:once     # one pass
```

### AI video pipeline (Thermal project Shorts)

Creates faceless Shorts about Thermal/Cutline — no VOD required:

```bash
pip install edge-tts
npm run ai:pipeline:once
npm run ai:pipeline
```

Public audience input: `/feedback` on the site.

Docs: [`docs/AI-VIDEO-PIPELINE.md`](docs/AI-VIDEO-PIPELINE.md)

## Google OAuth — YouTube + Gmail (one-time)

Full guide: [`docs/GOOGLE-OAUTH.md`](docs/GOOGLE-OAUTH.md)

1. OAuth client → `client_secret.json`
2. Enable **YouTube Data API v3** and **Gmail API** on project `utility-mapper-504300-d6`
3. Set `GOOGLE_CLOUD_PROJECT` + `GOOGLE_WORKSPACE_SENDER_EMAIL` in `.env`
4. Authorize YouTube + `gmail.send` scopes (Playground or Autopilot **Open OAuth**) → save `token.json`
5. AI Shorts default to **public** (`CUTLINE_AI_PRIVACY=public`)

| Secret / config | Purpose |
|-----------------|---------|
| `client_secret.json` | OAuth client ID + secret |
| `token.json` | Refresh/access tokens after authorization |
| `GOOGLE_CLOUD_PROJECT` | GCP project id |
| `GOOGLE_WORKSPACE_SENDER_EMAIL` | Gmail from-address |

## Agent tools (Cursor primary)

**Setup:** [`.cursor/README.md`](.cursor/README.md) · [`docs/CURSOR-PRIMARY.md`](docs/CURSOR-PRIMARY.md) · [`docs/COPILOT-VS-CURSOR.md`](docs/COPILOT-VS-CURSOR.md)

Open this repo in **Cursor** — Copilot/VS Code optional.

| Tool | Path | Purpose |
|------|------|---------|
| Phone approval | `tools/phone-approval-lite/` | ntfy push + `/approve` — MCP in Cursor |
| Voice print | `tools/voice-print/` | Chat **`print`** → HP OfficeJet (local PC) |
| Email → Cursor | `tools/email-to-cursor/` | Email triggers Cloud Agent runs |
| SynthLang CI | `.github/workflows/synthlang-pipeline.yml` | Lint, typecheck, test, build |

## Deploy

- **CI:** GitHub Actions on push to `main` — `ci.yml` (Node + Python), `codeql.yml`, `synthlang-pipeline.yml`, `deploy.yml`
- **Staging:** AWS Amplify (`staging.*.amplifyapp.com`)
- **Production domain:** `cutline-industries.studio` (Route 53 + Amplify — DNS cutover pending)
- **Artemis product site:** `artemisai-bycutlineindustries.studio`

## Business docs

PDFs in [`docs/business/`](docs/business/):

- Cutline Industries Blueprint
- 4-Week Outreach Plan
- Stripe Authorization Letter

AI Application Card (Cursor primary): [`docs/AI-APPLICATION-CARD-BLUEPRINT.md`](docs/AI-APPLICATION-CARD-BLUEPRINT.md) · printable [`docs/ai-application-card-blueprint.html`](docs/ai-application-card-blueprint.html)

## Secrets (never commit)

| File | Purpose |
|------|---------|
| `.env` | Runtime config (root) |
| `gateway/.env` | Artemis gateway server config |
| `client_secret.json` | Google OAuth client ID + secret |
| `token.json` | YouTube + Gmail refresh/access tokens |
| `tools/*/secrets/` | ntfy pair secret, device tokens |

Production secrets belong in Azure Key Vault — never in source, logs, or command arguments.

## Brand

**Cutline Industries** builds **Artemis** — AI for software delivery that never sends your code to someone else's model — and **Thermal** — stream heat → Shorts → cash.
