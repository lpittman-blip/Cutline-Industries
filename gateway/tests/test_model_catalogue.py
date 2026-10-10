"""Per-plan model entitlements for the Artemis SaaS platform.

Artemis's own model is the product. Third-party models (Grok) are an added service
a plan may include. Two properties must hold no matter how the config is edited:
Artemis is never gated away, and an external model is never silently presented as
if it were Artemis.
"""
import os
import tempfile

import pytest

from artemis.business import Business, PaymentRequired, load_business, load_plans


@pytest.fixture
def biz():
    b = Business(os.path.join(tempfile.mkdtemp(), "b.db"))
    for acct, plan in (("u_free", "free"), ("u_plus", "plus"), ("u_pro", "pro"),
                       ("u_team", "team"), ("u_ent", "enterprise")):
        b.set_plan(acct, plan)
    return b


def test_every_plan_can_reach_artemis(biz):
    """Our own model is the product; no plan may be sold without it."""
    for acct in ("u_free", "u_plus", "u_pro", "u_team", "u_ent"):
        assert "artemis" in [m["id"] for m in biz.allowed_models(acct)]
        biz.authorize_model(acct, "artemis")


def test_artemis_survives_a_config_that_omits_it():
    """A typo dropping artemis from a plan must not make the product unreachable."""
    cfg = load_business()
    cfg["plans"]["free"]["models"] = ["grok"]      # artemis omitted
    assert "artemis" in load_plans(cfg)["free"].models


def test_unknown_models_in_config_are_ignored():
    cfg = load_business()
    cfg["plans"]["free"]["models"] = ["artemis", "not-a-real-model"]
    assert load_plans(cfg)["free"].models == frozenset({"artemis"})


def test_grok_is_a_paid_tier_feature(biz):
    assert "grok" not in [m["id"] for m in biz.allowed_models("u_free")]
    assert "grok" in [m["id"] for m in biz.allowed_models("u_pro")]


def test_lower_plans_are_refused_with_a_payment_error(biz):
    with pytest.raises(PaymentRequired, match="grok"):
        biz.authorize_model("u_free", "grok")


def test_external_models_are_flagged_for_the_ui(biz):
    """The customer must be able to see the request left our infrastructure."""
    by_id = {m["id"]: m for m in biz.allowed_models("u_pro")}
    assert by_id["artemis"]["external"] is False
    assert by_id["grok"]["external"] is True
    assert by_id["grok"]["provider"] == "xai"


def test_catalogue_entries_carry_display_metadata(biz):
    for m in biz.allowed_models("u_pro"):
        assert m["display"] and m["description"], f"{m['id']} missing picker metadata"


def test_enterprise_all_expands_to_the_catalogue(biz):
    cat = set(load_business()["models"])
    assert {m["id"] for m in biz.allowed_models("u_ent")} == cat
