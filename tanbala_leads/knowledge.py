"""Документ владельца о Tanbala (knowledge/tanbala-agent.md). Только чтение."""

from pathlib import Path

from tanbala_leads import PROJECT_ROOT

OWNER_DOC = PROJECT_ROOT / "knowledge" / "tanbala-agent.md"


def load_owner_doc(path: Path = OWNER_DOC) -> str:
    """Прочитать документ целиком, как есть. Он идёт в system первым блоком и кэшируется."""
    return path.read_text(encoding="utf-8")
