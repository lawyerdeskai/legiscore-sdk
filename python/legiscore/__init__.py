"""LegiScore partner SDK.

    from legiscore import LegiScore

    client = LegiScore(api_key="lsk_...")
    case = client.create_report(
        property_focus="Sy. No. 123, Example Village, Telangana",
        files=["sale-deed.pdf", "ec.pdf"],
    )
    state = client.wait_for_case(case["case_id"])

Every call has an asyncio twin on :class:`AsyncLegiScore`, with the same method names:

    async with AsyncLegiScore() as client:
        case = await client.create_report(property_focus="...", files=["sale-deed.pdf"])
        state = await client.wait_for_case(case["case_id"])

Endpoints are grouped by module: ``client.core``, ``client.reports``, ``client.search``,
``client.translate``, ``client.extraction``, ``client.webhooks``. Those namespaces are generated
from the OpenAPI spec; the helpers on the client itself collapse the multi-step flows.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import time
import uuid
from collections.abc import Iterable
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from ._operations import (
    AsyncCoreOperations,
    AsyncExtractionOperations,
    AsyncReportsOperations,
    AsyncSearchOperations,
    AsyncTranslateOperations,
    AsyncWebhooksOperations,
    CoreOperations,
    ExtractionOperations,
    ReportsOperations,
    SearchOperations,
    TranslateOperations,
    WebhooksOperations,
)
from ._transport import (
    DEFAULT_BASE_URL,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_SECONDS,
    AsyncTransport,
    LegiScoreError,
    MissingAPIKeyError,
    Transport,
)
from .webhooks import InvalidSignature, WebhookEvent, verify_webhook

__all__ = [
    "CASE_STATES",
    "TERMINAL_CASE_STATES",
    "AsyncLegiScore",
    "InvalidSignature",
    "LegiScore",
    "LegiScoreError",
    "MissingAPIKeyError",
    "WebhookEvent",
    "verify_webhook",
]

try:
    __version__ = version("legiscore")
except PackageNotFoundError:  # running straight from a source checkout, nothing installed
    __version__ = "0.0.0+source"

# The public lifecycle vocabulary (PublicCaseState in the spec).
CASE_STATES = ("queued", "running", "awaiting_review", "completed", "failed")
# States where nothing more happens without the partner: the report is ready, the case
# failed, or it has paused for a review the partner has to answer.
TERMINAL_CASE_STATES = frozenset({"awaiting_review", "completed", "failed"})

DEFAULT_POLL_INTERVAL_SECONDS = 15.0
DEFAULT_CASE_TIMEOUT_SECONDS = 3600.0
DEFAULT_UPLOAD_CONTENT_TYPE = "application/pdf"

_KEY_PROBLEMS = {
    401: "The API key was rejected. Check it starts with lsk_ and has not been revoked.",
    403: (
        "The key was refused. Either it has an Allowed-domains list, which a "
        "server-side call cannot satisfy because it sends no Origin header, or its "
        "profile lacks a required permission. Leave Allowed domains empty for "
        "server-side keys."
    ),
}


def resolve_api_key(api_key: str | None) -> str:
    """Fall back to the environment so a deployment can set the key without touching code."""
    return api_key or os.environ.get("LEGISCORE_API_KEY", "")


def build_presign_body(path: Path, size: int, content_type: str) -> dict[str, Any]:
    """The presign request for one document.

    The object is presigned under a unique name so that two uploads sharing a filename cannot
    collide. The real filename is what goes to ``complete``, and that is what the case displays.
    """
    return {
        "fileName": f"{uuid.uuid4().hex}-{path.name}",
        "fileSize": size,
        "contentType": content_type,
    }


def build_case_body(
    property_focus: str | dict[str, Any], document_ids: list[str], options: dict[str, Any]
) -> dict[str, Any]:
    """Assemble the create-case payload, wrapping a bare address string as the API wants it."""
    if not document_ids:
        raise ValueError("A case needs at least one document: pass files= or document_ids=.")
    focus = {"address": property_focus} if isinstance(property_focus, str) else property_focus
    return {"propertyFocus": focus, "documentIds": document_ids, **options}


def resolve_upload_content_type(path: Path, content_type: str | None) -> str:
    return content_type or mimetypes.guess_type(path.name)[0] or DEFAULT_UPLOAD_CONTENT_TYPE


def describe_key_problem(error: LegiScoreError) -> str:
    return _KEY_PROBLEMS.get(error.status_code or 0, f"Could not reach the API: {error}")


def is_case_finished(status: Any) -> bool:
    return bool(status.get("state") in TERMINAL_CASE_STATES)


class LegiScore:
    """Blocking client.

    One connection pool is shared by every namespace, and ``httpx.Client`` is safe for
    concurrent use, so a single ``LegiScore`` instance can be shared across threads. Use it as a
    context manager, or call :meth:`close` when you are done with it.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        transport = Transport(
            resolve_api_key(api_key),
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
        )
        self._transport = transport
        self.core = CoreOperations(transport)
        self.reports = ReportsOperations(transport)
        self.search = SearchOperations(transport)
        self.translate = TranslateOperations(transport)
        self.extraction = ExtractionOperations(transport)
        self.webhooks = WebhooksOperations(transport)

    def check_connection(self) -> dict[str, Any]:
        """Preflight. Prove the key reaches us and report what it can do.

        Returns a plain dict rather than raising, so a setup script can print it:
        ``{"ok": True, "base_url": ..., "credits": ..., "scenarios": 12}``. When
        something is wrong, ``ok`` is False and ``problem`` says what to fix.
        """
        report: dict[str, Any] = {"ok": False, "base_url": self._transport.base_url.rstrip("/")}
        try:
            credits = self.core.get_credits()
        except LegiScoreError as error:
            report["problem"] = describe_key_problem(error)
            report["status_code"] = error.status_code
            return report

        report["ok"] = True
        report["credits"] = credits
        try:
            scenarios = self.core.list_scenarios()
            report["scenarios"] = len(scenarios) if isinstance(scenarios, list) else scenarios
        except LegiScoreError:
            # Not fatal: the key works, this org just cannot list scenarios.
            report["scenarios"] = None
        return report

    # -- multi-step flows -----------------------------------------------------
    # Each of these is several API calls the partner would otherwise sequence by hand.

    def upload_document(self, file: str | Path, *, content_type: str | None = None) -> str:
        """Presign, PUT the bytes to storage, register the upload. Returns a document_id."""
        path = Path(file)
        size = path.stat().st_size
        resolved_type = resolve_upload_content_type(path, content_type)

        presigned = self.core.presign_upload(body=build_presign_body(path, size, resolved_type))
        self._transport.put_file(presigned["uploadUrl"], path, resolved_type)
        registered = self.core.complete_upload(
            body={
                "objectName": presigned["objectName"],
                "fileName": path.name,
                "fileSize": size,
                "contentType": resolved_type,
            }
        )
        return str(registered["document_id"])

    def create_report(
        self,
        *,
        property_focus: str | dict[str, Any],
        files: Iterable[str | Path] = (),
        document_ids: Iterable[str] = (),
        **options: Any,
    ) -> Any:
        """Upload documents and open a case in one call.

        ``property_focus`` is the property description object the API stores as
        ``property_data``, e.g. ``{"address": "Sy. No. 123, Example Village, Telangana"}``.
        A plain string is accepted and wrapped as ``{"address": ...}``, because that is the
        one field every caller sets and sending a bare string would 422.

        ``options`` passes through to POST /api/requests — case_name, scenario_code,
        template_id, metadata, the enable*Review flags, and the rest.
        """
        all_ids = [*document_ids, *(self.upload_document(f) for f in files)]
        return self.reports.create_case(body=build_case_body(property_focus, all_ids, options))

    def wait_for_case(
        self,
        case_id: str,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
        timeout: float = DEFAULT_CASE_TIMEOUT_SECONDS,
    ) -> Any:
        """Poll until the case finishes, fails, or pauses for review.

        Polling is the fallback. Configure a webhook and you get the same transition
        pushed to you instead.
        """
        deadline = time.monotonic() + timeout
        while True:
            status = self.reports.get_case_status(case_id)
            if is_case_finished(status):
                return status
            if time.monotonic() >= deadline:
                raise LegiScoreError(
                    f"Case {case_id} was still {status.get('state')!r} after {timeout:.0f}s",
                    body=status,
                )
            time.sleep(poll_interval)

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> LegiScore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncLegiScore:
    """Asyncio client. Same method names and same return values as :class:`LegiScore`.

    Use it as an async context manager, or ``await client.aclose()`` when you are done::

        async with AsyncLegiScore() as client:
            case = await client.create_report(property_focus="...", files=["deed.pdf"])
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        transport = AsyncTransport(
            resolve_api_key(api_key),
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
        )
        self._transport = transport
        self.core = AsyncCoreOperations(transport)
        self.reports = AsyncReportsOperations(transport)
        self.search = AsyncSearchOperations(transport)
        self.translate = AsyncTranslateOperations(transport)
        self.extraction = AsyncExtractionOperations(transport)
        self.webhooks = AsyncWebhooksOperations(transport)

    async def check_connection(self) -> dict[str, Any]:
        """Preflight. Prove the key reaches us and report what it can do."""
        report: dict[str, Any] = {"ok": False, "base_url": self._transport.base_url.rstrip("/")}
        try:
            credits = await self.core.get_credits()
        except LegiScoreError as error:
            report["problem"] = describe_key_problem(error)
            report["status_code"] = error.status_code
            return report

        report["ok"] = True
        report["credits"] = credits
        try:
            scenarios = await self.core.list_scenarios()
            report["scenarios"] = len(scenarios) if isinstance(scenarios, list) else scenarios
        except LegiScoreError:
            report["scenarios"] = None
        return report

    async def upload_document(self, file: str | Path, *, content_type: str | None = None) -> str:
        """Presign, PUT the bytes to storage, register the upload. Returns a document_id."""
        path = Path(file)
        size = path.stat().st_size
        resolved_type = resolve_upload_content_type(path, content_type)

        presigned = await self.core.presign_upload(
            body=build_presign_body(path, size, resolved_type)
        )
        await self._transport.put_file(presigned["uploadUrl"], path, resolved_type)
        registered = await self.core.complete_upload(
            body={
                "objectName": presigned["objectName"],
                "fileName": path.name,
                "fileSize": size,
                "contentType": resolved_type,
            }
        )
        return str(registered["document_id"])

    async def create_report(
        self,
        *,
        property_focus: str | dict[str, Any],
        files: Iterable[str | Path] = (),
        document_ids: Iterable[str] = (),
        **options: Any,
    ) -> Any:
        """Upload documents and open a case in one call. See :meth:`LegiScore.create_report`."""
        all_ids = list(document_ids)
        for file in files:
            all_ids.append(await self.upload_document(file))
        return await self.reports.create_case(
            body=build_case_body(property_focus, all_ids, options)
        )

    async def wait_for_case(
        self,
        case_id: str,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
        timeout: float = DEFAULT_CASE_TIMEOUT_SECONDS,
    ) -> Any:
        """Poll until the case finishes, fails, or pauses for review."""
        deadline = time.monotonic() + timeout
        while True:
            status = await self.reports.get_case_status(case_id)
            if is_case_finished(status):
                return status
            if time.monotonic() >= deadline:
                raise LegiScoreError(
                    f"Case {case_id} was still {status.get('state')!r} after {timeout:.0f}s",
                    body=status,
                )
            await asyncio.sleep(poll_interval)

    async def aclose(self) -> None:
        await self._transport.aclose()

    async def __aenter__(self) -> AsyncLegiScore:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()
