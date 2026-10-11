"""The SFT provenance gate, and the row construction behind it.

Two separate risks. The gate is a legal one: a row that cannot say where it came
from is indistinguishable from a hosted model's output. The row construction is a
correctness one: three of the four failure modes here produce a row that trains on
nothing while still reporting a loss.
"""
import json

import pytest

from artemis.sft import ProvenanceError, check_provenance, load_records, supervised_rows
from artemis.teachers import TEACHERS

APPROVED = sorted(TEACHERS)[0]


def human(**over):
    row = {"messages": [{"role": "user", "content": "Hi"},
                        {"role": "assistant", "content": "Hello."}],
           "consent": True, "license": "CC-BY-4.0"}
    row.update(over)
    return row


def synthetic(**over):
    row = {"messages": [{"role": "user", "content": "Hi"},
                        {"role": "assistant", "content": "Hello."}],
           "synthetic": True, "teacher": APPROVED,
           "teacher_license": TEACHERS[APPROVED], "prompt_source": "handwritten"}
    row.update(over)
    return row


# --- the gate -------------------------------------------------------------

def test_consented_human_row_passes():
    assert check_provenance(human(), "x") == "human"


def test_approved_synthetic_row_passes():
    assert check_provenance(synthetic(), "x") == "synthetic"


def test_unlabelled_row_is_refused():
    """The case the gate exists for: a convenient JSONL of unknown origin."""
    with pytest.raises(ProvenanceError):
        check_provenance({"messages": []}, "x")


def test_human_row_without_consent_is_refused():
    with pytest.raises(ProvenanceError):
        check_provenance(human(consent=False), "x")


def test_human_row_without_licence_is_refused():
    with pytest.raises(ProvenanceError):
        check_provenance(human(license=""), "x")


def test_synthetic_row_from_a_hosted_model_is_refused():
    with pytest.raises(ProvenanceError, match="not an approved"):
        check_provenance(synthetic(teacher="grok-4.7", teacher_license="mit"), "x")


def test_relabelling_a_teacher_licence_is_refused():
    """Editing the label is the easy way to smuggle a row past the gate."""
    with pytest.raises(ProvenanceError, match="regenerate"):
        check_provenance(synthetic(teacher_license="mit"), "x")


def test_synthetic_row_without_prompt_source_is_refused():
    """A model-written prompt answered by a model is the distribution-collapse case."""
    with pytest.raises(ProvenanceError, match="prompt_source"):
        check_provenance(synthetic(prompt_source=""), "x")


# --- corpus loading -------------------------------------------------------

def write(tmp_path, rows):
    p = tmp_path / "sft.jsonl"
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


def test_load_counts_both_provenances(tmp_path):
    records, counts = load_records(write(tmp_path, [human(), synthetic(), synthetic()]))
    assert len(records) == 3
    assert counts == {"human": 1, "synthetic": 2}


def test_one_bad_row_fails_the_whole_corpus(tmp_path):
    """Skipping the bad row is how an unlabelled corpus becomes a labelled one."""
    with pytest.raises(ProvenanceError, match=":2"):
        load_records(write(tmp_path, [human(), {"messages": []}, human()]))


def test_corpus_must_end_each_record_on_the_assistant(tmp_path):
    bad = human(messages=[{"role": "assistant", "content": "Hello."},
                          {"role": "user", "content": "Hi"}])
    with pytest.raises(ValueError, match="assistant"):
        load_records(write(tmp_path, [bad]))


def test_unknown_tool_is_refused(tmp_path):
    with pytest.raises(ValueError, match="unknown tool"):
        load_records(write(tmp_path, [human(allowed_tools=["rm_rf"])]))


def test_system_role_in_messages_is_refused(tmp_path):
    """The system prompt is rendered by the product, not carried per record."""
    bad = human(messages=[{"role": "system", "content": "You are Artemis."},
                          {"role": "user", "content": "Hi"},
                          {"role": "assistant", "content": "Hello."}])
    with pytest.raises(ValueError, match="user/assistant"):
        load_records(write(tmp_path, [bad]))


def test_empty_corpus_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="no usable records"):
        load_records(write(tmp_path, []))


# --- row construction -----------------------------------------------------

class FakeEncoding:
    def __init__(self, ids):
        self.ids = ids


class FakeTok:
    """One token per word, deterministic, so offsets can be asserted exactly."""

    def encode(self, text):
        return FakeEncoding([hash(w) % 1000 + 1 for w in text.split()])


class FakePlayer:
    tok = FakeTok()
    stop = [999]

    @staticmethod
    def format_chat(messages):
        return " ".join(f"{m['role']} {m['content']}" for m in messages)


def test_each_assistant_turn_becomes_a_row():
    """A four-turn chat should teach four things, not one."""
    record = {"messages": [{"role": "user", "content": "one two"},
                           {"role": "assistant", "content": "three four"},
                           {"role": "user", "content": "five six"},
                           {"role": "assistant", "content": "seven eight"}]}
    rows = supervised_rows(FakePlayer(), record, "sys", max_len=512)
    assert len(rows) == 2


def test_prompt_positions_are_masked_and_answer_positions_are_not():
    record = {"messages": [{"role": "user", "content": "one two"},
                           {"role": "assistant", "content": "three four"}]}
    (xs, ys), = supervised_rows(FakePlayer(), record, "sys", max_len=512)
    assert len(xs) == len(ys)
    assert any(y == -100 for y in ys), "prompt tokens must be masked"
    assert any(y != -100 for y in ys), "answer tokens must be supervised"
    # Labels are shifted once: the model applies cross_entropy with no internal shift.
    assert ys[-1] == FakePlayer.stop[0]


def test_answer_capacity_is_reserved_before_truncation():
    """Taking the first max_len tokens of prompt+answer yields an all-prompt row."""
    record = {"messages": [{"role": "user", "content": " ".join(f"w{i}" for i in range(400))},
                           {"role": "assistant", "content": "alpha beta gamma"}]}
    rows = supervised_rows(FakePlayer(), record, "sys", max_len=64)
    assert rows, "a long prompt must not drop the row entirely"
    _xs, ys = rows[0]
    assert any(y != -100 for y in ys), "the answer survived truncation"


def test_row_is_dropped_when_nothing_can_be_supervised():
    """Checked after the shift, not before: an empty label set makes the loss NaN."""
    record = {"messages": [{"role": "user", "content": "one two"},
                           {"role": "assistant", "content": "three"}]}
    assert supervised_rows(FakePlayer(), record, "sys", max_len=1) == []
