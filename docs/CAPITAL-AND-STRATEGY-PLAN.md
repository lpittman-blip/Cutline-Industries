# Artemis: strategy and capital plan

Written 2026-10-23. Every dollar figure in here is sourced and marked with how
much I trust it. Do not plan around an unverified number.

---

## Part 1 — The decision you actually have to make

You asked for "a superior super intelligence ... better than ChatGPT ... an AI
that builds its next model itself."

Here is the arithmetic, stated once:

| | Artemis today | Frontier model |
|---|---|---|
| Training compute | 1.47 × 10^18 FLOPs | 10^25 – 10^26 FLOPs |
| Parameters | 153M | ~10^12 |
| Compute cost of the run | $0 (free Kaggle T4) | $50M – $500M+ |

The gap is roughly **100,000,000×**. Cloud credits do not close it. A seed
round does not close it. A Series A does not close it. The companies that
closed it raised $1B+ and bought physical datacenters.

Recursive self-improvement — "builds its next model itself" — is not a thing
anyone has shipped. Not OpenAI, not Anthropic, not Google. It is an open
research problem. If I told you we'd build it on free T4s I'd be lying to you.

**So the strategic question is not "how do we beat ChatGPT." It's "what can a
one-person company with no capital build that is genuinely worth money."**

That has a real answer, and you are closer to it than you think.

### My recommendation: go narrow, sell the platform, fund it with credits and revenue

Not investors. Not yet. Here's the reasoning.

Look at what you already named your ten experts:

    intent, architecture, planning, build, test, deploy,
    memory, security, observability, cost

That is not a chatbot. **That is a DevOps/SRE agent.** You didn't design a
ChatGPT competitor — you designed a software-delivery engine and then described
it to yourself as a ChatGPT competitor. The architecture is already pointed at
a narrow, valuable, unglamorous market where small specialised models actually
win on cost.

A 3B model fine-tuned on build logs, test failures, and deploy telemetry can
beat a frontier model on **cost per CI failure triaged**, because the task is
narrow and the context is structured. That is a defensible product. "Better
than ChatGPT at everything" is not.

### The rule you have to decide about

Blueprint Decisions 5 and 12 forbid calling any external LLM in product code or
Artemis decisions, and you extended that to training data. I want to be
straight with you about what that rule costs:

- **If the product is narrow** (CI triage, deploy review, cost analysis on your
  own telemetry), the rule is survivable. A 1–3B model trained on permissively
  licensed code and your own build data can do that job. The rule becomes a
  *selling point*: "your code never leaves your infrastructure, and we never
  send it to OpenAI." Enterprises pay a premium for exactly that.
- **If the product is a general assistant**, the rule is fatal. You cannot ship
  a general assistant backed by a 153M model and you cannot afford to train one
  that works.

So: **keep the rule, narrow the product.** That is a coherent company. The
alternative — keep the ambition, break the rule, ship a wrapper around someone
else's API — is a crowded, undifferentiated, low-margin business, and it throws
away the one thing you have that's actually unusual.

I'm recommending you keep the rule. It's your decision, not mine.

---

## Part 2 — Capital, for someone with no network

You said: no knowledge, no friends, no one with money. Good news — the three
largest sources of money available to you require **zero** connections. They
require written applications.

### Tier 1: free compute (apply this week, $0 cost, no equity)

This is the highest-value thing you can do in the next seven days. You could
not get **$15** of Azure GPU quota approved. These programs hand out
thousands of dollars of GPU to anyone who qualifies — and you qualify on every
published criterion: you own a software product, Cutline Industries is
privately held and for-profit, you're not a consultancy or an agency, you've
taken no prior credits, and you're not Series C.

| Program | Realistic amount, no investor | Equity | Notes |
|---|---|---|---|
| **NVIDIA Inception** | No published cash figure; partner cloud credits + hardware/software perks | **None** — NVIDIA takes no shares or warrants | Free to join. Some sources say it improves AWS terms. **Apply first.** |
| **Microsoft for Startups Founders Hub** | ~$1,000 (90 days) stepping to ~$5,000 (180 days) | None | Lifetime free-credit ceiling $350k. $100k tiers need an investor/accelerator referral code. |
| **Google for Startups Cloud** | ~$2,000 over 2 years (bootstrapped tier) | None | Larger AI tiers (up to $350k) require verifiable equity funding — SAFEs count, grants don't. One source claims $25–50k unfunded; conflicts, verify. |
| **AWS Activate** | up to $1,000 promo + $350 support credits | None | Higher tiers need an Activate Provider Org ID from an accelerator/VC/incubator. |

**Realistic total: $5,000–$10,000 of GPU, no equity, no network.**

Put that in perspective against what you've been fighting for:

- $5,000 ÷ $0.53/hr (NC4as_T4_v3) = **~9,400 T4-hours**
- $5,000 ÷ $3.67/hr (A100 80GB) = **~1,360 A100-hours**

