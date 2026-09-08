"""HTTP transport: auth, retries, errors. Hand-written; the method surface is generated.

Two transports live here and behave identically: :class:`Transport` (blocking) and
:class:`AsyncTransport` (asyncio). Both hold one pooled connection pool for the API and a second
one for presigned storage uploads, and both are safe to share across threads or tasks.
"""

from __future__ import annotations

import asyncio
import mimetypes
import random
import time
import uuid
import warnings
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urljoin, urlsplit

import httpx

DEFAULT_BASE_URL = "https://opinion.legiscore.in"
# Search is a separate product on a separate host. The spec says so per path, so the generated
# methods ask for this base by name rather than every caller having to know which is which.
DEFAULT_SEARCH_BASE_URL = "https://legiscore.in"
DEFAULT_TIMEOUT_SECONDS = 60.0
DEFAULT_MAX_RETRIES = 3

API_KEY_PREFIX = "lsk_"
HTTP_ERROR_FLOOR = 400
# Methods that change nothing, so a repeat costs nothing.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# Only these hosts may be reached over plain HTTP; everything else must be TLS, because the
# API key travels in a request header.
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# A read, or a write the server can recognise as a repeat, may replay on any of these.
RETRY_STATUSES = frozenset({429, 502, 503, 504})
# A write the server cannot recognise as a repeat replays on 429 only. 429 is the server
# declining the call before it runs; any other failure may mean the work was done and only the
# reply was lost, so the SDK surfaces the error rather than repeating a call that spends credits.
UNKEYED_WRITE_RETRY_STATUSES = frozenset({429})
# Routes that accept an ``Idempotency-Key``. The SDK generates one key per call and reuses it
# across that call's retries, so the server returns the first result instead of doing the work
# a second time.
IDEMPOTENT_WRITE_PATHS = frozenset({"/api/requests", "/api/v1/uploads/complete"})
# Writes that create nothing server-side, so replaying one is as safe as replaying a read.
HARMLESS_WRITE_PATHS = frozenset({"/api/v1/uploads/presign"})
# Never repeated. Each rotation returns the new secret exactly once, so a second attempt would
# leave the caller holding a value the API no longer accepts.
NEVER_RETRY_PATH_SUFFIXES = ("/rotate-secret",)

# A hostile or mistaken Retry-After cannot stall a caller for longer than this.
MAX_RETRY_AFTER_SECONDS = 60.0
# Spread retries so every client rate-limited in the same second does not come back in lockstep.
JITTER_FRACTION = 0.3
BACKOFF_BASE_SECONDS = 2.0

# Uploads are large, so give the body room, but never let a stalled connection hang forever.
UPLOAD_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=300.0, pool=10.0)


