#!/usr/bin/env python3
"""Sanitisation pass for the partner OpenAPI spec, plus the shared denylist.

Two jobs, deliberately in one module so they cannot drift apart:

1. ``sanitize_partner_surface`` strips every description the upstream API description
   carries and replaces it with curated partner-facing text from ``descriptions.json``.
   Anything without curated text ends up with no description at all — never upstream
   prose. It also drops request-body fields a partner must never set.
2. ``DENYLIST`` is the single list of things that must not appear in anything this
   repository publishes. ``assert_clean`` runs it over the built spec, and
   ``scan_tree`` runs the same list over the whole working tree for CI. The tree scan
   skips whatever git ignores — build output, agent worktrees, engineering notes — since
   a file that never leaves this machine is not part of the public surface.

    python3 build_spec.py --scan .     # tree-wide denylist scan (what CI runs)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Iterable

# --------------------------------------------------------------------------------------
# The denylist. ONE list, used by the spec build and by CI.
#
# Each entry is a case-insensitive regular expression. Keep them anchored enough that an
# ordinary English sentence cannot trip them: the value of this gate is that a red build
# always means something real.
# --------------------------------------------------------------------------------------
DENYLIST: list[str] = [
    # --- infrastructure and vendors --------------------------------------------------
    r"\bcelery\b",
    r"\bminio\b",
    r"\bgcs\b",
    r"google[ -]cloud",
    r"\bsupabase\b",
    r"\bredis\b",
    r"\bcashfree\b",
    r"\bdeepl\b",
    r"\bpydantic\b",
    r"\bzipstream\b",
    r"\bspooledtemporaryfile\b",
    # --- storage and schema vocabulary ------------------------------------------------
    # Shapes, not names: a public denylist must not itself be a map of the schema.
    r"\bjsonb\b",
    r"junction table",
    # --- internal headers and flags ---------------------------------------------------
    r"x-admin-key",
    r"x-active-org-id",
    r"\benable_api_docs\b",
    # --- internal code paths, modules and task names ----------------------------------
    r"\bmain\.(?:app\b|py\b|_[a-z])",
    r"[a-z_]*_(?:service|router|task|worker|repo)\.py\b",
    r"\b[a-z_]+_router\b",
    r"\b[a-z_]+_(?:task|worker)\b",
    r"\bget_current_user\b",
    r"\butils/",
    r"\broutes/",
    r"\bservices/",
    r"\d{2,4} routes\b",
    # --- permission strings -----------------------------------------------------------
    r"\borg\.[a-z_]+\b",
    # --- our own private world --------------------------------------------------------
    # Path forms only. Not bare "legal-opinion": that is a legitimate package keyword in
    # node/package.json and python/pyproject.toml.
    r"legal-opinion/",
    r"/Users/",
    r"~/[a-z-]+/",
    r"\bprospects\b",
    # Key-shaped strings: any real prefix, but not the deliberately fake test fixture.
    r"\blsk_(?:live|test)_[A-Za-z0-9]{8,}\b",
    r"\blsk_[0-9a-f]{32}\b",
    # Indian mobile numbers in any spacing.
    r"\+91[ -]?[6-9]\d{4}[ -]?\d{5}\b",
    r"\b[6-9]\d{9}\b",
    # --- customer-data shapes ------------------------------------------------------------
    # Loan / reference ids and survey-number parcels that look real rather than synthetic.
    r"\bLN-(?!0+\b)\d{4,}\b",
    r"\b[A-Z]{2,4}-20\d{2}-(?!0+\b)\d{4,}\b",
    r"\bvisakhapatnam\b",
]

_DENY_RE = [(pattern, re.compile(pattern, re.IGNORECASE)) for pattern in DENYLIST]

# --------------------------------------------------------------------------------------
# Tree scan
# --------------------------------------------------------------------------------------
# A floor, applied even outside a git checkout. Inside one, anything .gitignore covers
# is skipped as well — see ``ignored_paths`` — because a file git will not publish is not
# part of the public surface. ".claude" holds agent worktrees, which are whole second
# copies of the repo and would otherwise be scanned twice.
SCAN_SKIP_DIRS = {
    ".git",
    ".claude",
    "internal",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
}

# This file defines the patterns, so it necessarily contains them. Lock files are
# machine-written noise. Nothing else is exempt.
SCAN_SKIP_FILES = {"sanitize_spec.py", "package-lock.json", "poetry.lock", "yarn.lock"}

SCAN_SUFFIXES = {
    ".md",
    ".txt",
    ".json",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".yml",
    ".yaml",
    ".toml",
    ".cfg",
    ".ini",
    ".css",
    ".html",
    ".sh",
    ".env-example",
}


def find_hits(text: str) -> list[tuple[int, str, str]]:
    """Every denylist match in ``text``, as (line number, pattern, offending line)."""
    hits: list[tuple[int, str, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for pattern, compiled in _DENY_RE:
            if compiled.search(line):
                hits.append((number, pattern, line.strip()[:160]))
    return hits


def assert_clean(text: str, where: str) -> None:
    """Fail the build if anything on the denylist survived into ``text``."""
    hits = find_hits(text)
    if hits:
        report = "\n".join(f"  {where}:{n}  /{p}/  {line}" for n, p, line in hits)
        raise SystemExit(
            f"Denylisted terms reached {where}. The sanitiser missed them, or a curated\n"
            f"description reintroduced them:\n{report}"
        )


def _git(root: Path, args: list[str], stdin: bytes | None = None) -> list[str] | None:
    """Run a git command under ``root`` and split its NUL-separated output.

    Returns None when there is no usable git answer — no binary, not a checkout, or a
    real error. Callers fall back to the static skip list, which is never weaker than
    scanning too much.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), *args],
            input=stdin,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    # check-ignore exits 1 when nothing matched, which is a successful answer.
    if proc.returncode not in (0, 1):
        return None
    return [chunk for chunk in proc.stdout.decode("utf-8", "replace").split("\0") if chunk]


