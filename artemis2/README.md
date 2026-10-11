# artemis2 — the bootstrap self-improvement loop

**For Artemis's own weights, do not use this. Use the package module:**

```
python -m artemis.selfplay --checkpoint runs/1b/latest.pt --tokenizer data/tokenizer.json
```

This directory holds the *bootstrap* variant, which trains a LoRA adapter over
a **third-party base model** (Qwen2.5-Coder by default). Its output is not
Artemis's weights, and it labels itself that way in the dashboard and in the
header of every file it exports.

It lives outside `gateway/artemis/` deliberately. Blueprint Decisions 5 and 12
keep external models out of the product package; the same reasoning that puts
`AzureAIBackend` behind the explicit `ARTEMIS_BOOTSTRAP_AZURE=1` flag keeps
this script out of the package entirely. Nothing in `gateway/` imports it.

## Which one to run

| | `artemis.selfplay` (package) | `artemis2_loop.py` (here) |
| --- | --- | --- |
| Weights | Artemis's own, fine-tuned directly | third-party base + LoRA adapter |
| Needs | a trained Artemis checkpoint | `transformers`, `peft`, `bitsandbytes` |
| Output provenance | genuinely Artemis | explicitly not Artemis |
| Produces labelled corpus | yes | no |

The package version is the one that compounds: it writes every verified
solution out as a **domain-labelled** corpus (`build` for the solution, `test`
for its tests), which is the supervision `route_coef` needs and that ordinary
web text cannot provide.

## When the bootstrap is still worth running

Self-improvement amplifies a signal; it cannot create one. A model that never
solves anything produces no training data and improves forever by zero. Until
an Artemis checkpoint can occasionally pass a problem, this script is the only
one of the two that will actually move — which makes it useful for exercising
the sandbox, the accept/reject gate and the dashboard against a model that can
already write Python.

```
pip install -r requirements.txt
python artemis2_loop.py --download-humaneval
python artemis2_loop.py --rounds 5
```

Pipeline check with no GPU and no torch:

```
python artemis2_loop.py --mock-model --sandbox local --unsafe-local-exec
```
