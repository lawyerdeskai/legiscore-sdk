#!/usr/bin/env python3
"""Build the public partner OpenAPI spec.

The published spec is a whitelisted subset of the API, with human-readable operationIds
so the generated SDKs are named after the flow rather than after framework-generated
function names. Everything that is not listed in PARTNER_OPERATIONS is not part of the
partner surface and does not appear.

Every description in the output is written by us, in spec/descriptions.json. The build
drops whatever prose the upstream API description carries, applies the curated text, and
then runs the shared denylist over the result, so a regeneration cannot quietly publish
internal notes.

    python3 build_spec.py            # rebuild legiscore-openapi.json
    python3 build_spec.py --check    # exit 1 if the committed spec is not what we'd build
    python3 build_spec.py --scan .   # run the denylist over the whole repo (CI)
    python3 build_spec.py --source <url|file>   # refresh from an upstream API description
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sanitize_spec import (  # noqa: E402
    DROPPED_PROPERTIES,
    assert_clean,
    load_descriptions,
    missing_descriptions,
    sanitize_partner_surface,
    scan_tree,
)

SOURCE_SPEC_URL = "https://opinion.legiscore.in/openapi.json"
OUTPUT_PATH = Path(__file__).with_name("legiscore-openapi.json")
DESCRIPTIONS_PATH = Path(__file__).with_name("descriptions.json")

# The partner surface, grouped into the modules a customer buys.
# Everything not listed here is not part of the partner surface. Each entry becomes one
# SDK method, namespaced by module: client.reports.create_case(), client.translate.docx().
#
# (path, method) -> (module, operationId)
PARTNER_OPERATIONS: dict[tuple[str, str], tuple[str, str]] = {
    # --- core: plumbing every module needs -------------------------------------
    ("/api/v1/uploads/presign", "post"): ("core", "presignUpload"),
    ("/api/v1/uploads/complete", "post"): ("core", "completeUpload"),
    ("/api/v1/credits", "get"): ("core", "getCredits"),
    ("/api/scenarios", "get"): ("core", "listScenarios"),
    ("/api/v1/custom-field-configs", "get"): ("core", "listCustomFieldConfigs"),
    # --- reports: the legal opinion case lifecycle ------------------------------
    ("/api/requests", "post"): ("reports", "createCase"),
    ("/api/cases/{case_id}/status", "get"): ("reports", "getCaseStatus"),
    ("/api/cases/{case_id}/result", "get"): ("reports", "getCaseResult"),
    ("/api/cases/{case_id}/files", "get"): ("reports", "listCaseFiles"),
    ("/api/cases/{case_id}/files/zip", "get"): ("reports", "downloadCaseFilesZip"),
    # Review pauses: the case stops and waits for the partner to answer.
    ("/api/cases/{case_id}/missing-documents", "get"): ("reports", "getMissingDocuments"),
    ("/api/cases/{case_id}/continue", "post"): ("reports", "continueCase"),
    ("/api/cases/{case_id}/missing-documents/{slot_index}/link", "patch"): (
        "reports",
        "linkDocumentsToMissingSlot",
    ),
    ("/api/cases/{case_id}/document-review", "get"): ("reports", "getDocumentReview"),
    ("/api/cases/{case_id}/submit-document-review", "post"): ("reports", "submitDocumentReview"),
    ("/api/cases/{case_id}/acknowledgements", "get"): ("reports", "getAcknowledgements"),
    ("/api/cases/{case_id}/submit-acknowledgements", "post"): ("reports", "submitAcknowledgements"),
    # --- search: raw search over the state land-record portals ---------------------
    ("/api/v1/raw-search/submit", "post"): ("search", "submitRawSearch"),
    ("/api/v1/raw-search/status/{job_id}", "get"): ("search", "getRawSearchStatus"),
    ("/api/v1/raw-search/history", "get"): ("search", "listRawSearches"),
    ("/api/v1/raw-search/states", "get"): ("search", "listSearchStates"),
    ("/api/v1/raw-search/catalog", "get"): ("search", "getSearchCatalog"),
    ("/api/v1/raw-search/lookups", "get"): ("search", "listLookupDimensions"),
    ("/api/v1/raw-search/lookups/{state}/{dimension}", "get"): ("search", "getLookupValues"),
    # --- translate: document translation -----------------------------------------
    ("/api/v1/translate/submit", "post"): ("translate", "submitTranslation"),
    ("/api/v1/translate/status/{session_id}", "get"): ("translate", "getTranslationStatus"),
    ("/api/v1/translate/download/{session_id}", "get"): ("translate", "downloadTranslation"),
    ("/api/v1/translate/history", "get"): ("translate", "listTranslations"),
    ("/api/v1/docx-translate", "post"): ("translate", "translateDocx"),
    ("/api/v1/docx-translate/languages", "get"): ("translate", "listTranslationLanguages"),
    # --- webhooks: a partner manages its own delivery endpoints --------------------
    ("/api/v1/webhooks", "get"): ("webhooks", "listWebhooks"),
    ("/api/v1/webhooks", "post"): ("webhooks", "createWebhook"),
    ("/api/v1/webhooks/{webhook_id}", "patch"): ("webhooks", "updateWebhook"),
    ("/api/v1/webhooks/{webhook_id}", "delete"): ("webhooks", "deleteWebhook"),
    ("/api/v1/webhooks/{webhook_id}/rotate-secret", "post"): ("webhooks", "rotateWebhookSecret"),
    # --- extraction: property details out of a document ---------------------------
    ("/api/v1/extraction/property", "post"): ("extraction", "createPropertyExtraction"),
    ("/api/v1/extraction/property/{job_id}", "get"): ("extraction", "getPropertyExtraction"),
    ("/api/v1/documents/{case_id}", "get"): ("reports", "getCaseDocuments"),
}

MODULE_DESCRIPTIONS = {
    "core": "Uploads, credit balance and scenario reference data. Shared by every module.",
    "reports": "Create a legal opinion case, follow it to completion, answer review pauses, fetch the report.",
    "search": "Raw search across the state land-record portals.",
    "translate": "Translate a document into another Indian language.",
    "extraction": "Pull structured property details out of an uploaded document.",
    "webhooks": "Manage your own delivery endpoints: list, create, update, delete, rotate secret.",
}

SPEC_INFO = {
    "title": "LegiScore Partner API",
    "version": "1.0.0",
    "description": (
        "Programmatic access to LegiScore title search and legal opinion reports.\n\n"
        "Authentication: send your `lsk_` key as `X-API-Key` (or `Authorization: Bearer lsk_...`).\n"
        "Rate limits are per key. Exceeding one returns 429 with a `Retry-After` header.\n\n"
        "Typical flow: presign + upload documents, POST /api/requests to create the case, then either "
        "poll `/api/cases/{case_id}/status` or receive a webhook. A case can pause for missing documents, "
        "document review, or risk acknowledgements; each pause has a matching resume endpoint."
    ),
}

SECURITY_SCHEMES = {
    "ApiKeyHeader": {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
        "description": "Your LegiScore API key, e.g. `lsk_live_...`.",
    },
    "BearerToken": {
        "type": "http",
        "scheme": "bearer",
        "description": "The same `lsk_` key sent as `Authorization: Bearer lsk_...`.",
    },
}

LOCAL_SPEC_HELP = """The API does not serve a machine-readable description publicly.

