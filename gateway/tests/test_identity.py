"""Who built Artemis must come from config, not from the model's imagination.

Live, the site answered "I was created by the team behind Artemis AI" - vague and
unattributed, because no system prompt stated an origin and the backend filled the gap.
Attribution now comes from configs/business.yaml and reaches both the runtime prompt
and the identity training set, so the served answer and the trained weights agree.
"""
from artemis.brains import load_brains, origin_line
from artemis.business import load_business
from artemis.knowledge import identity_set


def test_origin_line_names_the_founder_and_title():
    line = origin_line(load_business())
    assert "Latoya Pittman" in line
    assert "CEO of Cutline Industries" in line
    assert line.endswith(".")


def test_origin_line_is_empty_without_a_configured_founder():
    """No founder configured must yield no claim at all, never a guess."""
    assert origin_line({"company": "Artemis AI"}) == ""


def test_origin_line_does_not_repeat_the_parent_company():
    line = origin_line({"founder": "A B", "founder_title": "CEO of Cutline Industries",
                        "parent_company": "Cutline Industries"})
    assert line.count("Cutline Industries") == 1, "parent company stated twice"


def test_system_prompt_carries_the_origin():
    b = load_brains()["artemis"]
    assert "Latoya Pittman" in b.system_prompt(origin_line(load_business()))


def test_system_prompt_without_origin_is_unchanged():
    """The parameter is optional so existing callers keep working."""
    b = load_brains()["artemis"]
    assert "Latoya Pittman" not in b.system_prompt()
    assert b.system_prompt().startswith("You are Artemis")


def test_every_specialist_also_carries_the_origin():
    line = origin_line(load_business())
    for b in load_brains().values():
        assert "Latoya Pittman" in b.system_prompt(line), f"{b.id} would answer differently"


def test_training_identity_credits_the_founder():
    """Only the self-description answers need the founder.

    The "Are you ChatGPT?" rebuttals also say "I'm Artemis" but exist to deny a
    different product, so they are deliberately excluded rather than being made to
    recite attribution.
    """
    pairs = {e["messages"][0]["content"]: e["messages"][1]["content"]
             for e in identity_set(load_brains(), load_business())}
    for q in ("Who made you?", "Who are you?", "Introduce yourself."):
        assert "Latoya Pittman" in pairs[q], f"{q!r} does not credit the founder"
    assert "Latoya Pittman" not in pairs["Are you ChatGPT?"], "rebuttal should stay focused"


def test_orchestrator_resolves_origin_at_construction():
    from artemis.orchestrator import Artemis
    a = Artemis(backend=object())
    assert "Latoya Pittman" in a._origin
