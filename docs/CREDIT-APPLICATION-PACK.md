# Startup credit application pack — Cutline Industries / Artemis

Prepared 2026-10-23. Paste these answers into the forms. Everything here is
true as of today — nothing is inflated. If a form asks something not covered,
answer it plainly rather than guessing upward.

---

## IMPORTANT: what I verified, and what I got wrong

I checked all four programs' **own** pages. Result: **none of them publish the
tier breakdown.** They show only headline maximums:

| Program | What its official page actually says |
|---|---|
| Microsoft for Startups | "up to $150,000 in credits" — no tiers, no eligibility list, no FAQ answer |
| AWS Activate | "up to $200,000" — no tiers, no eligibility criteria stated |
| Google for Startups Cloud | page content truncated; no figures retrievable |
| NVIDIA Inception | no cash figure at all; benefits + eligibility **are** published (below) |

**So the "$5,000 without a referral" number is unverified, and it should not
stand as firm.** It came from third-party blogs that contradict each other
($1,000 vs $5,000 for AWS; $2,000 vs $25–50k for Google). Your actual tier is
determined *inside* the application, from your answers — no public page states
it in advance.

What this does **not** change: applying is free, takes under an hour each, and
carries no equity. The uncertainty is about *how much*, not *whether*. But plan
on "some GPU, amount unknown until I apply," not "1,360 A100-hours."

The one number to treat as solid: **NVIDIA Inception membership is free, with
no application fee, no membership fee, and no equity requirement.**

---

## NVIDIA Inception — apply here first

Official eligibility, from nvidia.com/en-us/startups:
- Has a working website and **is officially incorporated**
- Less than 10 years old
- Clear use case for NVIDIA technology
- Actively operated by at least one founder
- Revenue not required; funding stage not required; you need not already be
  using NVIDIA GPUs or SDKs
- **Disqualified:** consulting/outsourced dev firms, crypto companies, cloud
  service providers, resellers/distributors, public companies

Both sites return HTTP 200, so the website criterion is met.
No deadlines or cohorts — apply any time.

Benefits: free cloud credits from NVIDIA and partners, preferred pricing on
hardware/software, SDKs and model libraries, training courses, and
Inception Capital Connect (VC introductions, eligibility-based).

It asks for a **pitch deck** and funding status.

### Draft answers

**Company name:** Cutline Industries

**Website:** https://cutline-industries.studio
**Product site:** https://artemisai-bycutlineindustries.studio

**Funding status:** Bootstrapped / pre-seed. No outside capital raised to date.

**What does your company do? (short)**
> Cutline Industries builds Artemis, a privately-hosted AI engine for software
> delivery. Artemis automates the parts of the software lifecycle that consume
> engineering time — triaging CI failures, reviewing deploys, and analysing
> build and infrastructure cost — and runs entirely inside the customer's own
> infrastructure. Source code never leaves the customer's environment and is
> never sent to a third-party model provider.

**What is your clear use case for NVIDIA technology?**
> Artemis is a mixture-of-experts transformer we train ourselves from scratch:
> a dense decoder-only core with ten additively-routed expert feed-forward
> networks, each specialised to one stage of software delivery (intent,
> architecture, planning, build, test, deploy, memory, security,
> observability, cost).
>
> We have trained and evaluated a 153M-parameter checkpoint to its
> compute-optimal (Chinchilla) token budget, with a matched-compute dense
> baseline and a routing ablation, to validate the architecture. That run was
> executed on free Tesla T4s, which is the binding constraint on the project:
> T4 is Turing, so it has no native bfloat16, and 16GB of VRAM caps us at a
> ~150M-parameter model.
>
> Our next milestone requires Ampere or newer. Specifically we need:
> - **bf16 tensor cores** (compute capability ≥ 8.0) for numerically stable
>   training without loss-scaling, on A100 or H100
> - **multi-GPU interconnect** to run our FSDP sharded training path, which is
>   implemented against PyTorch `fully_shard` but not yet validated on real
>   GPUs
> - **TensorRT / Triton** for quantised inference serving, since our product is
>   self-hosted and inference cost per customer is a core margin driver
>
> Access to A100-class GPUs is the difference between a 153M research artifact
> and a 1–3B production model.

