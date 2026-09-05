"""Fixtures for the pytest suite.

``tests/test_client.py`` also runs standalone (``python3 tests/test_client.py``) with no pytest
installed, so anything defined here has to have a plain-Python equivalent in that file's runner.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# So `import legiscore` finds the checkout rather than requiring an install first.
sys.path.insert(0, str(Path(__file__).resolve().parent))

SAMPLE_PDF_BYTES = b"%PDF-1.4 sample"


@pytest.fixture
def tmp_file(tmp_path: Path) -> Path:
    """A small document on disk, standing in for a partner's scanned deed."""
    sample = tmp_path / "sale-deed.pdf"
    sample.write_bytes(SAMPLE_PDF_BYTES)
    return sample
