"""Loads the brain definitions in brains/*.yaml and builds each brain's system prompt."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

BRAINS_DIR = Path(__file__).resolve().parent.parent / "brains"
SPECIALIST_IDS = ("apollo", "mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune", "pluto")


@dataclass(frozen=True)
class Brain:
    id: str
    name: str
    kind: str
    role: str
    instructions: tuple[str, ...]
    rules: tuple[str, ...]
    keywords: tuple[str, ...] = ()
    title: str = ""
    model: dict = field(default_factory=dict)
    training_sets: tuple[str, ...] = ()

    def system_prompt(self, origin: str = "") -> str:
        """`origin` states who built Artemis, so the model answers "who made you" from
        fact rather than improvising. Callers pass brains.origin_line(); it is optional
        so existing callers and tests keep working unchanged."""
        label = f"{self.name} ({self.title})" if self.title else self.name
        lines = [f"You are {label}, part of Artemis AI."]
        if origin:
            lines.append(origin)
        lines += [self.role, "", "Instructions:"]
        lines += [f"- {i}" for i in self.instructions]
        lines += ["", "Rules:"] + [f"- {r}" for r in self.rules]
        return "\n".join(lines)


def load_brains(directory: Path = BRAINS_DIR) -> dict[str, Brain]:
    brains = {}
    for path in sorted(directory.glob("*.yaml")):
        d = yaml.safe_load(path.read_text())
        brains[d["id"]] = Brain(
            id=d["id"], name=d["name"], kind=d["kind"], role=d["role"],
            instructions=tuple(d["instructions"]), rules=tuple(d.get("rules", ())),
            keywords=tuple(k.lower() for k in d.get("keywords", ())),
            title=d.get("title", ""), model=d.get("model", {}),
            training_sets=tuple(d.get("training_sets", ())),
        )
    missing = set(SPECIALIST_IDS) - brains.keys()
    if missing or "artemis" not in brains:
        raise ValueError(f"missing brain definitions: {sorted(missing | ({'artemis'} - brains.keys()))}")
    return brains


def origin_line(biz: dict | None = None) -> str:
    """One sentence naming who built Artemis, drawn from configs/business.yaml.

    Without this the model invents an answer - the live site replied "created by the
    team behind Artemis AI", which is vague and unattributed.
    """
    if biz is None:
        from .business import load_business
        biz = load_business()
    founder = biz.get("founder")
    if not founder:
        return ""
    title = biz.get("founder_title", "")
    parent = biz.get("parent_company")
    who = f"{founder}, {title}" if title else founder
    line = f"Artemis was created by {who}."
    if parent and parent not in title:
        line += f" Artemis AI is built by {parent}."
    return line
