"""Self-check for webhook verification. python3 tests/test_webhooks.py"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from legiscore.webhooks import InvalidSignature, verify_webhook

SECRET = "whsec_test"


def sign(body: bytes, timestamp: int, secret: str = SECRET) -> dict[str, str]:
    """Reproduces the documented signing scheme exactly."""
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return {
        "X-LegiScore-Signature": f"sha256={digest}",
        "X-LegiScore-Timestamp": str(timestamp),
        "X-LegiScore-Event": "report.completed",
        "X-LegiScore-Delivery": "d-1",
    }


def body_bytes(**extra) -> bytes:
    return json.dumps({"event": "report.completed", "case_id": "RPT-1", **extra}).encode()


def test_a_genuine_delivery_verifies() -> None:
    now = int(time.time())
    body = body_bytes()
    event = verify_webhook(body, sign(body, now), secret=SECRET)
    assert event.case_id == "RPT-1", event
    assert event.event == "report.completed", event.event
    assert event.delivery_id == "d-1", event.delivery_id
    assert event.is_pause is False


def test_a_pause_event_is_flagged() -> None:
    now = int(time.time())
    body = body_bytes()
    headers = sign(body, now) | {"X-LegiScore-Event": "report.paused.missing_documents"}
    assert verify_webhook(body, headers, secret=SECRET).is_pause is True


def test_headers_are_matched_case_insensitively() -> None:
    now = int(time.time())
    body = body_bytes()
    lowered = {key.lower(): value for key, value in sign(body, now).items()}
    assert verify_webhook(body, lowered, secret=SECRET).case_id == "RPT-1"


def test_a_tampered_body_is_rejected() -> None:
    now = int(time.time())
    headers = sign(body_bytes(), now)
    try:
        verify_webhook(body_bytes(case_id="RPT-EVIL"), headers, secret=SECRET)
    except InvalidSignature:
        return
    raise AssertionError("a body that does not match the signature must be rejected")


def test_the_wrong_secret_is_rejected() -> None:
    now = int(time.time())
    body = body_bytes()
    try:
        verify_webhook(body, sign(body, now, secret="whsec_other"), secret=SECRET)
    except InvalidSignature:
        return
    raise AssertionError("a signature made with another secret must be rejected")


def test_a_replayed_delivery_is_rejected() -> None:
    old = int(time.time()) - 3600
    body = body_bytes()
    try:
        verify_webhook(body, sign(body, old), secret=SECRET)
    except InvalidSignature as error:
        assert "old" in str(error), str(error)
        return
    raise AssertionError("an hour-old delivery must be outside the freshness window")


def test_missing_headers_are_rejected() -> None:
    for headers in ({}, {"X-LegiScore-Signature": "sha256=abc"}, {"X-LegiScore-Timestamp": "123"}):
        try:
            verify_webhook(body_bytes(), headers, secret=SECRET)
        except InvalidSignature:
            continue
        raise AssertionError(f"a delivery with headers {headers} must be rejected")


def test_an_empty_secret_is_rejected_rather_than_trusted() -> None:
    now = int(time.time())
    body = body_bytes()
    try:
        verify_webhook(body, sign(body, now), secret="")
    except InvalidSignature:
        return
    raise AssertionError("verification without a secret must fail closed")


def main() -> int:
    failures = 0
    for name, test in sorted(globals().items()):
        if not name.startswith("test_"):
            continue
        try:
            test()
            print(f"  ok    {name}")
        except Exception as exc:  # noqa: BLE001 - a self-check reports, it does not re-raise
            failures += 1
            print(f"  FAIL  {name}: {exc}")
    print("all green" if not failures else f"{failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