With no --source, this script rebuilds legiscore-openapi.json from itself: the whitelist,
the curated descriptions and the denylist are all reapplied, which is what CI checks. To
pick up a change to the API surface, pass the description as a file:

    python3 build_spec.py --source /path/to/openapi.json"""


def fetch_source_spec(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 404):
            raise SystemExit(f"{url} returned {exc.code}.\n\n{LOCAL_SPEC_HELP}") from exc
        raise


def collect_schema_refs(node: object, found: set[str]) -> None:
    """Walk a spec fragment and record every #/components/schemas/<name> it references."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            found.add(ref.rsplit("/", 1)[-1])
        for value in node.values():
            collect_schema_refs(value, found)
    elif isinstance(node, list):
        for value in node:
            collect_schema_refs(value, found)


def resolve_transitive_schemas(source_schemas: dict, seeds: set[str]) -> dict:
    """Seed schemas plus everything they reference, recursively."""
    kept: dict[str, object] = {}
    pending = set(seeds)
    while pending:
        name = pending.pop()
        schema = source_schemas.get(name)
        if schema is None or name in kept:
            continue
        kept[name] = schema
        nested: set[str] = set()
        collect_schema_refs(schema, nested)
        pending |= nested - kept.keys()
    return dict(sorted(kept.items()))


