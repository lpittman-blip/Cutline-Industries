"""Artemis improves itself on problems it can verify.

Artemis proposes a solution, a sandbox runs it against the problem's tests, and
only solutions that actually pass become training data. A round is kept only if
held-out pass@1 improves; otherwise the weights roll back. Nothing here grades
Artemis by opinion — every reward is a test that ran.

This trains ARTEMIS'S OWN WEIGHTS. There is no third-party base model and no
LoRA adapter, so Blueprint Decisions 5 and 12 hold without a label exemption.
The standalone artemis2/ loop is the bootstrap variant that fine-tunes someone
else's model, and it stays outside the package for exactly that reason.

Two outputs, and the second is the one that compounds:

  1. a checkpoint whose pass@1 is measurably better than the one before it;
  2. verified solutions written out as a DOMAIN-LABELLED corpus.

The second matters because today's proto experiment showed routing buying
nothing on unlabelled text — `route_coef` only does work on tokens carrying a
domain label, and a general web corpus has none. Solved code is labelled
`build` and its tests `test` by construction, so this loop manufactures exactly
the supervision the expert routers never had.

    python -m artemis.selfplay --checkpoint runs/1b/latest.pt \
        --tokenizer data/tokenizer.json --rounds 10
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .model import EXPERT_NAMES

# Solved code is `build` work and its tests are `test` work. Both are real
# expert names from model.EXPERT_NAMES, so data.prepare accepts them directly.
SOLUTION_DOMAIN = "build"
TEST_DOMAIN = "test"
WEIGHTS_LABEL = "Artemis-from-scratch weights (Prime Core + ten experts), fine-tuned directly"

FENCE = re.compile(r"```(?:python|py)?\s*\n([\s\S]*?)```")


# ---------------------------------------------------------------------------
# Problems
# ---------------------------------------------------------------------------

BUILTIN_PROBLEMS = [
    ("is_prime", 'def is_prime(n: int) -> bool:\n    """Return True if n is a prime number."""\n',
     "    if n < 2:\n        return False\n    i = 2\n    while i * i <= n:\n        if n % i == 0:\n            return False\n        i += 1\n    return True\n",
     "def check(candidate):\n    assert candidate(11) is True\n    assert candidate(1) is False\n    assert candidate(15) is False\n"),
    ("find_max", 'def find_max(values: list) -> int:\n    """Return the largest number in a non-empty list."""\n',
     "    best = values[0]\n    for v in values:\n        if v > best:\n            best = v\n    return best\n",
     "def check(candidate):\n    assert candidate([1, 5, 2]) == 5\n    assert candidate([-3, -1, -7]) == -1\n"),
    ("factorial", 'def factorial(n: int) -> int:\n    """Return n! for n >= 0."""\n',
     "    out = 1\n    for i in range(2, n + 1):\n        out *= i\n    return out\n",
     "def check(candidate):\n    assert candidate(0) == 1\n    assert candidate(5) == 120\n"),
    ("is_palindrome", 'def is_palindrome(s: str) -> bool:\n    """Return True if s reads the same backwards, ignoring case."""\n',
     "    s = s.lower()\n    return s == s[::-1]\n",
     "def check(candidate):\n    assert candidate('Racecar') is True\n    assert candidate('abc') is False\n"),
]


def builtin_problems() -> list[dict]:
    return [{"task_id": f"Builtin/{n}", "prompt": p, "canonical_solution": s,
             "test": t, "entry_point": n} for n, p, s, t in BUILTIN_PROBLEMS]


REQUIRED_FIELDS = ("task_id", "prompt", "test", "entry_point")


def validate_problems(problems: list[dict], minimum: int = 2) -> list[dict]:
    """Reject a dataset that cannot support an honest train/eval split.

    Every one of these failed silently before: a malformed row produced a
    KeyError deep inside the loop, and duplicate task_ids put the same problem
    on both sides of a split that is supposed to be disjoint, which quietly
    turns held-out pass@1 into training accuracy.
    """
    if not problems:
        raise ValueError("dataset is empty")
    seen = set()
    for i, p in enumerate(problems):
        if not isinstance(p, dict):
            raise ValueError(f"problem {i} is {type(p).__name__}, expected an object")
        missing = [f for f in REQUIRED_FIELDS if not p.get(f)]
        if missing:
            raise ValueError(f"problem {i} ({p.get('task_id', '?')}) is missing {missing}")
        if p["task_id"] in seen:
            raise ValueError(f"duplicate task_id {p['task_id']!r}; splits would overlap")
        seen.add(p["task_id"])
    if len(problems) < minimum:
        raise ValueError(f"need at least {minimum} problems, got {len(problems)}")
    return problems


def load_problems(path: Path | None) -> list[dict]:
    """Load a dataset. An explicitly named path that is missing is an error.

    Falling back to the ten built-in problems when --problems points at a
    typo looks like success and silently evaluates against a toy set.
    """
    if path is None:
        return validate_problems(builtin_problems())
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"problems file not found: {path}")
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        rows = []
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{n}: not valid JSON ({e})") from None
    return validate_problems(rows)


def three_way_split(problems: list[dict], val_fraction: float = 0.2,
                    test_fraction: float = 0.1) -> tuple[list[dict], list[dict], list[dict]]:
    """train / validation / final test, by a stable hash of task_id.

    Review item 7. Choosing checkpoints repeatedly against one held-out split
    turns that split into a validation set: by round twenty the loop has
    selected for it as surely as if it had trained on it, and its pass@1 is
    no longer evidence of general improvement. The final test set is reserved
    here and is never used for a commit decision — `run_loop` scores it once
    at the end, for reporting only.
    """
    if not 0.0 < val_fraction < 1.0:
        raise ValueError(f"val_fraction must be in (0,1), got {val_fraction}")
    if not 0.0 <= test_fraction < 1.0:
        raise ValueError(f"test_fraction must be in [0,1), got {test_fraction}")
    if val_fraction + test_fraction >= 1.0:
        raise ValueError("val_fraction + test_fraction must leave training problems")
    validate_problems(problems, minimum=3 if test_fraction else 2)
    train, val, test = [], [], []
    for p in problems:
        h = int(hashlib.sha256(p["task_id"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        if h < test_fraction:
            test.append(p)
        elif h < test_fraction + val_fraction:
            val.append(p)
        else:
            train.append(p)
    if not val:
        val.append(train.pop())
    if not train:
        raise ValueError("no training problems left after the split")
    ids = [{p["task_id"] for p in s} for s in (train, val, test)]
    if ids[0] & ids[1] or ids[0] & ids[2] or ids[1] & ids[2]:
        raise ValueError("splits overlap")
    return train, val, test


def split_problems(problems: list[dict], eval_fraction: float) -> tuple[list[dict], list[dict]]:
    """Split by a hash of task_id so the held-out set never moves between runs.

    A random split would let a problem drift into training between rounds and
    quietly invalidate every pass@1 comparison the loop makes.
    """
    if not 0.0 < eval_fraction < 1.0:
        raise ValueError(f"eval_fraction must be between 0 and 1 exclusive, got {eval_fraction}")
    validate_problems(problems)
    train, held = [], []
    for p in problems:
        h = int(hashlib.sha256(p["task_id"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        (held if h < eval_fraction else train).append(p)
    if not held:
        held.append(train.pop())
    if not train:
        raise ValueError(
            f"eval_fraction {eval_fraction} leaves no training problems "
            f"out of {len(problems)}")
    overlap = {p["task_id"] for p in train} & {p["task_id"] for p in held}
    if overlap:
        raise ValueError(f"splits overlap on {sorted(overlap)}")
    return train, held


# ---------------------------------------------------------------------------
# Code assembly and sandboxed execution
# ---------------------------------------------------------------------------

def extract_code(raw: str) -> str:
    m = FENCE.search(raw)
    return (m.group(1) if m else raw).rstrip() + "\n"


def solution_source(problem: dict, completion: str) -> str:
    """The completion as a standalone definition of the function.

    If the model wrote the whole function it redefines the docstring-only stub;
    otherwise the completion is a bare body and needs the stub in front of it,
    or it is a syntax error on its own.
    """
    ep = problem["entry_point"]
    if re.search(rf"^\s*def\s+{re.escape(ep)}\s*\(", completion, re.M):
        return problem["prompt"] + "\n" + completion
    return problem["prompt"] + completion


def build_program(problem: dict, completion: str, sentinel: str) -> str:
    """Wrap the candidate so that passing requires POSITIVE PROOF of completion.

    A zero exit code proves nothing. `sys.exit(0)` inside the first assertion
    leaves the process exiting cleanly with most of the tests never run, and
    the old code counted that as a pass — which quietly poisons training data
    with solutions that were never verified.

    So the harness catches BaseException (SystemExit included) around check()
    and prints a verdict line carrying a per-run nonce. `os._exit(0)` skips
    that line entirely, and no line means failure.

    TRUST BOUNDARY. The container is the security boundary; this wrapper is an
    integrity check inside it. Candidate code shares the interpreter, so code
    that deliberately printed the verdict line could forge a pass. That is
    accepted: the candidates come from our own model, so the threat being
    defended against is accidental early exit and silent partial execution,
    not an adversary. Nothing here makes arbitrary code trustworthy.
    """
    return (
        f"{solution_source(problem, completion)}\n\n"
        f"{problem['test']}\n\n"
        "import sys as _sys\n"
        "_ok = False\n"
        "try:\n"
        f"    check({problem['entry_point']})\n"
        "    _ok = True\n"
        "except BaseException:\n"
        "    _ok = False\n"
        f"_sys.stdout.write('\\n{sentinel}:' + ('PASS' if _ok else 'FAIL') + '\\n')\n"
        "_sys.stdout.flush()\n"
        "_sys.exit(0 if _ok else 1)\n"
    )


@dataclass
class RunResult:
    passed: bool
    error: str
    seconds: float
    infrastructure_error: bool = False  # our fault, not the solution's


MAX_CAPTURE_BYTES = 256 * 1024


def _read_capped(stream, cap: int, into: list):
    """Read at most `cap` bytes, then drain and discard the rest.

    `capture_output=True` buffers everything the candidate prints in host
    memory. The container's --memory limit does not bound that, so a program
    printing in a loop can exhaust the host while staying inside its own cap.
    """
    try:
        data = stream.read(cap) or b""
        into.append(data)
        while stream.read(65536):
            into.append(b"")  # discarded; keeps the pipe from blocking the child
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass


class Sandbox:
    """Runs model-written code. Docker by default: no network, read-only root,
    capped memory, CPU and pids. `local` runs it on this machine and must be
    unlocked explicitly, because generated code is untrusted by definition."""

    def __init__(self, mode: str = "docker", timeout: float = 10.0,
                 image: str = "python:3.11-slim", unsafe_ok: bool = False):
        self.mode, self.timeout, self.image = mode, timeout, image
        if mode == "docker" and not shutil.which("docker"):
            raise RuntimeError(
                "sandbox 'docker' selected but docker is not installed; for a "
                "throwaway machine only: --sandbox local --unsafe-local-exec")
        if mode == "local" and not unsafe_ok:
            raise RuntimeError(
                "refusing to run generated code on this host; pass "
                "--unsafe-local-exec only on a disposable machine")

    def verify(self, problem: dict, completion: str) -> RunResult:
        """Run a candidate and report whether its tests provably passed."""
        sentinel = f"__ARTEMIS_{uuid.uuid4().hex}__"
        return self._judge(self.run(build_program(problem, completion, sentinel)), sentinel)

    @staticmethod
    def _judge(raw: RunResult, sentinel: str) -> RunResult:
        if raw.infrastructure_error:
            return raw
        verdict = None
        for line in (raw.error or "").splitlines():
            if line.startswith(sentinel + ":"):
                verdict = line.split(":", 1)[1].strip()
        if verdict == "PASS":
            return RunResult(True, "", raw.seconds)
        if verdict == "FAIL":
            return RunResult(False, raw.error.replace(sentinel + ":FAIL", "").strip()[-300:]
                             or "tests failed", raw.seconds)
        # No verdict line at all: the process died before the harness could
        # report — os._exit, a crash, or a kill. Exit code 0 here is exactly
        # the case that used to be miscounted as a pass.
        return RunResult(False, f"incomplete: no verdict (exit {raw.error[:120]})", raw.seconds)

    def run(self, program: str) -> RunResult:
        """Execute a program. `error` carries combined output for the judge."""
        start = time.perf_counter()
        if self.mode == "docker":
            return self._run_docker(program, start)
        return self._run_local_checked(program, start)

    def _run_docker(self, program: str, start: float) -> RunResult:
        # A unique name is what makes cleanup possible: --rm removes a
        # container after it exits but imposes no deadline, so killing the
        # docker CLI on timeout can leave the container running forever.
        name = f"artemis-sbx-{uuid.uuid4().hex[:16]}"
        cmd = ["docker", "run", "--name", name, "--rm", "-i",
               "--network", "none", "--read-only", "--memory", "256m",
               "--cpus", "1", "--pids-limit", "64", "--tmpfs", "/tmp:size=16m",
               "--user", "65534:65534", self.image, "python", "-I", "-"]
        proc = None
        chunks: list[bytes] = []
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT)
            reader = threading.Thread(target=_read_capped,
                                      args=(proc.stdout, MAX_CAPTURE_BYTES, chunks),
                                      daemon=True)
            reader.start()
            try:
                proc.stdin.write(program.encode())
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            try:
                rc = proc.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                return RunResult(False, "timeout", time.perf_counter() - start)
            reader.join(timeout=5)
            out = b"".join(chunks).decode("utf-8", "replace")
            return RunResult(rc == 0, out if out else f"exit {rc}",
                             time.perf_counter() - start)
        except FileNotFoundError as e:
            return RunResult(False, f"docker unavailable: {e}",
                             time.perf_counter() - start, infrastructure_error=True)
        finally:
            # Always, on every path: success, failure, timeout, overflow and
            # KeyboardInterrupt. Without this a timed-out container survives.
            if proc and proc.poll() is None:
                proc.kill()
            subprocess.run(["docker", "rm", "-f", name],
                           capture_output=True, timeout=30, check=False)

    def _run_local_checked(self, program: str, start: float) -> RunResult:
        try:
            p = self._run_local(program)
        except subprocess.TimeoutExpired:
            return RunResult(False, "timeout", time.perf_counter() - start)
        out = ((p.stdout or "") + (p.stderr or ""))[:MAX_CAPTURE_BYTES]
        return RunResult(p.returncode == 0, out if out else f"exit {p.returncode}",
                         time.perf_counter() - start)

    def _run_local(self, program: str) -> subprocess.CompletedProcess:
        def limits():
            try:
                import resource
                t = int(self.timeout)
                resource.setrlimit(resource.RLIMIT_CPU, (t, t + 1))
                resource.setrlimit(resource.RLIMIT_AS, (512 * 2**20, 512 * 2**20))
                resource.setrlimit(resource.RLIMIT_FSIZE, (2**20, 2**20))
            except Exception:
                pass
        with tempfile.TemporaryDirectory(prefix="artemis-sbx-") as d:
            return subprocess.run([sys.executable, "-I", "-"], input=program, cwd=d,
                                  capture_output=True, text=True, timeout=self.timeout,
                                  env={"PATH": "/usr/bin:/bin"},
                                  preexec_fn=limits if os.name == "posix" else None)


# ---------------------------------------------------------------------------
# Artemis as the player
# ---------------------------------------------------------------------------

class ArtemisPlayer:
    """Artemis's own weights, fine-tuned in place on solutions it verified."""

    def __init__(self, checkpoint_path: str, tokenizer_path: str,
                 max_new_tokens: int = 384, device: str | None = None):
        import torch

        from . import checkpoint as ckpt_mod
        from .tokenizer import format_chat, load_tokenizer

        self.torch = torch
        self.ckpt_mod = ckpt_mod
        self.format_chat = format_chat
        self.max_new_tokens = max_new_tokens
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.model, self.ck = ckpt_mod.load_model(checkpoint_path, self.device)
        self.model.eval()
        self.tok = load_tokenizer(tokenizer_path)
        if self.tok.get_vocab_size() > self.model.cfg.vocab_size:
            raise ckpt_mod.CheckpointError(
                f"tokenizer has {self.tok.get_vocab_size()} tokens but the model has "
                f"{self.model.cfg.vocab_size}; they come from different runs")
        self.stop = [i for i in (self.tok.token_to_id("<|end|>"),
                                 self.tok.token_to_id("<|eos|>")) if i is not None]
        self.model_id = (f"artemis-{self.model.cfg.param_count() / 1e6:.0f}M"
                         f"@step{self.ck.get('step', 0)}")
        self._snapshot: dict | None = None

    def _prompt_ids(self, problem: dict) -> list[int]:
        msg = ("Complete this Python function. Reply with one ```python code block "
               "containing the full function and any imports it needs, no explanation.\n\n"
               + problem["prompt"])
        return self.tok.encode(self.format_chat([{"role": "user", "content": msg}])
                               + "<|assistant|>").ids

    def generate(self, problem: dict, sample: bool) -> str:
        torch = self.torch
        ids = self._prompt_ids(problem)[-(self.model.cfg.max_seq_len - 1):]
        self.model.eval()
        out: list[int] = []
        with torch.no_grad():
            idx = torch.tensor([ids], device=self.device)
            for t in self.model.stream(idx, self.max_new_tokens,
                                       0.8 if sample else 0.0,
                                       50 if sample else 0, self.stop):
                if t in self.stop:
                    break
                out.append(t)
        return self.tok.decode(out)

    def snapshot(self):
        """Keep the rollback copy on CPU; a large model would otherwise double
        its GPU memory just to hold the previous round."""
        self._snapshot = {k: v.detach().to("cpu", copy=True)
                          for k, v in self.model.state_dict().items()}

    def restore(self):
        if self._snapshot is not None:
            self.model.load_state_dict({k: v.to(self.device)
                                        for k, v in self._snapshot.items()})

    def train(self, examples: list[tuple[dict, str]], epochs: int = 2,
              lr: float = 2e-5, max_len: int = 768,
              min_prompt_tokens: int = 64) -> dict:
        torch = self.torch
        rows, dropped = [], 0
        for prob, code in examples:
            p_ids = self._prompt_ids(prob)
            t_ids = self.tok.encode(f"```python\n{code}```").ids + self.stop[:1]

            # Reserve room for the answer BEFORE truncating. Taking the first
            # max_len tokens of prompt+answer silently produces rows that are
            # all prompt: every label masked, nothing supervised, and a loss
            # over an empty set is NaN. Keep the tail of an overlong prompt,
            # which is where the actual question is.
            keep_target = min(len(t_ids), max(1, max_len - min_prompt_tokens))
            t_ids = t_ids[:keep_target]
            room = max_len - len(t_ids)
            if room < 1:
                dropped += 1
                continue
            p_ids = p_ids[-room:]
            ids = p_ids + t_ids
            if len(ids) < 2:
                dropped += 1
                continue

            # ArtemisLM applies cross_entropy with no internal shift, matching
            # data.TokenStream where y = tokens[s+1:]. Targets are therefore
            # shifted here, and every position whose target still lies in the
            # prompt is masked so the loss covers only the answer.
            xs = ids[:-1]
            ys = [t if i + 1 >= len(p_ids) else -100 for i, t in enumerate(ids[1:])]
            if all(y == -100 for y in ys):      # verified after the shift, not before
                dropped += 1
                continue
            rows.append((xs, ys))
        if not rows:
            return {"steps": 0, "final_loss": float("nan"),
                    "dropped": dropped, "nonfinite": 0}

        params = [p for p in self.model.parameters() if p.requires_grad]
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
        self.model.train()
        steps, last, nonfinite = 0, float("nan"), 0
        for _ in range(epochs):
            random.shuffle(rows)
            for xs, ys in rows:
                _logits, loss = self.model(torch.tensor([xs], device=self.device),
                                           torch.tensor([ys], device=self.device))
                # A non-finite loss poisons every weight the moment it is
                # stepped, and the damage is invisible afterwards.
                if not torch.isfinite(loss):
                    opt.zero_grad(set_to_none=True)
                    nonfinite += 1
                    continue
                loss.backward()
                gnorm = torch.nn.utils.clip_grad_norm_(params, 1.0)
                if not torch.isfinite(gnorm):
                    opt.zero_grad(set_to_none=True)
                    nonfinite += 1
                    continue
                opt.step()
                opt.zero_grad(set_to_none=True)
                steps, last = steps + 1, float(loss.detach())
        self.model.eval()
        return {"steps": steps, "final_loss": round(last, 4),
                "dropped": dropped, "nonfinite": nonfinite}

    def save(self, path: Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.ckpt_mod.save(path, self.model, step=int(self.ck.get("step", 0)),
                           extra={"source": "artemis.selfplay", "weights": WEIGHTS_LABEL})


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

def write_labelled_corpus(path: Path, solved: list[tuple[dict, str]]) -> dict:
    """Append verified solutions as a domain-labelled corpus for data.prepare.

    This is the output that compounds. Every record carries a real expert name,
    so prepare() emits a .dom sidecar and `route_coef` finally has tokens to
    supervise — which unlabelled web text never provides.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    counts = {SOLUTION_DOMAIN: 0, TEST_DOMAIN: 0}
    with path.open("a", encoding="utf-8") as f:
        for prob, code in solved:
            f.write(json.dumps({"text": solution_source(prob, code),
                                "domain": SOLUTION_DOMAIN,
                                "task_id": prob["task_id"]}) + "\n")
            counts[SOLUTION_DOMAIN] += 1
            if prob.get("test"):
                f.write(json.dumps({"text": prob["test"],
                                    "domain": TEST_DOMAIN,
                                    "task_id": prob["task_id"]}) + "\n")
                counts[TEST_DOMAIN] += 1
    return counts


MANIFEST = "run_manifest.json"


def run_identity(problems: list[dict], tokenizer_path: str, config: dict) -> dict:
    """What a resumed run must still agree with.

    Review item 6. Resuming against a different dataset, tokenizer or split
    silently invalidates every pass@1 comparison in the history, because the
    recorded best score was measured on problems the new run may not even
    contain.
    """
    ids = sorted(p["task_id"] for p in problems)
    return {
        "dataset_sha256": hashlib.sha256("\n".join(ids).encode()).hexdigest(),
        "problem_count": len(ids),
        "tokenizer_sha256": hashlib.sha256(Path(tokenizer_path).read_bytes()).hexdigest()
        if tokenizer_path and Path(tokenizer_path).exists() else None,
        "config": config,
    }


def write_manifest(out_dir: Path, identity: dict, state: dict) -> Path:
    path = Path(out_dir) / MANIFEST
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"identity": identity, "state": state}, indent=2))
    tmp.replace(path)          # atomic: a crash never leaves a half-written manifest
    return path


def load_manifest(out_dir: Path, identity: dict) -> dict | None:
    """Return stored state, or raise if the run on disk is a different run."""
    path = Path(out_dir) / MANIFEST
    if not path.exists():
        return None
    stored = json.loads(path.read_text())
    old = stored.get("identity", {})
    for field in ("dataset_sha256", "tokenizer_sha256", "problem_count"):
        if old.get(field) != identity.get(field):
            raise ValueError(
                f"cannot resume {out_dir}: {field} differs "
                f"({old.get(field)!r} on disk, {identity.get(field)!r} now). "
                "Use a fresh --out, or point at the original dataset and tokenizer.")
    for k, v in identity["config"].items():
        if old.get("config", {}).get(k) != v:
            raise ValueError(
                f"cannot resume {out_dir}: config {k} was {old.get('config', {}).get(k)!r}, now {v!r}")
    return stored.get("state", {})


def promote(player, out_dir: Path, version: str) -> Path:
    """Save and promote a checkpoint without ever destroying the previous one.

    Writes to a temporary name, then moves it into place, then repoints
    `accepted.pt`. If any step fails the previously accepted checkpoint is
    still exactly where it was.
    """
    ckpt_dir = Path(out_dir) / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    staged = ckpt_dir / f".{version}.partial"
    final = ckpt_dir / f"{version}.pt"
    player.save(staged)
    staged.replace(final)
    pointer = ckpt_dir / "accepted.json"
    tmp = pointer.with_suffix(".tmp")
    tmp.write_text(json.dumps({"accepted": final.name,
                               "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
    tmp.replace(pointer)
    return final


def export_solution(root: Path, version: str, prob: dict, code: str,
                    generated_by: str, sandbox: "Sandbox | None" = None) -> Path:
    """Write a verified solution, and prove the written file is the verified one.

    Two distinct checkpoints matter and conflating them misattributes the
    work: `generated_by` wrote the code, `version` is the checkpoint that was
    trained on it afterwards. The old header named only the latter, implying
    the new weights had produced output they never saw.
    """
    out = Path(root) / "verified" / version
    out.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9_]", "_", prob["task_id"]) + ".py"
    source = solution_source(prob, code)

    # Compile the exact text being written. An artifact that does not even
    # parse must never carry a header calling it verified.
    compile(source, str(out / name), "exec")

    header = (f"# Artemis verified solution\n# Task: {prob['task_id']}\n"
              f"# Generated by: {generated_by}\n# Trained into: {version}\n"
              f"# Weights: {WEIGHTS_LABEL}\n# Passed sandboxed tests at "
              f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}\n\n")
    path = out / name
    path.write_text(header + source, encoding="utf-8")

    # Re-run the tests against the artifact as written, not against the
    # in-memory string it was built from.
    if sandbox is not None:
        again = sandbox.verify(prob, path.read_text().split("\n\n", 1)[1])
        if not again.passed:
            path.unlink(missing_ok=True)
            raise RuntimeError(
                f"exported artifact for {prob['task_id']} failed re-verification: {again.error}")
    return path


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

def evaluate(player, sandbox: Sandbox, problems: list[dict]) -> float:
    """Greedy pass@1 on the held-out split, which never becomes training data."""
    passed = 0
    for p in problems:
        code = extract_code(player.generate(p, sample=False))
        passed += sandbox.verify(p, code).passed
    return passed / len(problems)


def run_loop(player, sandbox: Sandbox, problems: list[dict], out_dir: Path, *,
             rounds: int = 5, train_per_round: int = 16, samples: int = 4,
             epochs: int = 2, lr: float = 2e-5, eval_fraction: float = 0.3,
             min_gain: float = 0.0, seed: int = 0, log=print,
             test_fraction: float = 0.1, tokenizer_path: str = "",
             resume: bool = False) -> dict:
    """Returns a summary. Separate from main() so tests drive it directly."""
    for name, value in (("rounds", rounds), ("train_per_round", train_per_round),
                        ("samples", samples), ("epochs", epochs)):
        if value < 1:
            raise ValueError(f"{name} must be at least 1, got {value}")
    if lr <= 0:
        raise ValueError(f"lr must be positive, got {lr}")
    if min_gain < 0:
        raise ValueError(
            f"min_gain must be non-negative, got {min_gain}; a negative "
            "threshold accepts checkpoints that scored WORSE than the best")
    random.seed(seed)
    out_dir = Path(out_dir)
    # Selection happens on `val`; `test` is scored once at the end and never
    # influences a commit, so it stays a clean estimate of generalisation.
    train, held, test = three_way_split(problems, eval_fraction, test_fraction)
    identity = run_identity(problems, tokenizer_path,
                            {"eval_fraction": eval_fraction, "test_fraction": test_fraction,
                             "seed": seed, "lr": lr, "epochs": epochs})
    prior = load_manifest(out_dir, identity) if resume else None
    if prior:
        log(f"resuming: best pass@1 {prior.get('best_pass_rate')} from round {prior.get('round')}")
    corpus = out_dir / "labelled" / "verified.jsonl"

    best = evaluate(player, sandbox, held)
    history = [{"round": 0, "event": "BASELINE", "eval_pass_rate": best}]
    log(f"baseline pass@1 {best:.3f} on {len(held)} held-out problems")

    committed, labelled = 0, {SOLUTION_DOMAIN: 0, TEST_DOMAIN: 0}
    for rnd in range(1, rounds + 1):
        batch = random.sample(train, min(train_per_round, len(train)))
        solved: list[tuple[dict, str]] = []
        for prob in batch:
            for _ in range(samples):
                code = extract_code(player.generate(prob, sample=True))
                if sandbox.verify(prob, code).passed:
                    solved.append((prob, code))
                    break  # one verified solution per problem per round
        log(f"round {rnd}: solved {len(solved)}/{len(batch)}")
        if not solved:
            history.append({"round": rnd, "event": "NO_TRAINING_DATA"})
            continue

        # Write the labelled corpus BEFORE the accept/reject decision: these
        # solutions passed real tests, so they are valid supervision whether or
        # not this particular weight update survives.
        got = write_labelled_corpus(corpus, solved)
        for k, v in got.items():
            labelled[k] += v

        generated_by = getattr(player, "model_id", "unknown")
        player.snapshot()
        try:
            stats = player.train(solved, epochs=epochs, lr=lr)
            score = evaluate(player, sandbox, held)
        except Exception as e:
            # A crash mid-training leaves half-updated weights that would be
            # carried into the next round and silently degrade everything.
            player.restore()
            history.append({"round": rnd, "event": "FAILED", "error": str(e)[:300]})
            log(f"  training/eval failed, rolled back: {e}")
            continue
        if score > best + min_gain:
            version = f"ckpt-r{rnd:03d}-{uuid.uuid4().hex[:6]}"
            promote(player, out_dir, version)
            for prob, code in solved:
                export_solution(out_dir, version, prob, code, generated_by, sandbox)
            history.append({"round": rnd, "event": "COMMITTED", "version": version,
                            "eval_pass_rate": score, "steps": stats["steps"]})
            log(f"  committed {version}: pass@1 {best:.3f} -> {score:.3f}")
            best, committed = score, committed + 1
        else:
            player.restore()
            history.append({"round": rnd, "event": "ROLLED_BACK", "eval_pass_rate": score})
            log(f"  rolled back: pass@1 {score:.3f} did not beat {best:.3f}")

    # Scored exactly once, after all selection is finished.
    final_test = evaluate(player, sandbox, test) if test else None
    summary = {"best_pass_rate": best, "validation_pass_rate": best,
               "final_test_pass_rate": final_test, "final_test_size": len(test),
               "rounds": rounds, "committed": committed,
               "labelled_records": labelled, "corpus": str(corpus), "history": history}
    write_manifest(out_dir, identity, {"best_pass_rate": best, "round": rounds,
                                       "committed": committed})
    (out_dir / "summary.json").parent.mkdir(parents=True, exist_ok=True)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description="Artemis self-improvement on verified problems")
    ap.add_argument("--checkpoint", required=True, help="Artemis checkpoint to improve")
    ap.add_argument("--tokenizer", required=True, help="tokenizer.json it was trained with")
    ap.add_argument("--problems", help="HumanEval-format .jsonl/.jsonl.gz (default: built-in set)")
    ap.add_argument("--out", default="runs/selfplay")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--train-per-round", type=int, default=16)
    ap.add_argument("--samples", type=int, default=4)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--eval-fraction", type=float, default=0.3)
    ap.add_argument("--min-gain", type=float, default=0.0)
    ap.add_argument("--max-new-tokens", type=int, default=384)
    ap.add_argument("--sandbox", choices=["docker", "local"], default="docker")
    ap.add_argument("--unsafe-local-exec", action="store_true")
    ap.add_argument("--docker-image", default="python:3.11-slim")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    player = ArtemisPlayer(args.checkpoint, args.tokenizer, args.max_new_tokens)
    sandbox = Sandbox(args.sandbox, args.timeout, args.docker_image, args.unsafe_local_exec)
    summary = run_loop(player, sandbox, load_problems(args.problems), Path(args.out),
                       rounds=args.rounds, train_per_round=args.train_per_round,
                       samples=args.samples, epochs=args.epochs, lr=args.lr,
                       eval_fraction=args.eval_fraction, min_gain=args.min_gain,
                       seed=args.seed)
    print(f"best pass@1 {summary['best_pass_rate']:.3f}; "
          f"{summary['committed']} checkpoints committed; "
          f"labelled records {summary['labelled_records']}")
    return summary


if __name__ == "__main__":
    main()
