"""One report, start to finish, with every pause handled correctly.

    export LEGISCORE_API_KEY=lsk_...
    python3 examples/end_to_end.py sale-deed.pdf encumbrance-certificate.pdf

This is the reference the AI prompt points at. Adapt it; do not start from scratch.

Read this before adapting: the script deliberately STOPS at the acknowledgement pause instead
of accepting. Acknowledgements are title risks a human is agreeing to live with. Auto-accepting
them turns a legal opinion into a rubber stamp, so that decision does not belong in library code.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from legiscore import LegiScore, LegiScoreError, MissingAPIKeyError

PROPERTY = {"address": "Sy. No. 123, Example Village, Telangana"}
# Answering one pause can surface the next. Bound the rounds so a stuck case cannot spin forever.
MAX_REVIEW_ROUNDS = 5


def handle_missing_documents(client: LegiScore, case_id: str) -> bool:
    """The case wants documents it could not find. Supply them, or proceed without."""
    missing = client.reports.get_missing_documents(case_id)
    wanted = missing.get("missing_documents") or []  # NOT "documents"
    names = [d.get("document_type") or d.get("name") for d in wanted]
    print(f"  missing {len(wanted)} document(s): {names}")

    # Either supply them:
    #   ids = [client.upload_document("khata-extract.pdf")]
    #   client.reports.continue_case(case_id, body={"new_document_ids": ids})
    # or accept the report without them:
    client.reports.continue_case(case_id, body={"proceed_anyway": True})
    return True


def handle_document_review(client: LegiScore, case_id: str) -> bool:
    """The case wants its reading of a document confirmed or corrected."""
    review = client.reports.get_document_review(case_id)
    documents = review.get("documents") or []
    print(f"  {len(documents)} document(s) to confirm")

    # Send corrections in `updates`; sending none accepts what it read.
    client.reports.submit_document_review(
        case_id, body={"updates": [], "proceed_to_searches": True}
    )
    return True


def handle_acknowledgements(client: LegiScore, case_id: str) -> bool:
    """The case found title risks and needs a human to decide on each one.

    Returns False on purpose: this script stops here rather than deciding for you.
    """
    response = client.reports.get_acknowledgements(case_id)
    # The payload nests: response["acknowledgements"] is the stored dict, whose own
    # "acknowledgements" key holds the list. Iterating the outer dict yields its KEYS.
    generated = response.get("acknowledgements") or {}
    items = generated.get("acknowledgements") if isinstance(generated, dict) else generated

    print(f"\n  {len(items or [])} title risk(s) need a decision:")
    for item in items or []:
        print(f"    - {item.get('title') or item.get('description') or item}")

    print(
        "\n  Stopping here. Each risk takes a `decision` of\n"
        "  'accepted', 'rejected' or 'undecided'.\n"
        "  Once a human has decided, send them back like this:\n\n"
        "    client.reports.submit_acknowledgements(case_id, body={\n"
        '        "acknowledgements": [{**item, "decision": "accepted"} for item in items],\n'
        "    })\n\n"
        "  An item with no `decision` passes through untouched and acknowledges nothing."
    )
    return False


# The case tells you which pause it is in. Asking the wrong endpoint returns 400, so dispatch
# on internal_status rather than probing all three.
PAUSE_HANDLERS = {
    "awaiting_documents": handle_missing_documents,
    "awaiting_document_review": handle_document_review,
    "awaiting_acknowledgements": handle_acknowledgements,
    "awaiting_acknowledgement": handle_acknowledgements,
}


def main(files: list[str]) -> int:
    client = LegiScore()

    connection = client.check_connection()
    if not connection["ok"]:
        print(f"Cannot reach LegiScore: {connection.get('problem')}")
        return 1
    print(f"Connected to {connection['base_url']}")

    print(f"Uploading {len(files)} document(s)...")
    case = client.create_report(property_focus=PROPERTY, files=files, case_name="Example case")
    case_id = case["case_id"]
    print(f"Case {case_id} created")

    for attempt in range(MAX_REVIEW_ROUNDS):
        status = client.wait_for_case(case_id, poll_interval=15)
        state, internal = status["state"], (status.get("internal_status") or "").lower()
        print(f"[{attempt + 1}] {state} ({internal or 'no internal status'})")

        if state == "completed":
            report = client.reports.get_case_result(case_id)
            # Path(...).name so the filename can only ever land in this directory.
            archive = Path(f"{Path(case_id).name}.zip")
            archive.write_bytes(client.reports.download_case_files_zip(case_id))
            print(f"Done. Report keys: {sorted(report)[:6]}")
            print(f"Files written to {archive}")
            return 0

        if state == "failed":
            print(f"Case failed: {status.get('message')}")
            return 1

        handler = PAUSE_HANDLERS.get(internal)
        if handler is None:
            print(f"Paused on '{internal}', which this script does not handle. Open the dashboard.")
            return 1
        if not handler(client, case_id):
            return 1

    print(f"Still not finished after {MAX_REVIEW_ROUNDS} rounds. Stopping rather than looping.")
    return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(f"usage: {sys.argv[0]} <document.pdf> [more.pdf ...]")
    try:
        raise SystemExit(main(sys.argv[1:]))
    except MissingAPIKeyError as error:
        raise SystemExit(str(error)) from error
    except LegiScoreError as error:
        print(f"LegiScore error {error.status_code}: {error}")
        raise SystemExit(1) from error
