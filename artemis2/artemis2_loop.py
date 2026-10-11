#!/usr/bin/env python3
"""
Artemis 2.0 self-improvement loop (Cutline Industries).

A pretrained code model writes solutions to Python problems. Every solution
runs inside a sandbox against the problem's tests. Passing solutions from the
TRAIN split become LoRA fine-tuning data. An adapter update is kept only if
pass@1 on the held-out EVAL split goes up; otherwise it is rolled back.

Weights label: the base model is third-party (default Qwen2.5-Coder-1.5B-
Instruct). Only the LoRA adapter is trained here. Output from this loop is
NOT from Artemis-from-scratch weights and is labelled that way everywhere.

Quick start
  pip install -r requirements.txt
  python artemis2_loop.py --download-humaneval      # once, needs internet
  python artemis2_loop.py --rounds 5                 # docker sandbox (default)
  open http://127.0.0.1:8080

Pipeline test without torch or a GPU:
  python artemis2_loop.py --mock-model --sandbox local --unsafe-local-exec
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import html
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
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HUMANEVAL_URL = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz"
WEIGHTS_LABEL = "third-party base weights + Artemis LoRA adapter (not Artemis-from-scratch weights)"

# ---------------------------------------------------------------------------
# Problems
# ---------------------------------------------------------------------------

BUILTIN_PROBLEMS = [
    ("is_prime", 'def is_prime(n: int) -> bool:\n    """Return True if n is a prime number."""\n',
     "    if n < 2:\n        return False\n    i = 2\n    while i * i <= n:\n        if n % i == 0:\n            return False\n        i += 1\n    return True\n",
     "def check(candidate):\n    assert candidate(11) is True\n    assert candidate(1) is False\n    assert candidate(15) is False\n    assert candidate(97) is True\n"),
    ("find_max", 'def find_max(values: list) -> int:\n    """Return the largest number in a non-empty list."""\n',
     "    best = values[0]\n    for v in values:\n        if v > best:\n            best = v\n    return best\n",
     "def check(candidate):\n    assert candidate([1, 5, 2]) == 5\n    assert candidate([-3, -1, -7]) == -1\n"),
    ("factorial", 'def factorial(n: int) -> int:\n    """Return n! for n >= 0."""\n',
     "    out = 1\n    for i in range(2, n + 1):\n        out *= i\n    return out\n",
     "def check(candidate):\n    assert candidate(0) == 1\n    assert candidate(5) == 120\n"),
    ("reverse_words", 'def reverse_words(s: str) -> str:\n    """Reverse the order of words separated by single spaces."""\n',
     "    return ' '.join(s.split(' ')[::-1])\n",
     "def check(candidate):\n    assert candidate('a b c') == 'c b a'\n    assert candidate('hello') == 'hello'\n"),
    ("is_palindrome", 'def is_palindrome(s: str) -> bool:\n    """Return True if s reads the same backwards, ignoring case."""\n',
     "    s = s.lower()\n    return s == s[::-1]\n",
     "def check(candidate):\n    assert candidate('Racecar') is True\n    assert candidate('abc') is False\n"),
    ("fib", 'def fib(n: int) -> int:\n    """Return the n-th Fibonacci number, fib(0) == 0, fib(1) == 1."""\n',
     "    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n",
     "def check(candidate):\n    assert candidate(0) == 0\n    assert candidate(10) == 55\n"),
    ("rsa_private_key", 'def rsa_private_key(p: int, q: int, e: int) -> int:\n    """Return d such that (e * d) % ((p-1)*(q-1)) == 1."""\n',
     "    return pow(e, -1, (p - 1) * (q - 1))\n",
     "def check(candidate):\n    d = candidate(61, 53, 17)\n    assert (17 * d) % (60 * 52) == 1\n"),
    ("prime_factors", 'def prime_factors(n: int) -> list:\n    """Return the prime factors of n > 1 in ascending order, with repeats."""\n',
     "    out, d = [], 2\n    while d * d <= n:\n        while n % d == 0:\n            out.append(d)\n            n //= d\n        d += 1\n    if n > 1:\n        out.append(n)\n    return out\n",
     "def check(candidate):\n    assert candidate(13195) == [5, 7, 13, 29]\n    assert candidate(12) == [2, 2, 3]\n"),
    ("count_vowels", 'def count_vowels(s: str) -> int:\n    """Count the vowels a, e, i, o, u in s, case-insensitive."""\n',
     "    return sum(1 for c in s.lower() if c in 'aeiou')\n",
     "def check(candidate):\n    assert candidate('Artemis') == 3\n    assert candidate('xyz') == 0\n"),
    ("flatten", 'def flatten(items: list) -> list:\n    """Flatten one level of nesting: [[1, 2], [3]] -> [1, 2, 3]."""\n',
     "    return [x for sub in items for x in sub]\n",
     "def check(candidate):\n    assert candidate([[1, 2], [3]]) == [1, 2, 3]\n    assert candidate([]) == []\n"),
]


def builtin_problems() -> list[dict]:
    return [
        {"task_id": f"Builtin/{name}", "prompt": prompt, "canonical_solution": sol,
         "test": test, "entry_point": name}
        for name, prompt, sol, test in BUILTIN_PROBLEMS
    ]


def load_problems(path: Path | None) -> list[dict]:
    if path is None or not path.exists():
        return builtin_problems()
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def download_humaneval(dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading HumanEval to {dest} ...")
    req = urllib.request.Request(HUMANEVAL_URL, headers={"User-Agent": "artemis2-loop"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    n = len(load_problems(dest))
    print(f"Saved {n} problems.")
    return dest


def split_problems(problems: list[dict], eval_fraction: float) -> tuple[list[dict], list[dict]]:
    """Deterministic split by task_id hash, so the eval set never moves between runs."""
    train, held = [], []
    for p in problems:
        h = int(hashlib.sha256(p["task_id"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        (held if h < eval_fraction else train).append(p)
    if not held:
        held.append(train.pop())
    return train, held


# ---------------------------------------------------------------------------
# Code extraction and sandboxed execution
# ---------------------------------------------------------------------------

FENCE = re.compile(r"```(?:python|py)?\s*\n([\s\S]*?)```")


def extract_code(raw: str, completion_mode: bool) -> str:
    m = FENCE.search(raw)
    code = m.group(1) if m else raw
    if completion_mode:
        # A completion model keeps writing new functions/tests after the body; cut there.
        for stop in ("\ndef ", "\nclass ", "\nif __name__", "\nprint(", "\n#", "\nassert "):
            i = code.find(stop)
            if i != -1:
                code = code[:i]
    return code.rstrip() + "\n"


def solution_source(problem: dict, completion: str) -> str:
    """The completion as a standalone, importable definition of the function.

    A chat model usually returns the whole function, in which case it redefines
    the docstring-only stub. A base model in completion mode returns only the
    indented body, which is a syntax error on its own and has to keep the stub
    in front of it.
    """
    ep = problem["entry_point"]
    if re.search(rf"^\s*def\s+{re.escape(ep)}\s*\(", completion, re.M):
        return problem["prompt"] + "\n" + completion
    return problem["prompt"] + completion


def build_program(problem: dict, completion: str) -> str:
    ep = problem["entry_point"]
    return f"{solution_source(problem, completion)}\n\n{problem['test']}\n\ncheck({ep})\n"


@dataclass
class RunResult:
    passed: bool
    error: str
    seconds: float


class Sandbox:
    """Runs untrusted generated code. Docker by default: no network, read-only FS,
    capped memory/CPU/pids. 'local' is only for pipeline testing and must be
    explicitly unlocked, because it runs code on this machine."""

    def __init__(self, mode: str, timeout: float, image: str, unsafe_ok: bool):
        self.mode, self.timeout, self.image = mode, timeout, image
        if mode == "docker":
            if not shutil.which("docker"):
                sys.exit("Sandbox 'docker' selected but docker is not installed. "
                         "Install Docker, or for a throwaway test only: --sandbox local --unsafe-local-exec")
        elif mode == "local" and not unsafe_ok:
            sys.exit("Refusing to run generated code directly on this host. "
                     "Add --unsafe-local-exec only on a disposable machine or VM.")

    def run(self, program: str) -> RunResult:
        start = time.perf_counter()
        try:
            if self.mode == "docker":
                cmd = ["docker", "run", "--rm", "-i", "--network", "none", "--read-only",
                       "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
                       "--tmpfs", "/tmp:size=16m", "--user", "65534:65534",
                       self.image, "python", "-I", "-"]
                p = subprocess.run(cmd, input=program, capture_output=True, text=True,
                                   timeout=self.timeout + 10)
            else:
                p = self._run_local(program)
        except subprocess.TimeoutExpired:
            return RunResult(False, "timeout", time.perf_counter() - start)
        secs = time.perf_counter() - start
        if p.returncode == 0:
            return RunResult(True, "", secs)
        lines = (p.stderr or "").strip().splitlines()
        return RunResult(False, (lines[-1] if lines else f"exit {p.returncode}")[:300], secs)

    def _run_local(self, program: str) -> subprocess.CompletedProcess:
        def limits():
            try:
                import resource
                resource.setrlimit(resource.RLIMIT_CPU, (int(self.timeout), int(self.timeout) + 1))
                resource.setrlimit(resource.RLIMIT_AS, (512 * 2**20, 512 * 2**20))
                resource.setrlimit(resource.RLIMIT_FSIZE, (2**20, 2**20))
                resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
            except Exception:
                pass
        with tempfile.TemporaryDirectory(prefix="artemis-sbx-") as d:
            return subprocess.run([sys.executable, "-I", "-"], input=program, cwd=d,
                                  capture_output=True, text=True, timeout=self.timeout,
                                  env={"PATH": "/usr/bin:/bin"},
                                  preexec_fn=limits if os.name == "posix" else None)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class MockModel:
    """No torch needed. Returns canonical solutions, sometimes broken; a 'training'
    step lowers the break rate for problems it was trained on. Tests the pipeline only."""
    model_id = "mock"
    completion_mode = False

    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)
        self.skill: dict[str, float] = {}
        self._snapshot: dict[str, float] = {}

    def generate(self, problem: dict, sample: bool) -> str:
        p_ok = min(0.95, self.skill.get(problem["task_id"], 0.35) + self.skill.get("__general__", 0.0))
        # Greedy decoding is deterministic: a fixed per-problem "difficulty" in [0, 1).
        draw = self.rng.random() if sample else int(sha("difficulty:" + problem["task_id"]), 16) / 16**12
        if draw < p_ok:
            return f"```python\n{problem['prompt']}{problem['canonical_solution']}```"
        return f"```python\n{problem['prompt']}    return None\n```"

    def snapshot(self):
        self._snapshot = dict(self.skill)

    def restore(self):
        self.skill = dict(self._snapshot)

    def train(self, examples: list[tuple[dict, str]], **_):
        for prob, _code in examples:
            self.skill[prob["task_id"]] = min(0.95, self.skill.get(prob["task_id"], 0.35) + 0.3)
        # Stand-in for generalisation to unseen problems; a random sign so some
        # updates hurt and the rollback path gets exercised too.
        self.skill["__general__"] = self.skill.get("__general__", 0.0) + self.rng.choice([0.2, 0.2, -0.1])
        return {"steps": len(examples), "final_loss": 0.0}

    def save_adapter(self, path: Path):
        path.mkdir(parents=True, exist_ok=True)
        (path / "mock_adapter.json").write_text(json.dumps(self.skill, indent=1))


class HFModel:
    def __init__(self, model_id: str, use_4bit: bool, lora_r: int, max_new_tokens: int):
        import torch
        from peft import LoraConfig, TaskType, get_peft_model, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.model_id = model_id
        self.max_new_tokens = max_new_tokens
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tok = AutoTokenizer.from_pretrained(model_id)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.completion_mode = not getattr(self.tok, "chat_template", None)

        kwargs: dict = {}
        if use_4bit and self.device == "cuda":
            from transformers import BitsAndBytesConfig
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_use_double_quant=True, bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16)
            kwargs["device_map"] = "auto"
        else:
            kwargs["dtype"] = torch.bfloat16 if self.device == "cuda" else torch.float32
        print(f"Loading {model_id} on {self.device}{' (4-bit NF4)' if 'quantization_config' in kwargs else ''} ...")
        base = AutoModelForCausalLM.from_pretrained(model_id, **kwargs)
        if "quantization_config" in kwargs:
            base = prepare_model_for_kbit_training(base)
        elif self.device == "cuda":
            base = base.to("cuda")
        cfg = LoraConfig(task_type=TaskType.CAUSAL_LM, r=lora_r, lora_alpha=lora_r * 4,
                         lora_dropout=0.05, target_modules="all-linear")
        self.model = get_peft_model(base, cfg)
        self.model.print_trainable_parameters()
        self._snapshot = None

    def _prompt_text(self, problem: dict) -> str:
        if self.completion_mode:
            return problem["prompt"]
        msg = ("Complete this Python function. Reply with one ```python code block containing the "
               "full function (and any imports it needs), no explanation.\n\n" + problem["prompt"])
        return self.tok.apply_chat_template([{"role": "user", "content": msg}],
                                            tokenize=False, add_generation_prompt=True)

    def generate(self, problem: dict, sample: bool) -> str:
        torch = self.torch
        text = self._prompt_text(problem)
        inputs = self.tok(text, return_tensors="pt").to(self.model.device)
        gen = dict(max_new_tokens=self.max_new_tokens, pad_token_id=self.tok.pad_token_id)
        gen.update(do_sample=True, temperature=0.8, top_p=0.95) if sample else gen.update(do_sample=False)
        self.model.eval()
        with torch.no_grad():
            out = self.model.generate(**inputs, **gen)
        return self.tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

    def snapshot(self):
        from peft import get_peft_model_state_dict
        self._snapshot = {k: v.detach().clone() for k, v in get_peft_model_state_dict(self.model).items()}

    def restore(self):
        from peft import set_peft_model_state_dict
        if self._snapshot is not None:
            set_peft_model_state_dict(self.model, self._snapshot)

    def train(self, examples: list[tuple[dict, str]], epochs: int = 2, lr: float = 2e-4,
              max_len: int = 768) -> dict:
        torch = self.torch
        rows = []
        for prob, code in examples:
            prompt = self._prompt_text(prob)
            target = code if self.completion_mode else f"```python\n{code}```"
            p_ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
            t_ids = self.tok(target, add_special_tokens=False)["input_ids"] + [self.tok.eos_token_id]
            ids = (p_ids + t_ids)[:max_len]
            labels = ([-100] * len(p_ids) + t_ids)[:max_len]   # loss only on the answer
            rows.append((ids, labels))
        params = [p for p in self.model.parameters() if p.requires_grad]
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
        self.model.train()
        steps, last = 0, float("nan")
        for _ in range(epochs):
            random.shuffle(rows)
            for ids, labels in rows:
                x = torch.tensor([ids], device=self.model.device)
                y = torch.tensor([labels], device=self.model.device)
                loss = self.model(input_ids=x, labels=y).loss
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)
                steps, last = steps + 1, float(loss.detach())
        self.model.eval()
        return {"steps": steps, "final_loss": round(last, 4)}

    def save_adapter(self, path: Path):
        self.model.save_pretrained(str(path))


# ---------------------------------------------------------------------------
# Telemetry and dashboard
# ---------------------------------------------------------------------------

@dataclass
class Event:
    kind: str                 # BASELINE, SAMPLE_PASS, SAMPLE_FAIL, ADAPTER_COMMITTED, ADAPTER_ROLLED_BACK, NO_TRAINING_DATA
    round: int
    detail: str = ""
    task_id: str = ""
    code_sha: str = ""
    eval_pass_rate: float | None = None
    best_pass_rate: float | None = None
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))


class Telemetry:
    def __init__(self, root: Path, run_info: dict):
        self.path = root / "telemetry" / "events.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.run_info = run_info
        self.events: list[dict] = []

    def log(self, ev: Event):
        row = asdict(ev)
        with self.lock:
            self.events.append(row)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")

    def snapshot(self) -> tuple[dict, list[dict]]:
        with self.lock:
            return dict(self.run_info), list(self.events[-40:])


COLORS = {"ADAPTER_COMMITTED": "#2f7a4f", "ADAPTER_ROLLED_BACK": "#b3352c", "BASELINE": "#1f5f8b",
          "SAMPLE_PASS": "#3b6e4f", "SAMPLE_FAIL": "#8a5a1c", "NO_TRAINING_DATA": "#6b7280"}


def pct(x: float | None) -> str:
    return "" if x is None else f"{x * 100:.1f}%"


def start_dashboard(tel: Telemetry, host: str, port: int):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path not in ("/", "/events.json"):
                self.send_error(404)
                return
            info, events = tel.snapshot()
            if self.path == "/events.json":
                body = json.dumps({"run": info, "events": events}).encode()
                ctype = "application/json"
            else:
                e = html.escape
                rows = "".join(
                    f"<tr><td>{e(r['ts'][11:19])}</td><td>{r['round']}</td>"
                    f"<td><span class=k style='background:{COLORS.get(r['kind'], '#555')}'>{e(r['kind'])}</span></td>"
                    f"<td>{e(r['task_id'])}</td>"
                    f"<td>{pct(r['eval_pass_rate'])}</td>"
                    f"<td class=d>{e(r['detail'])}</td></tr>"
                    for r in reversed(events))
                stats = "".join(f"<div><b>{e(str(v))}</b><span>{e(k)}</span></div>" for k, v in info.items())
                body = f"""<!doctype html><html><head><meta charset=utf-8><meta http-equiv=refresh content=3>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Artemis 2.0 Loop</title><style>