def build_partner_spec(source: dict, only_module: str | None = None) -> dict:
    source_paths = source.get("paths", {})
    missing = [
        f"{method.upper()} {path}"
        for (path, method) in PARTNER_OPERATIONS
        if method not in source_paths.get(path, {})
    ]
    if missing:
        raise SystemExit(
            "These partner operations are no longer served:\n  "
            + "\n  ".join(missing)
            + "\nThe route was renamed or removed. Fix PARTNER_OPERATIONS before shipping an SDK."
        )

    paths: dict[str, dict] = {}
    for (path, method), (module, operation_id) in PARTNER_OPERATIONS.items():
        if only_module and module != only_module:
            continue
        operation = json.loads(json.dumps(source_paths[path][method]))
        operation["operationId"] = operation_id
        operation["tags"] = [module]
        operation["security"] = [{"ApiKeyHeader": []}, {"BearerToken": []}]
        paths.setdefault(path, {})[method] = operation

    if not paths:
        raise SystemExit(f"No operations for module {only_module!r}. Known: {sorted(MODULE_DESCRIPTIONS)}")

    referenced: set[str] = set()
    collect_schema_refs(paths, referenced)
    schemas = resolve_transitive_schemas(source.get("components", {}).get("schemas", {}), referenced)

    # Everything above this line is selection. Everything below is sanitisation: no prose
    # from upstream survives it, and no dropped field survives it.
    curated = load_descriptions(DESCRIPTIONS_PATH)
    paths, schemas = sanitize_partner_surface(paths, schemas, curated)

    uncurated = missing_descriptions(paths, curated)
    if uncurated:
        print(
            "note: no curated description for "
            + ", ".join(uncurated)
            + " — they ship without one. Add them to descriptions.json.",
            file=sys.stderr,
        )

    return {
        "openapi": source.get("openapi", "3.1.0"),
        "info": SPEC_INFO,
        "servers": [{"url": "https://opinion.legiscore.in", "description": "Production"}],
        "security": [{"ApiKeyHeader": []}],
        "tags": [
            {"name": name, "description": description}
            for name, description in MODULE_DESCRIPTIONS.items()
            if not only_module or name == only_module
        ],
        "paths": dict(sorted(paths.items())),
        "components": {
            "schemas": schemas,
            "securitySchemes": SECURITY_SCHEMES,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed spec is out of date")
    parser.add_argument(
        "--source",
        default=None,
        help="an upstream API description, URL or file. Defaults to the committed spec, "
        "which reapplies the whitelist, the curated descriptions and the denylist to it.",
    )
    parser.add_argument("--module", help="emit only one module's spec, to stdout (core, reports, search, ...)")
    parser.add_argument("--scan", metavar="PATH", help="run the shared denylist over a directory tree and exit")
    args = parser.parse_args()

    if args.scan:
        return scan_tree(Path(args.scan).resolve())

    source_arg = args.source or str(OUTPUT_PATH)
    if source_arg.startswith(("http://", "https://")):
        source = fetch_source_spec(source_arg)
    else:
        path = Path(source_arg)
        if not path.exists():
            raise SystemExit(f"{path} does not exist.\n\n{LOCAL_SPEC_HELP}")
        source = json.loads(path.read_text())

    if args.module:
        rendered = json.dumps(build_partner_spec(source, args.module), indent=2)
        assert_clean(rendered, f"{args.module} spec")
        print(rendered)
        return 0

    spec = build_partner_spec(source)
    rendered = json.dumps(spec, indent=2) + "\n"
    assert_clean(rendered, OUTPUT_PATH.name)

    if args.check:
        current = OUTPUT_PATH.read_text() if OUTPUT_PATH.exists() else ""
        if current != rendered:
            print("Partner spec is stale. Run build_spec.py and regenerate the SDKs.")
            return 1
        print(f"Partner spec is current: {len(spec['paths'])} paths, {len(spec['components']['schemas'])} schemas.")
        return 0

    OUTPUT_PATH.write_text(rendered)
    by_module: dict[str, int] = {}
    for module, _ in PARTNER_OPERATIONS.values():
        by_module[module] = by_module.get(module, 0) + 1
    summary = ", ".join(f"{name} {count}" for name, count in sorted(by_module.items()))
    dropped = sum(len(fields) for fields in DROPPED_PROPERTIES.values())
    print(
        f"Wrote {OUTPUT_PATH.name}: {len(spec['paths'])} paths, {len(PARTNER_OPERATIONS)} operations "
        f"({summary}), {len(spec['components']['schemas'])} schemas, {dropped} fields withheld."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
