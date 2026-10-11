# Proto rung: MoE vs matched-compute dense — 2026-10-11

Both runs: identical data, steps, batch, learning rate, warmup and seed. The
only variable is the architecture. Run on 4 CPU cores in a cloud container.

| | `proto` (MoE) | `proto-dense` |
| --- | --- | --- |
| Total parameters | 8.24 M | 5.87 M |
| Active per token | 5.9 M | 5.87 M |
| Final val loss | 3.9429 | **3.9397** |
| Wall clock, 3000 steps | 3332 s | **2757 s** |

**The dense baseline won**, by 0.0032 nats, while using 29% fewer parameters
and finishing 21% faster.

## Val loss through the run

| step | MoE | dense | dense − MoE |
| --- | --- | --- | --- |
| 500 | 4.8244 | 4.8360 | +0.0116 |
| 1000 | 4.4026 | 4.4123 | +0.0097 |
| 1500 | 4.1866 | 4.1850 | −0.0016 |
| 2000 | 4.0552 | 4.0514 | −0.0038 |
| 2500 | 3.9822 | 3.9756 | −0.0066 |
| 3000 | 3.9429 | 3.9397 | −0.0032 |

The MoE leads early, the dense model overtakes it around step 1500, and the gap
never exceeds ~0.012 nats in either direction. At this scale the two are
effectively tied and the MoE costs more to get there.

## The caveat that matters most

**Routing supervision was never active.** The corpus manifest records
`domain_labels: false` — 44 public-domain novels carry no domain labels, so the
`route_coef` term contributed nothing and the routers trained on the balance
and z-losses alone.

Artemis's ten experts are defined by *domain* (intent, architecture, planning,
build, test, deploy, memory, security, observability, cost). This experiment
asked them to specialise on Victorian fiction with no supervision telling them
what to specialise on. They did differentiate — router entropy fell layer by
layer, deepest hardest (2.22 / 2.13 / 1.88 against a ln(10)=2.30 ceiling), and
no expert collapsed, balance loss flat at ~1.01. The mechanism works. It simply
had nothing domain-shaped to learn.

So this is **not** evidence that Artemis's MoE design is wrong. It is evidence
that on unlabelled general text at 8 M parameters, routing earns nothing — which
is roughly what the literature predicts, since MoE gains typically appear at
far larger scale.

## What would actually settle it

1. Re-run at `100m` on labelled data, MoE vs dense. About an hour each on 8 GPUs.
2. Build a domain-labelled corpus so `route_coef` is live. Without it, every
   MoE comparison measures an architecture running on one engine.

Spending weeks of GPU time on an 8b MoE before step 2 exists would be buying
complexity with no measured return.