class LegiScoreError(Exception):
    """A LegiScore API call failed.

    ``status_code`` is the HTTP status and ``body`` the decoded response, so callers can
    branch on the reason rather than parsing the message string. ``code`` is the API's own
    error code when it sent one, e.g. ``"insufficient_credits"``; it is stable, and the thing
    to branch on, because the message is written for a person and may be reworded.

    ``body`` is the API's reply verbatim and may contain customer data — names, identifiers,
    document text. Do not log it raw; log ``status_code`` and ``str(error)``, which carry no
    customer data, no API key and no request headers.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        body: Any = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.code = code


class MissingAPIKeyError(LegiScoreError):
    """No API key was given, so no call can be made.

    A subclass of :class:`LegiScoreError` so that ``except LegiScoreError`` around a first run
    reports the missing key instead of showing a traceback.
    """


class RetryPolicy(NamedTuple):
    """What one call is allowed to replay on."""

    statuses: frozenset[int]
    send_idempotency_key: bool
    replay_transport_errors: bool


def normalise_base_url(base_url: str) -> str:
    """Return ``base_url`` without its trailing slash, rejecting anything that is not TLS.

    The API key travels in a request header, so a plain-HTTP or non-HTTP base URL would put it
    on the wire in the clear. Loopback hosts are allowed for local development.
    """
    trimmed = base_url.strip().rstrip("/")
    parts = urlsplit(trimmed)
    host = (parts.hostname or "").lower()
    if parts.scheme == "https" or (parts.scheme == "http" and host in LOCAL_HOSTS):
        return trimmed
    raise ValueError(
        f"base_url must be an https:// URL (or http:// on localhost), got {base_url!r}. "
        "The API key is sent as a header and must not travel unencrypted."
    )


def require_api_key(api_key: str | None) -> str:
    """Return the key with surrounding whitespace removed, or explain that it is missing."""
    key = (api_key or "").strip()
    if not key:
        raise MissingAPIKeyError("An API key is required. Pass api_key= or set LEGISCORE_API_KEY.")
    if not key.startswith(API_KEY_PREFIX):
        warnings.warn(
            f"API key does not start with {API_KEY_PREFIX!r}; check you copied the whole value.",
            stacklevel=3,
        )
    return key


def resolve_retry_policy(method: str, path: str) -> RetryPolicy:
    """Decide what this call may replay on, and whether it carries an ``Idempotency-Key``."""
    route = path.split("?")[0]
    if any(route.endswith(suffix) for suffix in NEVER_RETRY_PATH_SUFFIXES):
        return RetryPolicy(frozenset(), False, False)
    if method.upper() in SAFE_METHODS or route in HARMLESS_WRITE_PATHS:
        return RetryPolicy(RETRY_STATUSES, False, True)
    if route in IDEMPOTENT_WRITE_PATHS:
        return RetryPolicy(RETRY_STATUSES, True, True)
    return RetryPolicy(UNKEYED_WRITE_RETRY_STATUSES, False, False)


def parse_retry_after(value: str | None) -> float | None:
    """Read a ``Retry-After`` header, in seconds or as an HTTP-date, clamped to a sane range."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            # RFC 7231 permits the HTTP-date form, which float() cannot read.
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        seconds = (when - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, min(seconds, MAX_RETRY_AFTER_SECONDS))


def compute_backoff(attempt: int, retry_after: str | None) -> float:
    """Seconds to wait before attempt ``attempt + 1``, honouring the server's own pacing."""
    delay = parse_retry_after(retry_after)
    if delay is None:
        delay = BACKOFF_BASE_SECONDS**attempt
    return delay + random.uniform(0.0, JITTER_FRACTION * delay)


def build_multipart_parts(files: dict[str, Any] | None) -> list[tuple[str, tuple[str, bytes, str]]]:
    """Turn ``{field: path}`` or ``{field: [paths]}`` into the parts httpx wants.

    Bodies are read into memory here, not streamed, so that a replay re-sends the same bytes
    rather than an exhausted file handle. Large documents go through ``put_file``, which streams.
    """
    parts: list[tuple[str, tuple[str, bytes, str]]] = []
    for field, value in (files or {}).items():
        for item in value if isinstance(value, (list, tuple)) else [value]:
            file_path = Path(item)
            parts.append(
                (
                    field,
                    (
                        file_path.name,
                        file_path.read_bytes(),
                        mimetypes.guess_type(file_path.name)[0] or "application/octet-stream",
                    ),
                )
            )
    return parts


def read_failure(payload: Any) -> tuple[str | None, str | None]:
    """Pull ``(code, detail)`` out of a failure body, whichever shape it arrived in.

    Two shapes are in use: ``{"detail": ...}`` from the report modules and
    ``{"error": {"code", "message"}}`` from search. A top-level ``code`` is read as well, so a
    problem+json body is not lost.
    """
    if not isinstance(payload, dict):
        return None, None

    nested = payload.get("error")
    if isinstance(nested, dict):
        code = nested.get("code")
        message = nested.get("message")
        return (
            code if isinstance(code, str) else None,
            message if isinstance(message, str) else None,
        )

    code = payload.get("code")
    detail = payload.get("detail")
    return (
        code if isinstance(code, str) else None,
        None if detail is None else str(detail),
    )