**Pitch deck:** docs/artemis-deck.pdf in this repo (file 3 below).

---

## Microsoft for Startups Founders Hub

Eligibility (**re-verify on the form itself** — Microsoft's public page states
none of it):
- Own a software product ✅ (Artemis)
- Privately held, for-profit ✅
- Not an educational institution, government body, consultancy, or agency ✅
- Under $350,000 in lifetime free Azure credits ✅ (none taken)
- Not Series C or later ✅

**Flag:** one Microsoft Q&A thread reported a $25k account's credits expiring
with no extension granted. Credits are time-boxed. Do not start the clock until
the corpus skew is fixed and the bf16 bug in `train.py` is patched, or you will
burn the window preparing instead of training.

### Draft answers

**What are you building?**
> Artemis — a self-hosted AI engine for software delivery. It automates CI
> failure triage, deploy review, and build/infrastructure cost analysis. Its
> defining constraint is architectural: Artemis never calls an external model
> provider. Customer source code stays inside customer infrastructure. We train
> our own mixture-of-experts transformer on permissively-licensed code and the
> customer's own build telemetry.

**What problem does it solve?**
> Engineering teams lose hours per week to CI failures that are mechanical to
> diagnose but tedious to trace. The existing tools that automate this send
> source code and build logs to a third-party LLM API, which is a non-starter
> for regulated industries, defence suppliers, and anyone with source-code
> escrow obligations. Artemis does the same work with no external egress.

**Stage:** Pre-revenue. Working prototype; architecture validated by a trained
and evaluated checkpoint with a matched-compute baseline and routing ablation.

**How will you use Azure?**
> GPU compute for model training (NC/ND-series, A100-class), Azure Key Vault
> for secret management (already in use), and App Service / VM hosting for the
> inference gateway, which is already deployed and serving a hardened streaming
> chat API.

**Team size:** 1

---

## AWS Activate

- Self-funded "Founders" tier needs **no** investor, accelerator, or incubator
  affiliation
- Higher tiers require an **Activate Provider Org ID** from an affiliated
  accelerator/VC/incubator — a concrete reason to apply to NVIDIA Inception and
  accelerators first, since affiliation can unlock the larger tier
- Official page states only "up to $200,000"

Reuse the Microsoft answers above. AWS additionally asks for your **AWS account
ID**, so create the account first if you don't have one.

---

## Google for Startups Cloud Program

- Start tier is for bootstrapped / pre-seed with no equity funding — that's you
- Larger AI tiers require **verifiable equity funding** (SAFEs count; angel
  money and grants do not), so the large tier is closed to you today
- Amount for the bootstrapped tier is genuinely unclear: sources say both
  "$2,000 over two years" and "$25,000–50,000"

Reuse the Microsoft answers.

---

## Verified application URLs (checked 2026-10-23)

| Program | URL | Check |
|---|---|---|
| Microsoft for Startups | https://foundershub.startups.microsoft.com/signup | **200** → redirects to `portal.startups.microsoft.com/signup` |
| AWS Activate | https://aws.amazon.com/activate/portfolio-signup | **200** → redirects to `aws.amazon.com/startups/credits/` |
| Google for Startups Cloud | https://cloud.google.com/startup/apply | **200** → Google sign-in, then the form |
| NVIDIA Inception | https://programs.nvidia.com/phoenix/application | linked from NVIDIA's own program page; the checking container could not reach that host (connection failed, not a 404) — verify in a browser |

`nvidia.com/en-us/startups/apply` **404s** — don't use it. The Phoenix URL above
is what NVIDIA's own "Apply Now" buttons point to.

**Entity status:** Cutline Industries is a registered LLC, so the "officially
incorporated" (NVIDIA) and "privately held, for-profit" (Microsoft) criteria are
met and can be attested truthfully. Confirm the formation date satisfies
NVIDIA's under-10-years rule before submitting.

## What can go today vs. what's blocked

- **Microsoft, AWS, Google — ready now.** None requires a pitch deck. For AWS,
  create the AWS account first (it asks for an account ID).
- **NVIDIA — needs the pitch deck**, which is file 3 below.