body{{font:14px system-ui,sans-serif;margin:0;padding:20px;background:#0f161c;color:#e5ebef}}
h1{{margin:0 0 4px;font-size:22px}} .lbl{{color:#e8874a;margin:0 0 16px}}
.s{{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-bottom:18px}}
.s div{{background:#161f27;border:1px solid #26333d;padding:10px}} .s b{{display:block;font-size:17px}} .s span{{color:#93a2ad;font-size:12px}}
.t{{overflow-x:auto}} table{{width:100%;border-collapse:collapse;min-width:640px}} td,th{{padding:8px 10px;border-bottom:1px solid #26333d;text-align:left}}
th{{color:#93a2ad;font-size:11px;text-transform:uppercase}} .k{{color:#fff;padding:2px 6px;border-radius:3px;font-size:12px}}
.d{{font-family:ui-monospace,monospace;font-size:12px;color:#93a2ad}}</style></head><body>
<h1>Artemis 2.0 self-improvement loop</h1><p class=lbl>{e(info.get("weights", WEIGHTS_LABEL))}</p>
<div class=s>{stats}</div><div class=t><table><thead><tr><th>Time (UTC)</th><th>Round</th><th>Event</th><th>Task</th><th>Eval pass@1</th><th>Detail</th></tr></thead>
<tbody>{rows or '<tr><td colspan=6>Waiting for the first round...</td></tr>'}</tbody></table></div></body></html>""".encode()
                ctype = "text/html; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = ThreadingHTTPServer((host, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Dashboard: http://{host}:{port}")
    return srv


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:12]


def evaluate(model, sandbox: Sandbox, problems: list[dict]) -> float:
    """Greedy pass@1 on the held-out split. Never used as training data."""
    passed = 0
    for p in problems:
        code = extract_code(model.generate(p, sample=False), model.completion_mode)
        passed += sandbox.run(build_program(p, code)).passed
    return passed / len(problems)


def export_solution(root: Path, version: str, prob: dict, code: str, model_id: str,
                    weights_label: str = WEIGHTS_LABEL):
    out = root / "committed_artifacts" / version
    out.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9_]", "_", prob["task_id"]) + ".py"
    header = (f"# Artemis 2.0 verified solution\n# Task: {prob['task_id']}\n# Adapter: {version}\n"
              f"# Weights: {model_id} ({weights_label})\n# Passed sandboxed tests at "
              f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}\n\n")
    # Export what the sandbox actually graded, not the raw completion. In
    # completion mode `code` is a bare indented body, which does not parse on
    # its own, so every committed artifact would have been unusable.
    (out / name).write_text(header + solution_source(prob, code), encoding="utf-8")


def run(args):
    root = Path(args.workdir).resolve()
    root.mkdir(parents=True, exist_ok=True)

    problems_path = Path(args.problems) if args.problems else root / "data" / "HumanEval.jsonl.gz"
    if args.download_humaneval:
        download_humaneval(problems_path)
        if args.rounds == 0:
            return
    problems = load_problems(problems_path)
    source = problems_path.name if problems_path.exists() else "built-in set (10 problems)"
    train, held = split_problems(problems, args.eval_fraction)

    model = MockModel(args.seed) if args.mock_model else HFModel(
        args.model, not args.no_4bit, args.lora_r, args.max_new_tokens)
    label = WEIGHTS_LABEL
    sandbox = Sandbox(args.sandbox, args.timeout, args.docker_image, args.unsafe_local_exec)
    random.seed(args.seed)

    info = {"base model": model.model_id, "problems": source, "train / eval": f"{len(train)} / {len(held)}",
            "sandbox": args.sandbox, "weights": label, "round": 0, "best eval pass@1": "-", "committed adapter": "none"}
    tel = Telemetry(root, info)
    if not args.no_dashboard:
        start_dashboard(tel, args.host, args.port)

    best = evaluate(model, sandbox, held)
    info["best eval pass@1"] = f"{best*100:.1f}%"
    tel.log(Event("BASELINE", 0, "base model before any adapter training", eval_pass_rate=best, best_pass_rate=best))
    print(f"Baseline eval pass@1: {best:.3f} on {len(held)} held-out problems")

    for rnd in range(1, args.rounds + 1):
        info["round"] = rnd
        batch = random.sample(train, min(args.train_per_round, len(train)))
        examples: list[tuple[dict, str]] = []
        for prob in batch:
            for _ in range(args.samples):
                code = extract_code(model.generate(prob, sample=True), model.completion_mode)
                res = sandbox.run(build_program(prob, code))
                tel.log(Event("SAMPLE_PASS" if res.passed else "SAMPLE_FAIL", rnd,
                              f"{res.seconds:.2f}s" if res.passed else res.error, prob["task_id"], sha(code)))
                if res.passed:
                    examples.append((prob, code))
                    break  # one verified solution per problem per round
        print(f"Round {rnd}: {len(examples)}/{len(batch)} train problems solved")
        if not examples:
            tel.log(Event("NO_TRAINING_DATA", rnd, "no passing samples this round"))
            continue

        model.snapshot()
        stats = model.train(examples, epochs=args.epochs, lr=args.lr)
        score = evaluate(model, sandbox, held)
        if score > best + args.min_gain:
            version = f"adapter-r{rnd:03d}-{uuid.uuid4().hex[:6]}"
            model.save_adapter(root / "adapters" / version)
            for prob, code in examples:
                export_solution(root, version, prob, code, model.model_id, label)
            tel.log(Event("ADAPTER_COMMITTED", rnd, f"{version}; {stats['steps']} steps, loss {stats['final_loss']}",
                          eval_pass_rate=score, best_pass_rate=score))
            print(f"  committed {version}: eval pass@1 {best:.3f} -> {score:.3f}")
            best = score
            info["best eval pass@1"] = f"{best*100:.1f}%"
            info["committed adapter"] = version
        else:
            model.restore()
            tel.log(Event("ADAPTER_ROLLED_BACK", rnd, f"eval {score:.3f} did not beat {best:.3f}",
                          eval_pass_rate=score, best_pass_rate=best))
            print(f"  rolled back: eval pass@1 {score:.3f} <= best {best:.3f}")

    print(f"Done. Best eval pass@1 {best:.3f}. Telemetry: {tel.path}")
    if not args.no_dashboard and not args.exit_when_done:
        print("Dashboard still running; Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Artemis 2.0 self-improvement loop")
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    ap.add_argument("--mock-model", action="store_true", help="no torch; tests the pipeline only")
    ap.add_argument("--no-4bit", action="store_true", help="disable NF4 quantization on CUDA")
    ap.add_argument("--problems", help="HumanEval-format .jsonl or .jsonl.gz (default: workdir/data/HumanEval.jsonl.gz, else built-in)")
    ap.add_argument("--download-humaneval", action="store_true")
    ap.add_argument("--eval-fraction", type=float, default=0.3)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--train-per-round", type=int, default=32)
    ap.add_argument("--samples", type=int, default=4, help="attempts per train problem per round")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=8)
    ap.add_argument("--max-new-tokens", type=int, default=384)
    ap.add_argument("--min-gain", type=float, default=0.0, help="eval pass@1 must exceed best by more than this")
    ap.add_argument("--sandbox", choices=["docker", "local"], default="docker")
    ap.add_argument("--unsafe-local-exec", action="store_true")
    ap.add_argument("--docker-image", default="python:3.11-slim")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--workdir", default="./artemis2_runs")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--no-dashboard", action="store_true")
    ap.add_argument("--exit-when-done", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    run(ap.parse_args(argv))


if __name__ == "__main__":
    main()
