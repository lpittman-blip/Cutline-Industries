# Azure GPU quota request — Cutline Industries

**Forward this to whoever administers the Azure subscription.** It is a free
request, needs no purchase order, no new vendor and no payment method, and it
bills to the Azure subscription Cutline already pays for.

---

## What is being asked for

Raise one quota limit on the existing Azure subscription:

| | |
| --- | --- |
| Subscription | `Azure subscription 1` — `6b812355-4bfc-4948-92ea-caf3ee5579de` |
| Region | **East US 2** |
| Quota | **`Standard NCASv3_T4 Family`** |
| Current limit | **0** |
| Requested limit | **4** |

That is the whole request. Nothing else needs to change.

## Where to do it

1. **portal.azure.com** → search **Quotas** → **Compute**
2. Subscription: `Azure subscription 1` · Region: **East US 2**
3. Search `NCASv3_T4` → **Request increase** → enter **4** → submit

The portal's quota flow files a free support ticket. Automated requests on this
subscription have been refused three times (see below), so this one needs the
human review that the portal path provides.

## Justification to paste into the request

> Training a small internal transformer model (~150M parameters) for product
> development. Need one `Standard_NC4as_T4_v3` instance (4 vCPUs, 1× NVIDIA T4).
> Existing regional vCPU quota is sufficient; only the NCASv3_T4 family limit
> needs raising from 0 to 4.

## Why this specific, minimal ask

It was chosen to be the smallest grant Azure could reasonably make:

- `Standard_NC4as_T4_v3` is **4 vCPUs** with one whole T4 GPU — the only modern
  GPU SKU that fits inside the subscription's existing 10-vCPU regional cap.
- **East US 2 has all 10 of its regional vCPUs free**, so no regional increase
  is needed. (East US has 8 of 10 in use.)
- That SKU is **unrestricted** in East US 2 — `az vm list-skus` shows no
  restriction there. Only the quota number is zero.

So exactly one number moves, from 0 to 4.

## Cost

| | |
| --- | --- |
| Rate | ~$0.53/hour for `Standard_NC4as_T4_v3` |
| Run length | ~29 hours (one training run) |
| **Total** | **~$15, once** |

Billed to the existing Azure subscription. The VM is deleted when the run
finishes; nothing recurring is created.

**Optional, if faster turnaround is wanted:** also request
`StandardNCADSA100v4Family` → **24** and **Total Regional vCPUs** → **24** in
the same ticket. An A100 (`Standard_NC24ads_A100_v4`) finishes the same run in
~6 hours for ~$22 instead of ~29 hours for ~$15. There is no extra cost to
asking for both in one ticket.

## What was already tried, so it is not repeated

The quota API refused three times, with no reason given beyond
`"Request failed."`:

```
Standard NCASv3_T4 Family -> 4    eastus    Failed
cores (regional)          -> 24   eastus    Failed
Standard NCASv3_T4 Family -> 4    eastus2   Failed
```

The third was the minimal ask described above. Two things rule out the usual
explanations:

- **The subscription is healthy.** `quotaId: PayAsYouGo_2014-09-01`,
  `state: Enabled`, `spendingLimit: Off` — not a trial, not suspended. Three
  VMs are running and billing normally today.
- **The hardware is offered.** A100, H100, A10 v5 and T4 SKUs all appear with
  no restriction in most regions. Every modern GPU family simply sits at
  limit 0.

Refusing automated GPU increases on a young subscription is Azure's normal
posture. The portal's request goes to human review, which is the documented
route through it.

The Azure **Support API** is not an alternative: it is gated behind a paid
support plan and returns `InvalidSupportPlan` on this subscription. The portal
quota flow is free; only the API is paywalled.

## Two unrelated cost items worth a look while in the portal

Neither affects this request, but both are spending money now:

1. **`aks-system-surge-4jjwh`** (`Standard_D4als_v6`, running, resource group
   `MC_RG-LAMONTPITTMAN-2247_ARTEMIS_EASTUS`) — a node from an AKS cluster
   created earlier and never completed. It is likely costing several hundred
   dollars a month, serves nothing, and consumes 4 of East US's 10 regional
   vCPUs.
2. **`Nvida2`** (`Standard_F2amds_v7`, deallocated, resource group
   `NVIDA2_GROUP`) — despite the name this VM has **no GPU**; it is a 2-core
   AMD general-purpose VM. Deallocated, so no compute charge, but its managed
   disk still bills. Safe to delete.

## What happens once the quota is approved

No further input needed from the requester. The VM is created from an ARM
template, the training run starts, and the VM is deleted when it finishes.
Expected total: **one charge of roughly $15.**
