"""Verify that a webhook really came from LegiScore.

Getting this wrong is the most common integration bug we see, so the SDK does it:

    from legiscore.webhooks import verify_webhook, InvalidSignature

    @app.post("/webhooks/legiscore")
    def receive(request):
        try:
            event = verify_webhook(request.body, request.headers, secret=WEBHOOK_SECRET)
        except InvalidSignature:
            return 400
        ...

``body`` must be the RAW request bytes. Re-serialising parsed JSON changes the byte string and
every signature check then fails.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from typing import Any

__all__ = ["verify_webhook", "InvalidSignature", "WebhookEvent", "EVENTS"]

SIGNATURE_HEADER = "X-LegiScore-Signature"
TIMESTAMP_HEADER = "X-LegiScore-Timestamp"
EVENT_HEADER = "X-LegiScore-Event"
DELIVERY_HEADER = "X-LegiScore-Delivery"

# The events a case can send. A pause event means the case is waiting on you.
EVENTS = (
    "asset.created",
    "report.auto_triggered",
    "report.started",
    "report.paused.missing_documents",
    "report.paused.review",
    "report.paused.acknowledgements",
    "report.completed",
    "report.failed",
    # Legacy names the older dispatch path still emits.
    "case.paused",
    "case.completed",
)

# Replays older than this are rejected. Five minutes is generous for clock skew and
# still short enough that a captured delivery cannot be resent tomorrow.
DEFAULT_TOLERANCE_SECONDS = 300


class InvalidSignature(Exception):
    """The delivery did not come from LegiScore, or is too old to trust."""


class WebhookEvent(dict[str, Any]):
    """The verified payload, with the delivery metadata pulled up as attributes."""

    def __init__(
        self, payload: dict[str, Any], *, event: str, delivery_id: str, timestamp: int
    ) -> None:
        super().__init__(payload)
        self.event = event
        self.delivery_id = delivery_id
        self.timestamp = timestamp

    @property
    def case_id(self) -> str | None:
        return self.get("case_id") or (self.get("data") or {}).get("case_id")

    @property
    def is_pause(self) -> bool:
        """True when the case has stopped and is waiting for an answer from you."""
        return self.event.startswith("report.paused.") or self.event == "case.paused"


def _header(headers: Mapping[str, Any], name: str) -> str:
    """Case-insensitive lookup — WSGI, ASGI and every framework spell these differently."""
    if name in headers:
        return str(headers[name])
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value)
    return ""


def verify_webhook(
    body: bytes | str,
    headers: Mapping[str, Any],
    *,
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: float | None = None,
) -> WebhookEvent:
    """Check the signature and freshness of one delivery, and return its parsed payload.

    Raises :class:`InvalidSignature` if the signature does not match, the timestamp is
    missing or stale, or the body is not the JSON we sent.
    """
    if not secret:
        raise InvalidSignature("No webhook secret configured")

    raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    sent_signature = _header(headers, SIGNATURE_HEADER)
    timestamp_header = _header(headers, TIMESTAMP_HEADER)

    if not sent_signature or not timestamp_header:
        raise InvalidSignature("Delivery is missing its signature or timestamp header")

    try:
        timestamp = int(timestamp_header)
    except ValueError:
        raise InvalidSignature(
            f"Timestamp header is not a unix time: {timestamp_header!r}"
        ) from None

    age = abs((time.time() if now is None else now) - timestamp)
    if age > tolerance_seconds:
        raise InvalidSignature(
            f"Delivery is {age:.0f}s old, outside the {tolerance_seconds}s window"
        )

    # Same construction as the sender: HMAC-SHA256 over "<timestamp>." + the raw body,
    # hex-encoded and prefixed with "sha256=".
    expected = (
        "sha256="
        + hmac.new(
            secret.encode("utf-8"), f"{timestamp}.".encode() + raw, hashlib.sha256
        ).hexdigest()
    )
    # Compare as bytes: a WSGI server decodes header bytes as latin-1, so a byte >= 0x80 reaches
    # us as a non-ASCII str and hmac.compare_digest raises TypeError on those. Fail closed with
    # our own exception instead, which is what a partner's `except InvalidSignature` catches.
    if not hmac.compare_digest(
        expected.encode("utf-8"), sent_signature.encode("utf-8", "surrogateescape")
    ):
        raise InvalidSignature("Signature does not match")

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidSignature(f"Body is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise InvalidSignature("Body is not a JSON object")

    return WebhookEvent(
        payload,
        event=_header(headers, EVENT_HEADER) or str(payload.get("event", "")),
        delivery_id=_header(headers, DELIVERY_HEADER) or str(payload.get("delivery_id", "")),
        timestamp=timestamp,
    )