1,360 A100-hours is enough to train a **1–3B parameter model to Chinchilla
optimum**. That is 10–20× the size of what's training on Kaggle right now, and
it is enough to build the narrow product described above.

It also solves the quota problem sideways: credit-backed subscriptions
generally come provisioned with GPU quota, which is the wall you've been stuck
behind for weeks.

**Caveat, and it matters: credits expire.** One Microsoft Q&A thread reports a
$25k account's credits expiring with no extension granted. Do not apply until
you have a corpus ready and a training script that runs — otherwise the clock
burns while you prepare. You are nearly there: the corpus pipeline
(`stream_corpus.py`, `stream_parallel.py`) and the trainer both work.

### Tier 2: SBIR/STTR — the real money, no equity, no network

**This is the single biggest lever available to you, and almost nobody in your
position knows it exists.**

America's Seed Fund (NSF SBIR/STTR) awards **up to ~$305,000 for Phase I** and
**up to ~$1,250,000 for Phase II**. The government takes **no equity**. You do
not need an introduction, a warm lead, or a friend with money. You need a
written Project Pitch.

Published eligibility (verify against the official solicitation, NSF 26-510):
- For-profit US small business, fewer than 500 employees ✅
- At least 51% US-owned (sources disagree: one says 50%) ✅
- Not majority-owned by VC/PE/hedge funds ✅
- Full proposal requires an invited Project Pitch first

**Two things to verify before you build a plan on this:**
1. Sources disagree on 50% vs 51% ownership, and none of them address whether a
   **one-person company** can apply. Confirm in NSF 26-510 and the Project
   Pitch instructions.
2. One listing notes NSF **paused** new Project Pitch submissions due to a
   lapse in congressional SBIR/STTR authorization; another says it restarted in
   May 2026. **Check nsf.gov/eng/sbir for current status before planning around
   a deadline.** This is the most important thing to verify in this whole
   document.

A Project Pitch is a short written document. It is free to submit. It is the
highest expected-value hour of work available to you.

### Tier 3: accelerators — cold applications, no network needed

Y Combinator and Techstars both accept cold applications and fund people with
no connections; that is explicitly what they're for. YC's standard deal is
$500k. Techstars is comparable in structure. These **do** take equity, and the
acceptance rate is low — but the application costs nothing but time, and an
accelerator affiliation also unlocks the **$100k+ cloud credit tiers** that are
otherwise closed to you. Apply as a side effect of Tier 1 and 2, not instead of
them.

### Tier 4: revenue

The thing nobody tells a first-time founder: **customer money is the best
money.** It's non-dilutive, it doesn't expire, and it proves the product works
in a way no deck can. If the narrow DevOps agent helps one team triage CI
failures and they pay $200/month for it, you have something an investor will
eventually want — and leverage you don't have today.

---

## Part 3 — The sequence

### Week 1 (this week) — free, no dependencies
1. **Verify the SBIR authorization status** at nsf.gov. Single most important
   check in this plan.
2. **Apply to NVIDIA Inception.** Free, no equity, fastest approval, and may
   improve the AWS tier.
3. **Apply to Microsoft for Startups Founders Hub.** Verify the current credit
   amounts on Microsoft's own pages first — every figure above is from
   third-party blogs that contradict each other.
4. **Apply to Google for Startups Cloud and AWS Activate** (bootstrapped tiers).
5. **Rotate the leaked credentials** (see `#26` in the issue list). Do this
   before any of these programs attach billing to your accounts. The HF token,
   Kaggle token, SSH key, GitHub App key, Azure AI keys, Postgres password and
   Gemini key are all exposed, and there is still a third-party 8×GPU instance
   and a 2000 GiB disk billing against you.

### Weeks 2–4 — while applications are pending (free)
6. **Let the Kaggle run finish.** It's the only training you have in flight.
7. **Fix the bf16 detection bug** in `gateway/artemis/train.py` (it checks
   `torch.cuda.is_bf16_supported()`, which returns True on Turing where bf16 is
   emulated; it needs `get_device_capability()[0] >= 8`). Then delete
   `patch_bf16_detection` from the Kaggle runner. You do not want to discover
   this on paid GPU time.
8. **Remove the false "fits comfortably in 12 GB" claim** from
   `docs/TRAIN-ON-YOUR-OWN-GPU.md` — the Kaggle OOM disproved it.
9. **Write the SBIR Project Pitch.** Narrow framing: a privately-hosted
   software-delivery agent that never sends source code to a third-party LLM.
   That framing is fundable *because* of Blueprint Decision 5, not despite it.
10. **Fix the corpus skew.** `build` is at 71.6% and three domains are at zero
    across independent shards. You validated that GitHub issues supply the
    missing three (median 1,042 chars vs 44 for commits). Finish the issue
    classifier validation on ~200 hand-labelled threads and settle the issues
    licensing question. A model trained on a 71%-one-domain corpus will not
    demonstrate the ten-expert architecture to anyone.

