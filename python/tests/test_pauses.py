"""Self-check for the two replies to a pause that are not "it worked".

    pytest -q                     # the normal way
    python3 tests/test_pauses.py  # same tests, no pytest installed

No network: httpx.MockTransport answers every call.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from legiscore import (
    PAUSE_GATE_UNMET,
    LegiScore,
    LegiScoreError,
    is_pending_second_approval,
    read_pause_gate_refusal,
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
