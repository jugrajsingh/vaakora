"""Explicit roots for the packaging tests."""
import os
from pathlib import Path

PACKAGING = Path(__file__).resolve().parents[1]
ROOT = PACKAGING.parent
SCRATCH = Path(os.environ.get("VAAKORA_TEST_SCRATCH", ROOT / "packaging/.work/test-scratch")).resolve()
if not SCRATCH.is_relative_to(ROOT):
    raise RuntimeError("test scratch must be inside the repository root")
SCRATCH.mkdir(parents=True, exist_ok=True)
