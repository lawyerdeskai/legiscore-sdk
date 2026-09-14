"""Self-check for the two replies to a pause that are not "it worked".

    pytest -q                     # the normal way
    python3 tests/test_pauses.py  # same tests, no pytest installed

No network: httpx.MockTransport answers every call.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from legiscore import (
    PAUSE_GATE_UNMET,
    LegiScore,
    LegiScoreError,
    build_document_review_annotations,
    is_pending_second_approval,
    read_pause_gate_refusal,
    read_review_findings,
)

TEST_KEY = "lsk_fake_0000000000000000000000000000"
CASE_ID = "11111111-1111-4111-8111-111111111111"

REFUSAL: dict[str, Any] = {
    "detail": {
        "code": PAUSE_GATE_UNMET,
        "stage": "upload_docs",
        "errors": ["2 missing documents are not yet actioned: Sale Deed, Encumbrance Certificate"],
    }
}


def build_client(status: int, payload: Any) -> LegiScore:
    client = LegiScore(api_key=TEST_KEY, max_retries=0)
    handler = lambda request: httpx.Response(status, json=payload)  # noqa: E731
    client._transport._client = httpx.Client(
        transport=httpx.MockTransport(handler), headers={"X-API-Key": TEST_KEY}
    )
    return client


def test_refused_resume_keeps_its_code_and_stays_readable() -> None:
    client = build_client(422, REFUSAL)
    try:
        client.reports.continue_case(CASE_ID, {"proceed_anyway": True})
    except LegiScoreError as error:
        assert error.status_code == 422
        # The bug this guards: str({...}) prints the whole mapping and buries the code.
        assert error.code == PAUSE_GATE_UNMET
        assert PAUSE_GATE_UNMET in str(error)
        assert "upload_docs" in str(error)
        # The reasons name documents on the case, so they belong on the body, not in a log line.
        assert "Sale Deed" not in str(error)
        assert error.body == REFUSAL
    else:  # pragma: no cover - the call must not succeed
        raise AssertionError("a 422 must raise")


def test_read_pause_gate_refusal_reads_the_error_and_the_raw_body() -> None:
    error = LegiScoreError("422", status_code=422, body=REFUSAL, code=PAUSE_GATE_UNMET)
    for candidate in (error, REFUSAL):
        refused = read_pause_gate_refusal(candidate)
        assert refused is not None
        assert refused.stage == "upload_docs"
        assert len(refused.reasons) == 1
        assert "Sale Deed" in refused.reasons[0]


def test_read_pause_gate_refusal_says_no_to_everything_else() -> None:
    assert read_pause_gate_refusal(None) is None
    assert read_pause_gate_refusal("422 Unprocessable Entity") is None
    assert read_pause_gate_refusal({"detail": "Case is not awaiting documents"}) is None
    # A field-validation 422 is a list, not the gate.
    assert read_pause_gate_refusal({"detail": [{"loc": ["body"], "msg": "field required"}]}) is None
    assert read_pause_gate_refusal({"detail": {"code": "something_else", "errors": ["x"]}}) is None
    # The code with no reasons is still a refusal; the caller decides what to show.
    bare = read_pause_gate_refusal({"detail": {"code": PAUSE_GATE_UNMET}})
    assert bare is not None
    assert bare.stage == ""
    assert bare.reasons == []


def test_field_validation_422_counts_the_fields() -> None:
    client = build_client(422, {"detail": [{"loc": ["body", "documentIds"], "msg": "required"}]})
    try:
        client.reports.create_case({"propertyFocus": {}})
    except LegiScoreError as error:
        assert "1 field" in str(error)
        assert "loc" not in str(error)
    else:  # pragma: no cover - the call must not succeed
        raise AssertionError("a 422 must raise")


def test_a_plain_string_detail_is_unchanged() -> None:
    client = build_client(400, {"detail": "Case is not awaiting documents"})
    try:
        client.reports.continue_case(CASE_ID, {})
    except LegiScoreError as error:
        assert error.code is None
        assert "Case is not awaiting documents" in str(error)
    else:  # pragma: no cover - the call must not succeed
        raise AssertionError("a 400 must raise")


def test_is_pending_second_approval_tells_parked_from_advanced() -> None:
    assert is_pending_second_approval({"success": True, "pending_checker": True}) is True
    assert is_pending_second_approval({"advanced": False, "pending_checker": True}) is True
    assert is_pending_second_approval({"success": True, "task_id": "t"}) is False
    assert is_pending_second_approval({"pending_checker": "true"}) is False
    assert is_pending_second_approval(None) is False


# One document-analysis pause as the API actually answers it: a finding to tick, one already
# resolved by its own recorded answer, and one ticked on an earlier round.
REVIEW_PAYLOAD: dict[str, Any] = {
    "case_id": "RPT-2026-EXAMPLE1",
    "status": "awaiting_document_review",
    "documents": [],
    "editable_fields": ["document_number", "document_date"],
    "review_findings": [
        {
            "fingerprint": "1a2b3c4d",
            "finding_kind": "review_flag",
            "document_id": "22222222-2222-4222-8222-222222222222",
            "label": "Ownership mismatch",
            "resolved": False,
            "acknowledged": False,
        },
        {
            "fingerprint": "5e6f7a8b",
            "finding_kind": "irrelevant",
            "document_id": None,
            "label": "May not relate to this property",
            "resolved": True,
            "acknowledged": False,
        },
        {
            "fingerprint": "9c0d1e2f",
            "finding_kind": "missing_fields",
            "document_id": "33333333-3333-4333-8333-333333333333",
            "label": "Survey number not read",
            "resolved": False,
            "acknowledged": True,
        },
    ],
}


def build_recording_client(payload: Any) -> tuple[LegiScore, list[Any]]:
    """A client that answers with ``payload`` and keeps every request body it was sent."""
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.content:
            sent.append(json.loads(request.content))
        return httpx.Response(200, json=payload)

    client = LegiScore(api_key=TEST_KEY, max_retries=0)
    client._transport._client = httpx.Client(
        transport=httpx.MockTransport(handler), headers={"X-API-Key": TEST_KEY}
    )
    return client, sent


def test_review_findings_are_read_off_the_pause_payload() -> None:
    client = build_client(200, REVIEW_PAYLOAD)
    findings = read_review_findings(client.reports.get_document_review(CASE_ID))

    assert [finding.fingerprint for finding in findings] == ["1a2b3c4d", "5e6f7a8b", "9c0d1e2f"]
    assert findings[0].finding_kind == "review_flag"
    assert findings[0].label == "Ownership mismatch"
    assert findings[0].resolved is False and findings[0].acknowledged is False
    # A case-level finding names no document.
    assert findings[1].document_id is None
    assert findings[1].resolved is True
    assert findings[2].acknowledged is True
    # The list on its own reads the same, for a server that proxies the call to its front end.
    assert read_review_findings(REVIEW_PAYLOAD["review_findings"]) == findings


def test_a_backend_without_the_field_yields_no_findings() -> None:
    # An older deployment omits the key; an org that never made the pause strict sends [].
    without_the_key = {
        key: value for key, value in REVIEW_PAYLOAD.items() if key != "review_findings"
    }
    assert read_review_findings(without_the_key) == []
    assert read_review_findings({**REVIEW_PAYLOAD, "review_findings": []}) == []
    assert read_review_findings({"review_findings": None}) == []
    assert read_review_findings(None) == []
    assert read_review_findings("awaiting_document_review") == []
    client = build_client(200, without_the_key)
    assert read_review_findings(client.reports.get_document_review(CASE_ID)) == []


def test_a_malformed_finding_is_skipped_rather_than_raising() -> None:
    findings = read_review_findings(
        {
            "review_findings": [
                None,
                "review_flag",
                {"label": "No fingerprint, so nothing can tick it"},
                {"fingerprint": "   "},
                {"fingerprint": 12345},
                {
                    "fingerprint": " 4d5e6f70 ",
                    "finding_kind": 7,
                    "document_id": "",
                    "label": None,
                    "resolved": "yes",
                    "acknowledged": 1,
                },
            ]
        }
    )
    assert len(findings) == 1
    only = findings[0]
    assert only.fingerprint == "4d5e6f70"
    assert only.finding_kind is None
    assert only.document_id is None
    assert only.label == ""
    # Anything but a real boolean true is not a tick, and not an answer either.
    assert only.resolved is False
    assert only.acknowledged is False


def test_annotations_skip_what_the_gate_already_counts_as_seen() -> None:
    findings = read_review_findings(REVIEW_PAYLOAD)
    annotations = build_document_review_annotations(findings)

    assert annotations == [{"fingerprint": "1a2b3c4d", "acknowledged": True}]
    # Nothing outstanding is an empty list, not an error.
    assert build_document_review_annotations([]) == []
    assert build_document_review_annotations(findings[1:]) == []


def test_annotations_reach_the_submit_body_unchanged() -> None:
    client, sent = build_recording_client({"success": True, "case_id": CASE_ID})
    annotations = build_document_review_annotations(read_review_findings(REVIEW_PAYLOAD))
    client.reports.submit_document_review(
        CASE_ID,
        {"proceed_to_searches": True, "document_review_annotations": annotations},
    )

    assert len(sent) == 1
    assert sent[0]["document_review_annotations"] == [
        {"fingerprint": "1a2b3c4d", "acknowledged": True}
    ]
    assert sent[0]["proceed_to_searches"] is True


if __name__ == "__main__":
    failures = 0
    for name, case in sorted(globals().items()):
        if name.startswith("test_") and callable(case):
            try:
                case()
                print(f"ok   {name}")
            except AssertionError as failure:
                failures += 1
                print(f"FAIL {name}: {failure}")
    sys.exit(1 if failures else 0)
