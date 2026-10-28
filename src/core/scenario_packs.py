"""
Vertical conversation scenario packs.

AVA is a multi-business voice/sales platform: the call runtime, Sales Brain and
tenant isolation stay generic. Vertical behaviour (hotel today, clinic/restaurant
later) is layered on top as a declarative, versioned "scenario pack" that is
resolved per call from the business profile ``businessType`` and appended to the
context prompt next to the hotel profile block.

Design rules:

- Packs live in ``config/scenarios/<business_type>.yaml`` and are pure data.
- A missing, unreadable or invalid pack is a no-op: the generic sales flow keeps
  working exactly as before (``resolve_scenario_pack`` returns ``None``).
- Rendering is deterministic so prompt composition can be contract-tested
  without hitting any LLM.
- Packs never carry credentials, tenant identifiers or CRM payloads: they only
  describe how the agent should behave.
"""

import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

_PROJ_DIR = Path(__file__).resolve().parents[2]

INBOUND = "inbound"
OUTBOUND = "outbound"

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")


def scenario_packs_dir() -> Path:
    """Directory holding vertical scenario packs (env-overridable for tests)."""
    override = (os.getenv("AAVA_SCENARIO_PACKS_DIR") or "").strip()
    if override:
        return Path(override)
    return _PROJ_DIR / "config" / "scenarios"


class ScenarioEntry(BaseModel):
    """One named conversation scenario inside a direction."""

    model_config = ConfigDict(extra="allow")

    id: str
    title: str
    guidance: List[str] = Field(default_factory=list)

    def render(self) -> str:
        lines = [f"- {self.title}:"]
        lines.extend(f"  - {item}" for item in self.guidance if str(item).strip())
        return "\n".join(lines)


class DirectionPack(BaseModel):
    """Direction-specific (inbound/outbound) part of a scenario pack."""

    model_config = ConfigDict(extra="allow")

    persona: Optional[str] = None
    rules: List[str] = Field(default_factory=list)
    scenarios: List[ScenarioEntry] = Field(default_factory=list)
    forbidden_openings: List[str] = Field(default_factory=list)
    fallback_opening: Optional[str] = None

    def scenario_ids(self) -> List[str]:
        return [entry.id for entry in self.scenarios]


class ScenarioPack(BaseModel):
    """Versioned vertical scenario pack for a single ``businessType``."""

    model_config = ConfigDict(extra="allow")

    version: int = Field(default=1, ge=1)
    business_type: str
    description: Optional[str] = None
    voice_rules: List[str] = Field(default_factory=list)
    safety_rules: List[str] = Field(default_factory=list)
    inbound: DirectionPack = Field(default_factory=DirectionPack)
    outbound: DirectionPack = Field(default_factory=DirectionPack)

    def direction(self, direction: str) -> DirectionPack:
        return self.outbound if str(direction).lower() == OUTBOUND else self.inbound

    def marker(self, direction: str) -> str:
        """Stable header used to keep prompt composition idempotent."""
        normalized = OUTBOUND if str(direction).lower() == OUTBOUND else INBOUND
        return (
            f"СЦЕНАРИИ РАЗГОВОРА ({self.business_type}/{normalized}, "
            f"pack v{self.version}):"
        )

    def render_prompt_block(self, direction: str) -> str:
        """Render the deterministic prompt block for one call direction."""
        normalized = OUTBOUND if str(direction).lower() == OUTBOUND else INBOUND
        pack_direction = self.direction(normalized)

        sections: List[str] = [self.marker(normalized)]

        if pack_direction.persona:
            sections.append(pack_direction.persona.strip())

        if self.voice_rules:
            sections.append(
                "\n".join(["ГОЛОС И СТИЛЬ:"] + [f"- {rule}" for rule in self.voice_rules if str(rule).strip()])
            )

        if pack_direction.rules:
            title = "ПРАВИЛА ИСХОДЯЩЕГО ЗВОНКА:" if normalized == OUTBOUND else "ПРАВИЛА ВХОДЯЩЕГО ЗВОНКА:"
            sections.append(
                "\n".join([title] + [f"- {rule}" for rule in pack_direction.rules if str(rule).strip()])
            )

        rendered_scenarios = [entry.render() for entry in pack_direction.scenarios]
        if rendered_scenarios:
            sections.append("\n".join(["СЦЕНАРИИ:"] + rendered_scenarios))

        if self.safety_rules:
            sections.append(
                "\n".join(["ГРАНИЦЫ И БЕЗОПАСНОСТЬ:"] + [f"- {rule}" for rule in self.safety_rules if str(rule).strip()])
            )

        return "\n\n".join(part for part in sections if str(part).strip()).strip()

    def sanitize_outbound_opening(self, opening: str) -> str:
        """Strip inbound-style phrases ("чем могу помочь") from an outbound opener.

        The Sales Brain prompt already forbids them, but the opener comes from an
        LLM, so the runtime keeps a deterministic guard. Sentences carrying a
        forbidden phrase are dropped; if nothing survives, the pack's neutral
        fallback opener is used instead of inventing details.
        """
        text = str(opening or "").strip()
        forbidden = [str(item).strip().lower() for item in self.outbound.forbidden_openings if str(item).strip()]
        fallback = str(self.outbound.fallback_opening or "").strip()

        if not text:
            return fallback
        if not forbidden:
            return text

        kept = [
            sentence
            for sentence in _SENTENCE_SPLIT_RE.split(text)
            if sentence.strip() and not any(phrase in sentence.lower() for phrase in forbidden)
        ]
        cleaned = " ".join(part.strip() for part in kept).strip()
        return cleaned or fallback