def ignored_paths(root: Path, candidates: list[Path]) -> set[Path]:
    """Of ``candidates``, the ones git would not publish.

    A *tracked* file is never treated as ignored even if a pattern matches it: it is in
    the repository whatever .gitignore says, so it still has to pass the denylist.
    """
    if not candidates:
        return set()
    stdin = b"\0".join(os.fsencode(str(path)) for path in candidates) + b"\0"
    ignored = _git(root, ["check-ignore", "-z", "--stdin"], stdin=stdin)
    if ignored is None:
        return set()
    tracked = {root / name for name in (_git(root, ["ls-files", "-z"]) or [])}
    return {Path(name) for name in ignored} - tracked


def iter_scannable(root: Path) -> Iterable[Path]:
    candidates: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SCAN_SKIP_DIRS or part.endswith(".egg-info") for part in path.parts):
            continue
        if path.name in SCAN_SKIP_FILES:
            continue
        if path.suffix.lower() not in SCAN_SUFFIXES:
            continue
        candidates.append(path)
    skip = ignored_paths(root, candidates)
    return [path for path in candidates if path not in skip]


def scan_tree(root: Path) -> int:
    """Run the denylist over every text file under ``root``. Returns a process exit code."""
    findings: list[str] = []
    scanned = 0
    for path in iter_scannable(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        rel = path.relative_to(root)
        findings += [f"{rel}:{n}  /{p}/  {line}" for n, p, line in find_hits(text)]
    if findings:
        print("::error::Denylisted terms found in tracked files. Engineering notes live in internal/.")
        print("\n".join(findings))
        return 1
    print(f"denylist clean: {scanned} files scanned, {len(DENYLIST)} patterns")
    return 0


# --------------------------------------------------------------------------------------
# Spec sanitisation
# --------------------------------------------------------------------------------------

# Request-body fields a partner must never set. Some select another tenant's objects,
# some act as another profile, some set money on a billable call. They are removed from
# the partner schemas entirely so no generated SDK or collection can offer them.
DROPPED_PROPERTIES: dict[str, tuple[str, ...]] = {
    "CreateCaseRequest": (
        "auto_start_profile_id",
        "on_behalf_draft_id",
        "share_with_profile_ids",
    ),
    "UnifiedRawSearchRequest": ("auto_start_profile_id",),
    # The title-search operations are not in PARTNER_OPERATIONS, so this schema does not
    # reach the spec today. The entry stays as the guard: whenever those routes rejoin the
    # partner surface, this field must not come back with them.
    "TitleSearchStartRequest": ("payment_status",),
    "Body_submit_translation_api_v1_translate_submit_post": (
        "subtotal",
        "total_cost",
        "discount_amount",
        "gst_amount",
    ),
}

# Header parameters that are internal tooling, never a partner input.
DROPPED_HEADER_PARAMS = {"x-admin-key", "x-active-org-id"}

DESCRIPTION_KEYS = ("description", "summary")

# OpenAPI requires a description on every Response Object, so it cannot simply be dropped.
# It is rewritten to a fixed value instead of being carried over from upstream.
RESPONSE_DESCRIPTIONS = {"422": "Validation Error"}


def _strip_prose(node: Any) -> Any:
    """Recursively remove every description/summary carried in from upstream."""
    if isinstance(node, dict):
        return {
            key: _strip_prose(value)
            for key, value in node.items()
            if key not in DESCRIPTION_KEYS
        }
    if isinstance(node, list):
        return [_strip_prose(value) for value in node]
    return node


def load_descriptions(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    return {
        "operations": data.get("operations", {}),
        "properties": data.get("properties", {}),
        "parameters": data.get("parameters", {}),
    }


def sanitize_operation(operation: dict, operation_id: str, curated: dict) -> dict:
    """One operation, stripped of upstream prose and given curated text if we wrote any."""
    clean = _strip_prose(operation)

    for code, response in (clean.get("responses") or {}).items():
        response["description"] = RESPONSE_DESCRIPTIONS.get(code, "Successful Response")

    parameters = []
    for parameter in clean.get("parameters", []):
        if parameter.get("in") == "header" and parameter.get("name", "").lower() in DROPPED_HEADER_PARAMS:
            continue
        text = curated["parameters"].get(f"{operation_id}.{parameter.get('name')}")
        if text:
            parameter["description"] = text
        parameters.append(parameter)
    if "parameters" in clean:
        clean["parameters"] = parameters

    entry = curated["operations"].get(operation_id)
    if entry:
        if entry.get("summary"):
            clean["summary"] = entry["summary"]
        if entry.get("description"):
            clean["description"] = entry["description"]
    return clean


def sanitize_schema(name: str, schema: dict, curated: dict) -> dict:
    """One component schema, stripped of upstream prose and shorn of dropped fields."""
    clean = _strip_prose(schema)

    dropped = set(DROPPED_PROPERTIES.get(name, ()))
    if dropped and isinstance(clean.get("properties"), dict):
        clean["properties"] = {
            key: value for key, value in clean["properties"].items() if key not in dropped
        }
        if isinstance(clean.get("required"), list):
            clean["required"] = [key for key in clean["required"] if key not in dropped]
            if not clean["required"]:
                del clean["required"]

    for key, value in (clean.get("properties") or {}).items():
        text = curated["properties"].get(f"{name}.{key}")
        if text:
            value["description"] = text
    text = curated["properties"].get(name)
    if text:
        clean["description"] = text
    return clean


def sanitize_partner_surface(
    paths: dict[str, dict],
    schemas: dict[str, dict],
    curated: dict,
) -> tuple[dict, dict]:
    """Sanitise the whitelisted paths and their schemas. Returns (paths, schemas)."""
    clean_paths = {
        path: {
            method: sanitize_operation(operation, operation["operationId"], curated)
            for method, operation in methods.items()
        }
        for path, methods in paths.items()
    }
    clean_schemas = {name: sanitize_schema(name, schema, curated) for name, schema in schemas.items()}
    return clean_paths, clean_schemas


def missing_descriptions(paths: dict[str, dict], curated: dict) -> list[str]:
    """operationIds with no curated text — they ship with none, which is the safe default."""
    return sorted(
        operation["operationId"]
        for methods in paths.values()
        for operation in methods.values()
        if not curated["operations"].get(operation["operationId"], {}).get("description")
    )
