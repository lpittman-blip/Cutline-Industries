"""Artemis's own weights as the model behind the self-improvement loop.

Drop-in replacement for HFModel in artemis2_loop.py. The difference is the
whole point: HFModel trains a LoRA adapter over somebody else's base model and
has to label its output as third-party. This loads an Artemis checkpoint —
Prime Core and the ten experts from gateway/artemis/model.py — and fine-tunes
the weights directly. There is no adapter because there is no foreign base
model to leave untouched.

Requires a trained Artemis checkpoint and its tokenizer:
    python artemis2_loop.py --artemis-checkpoint runs/1b/latest.pt \
                            --artemis-tokenizer data/tokenizer.json
"""
from __future__ import annotations

import copy
import random
from pathlib import Path


def _artemis_imports():
    """Import the gateway package, adding the repo to sys.path if needed."""
    import sys
    try:
        from artemis import checkpoint  # noqa: F401
    except ImportError:
        here = Path(__file__).resolve()
        for parent in here.parents:
            gw = parent / "gateway"
            if (gw / "artemis" / "model.py").is_file():
                sys.path.insert(0, str(gw))
                break
        else:
            raise ImportError(
                "cannot find gateway/artemis; run from the repo or set PYTHONPATH"
            )
    from artemis import checkpoint
    from artemis.tokenizer import format_chat, load_tokenizer
    return checkpoint, format_chat, load_tokenizer


class ArtemisModel:
    """Artemis's own weights, fine-tuned in place on verified solutions."""

    # Artemis has its own chat format, so completions come back as full answers
    # rather than a bare function body.
    completion_mode = False

    def __init__(self, checkpoint_path: str, tokenizer_path: str,
                 max_new_tokens: int = 384, device: str | None = None):
        import torch

        checkpoint, format_chat, load_tokenizer = _artemis_imports()
        self.torch = torch
        self.checkpoint = checkpoint
        self.format_chat = format_chat
        self.max_new_tokens = max_new_tokens
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))

        self.model, self.ck = checkpoint.load_model(checkpoint_path, self.device)
        self.model.eval()
        self.tok = load_tokenizer(tokenizer_path)
        if self.tok.get_vocab_size() > self.model.cfg.vocab_size:
            raise checkpoint.CheckpointError(
                f"tokenizer has {self.tok.get_vocab_size()} tokens but the model "
                f"has {self.model.cfg.vocab_size}; they are from different runs"
            )
        self.stop = [i for i in (self.tok.token_to_id("<|end|>"),
                                 self.tok.token_to_id("<|eos|>")) if i is not None]
        cfg = self.model.cfg
        self.model_id = (f"artemis-{cfg.param_count() / 1e6:.0f}M"
                         f"@step{self.ck.get('step', 0)}")
        self._snapshot = None

    # -- prompting ---------------------------------------------------------

    def _prompt_ids(self, problem: dict) -> list[int]:
        msg = ("Complete this Python function. Reply with one ```python code block "
               "containing the full function and any imports it needs, no explanation.\n\n"
               + problem["prompt"])
        text = self.format_chat([{"role": "user", "content": msg}]) + "<|assistant|>"
        return self.tok.encode(text).ids

    def generate(self, problem: dict, sample: bool) -> str:
        torch = self.torch
        ids = self._prompt_ids(problem)[-(self.model.cfg.max_seq_len - 1):]
        self.model.eval()
        out: list[int] = []
        with torch.no_grad():
            idx = torch.tensor([ids], device=self.device)
            # Greedy decoding is temperature 0; the loop relies on it being
            # deterministic so evaluate() is reproducible across rounds.
            for t in self.model.stream(idx, self.max_new_tokens,
                                       0.8 if sample else 0.0,
                                       50 if sample else 0,
                                       self.stop):
                if t in self.stop:
                    break
                out.append(t)
        return self.tok.decode(out)

    # -- rollback ----------------------------------------------------------

    def snapshot(self):
        """Full weights, on CPU so a large model does not double its GPU memory."""
        self._snapshot = {k: v.detach().to("cpu", copy=True)
                          for k, v in self.model.state_dict().items()}

    def restore(self):
        if self._snapshot is not None:
            self.model.load_state_dict({k: v.to(self.device)
                                        for k, v in self._snapshot.items()})

    # -- training ----------------------------------------------------------

    def train(self, examples: list[tuple[dict, str]], epochs: int = 2,
              lr: float = 2e-5, max_len: int = 768) -> dict:
        """Fine-tune every weight on verified solutions.

        The learning rate defaults far below HFModel's 2e-4: that value suits a
        LoRA adapter with few trainable parameters, and would wreck a fully
        fine-tuned model.
        """
        torch = self.torch
        rows = []
        for prob, code in examples:
            p_ids = self._prompt_ids(prob)
            t_ids = self.tok.encode(f"```python\n{code}```").ids + self.stop[:1]
            ids = (p_ids + t_ids)[:max_len]
            if len(ids) < 2:
                continue
            # ArtemisLM.forward computes cross_entropy(logits, targets) with no
            # internal shift — data.TokenStream feeds y = tokens[s+1:], so the
            # target at position i is the token that follows x[i]. Mirror that,
            # and mask every position whose target still lies in the prompt so
            # the loss only covers the answer.
            x = ids[:-1]
            y = [tok_id if i + 1 >= len(p_ids) else -100
                 for i, tok_id in enumerate(ids[1:])]
            rows.append((x, y))
        if not rows:
            return {"steps": 0, "final_loss": float("nan")}

        params = [p for p in self.model.parameters() if p.requires_grad]
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
        self.model.train()
        steps, last = 0, float("nan")
        for _ in range(epochs):
            random.shuffle(rows)
            for xs, ys in rows:
                x = torch.tensor([xs], device=self.device)
                y = torch.tensor([ys], device=self.device)
                # ArtemisLM.forward returns (logits, loss); the second argument
                # is `targets`, not HuggingFace's `labels`.
                _logits, loss = self.model(x, y)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)
                steps, last = steps + 1, float(loss.detach())
        self.model.eval()
        return {"steps": steps, "final_loss": round(last, 4)}

    def save_adapter(self, path: Path):
        """Named for the loop's interface; writes a full Artemis checkpoint."""
        path = Path(path)
        path.mkdir(parents=True, exist_ok=True)
        self.checkpoint.save(path / "artemis.pt", self.model,
                             step=int(self.ck.get("step", 0)),
                             extra={"source": "artemis2 self-improvement loop"})
