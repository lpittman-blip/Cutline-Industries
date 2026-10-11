"""Review bug 3: a long prompt must not consume the whole token budget.

Truncating prompt+answer to the first max_len tokens can leave a row whose
labels are every single -100. Cross-entropy over an empty label set is NaN,
and a NaN step destroys every weight in the model without raising anything.
These tests drive the real ArtemisPlayer.train against a tiny real checkpoint.
"""
import pytest

torch = pytest.importorskip("torch")

from artemis.checkpoint import save
from artemis.model import ArtemisLM, ModelConfig
from artemis.selfplay import ArtemisPlayer
from artemis.tokenizer import train_tokenizer


@pytest.fixture(scope="module")
def player(tmp_path_factory):
    d = tmp_path_factory.mktemp("sp")
    text = d / "t.txt"
    text.write_text("def f(x):\n    return x + 1\n" * 400 + "hello world artemis\n" * 400)
    tok = d / "tok.json"
    train_tokenizer([str(text)], 512, tok)
    cfg = ModelConfig(vocab_size=512, d_model=64, n_layers=2, n_heads=4,
                      n_kv_heads=2, max_seq_len=128)
    ck = d / "m.pt"
    save(ck, ArtemisLM(cfg), step=1)
    return ArtemisPlayer(str(ck), str(tok), max_new_tokens=4, device="cpu")


def _problem(prompt: str) -> dict:
    return {"task_id": "T/1", "prompt": prompt, "test": "def check(c):\n    pass\n",
            "entry_point": "f", "canonical_solution": "    return 1\n"}


def test_overlong_prompt_still_supervises_the_answer(player):
    """The reproduction case: a prompt far longer than the budget."""
    stats = player.train([(_problem("x = 1\n" * 4000), "def f():\n    return 1\n")],
                         epochs=1, max_len=128)
    assert stats["steps"] >= 1, "the example must still train, not be silently dropped"
    assert stats["nonfinite"] == 0, "loss must be finite"
    assert stats["final_loss"] == stats["final_loss"], "final_loss must not be NaN"


def test_row_with_no_room_for_an_answer_is_dropped_not_trained(player):
    """When the budget cannot hold even one supervised token, drop the row.

    max_len=1 leaves no room for a prompt token and a target token, so there
    is nothing to supervise. The old code would have emitted an all-masked
    row and stepped on a NaN; the fix drops it and reports the count.
    """
    stats = player.train([(_problem("x = 1\n" * 4000), "y")], epochs=1, max_len=1)
    assert stats["steps"] == 0
    assert stats["dropped"] >= 1


@pytest.mark.parametrize("max_len", [1, 2, 4, 8, 32, 128])
def test_no_budget_ever_produces_a_nonfinite_step(player, max_len):
    """The guarantee that matters across every budget: train or drop, never NaN."""
    stats = player.train([(_problem("x = 1\n" * 4000), "def f():\n    return 1\n")],
                         epochs=1, max_len=max_len)
    assert stats["nonfinite"] == 0
    if stats["steps"]:
        assert stats["final_loss"] == stats["final_loss"], "trained steps must have finite loss"
    else:
        assert stats["dropped"] >= 1, "if nothing trained, the row must have been dropped"


def test_normal_example_trains_and_rolls_back_exactly(player):
    before = {k: v.detach().clone() for k, v in player.model.state_dict().items()}
    player.snapshot()
    stats = player.train([(_problem("def f():\n"), "def f():\n    return 1\n")],
                         epochs=1, max_len=128)
    assert stats["steps"] >= 1 and stats["nonfinite"] == 0
    changed = sum(1 for k, v in player.model.state_dict().items()
                  if not torch.equal(v, before[k]))
    assert changed > 0, "training must actually move weights"
    player.restore()
    assert all(torch.equal(v, before[k]) for k, v in player.model.state_dict().items())
