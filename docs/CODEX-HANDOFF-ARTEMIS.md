# Artemis — handoff for Codex

Written 2026-10-19. Everything here was verified by running it, not inferred.
Where something is unverified or blocked, it says so.

## Read this first: how to get credentials

**No secret values are in this file, and none should be added.** This repo is
PUBLIC (`github.com/lpittman-g/Cutline-Industries`). A key committed here is
published to the internet and picked up by scanners within minutes.

Every secret Artemis uses is retrievable with a command, as the authenticated
owner. Run these yourself; do not ask a human to paste anything.

| secret | how to get it |
| --- | --- |
| Azure AI Services key (gateway's model backend) | `az cognitiveservices account keys list -g rg-lamontpittman-2247 -n lamontpittman-8317-resource --query key1 -o tsv` |
| Azure AI endpoint | `az cognitiveservices account show -g rg-lamontpittman-2247 -n lamontpittman-8317-resource --query properties.endpoint -o tsv` |
| gateway DB password + all runtime env | on the VM: `sudo cat /etc/artemis-chat.env` (root, 0600) |
| gateway SSH | **not usable from a Claude Code container** — see "Access" below |

### Credentials that are COMPROMISED and must be rotated

These passed through a chat transcript during the session that produced this
handoff. Treat every one as public. None is required to operate the system —
the commands above supersede them.

1. **`artemisai2` GitHub App private key** — grants repo access. Revoke at
   Settings → Developer settings → GitHub Apps → artemisai2 → Private keys.
   **Highest priority; still not done.**
2. **Azure AI Services key1 and key2** on `lamontpittman-4876-resource`.
   Regenerate: `az cognitiveservices account keys regenerate -g rg-lamontpittman-5208 -n lamontpittman-4876-resource --key-name Key1`
3. **`artemis_chat` Postgres password** — printed to stdout by an earlier
   version of `setup-vps-gateway.sh` (that bug is fixed in commit `7178df3`).
4. **A Gemini API key** (`AQ.Ab8RN6...` prefix) — revoke in Google AI Studio.
5. **Three SSH private keys** (one ed25519, two RSA) for the VMs.
6. **The Nebius S3 static key `accesskey-e00zdh5pd3q0dcjxy4`
   (`artemis-train-sync`)** — sits in plaintext inside the `artemis-8gpu`
   instance's cloud-init, and `nebius iam v2 access-key list` returns its
   secret to anyone who can read the project. Already `INACTIVE`, so the
   exposure is spent rather than live, but it must not be re-created the same
   way; see blocker 3.

## Current state, verified

### Gateway — LIVE

```
https://api.artemisai-bycutlineindustries.studio/api/health
  -> {"ok": true, "queued": 0, "generating": 0}        HTTP 200, TLS valid
http:// -> 301 https://
```

```
host        Vm, 40.90.251.232, Ubuntu 24.04 x86_64, Standard_F2amds_v7
rg          RG-LAMONTPITTMAN-2247   region eastus2
services    artemis-chat, nginx, postgresql  — all active
app dir     /opt/artemis-chat   owner artemis:artemis
env         /etc/artemis-chat.env   root, 0600
cert        Let's Encrypt, expires 2027-01-16, auto-renew scheduled
NSG         Vm-nsg — 22, 80, 443 open from *
```

`/api/status` currently reports:

```json
{"serving": true, "status": "available", "model": "artemis-bootstrap",
 "provider": "azure-ai-services", "quality": "not-artemis", "bootstrap": true}
```

**`quality: "not-artemis"` is correct and must stay correct.** The gateway is
serving `gpt-4.1-mini` through `AzureAIBackend`, which `backends.py` documents
as "THIS IS NOT ARTEMIS". It exists so the orchestrator, ten experts, tools and
decision engine can be exercised while the real model is trained. Every reply
carries `external: True`. Do not remove those markers, and do not describe the
product as running on Artemis's own weights until a real checkpoint is served.

### Azure — which account, and the one that is dead

**USE THIS ONE:**
```
tenant        df0f27e4-b313-498d-97ff-8792f6fb80d4  (CutlineIndustries1.onmicrosoft.com)
user          LamontPittman@CutlineIndustries1.onmicrosoft.com   Owner
subscription  6b812355-4bfc-4948-92ea-caf3ee5579de  "Azure subscription 1"   Enabled
              52056bc2-3eb2-437d-95e7-36d360871ea7  "Subscription 1"  Enabled but ZERO compute quota
```

**DO NOT USE — all three subscriptions DISABLED for billing:**
```
tenant 994d61e4-75f2-425a-842e-92e59d1c719b   (the original CUTLINE tenant)
  8c9ca5bc-42af-4265-aced-f30f37738ea8
  bd193cb1-661c-44cc-bb7f-04d545296da8
  65c3f7b2-285e-47e3-84fe-2c77c16ad301   <- held the OLD gateway, cutline-vps
```
Every write returns `ReadOnlyDisabledSubscription`. All seven VMs there were
deallocated by Azure. **The old gateway's OS disk and the Key Vault
`artemis-kv-6b22c1` secrets are locked inside and cannot be recovered until a
human clears the billing invoice.** The new gateway therefore has FRESH
credentials, not the originals.

Note: `az account show` reports the *cached* profile and said "Enabled" for a
disabled subscription. Always verify against the live API:
`az rest --method get --url "https://management.azure.com/subscriptions/<id>?api-version=2022-12-01"`

### Resources on the live subscription

```
rg-lamontpittman-2247   Vm (gateway, running)
                        lamontpittman-8317-resource (AI Services)
                          deployment: artemis-bootstrap = gpt-4.1-mini 2025-04-14
                        artemis (AKS cluster, state Creating — see Blockers)
rg-lamontpittman-5208   lamontpittman-4876-resource (AI Services, NO deployments)
Nvida2_group            Nvida2 — DEALLOCATED. Standard_F2amds_v7, NO GPU despite
                        the name. Cannot train. Deallocated to stop billing.
```

## Access: this container cannot SSH

**Proven, not assumed:** outbound SSH is blocked. `github.com:22` times out
identically to the VMs; port 443 to the same VM is open. Only HTTPS egress
works.

**Drive the VM through the Azure control plane instead:**

```bash
az vm run-command invoke --subscription 6b812355-4bfc-4948-92ea-caf3ee5579de \
  -g RG-LAMONTPITTMAN-2247 -n Vm --command-id RunShellScript \
  --scripts 'systemctl is-active artemis-chat'
```

Two practical limits found by hitting them:
- **Long payloads fail** with `Connection reset by peer`. Keep scripts short;
  have the VM `curl` longer scripts from the public repo instead.
- **`az vm create` is broken in this environment** —
  `RuntimeError: The content for this response was already consumed`, with and
  without `--no-wait`. Individual resource creates work. Use an ARM template via
  `az deployment group create` instead; that path works.

## Training — the model that does not exist yet

There is **no trained Artemis checkpoint**. The gateway serves an external
model because there is nothing else to serve.

### The pipeline is ready and correct

```
scripts/train/rent-gpu-run.sh          provider-agnostic single-GPU bootstrap
scripts/train/stages.sh                stage 1 pretrain / sft / stage 2 selfplay
scripts/train/proto-routing-ablation.sh
scripts/train/proto-label-ablation.sh
gateway/artemis/code_corpus.py         licence filter + domain labelling
gateway/configs/models.yaml            100m / 1b / 3b / 8b definitions
```

Run `100m` first — ~3.0B tokens, ~1.4 h on one H100, about **$4**. It proves
the licence filter, tokenizer, domain labels and training loop before the `1b`
rung costs 88 hours.

### Settled by experiment — do not relitigate

`docs/MOE-ROUTING-ABLATION.md` has the full write-up. Five matched arms sharing
one token stream, seed and schedule:

| arm | val | eff. experts | dead |
| --- | --- | --- | --- |
| `moe-unsup` route_coef 0 | **3.5732** | 8.03 | 0 |
| `moe-wide` 7 labels + build | 3.6115 | 2.05 | 7 |
| `dense` | 3.6222 | — | — |
| `moe-sup` 3 labels + build | 3.6222 | 1.35 | 7 |
| `moe-nores` 7 labels, no build | 3.6624 | 3.01 | 4 |

- **Routing supervision costs ~0.046 val loss and kills 7 of 10 experts.**
  `stages.sh` now defaults `ROUTE_COEF=0` (commit `c096a73`). Keep it there.
- The MoE architecture **beats** matched-compute dense by ~0.046 once the
  router is unsupervised. The original "dense wins" conclusion was measured
  with `domain_labels: false`, so the mechanism under test was switched off.
- **Expert utilisation is not a proxy for quality.** `moe-nores` improved every
  routing metric and got the worst validation loss. The damage shows in
  `lm_loss`: supervision competes with next-token prediction for the same
  gradient.
- Thin labels never earn an expert. `security` 1.1%, `cost` 0.8%,
  `observability` 0.6%, `deploy` 0.2% of tokens all stayed at 0.000 load under
  top-2 routing.

Limits that still apply: proto scale (5.9M active, seq 256), 1.7 tokens per
active parameter against a Chinchilla 20, 108k validation tokens, and
`intent`/`architecture`/`planning` unlabelled because source code cannot
evidence them.

## Blockers — each needs a human, with the reason

1. **GPU quota. Azure refused it.** I registered `Microsoft.Quota`, found the
   correct resource names, and submitted both requests via the API:
   ```
   Standard NCASv3_T4 Family -> 4    Failed — "Request failed."
   cores (regional)          -> 24   Failed — "Request failed."
   ```
   No reason given. Even the non-GPU `cores` raise was refused, so the
   subscription appears restricted from automated increases. Every usable GPU
   family reads `0/0`; the only non-zero families are NC/NV (K80/M60), which
   modern PyTorch cannot use.
   **The Azure route is now closed, definitively.** Quota tickets are free in
   the portal, but the Support *API* is gated behind a paid support plan. The
   async operation returns:
   ```
   InvalidSupportPlan: Your support plan type is Free. To create and update
   support tickets ... you need access to our high tier-support plans.
   ```
   A PUT to `supportTickets` answers 202 and then fails at validation, so the
   202 means nothing — poll `azure-asyncoperation` or the ticket silently never
   exists. Nothing in this container can raise Azure GPU quota. A human must
   either file the ticket in the portal or buy a support plan.

   The quota API itself has now refused **three** requests, including the
   smallest one Azure could possibly grant, so do not retry it in a new shape:
   ```
   Standard NCASv3_T4 Family -> 4   eastus    Failed — "Request failed."
   cores (regional)          -> 24  eastus    Failed — "Request failed."
   Standard NCASv3_T4 Family -> 4   eastus2   Failed — "Request failed."
   ```
   The third was deliberately minimal: `Standard_NC4as_T4_v3` is 4 vCPUs with
   one whole T4, eastus2 has all 10 of its regional vCPUs free, and that SKU is
   unrestricted there — so it needed *one* family limit moved 0 → 4 and no
   regional increase at all. Still refused, with no reason given.

   Two facts rule out the usual explanations. The subscription is healthy:
   `quotaId: PayAsYouGo_2014-09-01`, `state: Enabled`, `spendingLimit: Off` —
   not a free trial. And the hardware is *offered*: `az vm list-skus` shows
   A100, H100, A10 v5 and T4 SKUs with no `restrictions` entry in most regions
   (only GermanyWestCentral and westeurope are `NotAvailableForSubscription`
   for T4). Every modern GPU family simply sits at limit 0, and automated
   increases are refused — which for GPU families is Azure's normal posture on
   a young subscription. The portal's quota flow files the free support ticket
   that gets human review; that is the only route.

   Also worth knowing before planning any Azure GPU run: **the regional vCPU
   cap is 10 in every region checked** (eastus 8/10 used, all others 0/10), so
   anything past a single small card needs that raised too. A full A10 is
   `NV36ads_A10_v5` at 36 vCPUs; the fractional `NV6ads_A10_v5` is 1/6 of a
   card. The only modern GPU that fits under a 10-vCPU cap is
   `Standard_NC4as_T4_v3`.

2. **Nebius: abandoned by decision, 2026-10-19.** It was the closest thing to
   working — an 8xH100 SXM instance `computeinstance-e00hf3ff9c9d3g63z1`
   (`artemis-8gpu`, project `project-e00yn51ypr007sqnbn1x9t`, eu-north1) was
   already built and bootstrapped to run stage 1 from `origin/main` on boot,
   with capacity confirmed on-demand 1/1 AVAILABILITY_HIGH. The tenant is
   nonetheless barred from creating or starting billable compute:

   - `instance start` and a fresh `instance create` in a *different* region and
     project both return `PermissionDenied`, so it is not instance- or
     region-specific.
   - It is not RBAC. The service account has been in the tenant `admins` group
     since 2026-10-11, and that group holds `admin`, `editor` and
     `compute.instance-power-operator` on the tenant itself. Reads work, IAM
     writes work, and `instance stop` on the same instance in the same region
     succeeded and bumped `resource_version`.
   - Only operations that *begin* billing are refused, on a tenant whose log
     bucket also reads `suspension_state: SUSPENDED`. That is a billing hold.

   Do not spend time on roles, regions or quota here. The decision is to use
   Vast.ai instead; this entry exists so nobody re-derives the diagnosis.

   **One loose end that can cost money.** That instance still exists, stopped,
   with a 2000 GiB NETWORK_SSD boot disk attached. Storage normally bills while
   an instance exists, stopped or not. Nothing appears to be accruing while the
   hold is in force, but if the hold is ever cleared the disk starts billing
   immediately — and nobody will be watching, because this path is abandoned.
   Delete it in the console, or:
   `nebius compute instance delete --id computeinstance-e00hf3ff9c9d3g63z1`
   (the MCP server in use refuses commands containing "delete", so this one is
   a human or a direct CLI call). The same applies to the `artemis-train-logs`
   bucket and the two `artemis-train-*` projects.

3. **What Nebius did prove, and Vast now provides.** `nebius compute instance
   logs` returned serial console and journald over plain HTTPS — the readback
   this container never had on Azure, and the absence of which cost six days to
   a misdiagnosed "sshd problem" that was really a powered-off VM plus a
   container with no outbound SSH at all. Any future provider should be judged
   partly on whether it offers that. On Vast the equivalent is the instance's
   own log endpoint plus the journal written by the onstart script, which is why
   `vast-rent.sh` sends everything through `tee` to a log file.

4. **When the run does start, two numbers are worth knowing.** At 100m with
   `batch 6 x accum 4 x seq 2048` on ONE GPU, tokens/step is 49,152 and a
   single pass over the 43-shard, 3.03B-token pool is 61,589 steps. On eight
   GPUs tokens/step is 393,216 and the same pass is 7,698 steps — holding STEPS
   fixed across GPU counts multiplies the tokens trained, and the bill, by the
   GPU count. `rent-gpu-run.sh` derives STEPS from SHARDS for exactly this
   reason. And `ROUTE_COEF=0`: see docs/MOE-ROUTING-ABLATION.md, where a full
   shard measures 77.3% of documents carrying no real label, `test` and
   `memory` holding 93% of the genuine ones, and `intent`/`architecture`/
   `planning` permanently empty.

5. **AKS cluster `artemis` is provisioning and probably should not exist.**
   It was started from the portal. AKS Automatic needs ~12 vCPUs; regional
   quota is 10 with 4 used. It may fail on quota, leaving ACR, namespace and
   federated credentials behind. It costs roughly $300–500/month against the
   gateway's ~$30, and it does not solve training — Kubernetes does not conjure
   GPUs. **Decide: finish it or tear it down.** If torn down, remove
   `MC_rg-lamontpittman-2247_artemis_eastus` too.

6. **CUTLINE billing invoice** — the only route to the old Key Vault secrets
   and the old gateway disk.

7. **GitHub repo move to `lpittman-blip`** — requested but not done. Needs the
   account connected at https://claude.ai/connect-github and the repo created
   there; repo creation is not a repository-scoped call and is blocked from an
   agent session. **12 files hardcode the old URL**; three break operationally
   if the old repo disappears:
   ```
   infra/azure/setup-vps-gateway.sh:48   REPO_URL — gateway re-run clones this
   scripts/train/rent-gpu-run.sh:34      REPO_URL — training launcher clones this
   server/missionControlStatus.ts:60     REPOSITORY_URL — shown in the app UI
   ```
   The VM also fetches its bootstrap script from
   `raw.githubusercontent.com/lpittman-g/...`.

## Bugs fixed this session — context for why the code looks as it does

Each was found by running the thing, not reading it.

| commit | bug |
| --- | --- |
| `e992851` | `useradd -r` without `-U` left the service account in `users` (gid 100), aborting setup AND leaving `/opt/artemis-chat` group-readable by every user |
| `7178df3` | setup script echoed the generated DB password to stdout, into logs and `run-command` output |
| `c096a73` | `stages.sh` never passed `--route-coef`, so real runs used 0.1 — the setting two ablations measured as worse |
| `4a046b1` | six files named the dead gateway IP, including `sync-secrets.sh`'s `SSH_TARGET` — a secrets push aimed at a decommissioned host |
| `e62848f` | launcher's cost estimate derived from corpus size, not step budget; quoted 83 h for a 26 h run |
| `0186249` | ablation skipped an interrupted arm instead of resuming it, which would have compared a half-trained arm against full ones |

Recurring pattern worth watching: **a wrapper that owns a run must pass the
values it is responsible for.** `STEPS`, `WARMUP` and `ROUTE_COEF` were each
left to a default the wrapper could not see.

## Next executable work, in order

1. **Get a GPU. Vast.ai is the chosen route; Nebius is abandoned by decision,
   Azure by exhaustion.** Two human steps, about five minutes, and neither can
   be done from a container because both need a payment instrument and a
   verified email:

   - `cloud.vast.ai/billing/` → add credit. ~$20 is ample; the whole 100m run
     is $3–5. **Do not save a card** if you want a hard ceiling: prepaid credit
     with no card on file is the only spending limit on this platform that
     cannot be defeated by software (see `scripts/train/vast-limits.sh`).
   - `cloud.vast.ai/manage-keys/` → create a key, preferably scoped:
     `vastai create api-key --name artemis-train --permission_file
     infra/vast/api-key-permissions.json`. The console's +New button mints a
     FULL-ACCESS key, which can move credit and mint more keys; the scoped one
     cannot. Supply it to automation as an environment secret, never as a
     command argument or pasted into a transcript.

2. **Run it.** `VAST_API_KEY=... bash scripts/train/vast-rent.sh --preflight`
   prices the cheapest eligible offer and spends nothing. Drop `--preflight` to
   rent, train and destroy. The box self-destructs on completion, a watchdog
   caps it at MAX_HOURS, and the script tears down on success, failure, timeout
   and Ctrl-C. Afterwards, confirm what it actually cost:
   `bash scripts/train/vast-limits.sh --charges 7`.

   **Cheapest $/hr is not cheapest $/run.** Measured on the live market
   2026-10-19: RTX 3090 $0.170/hr ≈ 26h ≈ $4.46; A100 40GB $0.483/hr ≈ 6h ≈
   $2.88; H100 $2.206/hr ≈ 1.9h ≈ $4.15. Prefer the A100
   (`GPU_QUERY='gpu_name=A100_SXM4'`) and set MAX_HOURS to ~12 so the watchdog
   ceiling stays near $6 instead of $17.

   **On owned hardware instead, this is free and no account is needed.**
   `WORK=$HOME/artemis-work REPO_DIR=$HOME/artemis-src RATE_PER_HOUR=0 bash
   scripts/train/rent-gpu-run.sh --preflight` checks GPU, VRAM, disk and
   torch/CUDA and prints hours derived from the detected card. Needs ~150 GiB
   free; lower SHARDS to shrink it.
3. **Serve the checkpoint** — set `ARTEMIS_CHECKPOINT` + `ARTEMIS_TOKENIZER` in
   `/etc/artemis-chat.env` and remove `ARTEMIS_BOOTSTRAP_AZURE`. Precedence in
   `server.py:build_app()` is `VLLM_BASE_URL` → `ARTEMIS_CHECKPOINT` →
   `ARTEMIS_BOOTSTRAP_AZURE` → `NotReadyBackend`. **A non-empty
   `VLLM_BASE_URL` silently wins over everything below it** — that cost an hour
   this session; the setup script wrote `http://127.0.0.1:8000` for a vLLM that
   was never installed, so the gateway chose a dead backend and reported
   `serving: false`.
4. **Rotate the five compromised credentials.**
5. **Resolve AKS**, and the repo move if still wanted.

## Do not

- Put secret values in this repo. It is public.
- Report `ready` from an accepted provisioning request. `{"ok": true}` from the
  gateway means the gateway is healthy, not that Artemis can answer.
- Call the current deployment "Artemis". It is `gpt-4.1-mini` behind a backend
  explicitly labelled not-artemis.
- Wire any external LLM into product code or Artemis decisions. Blueprint
  Decisions 5 and 12. `gateway/artemis/teachers.py` enforces the training-data
  side with a licence allowlist; `AzureAIBackend` is the one sanctioned
  exception and is gated behind an explicit flag.