def resolve_signed_url(response: httpx.Response) -> str:
    """The absolute target of a redirect the API answered with, refused unless it is encrypted.

    The signed URL belongs to a storage host, so it is fetched on a client with no API key on it.
    That is only safe if the target really is the host we were sent to over TLS.
    """
    location = response.headers.get("location", "")
    if not location:
        raise LegiScoreError(
            f"{response.request.url.path} redirected with no Location header.",
            status_code=response.status_code,
        )
    target = response.request.url.join(location)
    host = (target.host or "").lower()
    if target.scheme != "https" and host not in LOCAL_HOSTS:
        raise LegiScoreError(
            f"{response.request.url.path} redirected to {target.scheme}://{host}, "
            "which is not https. The SDK will not fetch it."
        )
    return str(target)


def unwrap_download(response: httpx.Response, path: str) -> bytes:
    """The bytes of a signed-URL download, or an error naming the API path that produced it."""
    if response.status_code >= HTTP_ERROR_FLOOR:
        raise LegiScoreError(
            f"Downloading {path} failed: {response.status_code}",
            status_code=response.status_code,
        )
    if response.is_redirect:
        raise LegiScoreError(
            f"Downloading {path} redirected again, which a signed URL never does.",
            status_code=response.status_code,
        )
    return response.content


def unwrap_response(response: httpx.Response) -> Any:
    """Decode a reply, or raise :class:`LegiScoreError` describing why it failed."""
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    payload: Any
    if content_type.endswith("json"):
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
    else:
        payload = response.content  # ZIP downloads and other binaries

    if response.is_redirect:
        # Only the download route is allowed one, and it never reaches here. Anywhere else a
        # 3xx would otherwise hand back an empty body as though the call had succeeded.
        raise LegiScoreError(
            f"{response.request.url.path} answered with a redirect "
            f"({response.status_code}); the LegiScore API does not redirect here. "
            "Check base_url.",
            status_code=response.status_code,
        )

    if response.status_code >= HTTP_ERROR_FLOOR:
        code, detail = read_failure(payload)
        # The path, never the full URL: query values can carry identifiers.
        raise LegiScoreError(
            f"{response.status_code} {response.reason_phrase}: "
            f"{detail or response.request.url.path}",
            status_code=response.status_code,
            body=payload,
            code=code,
        )
    return payload


def build_api_client_kwargs(api_key: str, timeout: float) -> dict[str, Any]:
    """Client settings shared by the sync and async transports."""
    return {
        "timeout": timeout,
        "headers": {"X-API-Key": api_key, "Accept": "application/json"},
        # Explicit, so a change to an httpx default can never quietly weaken either of them.
        "verify": True,
        "follow_redirects": False,
    }


def build_storage_client_kwargs() -> dict[str, Any]:
    """Client settings for presigned storage uploads, which must not carry the API key."""
    return {"timeout": UPLOAD_TIMEOUT, "verify": True, "follow_redirects": False}


def build_upload_headers(content_type: str, size: int) -> dict[str, str]:
    """Headers for a streamed PUT.

    Setting ``Content-Length`` keeps httpx from switching to chunked transfer encoding, which
    presigned storage URLs reject.
    """
    return {"Content-Type": content_type, "Content-Length": str(size)}


