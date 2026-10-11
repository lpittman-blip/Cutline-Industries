"""The self-improvement loop: verification, the accept/reject gate, and the
domain-labelled corpus it produces.

A scripted player stands in for the model so these tests exercise the loop's
logic rather than a checkpoint's ability to write Python. ArtemisPlayer itself
is covered by test_training.py's end-to-end checkpoint, which is slow; here the
contract that matters is that nothing is ever learned from code that did not
pass its tests.
"""
import json
import subprocess
from pathlib import Path

import pytest

from artemis.data import prepare
from artemis.model import EXPERT_NAMES
from artemis.selfplay import (
    SOLUTION_DOMAIN,
    export_solution,
    load_problems,
    validate_problems,
    three_way_split,
    run_identity,
    write_manifest,
    load_manifest,
    promote,
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
    assert sandbox.verify(prob, prob["canonical_solution"]).passed
    assert not sandbox.verify(prob, "    return 0\n").passed
    assert not sandbox.run("while True:\n    pass\n").passed  # times out, does not hang the run


# --- review bug 1: a clean exit is not proof that the tests ran -------------

@pytest.mark.parametrize("completion,should_pass,why", [
    ("    return max(values)\n", True, "normal completion"),
    ("    import sys\n    sys.exit(0)\n", False, "sys.exit(0) before assertions finish"),
    ("    import os\n    os._exit(0)\n", False, "os._exit(0) skips the harness entirely"),
    ("    return 0\n", False, "ordinary assertion failure"),
    ("    raise SystemExit(0)\n", False, "SystemExit raised directly"),
])
def test_early_exit_is_never_counted_as_a_pass(sandbox, completion, should_pass, why):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    assert sandbox.verify(prob, completion).passed is should_pass, why


def test_missing_verdict_reports_incomplete(sandbox):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    r = sandbox.verify(prob, "    import os\n    os._exit(0)\n")
    assert not r.passed and "incomplete" in r.error


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


# --- review bug 2: docker deadline and guaranteed cleanup ------------------

def test_docker_command_has_identity_and_isolation():
    import shutil as _sh
    from unittest.mock import patch
    with patch.object(_sh, "which", return_value="/usr/bin/docker"):
        sb = Sandbox(mode="docker", timeout=1.0)
    seen = {}

    class FakeProc:
        stdin, stdout = None, None
        def __init__(self): self.stdin = _Devnull(); self.stdout = _Empty()
        def wait(self, timeout=None): raise subprocess.TimeoutExpired("docker", 1)
        def poll(self): return None
        def kill(self): seen["killed"] = True

    class _Devnull:
        def write(self, b): pass
        def close(self): pass

    class _Empty:
        def read(self, n=-1): return b""
        def close(self): pass

    def fake_popen(cmd, **kw):
        seen["cmd"] = cmd
        return FakeProc()

    def fake_run(cmd, **kw):
        seen.setdefault("cleanup", []).append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    with patch.object(subprocess, "Popen", fake_popen), \
         patch.object(subprocess, "run", fake_run):
        r = sb.run("while True: pass")

    assert r.error == "timeout"
    cmd = seen["cmd"]
    assert "--name" in cmd, "container needs a unique identity to be cleanable"
    name = cmd[cmd.index("--name") + 1]
    assert name.startswith("artemis-sbx-")
    for flag in ("--network", "none", "--read-only", "--memory", "--pids-limit"):
        assert flag in cmd
    # the bug: a timed-out container was left running
    assert seen.get("killed"), "the docker client process must be killed"
    assert ["docker", "rm", "-f", name] in seen["cleanup"], "container must be force-removed"


def test_docker_absence_is_an_infrastructure_error_not_a_wrong_answer():
    import shutil as _sh
    from unittest.mock import patch
    with patch.object(_sh, "which", return_value="/usr/bin/docker"):
        sb = Sandbox(mode="docker", timeout=1.0)
    with patch.object(subprocess, "Popen", side_effect=FileNotFoundError("docker")), \
         patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
        r = sb.run("pass")
    assert r.infrastructure_error and not r.passed


# --- review bug 5: dataset and argument validation -------------------------

def test_empty_dataset_is_rejected_clearly():
    with pytest.raises(ValueError, match="empty"):
        validate_problems([])


def test_duplicate_task_ids_are_rejected():
    probs = builtin_problems()
    with pytest.raises(ValueError, match="duplicate"):
        validate_problems(probs + [probs[0]])


def test_malformed_problem_is_rejected():
    with pytest.raises(ValueError, match="missing"):
        validate_problems([{"task_id": "x", "prompt": "p"}])


@pytest.mark.parametrize("frac", [0.0, 1.0, -0.1, 1.5])
def test_degenerate_eval_fraction_is_rejected(frac):
    with pytest.raises(ValueError, match="between 0 and 1"):
        split_problems(builtin_problems(), frac)


def test_missing_problems_file_is_an_error_not_a_silent_fallback(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_problems(tmp_path / "does-not-exist.jsonl")


def test_negative_min_gain_is_rejected(tmp_path, sandbox):
    with pytest.raises(ValueError, match="non-negative"):
        run_loop(ScriptedPlayer(solves=set()), sandbox, builtin_problems(), tmp_path,
                 rounds=1, min_gain=-0.5, log=lambda *a: None)


@pytest.mark.parametrize("kw", [{"rounds": 0}, {"samples": 0}, {"train_per_round": 0}, {"epochs": 0}])
def test_nonpositive_counts_are_rejected(tmp_path, sandbox, kw):
    with pytest.raises(ValueError, match="at least 1"):
        run_loop(ScriptedPlayer(solves=set()), sandbox, builtin_problems(), tmp_path,
                 log=lambda *a: None, **kw)


# --- review bug 4: exported artifacts are the verified ones ----------------

def test_export_compiles_and_reverifies(tmp_path, sandbox):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    path = export_solution(tmp_path, "ckpt-002", prob, prob["canonical_solution"],
                           generated_by="ckpt-001", sandbox=sandbox)
    text = path.read_text()
    compile(text, str(path), "exec")                       # the body-only bug
    assert "Generated by: ckpt-001" in text                 # provenance split
    assert "Trained into: ckpt-002" in text


def test_export_refuses_code_that_does_not_compile(tmp_path):
    prob = next(p for p in builtin_problems() if p["entry_point"] == "find_max")
    with pytest.raises(SyntaxError):
        export_solution(tmp_path, "v", prob, "    this is not python(\n", "gen")


# --- review bug 3 is exercised in test_selfplay_training.py (needs torch) ---


# --- review item 7: a reserved final test set ------------------------------

def test_three_way_split_is_disjoint_and_stable():
    probs = builtin_problems() * 1  # stable ids
    probs = [dict(p, task_id=f"T/{i}") for i, p in enumerate(builtin_problems() * 5)]
    tr, va, te = three_way_split(probs, 0.2, 0.1)
    a, b, c = ({p["task_id"] for p in s} for s in (tr, va, te))
    assert a and b and c
    assert not (a & b) and not (a & c) and not (b & c)
    # stable under input order
    tr2, va2, te2 = three_way_split(list(reversed(probs)), 0.2, 0.1)
    assert {p["task_id"] for p in te2} == c


def test_final_test_set_is_scored_but_never_selected_on(tmp_path, sandbox):
    probs = [dict(p, task_id=f"T/{i}") for i, p in enumerate(builtin_problems() * 5)]
    tr, va, te = three_way_split(probs, 0.2, 0.1)
    player = ScriptedPlayer(solves={p["task_id"] for p in tr[:1]})
    summary = run_loop(player, sandbox, probs, tmp_path, rounds=1,
                       train_per_round=4, samples=1, test_fraction=0.1,
                       log=lambda *a: None)
    assert summary["final_test_size"] == len(te)
    assert summary["final_test_pass_rate"] is not None
    assert "validation_pass_rate" in summary


def test_split_fractions_must_leave_training_problems():
    with pytest.raises(ValueError, match="leave training"):
        three_way_split(builtin_problems(), 0.8, 0.3)


# --- review item 6: resume must validate run identity ----------------------

def test_resume_rejects_a_different_dataset(tmp_path):
    a = builtin_problems()
    b = [dict(p, task_id=p["task_id"] + "-x") for p in a]
    ident_a = run_identity(a, "", {"seed": 0})
    write_manifest(tmp_path, ident_a, {"best_pass_rate": 0.5})
    assert load_manifest(tmp_path, ident_a) == {"best_pass_rate": 0.5}
    with pytest.raises(ValueError, match="dataset_sha256 differs"):
        load_manifest(tmp_path, run_identity(b, "", {"seed": 0}))


def test_resume_rejects_changed_config(tmp_path):
    a = builtin_problems()
    write_manifest(tmp_path, run_identity(a, "", {"seed": 0}), {})
    with pytest.raises(ValueError, match="config seed"):
        load_manifest(tmp_path, run_identity(a, "", {"seed": 1}))


def test_no_manifest_means_a_fresh_run(tmp_path):
    assert load_manifest(tmp_path, run_identity(builtin_problems(), "", {})) is None


def test_promotion_preserves_the_previous_checkpoint(tmp_path):
    """A failed promotion must not destroy what was already accepted."""
    class P:
        def __init__(self): self.fail = False
        def save(self, path):
            if self.fail:
                raise RuntimeError("disk full")
            Path(path).write_text("weights")
    p = P()
    first = promote(p, tmp_path, "ckpt-001")
    assert first.exists()
    p.fail = True
    with pytest.raises(RuntimeError):
        promote(p, tmp_path, "ckpt-002")
    assert first.exists() and first.read_text() == "weights"
    accepted = json.loads((tmp_path / "checkpoints" / "accepted.json").read_text())
    assert accepted["accepted"] == "ckpt-001.pt", "pointer must still name the good checkpoint"
    assert not (tmp_path / "checkpoints" / "ckpt-002.pt").exists()