### Months 2–3 — once credits land
11. **Train a 1–3B Artemis on real GPU** to Chinchilla optimum on the fixed
    corpus. Prove FSDP works on real hardware first (`#25` — it's written but
    unproven on GPUs, and FSDP bugs are expensive to find at $3.67/hr).
12. **Ship the narrow product.** One task, done genuinely well, on your own
    infrastructure, with the no-external-LLM guarantee as the headline.
13. **Get one paying user.** Not ten. One.

### Months 4+ 
14. SBIR Phase I if invited. Accelerator applications. Only then investors —
    with a working product, revenue, and a trained model, which is a completely
    different conversation from the one you'd have today.

---

## Part 4 — What needs capital and what doesn't

**Needs money:**
- Training anything above ~3B parameters
- Sustained inference hosting at scale
- Anything resembling a frontier run (and no realistic amount of money you can
  raise in year one reaches this)

**Does not need money — you can do all of this at $0:**
- Fixing the bf16 bug, the corpus skew, the FSDP validation
- The issue classifier and its hand-labelled validation set
- Every application in Part 2
- Rotating the credentials
- Closing `Artemis-nsg` port 22 to `*`
- Writing the Project Pitch
- The entire gateway and platform layer, which already exists and works
  (the CORS/CSRF fix shipped and was verified live)
- Finding your first user

Most of your remaining blockers are **not money problems.** They are a handful
of engineering fixes and four written applications. That's the honest read.

---

## Part 5 — What I could not do, and what I got wrong

You asked me to "scan millions of sites, businesses or etc." **I can't, and
nothing can, usefully.** What's useful isn't volume — it's knowing that
SBIR/STTR exists and takes no equity, that NVIDIA Inception is free, and that
the credit tiers you can reach without an investor are small but sufficient for
a 1–3B model. That's about a dozen facts, not a million pages.

**Every dollar figure in Part 2 is from third-party blogs and aggregators, not
from the programs' own current pages.** They contradict each other — Google's
bootstrapped tier is quoted as both $2,000 and $25,000–50,000; AWS Activate as
$1,000 and $5,000; Microsoft's ceiling as $150,000 and $350,000. The SBIR
figures trace to NSF 26-510 but came to me via a consulting-firm guide, not NSF.
**Verify each on the official site before you plan around it.** I'd rather hand
you a number marked "unverified" than a confident wrong one.

---

## Sources

Cloud and GPU credit programs:
- [GPU Credit Programs for AI Startups: 2026 Funding Guide](https://www.gmicloud.ai/en/blog/gpu-credit-programs-for-ai-startups-from-prototype-to-production-without-dilution)
- [Startup Cloud Credits 2026: Tiers, Rules, Cliffs](https://hub.causo.ai/guides/startup-cloud-credits-compared-2026)
- [Free GPU Cloud Credits: 9 Programs That Changed in 2026](https://www.spheron.network/blog/free-gpu-cloud-credits-2026/)
- [Cloud Credits for Startups: Google, AWS, Microsoft & NVIDIA Guide](https://raem.kz/en/cloud-credits-startups-google-aws-microsoft-nvidia-guide/)
- [AI Credits for Startups 2026: OpenAI, Anthropic, Google](https://fin.ai/learn/ai-credits-for-startups)
- [Startup Credits List 2026: AWS, Azure, Google Cloud & More](https://startupsmap.co.in/blog/startup-credits-list-2026-aws-azure-google-cloud-more)
- [The 2026 Startup Perks Stack: $500K+ in Free Credits](https://valu.vc/startup-perks-stack/)
- [Best Free Cloud Credits for AI Startups in 2026](https://sidehustletools.app/blog/best-free-cloud-credits-ai-startups)
- [AI Credits for Startups 2026 Guide](https://www.startupbricks.in/blog/ai-credits-for-startups-2026-guide/)

SBIR/STTR:
- [NSF SBIR 2026: Funding Amounts, Deadlines & Startup Eligibility Guide](https://www.bwcoconsulting.com/fod/nsfsbir)
- [NSF SBIR Grant 2026: Funding Requirements and How to Apply](https://noviralane.com/nsf-sbir-grant-requirements-2026/)
- [NSF SBIR Guide 2026](https://grantsights.com/blog/nsf-sbir-guide)
- [America's Seed Fund SBIR Phase I & II (2026)](https://grantedai.com/grants/america-s-seed-fund-sbir-phase-i-ii-national-science-foundation-nsf-e5ff695a)
- [Artificial Intelligence (AI) - NSF SBIR/STTR (2026)](https://grantedai.com/grants/artificial-intelligence-ai-nsf-sbir-sttr-america-s-seed-fund-u-s-national-science-foundation-nsf-c6eca3cb)