class Transport:
    """Blocking transport.

    One :class:`httpx.Client` is created here and shared by every module namespace, so a session
    reuses connections and TLS sessions. ``httpx.Client`` is safe for concurrent use, so a single
    ``Transport`` (and the ``LegiScore`` client holding it) can be shared across threads.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        search_base_url: str = DEFAULT_SEARCH_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        client: httpx.Client | None = None,
    ) -> None:
        key = require_api_key(api_key)
        self.base_url = normalise_base_url(base_url) + "/"
        # Where the search module is sent. Named per module so the generated methods can ask
        # for a base by name instead of every caller knowing which host serves what.
        self.search_base_url = normalise_base_url(search_base_url) + "/"
        self._module_base_urls = {"search": self.search_base_url}
        self.max_retries = max_retries
        self._client = client or httpx.Client(**build_api_client_kwargs(key, timeout))
        # Presigned URLs carry their own auth, so uploads go out on a second pooled client that
        # has no API key on it and therefore cannot hand one to a storage host.
        self._storage = httpx.Client(**build_storage_client_kwargs())

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> Any:
        return self._send(method, path, query, base=base, json=body)

    def request_multipart(
        self,
        method: str,
        path: str,
        *,
        files: dict[str, Any] | None = None,
        form: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> Any:
        """Send a file upload. ``files`` maps a field name to a path, or a list of paths."""
        parts = build_multipart_parts(files)
        data = {k: str(v) for k, v in (form or {}).items() if v is not None}
        return self._send(method, path, None, base=base, files=parts or None, data=data or None)

    def request_download(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> bytes:
        """Fetch a file the API hands over by redirect, and return its bytes.

        The route answers 302 with a short-lived signed URL. The redirect is resolved here and
        the URL is fetched on the storage client, which has no API key on it, so a credential is
        never sent to a host that is not ours.
        """
        return self._send(method, path, query, base=base, allow_redirect=True)  # type: ignore[no-any-return]

    def _follow_download(self, response: httpx.Response) -> bytes:
        path = response.request.url.path
        target = resolve_signed_url(response)
        try:
            downloaded = self._storage.get(target, timeout=UPLOAD_TIMEOUT)
        except httpx.RequestError as exc:
            raise LegiScoreError(f"Downloading {path} failed: {exc}") from exc
        return unwrap_download(downloaded, path)

    def _base_for(self, base: str | None) -> str:
        """The host for one call. An unknown name falls back to ``base_url`` rather than raising,
        so an older client paired with a newer spec still reaches something."""
        return self._module_base_urls.get(base or "", self.base_url)

    def _send(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None,
        base: str | None = None,
        allow_redirect: bool = False,
        **payload: Any,
    ) -> Any:
        url = urljoin(self._base_for(base), path.lstrip("/"))
        params = {k: v for k, v in (query or {}).items() if v is not None}
        policy = resolve_retry_policy(method, path)
        headers = dict(payload.pop("headers", {}) or {})
        if policy.send_idempotency_key:
            headers["Idempotency-Key"] = uuid.uuid4().hex

        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self._client.request(
                    method, url, params=params, headers=headers, **payload
                )
            except httpx.RequestError as exc:  # connection reset, DNS failure, timeout
                last_error = exc
                if attempt == self.max_retries or not policy.replay_transport_errors:
                    raise LegiScoreError(f"Could not reach {url}: {exc}") from exc
                time.sleep(compute_backoff(attempt, None))
                continue

            if allow_redirect and response.is_redirect:
                return self._follow_download(response)
            if response.status_code in policy.statuses and attempt < self.max_retries:
                time.sleep(compute_backoff(attempt, response.headers.get("Retry-After")))
                continue
            return unwrap_response(response)

        raise LegiScoreError(f"Request to {url} failed after retries: {last_error}")

    def put_file(self, upload_url: str, file: str | Path, content_type: str) -> None:
        """Stream a file straight to presigned storage. The URL carries its own auth.

        A PUT to a presigned URL replaces the whole object, so repeating one is safe and every
        transient failure is retried.
        """
        path = Path(file)
        headers = build_upload_headers(content_type, path.stat().st_size)
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                with path.open("rb") as handle:
                    response = self._storage.put(upload_url, content=handle, headers=headers)
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == self.max_retries:
                    raise LegiScoreError(f"Upload to storage failed: {exc}") from exc
                time.sleep(compute_backoff(attempt, None))
                continue

            if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                time.sleep(compute_backoff(attempt, response.headers.get("Retry-After")))
                continue
            if response.status_code >= HTTP_ERROR_FLOOR:
                raise LegiScoreError(
                    f"Upload to storage failed: {response.status_code}",
                    status_code=response.status_code,
                    body=response.text,
                )
            return

        raise LegiScoreError(f"Upload to storage failed after retries: {last_error}")

    def close(self) -> None:
        self._client.close()
        self._storage.close()


class AsyncTransport:
    """Asyncio transport. Same routes, same retry rules, same errors as :class:`Transport`."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        search_base_url: str = DEFAULT_SEARCH_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        key = require_api_key(api_key)
        self.base_url = normalise_base_url(base_url) + "/"
        # Where the search module is sent. Named per module so the generated methods can ask
        # for a base by name instead of every caller knowing which host serves what.
        self.search_base_url = normalise_base_url(search_base_url) + "/"
        self._module_base_urls = {"search": self.search_base_url}
        self.max_retries = max_retries
        self._client = client or httpx.AsyncClient(**build_api_client_kwargs(key, timeout))
        self._storage = httpx.AsyncClient(**build_storage_client_kwargs())

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> Any:
        return await self._send(method, path, query, base=base, json=body)

    async def request_multipart(
        self,
        method: str,
        path: str,
        *,
        files: dict[str, Any] | None = None,
        form: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> Any:
        """Send a file upload. ``files`` maps a field name to a path, or a list of paths."""
        parts = build_multipart_parts(files)
        data = {k: str(v) for k, v in (form or {}).items() if v is not None}
        return await self._send(
            method, path, None, base=base, files=parts or None, data=data or None
        )

    async def request_download(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        base: str | None = None,
    ) -> bytes:
        """Fetch a file the API hands over by redirect. See :meth:`Transport.request_download`."""
        return await self._send(method, path, query, base=base, allow_redirect=True)  # type: ignore[no-any-return]

    async def _follow_download(self, response: httpx.Response) -> bytes:
        path = response.request.url.path
        target = resolve_signed_url(response)
        try:
            downloaded = await self._storage.get(target, timeout=UPLOAD_TIMEOUT)
        except httpx.RequestError as exc:
            raise LegiScoreError(f"Downloading {path} failed: {exc}") from exc
        return unwrap_download(downloaded, path)

    def _base_for(self, base: str | None) -> str:
        """The host for one call. An unknown name falls back to ``base_url`` rather than raising,
        so an older client paired with a newer spec still reaches something."""
        return self._module_base_urls.get(base or "", self.base_url)

    async def _send(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None,
        base: str | None = None,
        allow_redirect: bool = False,
        **payload: Any,
    ) -> Any:
        url = urljoin(self._base_for(base), path.lstrip("/"))
        params = {k: v for k, v in (query or {}).items() if v is not None}
        policy = resolve_retry_policy(method, path)
        headers = dict(payload.pop("headers", {}) or {})
        if policy.send_idempotency_key:
            headers["Idempotency-Key"] = uuid.uuid4().hex

        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.request(
                    method, url, params=params, headers=headers, **payload
                )
            except httpx.RequestError as exc:  # connection reset, DNS failure, timeout
                last_error = exc
                if attempt == self.max_retries or not policy.replay_transport_errors:
                    raise LegiScoreError(f"Could not reach {url}: {exc}") from exc
                await asyncio.sleep(compute_backoff(attempt, None))
                continue

            if allow_redirect and response.is_redirect:
                return await self._follow_download(response)
            if response.status_code in policy.statuses and attempt < self.max_retries:
                await asyncio.sleep(compute_backoff(attempt, response.headers.get("Retry-After")))
                continue
            return unwrap_response(response)

        raise LegiScoreError(f"Request to {url} failed after retries: {last_error}")

    async def put_file(self, upload_url: str, file: str | Path, content_type: str) -> None:
        """Stream a file straight to presigned storage. The URL carries its own auth."""
        path = Path(file)
        headers = build_upload_headers(content_type, path.stat().st_size)
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                with path.open("rb") as handle:
                    response = await self._storage.put(upload_url, content=handle, headers=headers)
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == self.max_retries:
                    raise LegiScoreError(f"Upload to storage failed: {exc}") from exc
                await asyncio.sleep(compute_backoff(attempt, None))
                continue

            if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                await asyncio.sleep(compute_backoff(attempt, response.headers.get("Retry-After")))
                continue
            if response.status_code >= HTTP_ERROR_FLOOR:
                raise LegiScoreError(
                    f"Upload to storage failed: {response.status_code}",
                    status_code=response.status_code,
                    body=response.text,
                )
            return

        raise LegiScoreError(f"Upload to storage failed after retries: {last_error}")

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._storage.aclose()
