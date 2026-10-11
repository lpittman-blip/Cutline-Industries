"""The self-improvement loop: verification, the accept/reject gate, and the
domain-labelled corpus it produces.

A scripted player stands in for the model so these tests exercise the loop's
logic rather than a checkpoint's ability to write Python. ArtemisPlayer itself
is covered by test_training.py's end-to-end checkpoint, which is slow; here the
contract that matters is that nothing is ever learned from code that did not
pass its tests.
"""
import json
from pathlib import Path

import pytest

from artemis.data import prepare
from artemis.model import EXPERT_NAMES
from artemis.selfplay import (
    SOLUTION_DOMAIN,
    TEST_DOMAIN,
    Sandbox,
    build_program,
    builtin_problems,
    evaluate,
    extract_code,
    run_loop,
    solution_source,
    split_problems,
    write_labelled_corpus,
)
from artemis.tokenizer import train_tokenizer


@pytest.fixture
def sandbox():
    return Sandbox(mode="local", timeout=10.0, unsafe_ok=True)


class ScriptedPlayer:
    """Solves a fixed set of task_ids; `improves` adds more after training."""

    model_id = "scripted"

    def __init__(self, solves: set[str], improves: set[str] = frozenset()):
        self.solves, self.improves = set(solves), set(improves)
        self.trained, self.snapshots, self.restores, self.saves = 0, 0, 0, []

    def generate(self, problem, sample):
        if problem["task_id"] in self.solves:
            return f"```python\n{problem['prompt']}{problem['canonical_solution']}```"
        return "```python\ndef wrong():\n    return None\n```"

    def snapshot(self):
        self.snapshots += 1
        self._saved = set(self.solves)

    def restore(self):
        self.restores += 1
        self.solves = set(self._saved)

    def train(self, examples, **kw):
        self.trained += 1
        self.solves |= self.improves
        return {"steps": len(examples), "final_loss": 0.1}

    def save(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text("checkpoint")
        self.saves.append(Path(path).name)


def test_solution_source_handles_both_model_styles():
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    body_only = "    return max(values)\n"
    full_func = "def find_max(values: list) -> int:\n    return max(values)\n"
    for completion in (body_only, full_func):
        ns = {}
        exec(solution_source(prob, completion), ns)
        assert ns["find_max"]([1, 9, 3]) == 9


def test_sandbox_rejects_failing_and_hanging_code(sandbox):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    assert sandbox.run(build_program(prob, prob["canonical_solution"])).passed
    assert not sandbox.run(build_program(prob, "    return 0\n")).passed
    assert not sandbox.run("while True:\n    pass\n").passed  # times out, does not hang the run


def test_local_sandbox_refuses_without_explicit_unlock():
    with pytest.raises(RuntimeError, match="disposable"):
        Sandbox(mode="local", unsafe_ok=False)


def test_split_is_stable_across_runs():
    probs = builtin_problems()
    a_train, a_held = split_problems(probs, 0.3)
    b_train, b_held = split_problems(list(reversed(probs)), 0.3)
    assert {p["task_id"] for p in a_held} == {p["task_id"] for p in b_held}
    assert not ({p["task_id"] for p in a_train} & {p["task_id"] for p in a_held})


def test_commit_only_when_held_out_improves(tmp_path, sandbox):
    probs = builtin_problems()
    train, held = split_problems(probs, 0.3)
    player = ScriptedPlayer(solves=set(), improves={p["task_id"] for p in held})
    # It cannot solve anything yet, so give it one train problem to learn from.
    player.solves = {train[0]["task_id"]}

    summary = run_loop(player, sandbox, probs, tmp_path, rounds=1,
                       train_per_round=len(train), samples=1, log=lambda *a: None)
    assert summary["committed"] == 1
    assert summary["best_pass_rate"] > 0
    assert player.restores == 0 and player.saves


def test_rollback_when_training_does_not_help(tmp_path, sandbox):
    probs = builtin_problems()
    train, _ = split_problems(probs, 0.3)
    # Solves a training problem but never any held-out one, so pass@1 cannot rise.
    player = ScriptedPlayer(solves={train[0]["task_id"]})
    summary = run_loop(player, sandbox, probs, tmp_path, rounds=2,
                       train_per_round=len(train), samples=1, log=lambda *a: None)
    assert summary["committed"] == 0
    assert player.restores == 2 and not player.saves


def test_only_verified_solutions_reach_the_corpus(tmp_path, sandbox):
    """The loop's core promise: a wrong answer never becomes training data."""
    probs = builtin_problems()
    train, _ = split_problems(probs, 0.3)
    solved_id = train[0]["task_id"]
    player = ScriptedPlayer(solves={solved_id})
    run_loop(player, sandbox, probs, tmp_path, rounds=1,
             train_per_round=len(train), samples=1, log=lambda *a: None)

    rows = [json.loads(l) for l in (tmp_path / "labelled" / "verified.jsonl").read_text().splitlines() if l.strip()]
    assert rows, "a verified solution should have been written"
    assert {r["task_id"] for r in rows} == {solved_id}


def test_corpus_domains_are_real_experts_and_prepare_labels_them(tmp_path):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    corpus = tmp_path / "verified.jsonl"
    counts = write_labelled_corpus(corpus, [(prob, prob["canonical_solution"])])
    assert counts == {SOLUTION_DOMAIN: 1, TEST_DOMAIN: 1}

    rows = [json.loads(l) for l in corpus.read_text().splitlines() if l.strip()]
    assert {r["domain"] for r in rows} <= set(EXPERT_NAMES)

    # The point of the labels: prepare() must accept them and emit the .dom
    # sidecar that route supervision reads. Unlabelled text never produces one.
    text = tmp_path / "t.txt"
    text.write_text("\n".join(r["text"] for r in rows) * 50)
    tok = tmp_path / "tok.json"
    train_tokenizer([str(text)], 512, tok)
    manifest = prepare([{"path": str(corpus), "license": "generated-and-verified",
                         "origin": "artemis.selfplay"}], str(tok), str(tmp_path / "data"))
    assert manifest["domain_labels"] is True
    assert (tmp_path / "data" / "train.dom").exists()


def test_evaluate_never_trains_on_held_out(tmp_path, sandbox):
    probs = builtin_problems()
    _, held = split_problems(probs, 0.3)
    player = ScriptedPlayer(solves={p["task_id"] for p in held})
    assert evaluate(player, sandbox, held) == 1.0
    assert player.trained == 0


def test_extract_code_unwraps_a_fence():
    assert extract_code("```python\nx = 1\n```").strip() == "x = 1"
    assert extract_code("x = 1").strip() == "x = 1"