# business_type -> (pack or None, tuple of (path, mtime) the decision was based on)
_PACK_CACHE: Dict[str, Tuple[Optional[ScenarioPack], Optional[Tuple[str, float]]]] = {}
_PACK_CACHE_LOCK = threading.Lock()


def normalize_business_type(value: Any) -> str:
    """Normalize a business type into a safe pack identifier.

    The value comes from an external CRM/profile API and is used to build a file
    name, so everything outside ``[a-z0-9_]`` is dropped rather than escaped.
    """
    text = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return re.sub(r"[^a-z0-9_]", "", text)


def _pack_path(business_type: str) -> Optional[Path]:
    directory = scenario_packs_dir()
    for suffix in (".yaml", ".yml"):
        candidate = directory / f"{business_type}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def _stamp(path: Optional[Path]) -> Optional[Tuple[str, float]]:
    if path is None:
        return None
    try:
        return (str(path), path.stat().st_mtime)
    except OSError:
        return None


def load_scenario_pack(business_type: Any) -> Optional[ScenarioPack]:
    """Load and validate the scenario pack for a business type.

    Returns ``None`` when the business type is unknown, the pack file is absent
    or the YAML fails validation. Callers must treat ``None`` as "generic flow".
    """
    normalized = normalize_business_type(business_type)
    if not normalized:
        return None

    path = _pack_path(normalized)
    stamp = _stamp(path)

    with _PACK_CACHE_LOCK:
        cached = _PACK_CACHE.get(normalized)
        if cached is not None and cached[1] == stamp:
            return cached[0]

    pack: Optional[ScenarioPack] = None
    if path is not None:
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if isinstance(raw, dict):
                raw.setdefault("business_type", normalized)
                pack = ScenarioPack(**raw)
                if normalize_business_type(pack.business_type) != normalized:
                    logger.warning(
                        "Scenario pack business_type mismatch, ignoring pack: %s != %s",
                        pack.business_type,
                        normalized,
                    )
                    pack = None
            else:
                logger.warning("Scenario pack %s is not a mapping, ignoring", path)
        except Exception:
            logger.warning("Failed to load scenario pack %s, falling back to generic flow", path, exc_info=True)
            pack = None

    with _PACK_CACHE_LOCK:
        _PACK_CACHE[normalized] = (pack, stamp)
    return pack


def clear_scenario_pack_cache() -> None:
    """Drop the in-process pack cache (used by tests and config reloads)."""
    with _PACK_CACHE_LOCK:
        _PACK_CACHE.clear()


def available_scenario_packs() -> List[str]:
    """Business types that currently ship a scenario pack."""
    directory = scenario_packs_dir()
    if not directory.is_dir():
        return []
    names = set()
    for suffix in ("*.yaml", "*.yml"):
        for path in directory.glob(suffix):
            names.add(normalize_business_type(path.stem))
    return sorted(name for name in names if name)
