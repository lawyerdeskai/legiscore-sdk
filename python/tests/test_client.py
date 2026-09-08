"""Self-check for the hand-written parts: transport retries, errors, and the multi-step flows.

    pytest -q                     # the normal way
    python3 tests/test_client.py  # same tests, no pytest installed

No network: httpx.MockTransport answers every call.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from legiscore import AsyncLegiScore, LegiScore, LegiScoreError, MissingAPIKeyError
from legiscore._transport import (
    AsyncTransport,
    Transport,
    compute_backoff,
    parse_retry_after,
)

# Not a key shape anyone can mistake for a live one, and it still starts with lsk_ so the
# client does not warn about a truncated paste.
TEST_KEY = "lsk_fake_0000000000000000000000000000"
Handler = Callable[[httpx.Request], httpx.Response]


def build_client(handler: Handler, **kwargs: Any) -> LegiScore:
    client = LegiScore(api_key=TEST_KEY, **kwargs)
    client._transport._client = httpx.Client(
        transport=httpx.MockTransport(handler), headers={"X-API-Key": TEST_KEY}
    )
    return client


def build_async_client(handler: Handler, **kwargs: Any) -> AsyncLegiScore:
    client = AsyncLegiScore(api_key=TEST_KEY, **kwargs)
    client._transport._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), headers={"X-API-Key": TEST_KEY}
    )
    return client


def use_mock_storage(client: LegiScore, handler: Handler) -> None:
    client._transport._storage = httpx.Client(transport=httpx.MockTransport(handler))


def respond(status: int, **kwargs: Any) -> Handler:
    """A handler that always answers the same way, pacing retries to zero so tests stay fast."""
    headers = {"Retry-After": "0", **kwargs.pop("headers", {})}
    return lambda request: httpx.Response(status, headers=headers, **kwargs)


# -- construction ------------------------------------------------------------


def test_api_key_required() -> None:
    for missing in ("", "   "):
        try:
            Transport(missing)
        except MissingAPIKeyError as error:
            assert isinstance(error, LegiScoreError), "callers catch LegiScoreError"
            continue
        raise AssertionError(f"an API key of {missing!r} must be rejected before any request")


def test_base_url_must_be_encrypted_or_local() -> None:
    for rejected in ("http://evil.example", "file:///etc", "ftp://x", "opinion.legiscore.in"):
        try:
            Transport(TEST_KEY, base_url=rejected)
        except ValueError:
            continue
        raise AssertionError(f"{rejected!r} would put the API key on the wire in the clear")

    assert (
        Transport(TEST_KEY, base_url="http://localhost:8000").base_url == "http://localhost:8000/"
    )
    assert Transport(TEST_KEY, base_url="https://api.example/").base_url == "https://api.example/"


def test_the_client_is_a_context_manager() -> None:
    with build_client(respond(200, json={"state": "queued"})) as client:
        assert client.reports.get_case_status("RPT-1")["state"] == "queued"


# -- requests and errors -----------------------------------------------------


def test_auth_header_and_path() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.headers.get("X-API-Key")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"state": "queued"})

    build_client(handler).reports.get_case_status("RPT-2026-ABC12345")
    assert seen["key"] == TEST_KEY, seen
    assert seen["url"] == "https://opinion.legiscore.in/api/cases/RPT-2026-ABC12345/status", seen


def test_error_carries_status_and_body_but_never_the_key() -> None:
    handler = respond(402, json={"detail": "insufficient credits", "pan": "ABCDE1234F"})
    try:
        build_client(handler).reports.get_case_status("RPT-1")
    except LegiScoreError as exc:
        assert exc.status_code == 402, exc.status_code
        assert exc.body["pan"] == "ABCDE1234F", exc.body
        assert "insufficient credits" in str(exc), str(exc)
        assert TEST_KEY not in str(exc), "the message must never quote the key"
        assert TEST_KEY not in repr(vars(exc)), "no attribute may hold the key"
        return
    raise AssertionError("a 402 must raise LegiScoreError")


def test_a_problem_json_error_is_parsed_rather_than_returned_as_bytes() -> None:
    handler = respond(
        402,
        content=b'{"code": "insufficient_credits", "detail": "no credits"}',
        headers={"content-type": "application/problem+json"},
    )
    try:
        build_client(handler).reports.get_case_status("RPT-1")
    except LegiScoreError as error:
        assert error.body == {"code": "insufficient_credits", "detail": "no credits"}, error.body
        return
    raise AssertionError("a problem+json error must raise with a decoded body")


def test_binary_download_is_not_parsed_as_json() -> None:
    handler = respond(200, content=b"PK\x03\x04zip", headers={"content-type": "application/zip"})
    payload = build_client(handler).reports.download_case_files_zip("RPT-1")
    assert payload == b"PK\x03\x04zip", payload


def test_a_path_parameter_cannot_retarget_the_request() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        return httpx.Response(200, json={})

    build_client(handler).reports.get_case_status("../../v1/admin/keys")
    assert seen["path"].startswith("/api/cases/"), seen
    assert "admin" not in seen["path"].split("/api/cases/")[0], seen


# -- the retry matrix --------------------------------------------------------
# One row per rule in legiscore._transport: a read replays on anything transient, a write that
# the server cannot recognise as a repeat replays on 429 only, a write carrying an
# Idempotency-Key replays like a read, and a secret rotation never replays.


def count_attempts(handler_status: int, call: Callable[[LegiScore], object], **kwargs: Any) -> int:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(handler_status, json={"detail": "x"}, headers={"Retry-After": "0"})

    try:
        call(build_client(handler, **kwargs))
    except LegiScoreError:
        pass
    return attempts["n"]


def test_a_read_replays_on_every_transient_status() -> None:
    for status in (429, 502, 503, 504):
        attempts = count_attempts(status, lambda c: c.reports.get_case_status("RPT-1"))
        assert attempts == 4, f"a read on {status} made {attempts} attempts, expected 4"


def test_an_unkeyed_write_never_replays_on_5xx() -> None:
    """A 502 is not proof the server refused the work, so repeating it could charge twice."""
    for status in (502, 503, 504):
        attempts = count_attempts(
            status, lambda c: c.search.submit_search(body={"state": "telangana"})
        )
        assert attempts == 1, f"an unkeyed write on {status} was replayed {attempts} times"


def test_an_unkeyed_write_still_replays_on_429() -> None:
    """429 is the server declining before it runs, so the work definitely did not happen."""
    attempts = count_attempts(429, lambda c: c.search.submit_search(body={"state": "tg"}))
    assert attempts == 4, attempts


def test_a_keyed_write_replays_on_5xx_and_reuses_one_key() -> None:
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("Idempotency-Key", ""))
        if len(keys) < 3:
            return httpx.Response(502, json={"detail": "bad gateway"}, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"case_id": "RPT-1"})

    result = build_client(handler).reports.create_case(body={"propertyFocus": {}})
    assert result["case_id"] == "RPT-1", result
    assert len(keys) == 3, keys
    assert all(keys), "every attempt must carry an Idempotency-Key"
    assert len(set(keys)) == 1, f"retries must reuse ONE key, got {set(keys)}"


def test_rotating_a_secret_is_never_replayed() -> None:
    """Each rotation returns the new secret once, so a second attempt would strand the caller."""
    for status in (429, 502, 503, 504):
        attempts = count_attempts(status, lambda c: c.webhooks.rotate_webhook_secret("wh_1"))
        assert attempts == 1, f"rotate-secret on {status} was replayed {attempts} times"


def test_retries_eventually_give_up_and_raise() -> None:
    try:
        build_client(respond(503, json={"detail": "down"}), max_retries=1).reports.get_case_status(
            "R"
        )
    except LegiScoreError as exc:
        assert exc.status_code == 503, exc.status_code
        return
    raise AssertionError("exhausted retries must still raise")


# -- backoff -----------------------------------------------------------------


def test_retry_after_is_parsed_in_both_forms_and_clamped() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("not a date") is None
    assert parse_retry_after("-5") == 0.0
    assert parse_retry_after("999") == 60.0, "a hostile Retry-After must not stall the caller"

    soon = datetime.now(timezone.utc) + timedelta(seconds=30)
    parsed = parse_retry_after(format_datetime(soon, usegmt=True))
    assert parsed is not None and 25.0 <= parsed <= 35.0, parsed


def test_backoff_is_jittered_so_clients_do_not_retry_in_lockstep() -> None:
    delays = {compute_backoff(1, None) for _ in range(20)}
    assert len(delays) > 1, "identical delays mean no jitter"
    assert all(2.0 <= d <= 2.6 for d in delays), delays


# -- uploads -----------------------------------------------------------------


def test_upload_document_runs_the_three_steps(tmp_file: Path) -> None:
    calls: list[str] = []
    put: dict[str, Any] = {}

    def api(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/presign"):
            return httpx.Response(
                200, json={"uploadUrl": "https://storage.example/put", "objectName": "org/abc.pdf"}
            )
        return httpx.Response(200, json={"document_id": "doc-42"})

    def storage(request: httpx.Request) -> httpx.Response:
        put["url"] = str(request.url)
        put["type"] = request.headers.get("Content-Type")
        put["key"] = request.headers.get("X-API-Key")
        put["body"] = request.content
        return httpx.Response(200)

    client = build_client(api)
    use_mock_storage(client, storage)

    assert client.upload_document(tmp_file) == "doc-42"
    assert calls == ["/api/v1/uploads/presign", "/api/v1/uploads/complete"], calls
    assert put["url"] == "https://storage.example/put", put
    assert put["type"] == "application/pdf", put
    assert put["body"] == b"%PDF-1.4 sample", put
    assert put["key"] is None, "the API key must never be sent to a storage host"


def test_a_storage_upload_is_retried(tmp_file: Path) -> None:
    attempts = {"n": 0}

    def storage(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 2:
            return httpx.Response(503, headers={"Retry-After": "0"})
        return httpx.Response(200)

    client = build_client(respond(200, json={}))
    use_mock_storage(client, storage)
    client._transport.put_file("https://storage.example/put", tmp_file, "application/pdf")
    assert attempts["n"] == 2, attempts


def test_multipart_sends_the_file_and_the_form_fields(tmp_file: Path) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["type"] = request.headers.get("content-type", "")
        seen["body"] = request.content
        return httpx.Response(200, json={"session_id": "t-1"})

    build_client(handler).translate.translate_docx(files={"file": tmp_file}, target_lang="hi")
    assert "multipart/form-data" in str(seen["type"]), seen["type"]
    body = bytes(seen["body"])  # type: ignore[arg-type]
    assert b'name="file"; filename="sale-deed.pdf"' in body, body[:300]
    assert b"%PDF-1.4 sample" in body, body[:300]
    assert b'name="target_lang"' in body and b"hi" in body, body[:300]


# -- multi-step flows --------------------------------------------------------


def test_create_report_without_documents_fails_before_any_call() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request should be made when there are no documents")

    try:
        build_client(handler).create_report(property_focus="Sy. No. 123")
    except ValueError:
        return
    raise AssertionError("a case with no documents must be rejected client-side")


def test_a_string_property_focus_is_wrapped_into_the_object_the_api_wants() -> None:
    sent: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        if request.url.path == "/api/requests":
            sent.update(_json.loads(request.content))
        return httpx.Response(200, json={"case_id": "RPT-1"})

    build_client(handler).create_report(property_focus="Sy. No. 123", document_ids=["doc-1"])
    assert sent["propertyFocus"] == {"address": "Sy. No. 123"}, sent


def test_wait_for_case_stops_on_pause_and_times_out() -> None:
    states = iter(["queued", "running", "awaiting_review"])
    handler = lambda request: httpx.Response(200, json={"state": next(states)})
    final = build_client(handler).wait_for_case("RPT-1", poll_interval=0)
    assert final["state"] == "awaiting_review", final

    try:
        build_client(respond(200, json={"state": "running"})).wait_for_case(
            "RPT-1", poll_interval=0, timeout=0
        )
    except LegiScoreError as exc:
        assert "running" in str(exc), str(exc)
        return
    raise AssertionError("a case that never settles must time out")


def test_check_connection_reports_a_bad_key_instead_of_raising() -> None:
    report = build_client(respond(401, json={"detail": "Invalid API key"})).check_connection()
    assert report["ok"] is False, report
    assert "rejected" in report["problem"], report
    assert report["status_code"] == 401, report
    assert report["search"]["ok"] is False, "a rejected key is rejected on both hosts"


def test_check_connection_reports_a_working_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/search/credits":
            return httpx.Response(200, json={"balance": 7})
        if request.url.path == "/api/v1/credits":
            return httpx.Response(200, json={"balance": 42})
        return httpx.Response(200, json=[{"code": "purchase"}, {"code": "lease"}])

    report = build_client(handler).check_connection()
    assert report["ok"] is True, report
    assert report["credits"] == {"balance": 42}, report
    assert report["scenarios"] == 2, report
    assert report["search"] == {
        "ok": True,
        "base_url": "https://legiscore.in",
        "credits": {"balance": 7},
    }, report


# -- the search module -------------------------------------------------------
# Search is a separate product on a separate host with its own credit balance. Two things have
# to hold: the call goes to that host and nowhere else, and its error shape reaches the caller
# as the same exception type the rest of the SDK raises.


def test_a_search_goes_to_the_search_host_with_the_key() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("X-API-Key")
        return httpx.Response(202, json={"data": {"searches": []}})

    build_client(handler).search.submit_search(
        body={"state": "andhra", "search_type": "ec", "params": {"sro": "1"}}
    )
    assert seen["url"] == "https://legiscore.in/api/v1/search", seen
    assert seen["key"] == TEST_KEY, seen


def test_a_report_call_still_goes_to_the_reports_host() -> None:
    """The override is per operation, so adding a host must not move the other modules."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"state": "queued"})

    build_client(handler).reports.get_case_status("RPT-1")
    assert seen["url"].startswith("https://opinion.legiscore.in/"), seen


def test_search_base_url_is_overridable_and_validated_like_base_url() -> None:
    try:
        Transport(TEST_KEY, search_base_url="http://legiscore.in")
    except ValueError:
        pass
    else:
        raise AssertionError("an unencrypted search_base_url would leak the key too")

    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"data": {}})

    build_client(handler, search_base_url="http://localhost:3000").search.get_search_catalog()
    assert seen["url"] == "http://localhost:3000/api/v1/search/catalog", seen


def test_insufficient_credits_carries_the_code_not_just_the_status() -> None:
    """Search fails as {"error": {code, message}}; the report modules fail as {"detail": ...}.

    Both have to arrive as one exception type carrying a code worth branching on.
    """
    handler = respond(
        402,
        json={
            "error": {
                "code": "insufficient_credits",
                "message": "This run needs 20 search credits; 0 available.",
            }
        },
    )
    try:
        build_client(handler).search.submit_search(body={"state": "andhra"})
    except LegiScoreError as error:
        assert error.status_code == 402, error.status_code
        assert error.code == "insufficient_credits", error.code
        assert "search credits" in str(error), str(error)
        return
    raise AssertionError("a 402 from search must raise LegiScoreError")


def test_a_conflict_from_search_keeps_its_code_too() -> None:
    handler = respond(
        409,
        json={"error": {"code": "already_finished", "message": "This search already succeeded."}},
    )
    try:
        build_client(handler).search.cancel_search("SRCH-1")
    except LegiScoreError as error:
        assert error.code == "already_finished", error.code
        return
    raise AssertionError("a 409 from search must raise LegiScoreError")


def test_a_search_document_is_fetched_from_the_signed_url_without_the_key() -> None:
    """The route answers 302. The signed URL belongs to a storage host, so it gets no key."""
    seen: list[tuple[str, str | None]] = []

    def api(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("X-API-Key")))
        return httpx.Response(302, headers={"location": "https://files.example/x?sig=1"})

    def storage(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("X-API-Key")))
        return httpx.Response(200, content=b"%PDF")

    client = build_client(api)
    use_mock_storage(client, storage)

    assert client.search.get_search_document("SRCH-1", "ec.pdf") == b"%PDF"
    assert seen[0] == (
        "https://legiscore.in/api/v1/search/SRCH-1/documents/ec.pdf",
        TEST_KEY,
    ), seen
    assert seen[1] == ("https://files.example/x?sig=1", None), "the signed URL gets no API key"


def test_a_document_filename_cannot_walk_out_of_its_search() -> None:
    """raw_path, not path: httpx decodes `path`, and what goes on the wire is what matters."""
    seen: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["raw"] = request.url.raw_path
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": "No such document."}}
        )

    try:
        build_client(handler).search.get_search_document("SRCH-1", "../../secrets")
    except LegiScoreError as error:
        assert error.code == "not_found", error.code
        assert seen["raw"] == b"/api/v1/search/SRCH-1/documents/..%2F..%2Fsecrets", seen
        return
    raise AssertionError("a missing document must raise")


def test_a_redirect_to_plain_http_is_refused_rather_than_followed() -> None:
    handler = respond(302, headers={"location": "http://files.example/x"})
    try:
        build_client(handler).search.get_search_document("SRCH-1", "ec.pdf")
    except LegiScoreError as error:
        assert "not https" in str(error), str(error)
        return
    raise AssertionError("an unencrypted redirect target must be refused")


def test_a_redirect_anywhere_else_is_an_error_not_an_empty_body() -> None:
    """Only the download route opts in; elsewhere a 3xx used to return an empty body."""
    handler = respond(302, headers={"location": "https://elsewhere.example/"})
    try:
        build_client(handler).search.get_search("SRCH-1")
    except LegiScoreError as error:
        assert "redirect" in str(error), str(error)
        return
    raise AssertionError("a stray redirect must raise rather than look like success")


def test_check_connection_reports_each_host_separately() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "legiscore.in":
            return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "no"}})
        if request.url.path == "/api/v1/credits":
            return httpx.Response(200, json={"balance": 42})
        return httpx.Response(200, json=[{"code": "purchase"}])

    report = build_client(handler).check_connection()
    assert report["ok"] is True, "the reports host answered, so ok stays true"
    assert report["credits"] == {"balance": 42}, report
    assert report["search"]["ok"] is False, report
    assert report["search"]["base_url"] == "https://legiscore.in", report
    assert report["search"]["status_code"] == 401, report
    assert "rejected" in report["search"]["problem"], report


def test_a_detail_shaped_failure_still_has_no_code() -> None:
    """The report modules send no code, so `code` must be None rather than a guess."""
    try:
        build_client(respond(422, json={"detail": "bad payload"})).reports.get_case_status("R")
    except LegiScoreError as error:
        assert error.code is None, error.code
        assert "bad payload" in str(error), str(error)
        return
    raise AssertionError("a 422 must raise LegiScoreError")


# -- the async twin ----------------------------------------------------------


def test_async_client_opens_a_case_and_reads_it_back() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/requests":
            return httpx.Response(200, json={"case_id": "RPT-9"})
        return httpx.Response(200, json={"state": "completed"})

    async def scenario() -> tuple[Any, Any]:
        async with build_async_client(handler) as client:
            case = await client.create_report(property_focus="Sy. No. 123", document_ids=["d"])
            return case, await client.reports.get_case_status(case["case_id"])

    case, status = asyncio.run(scenario())
    assert case["case_id"] == "RPT-9", case
    assert status["state"] == "completed", status


def test_async_wait_for_case_polls_until_the_case_settles() -> None:
    states = iter(["queued", "running", "completed"])
    handler = lambda request: httpx.Response(200, json={"state": next(states)})

    async def scenario() -> Any:
        client = build_async_client(handler)
        try:
            return await client.wait_for_case("RPT-1", poll_interval=0)
        finally:
            await client.aclose()

    assert asyncio.run(scenario())["state"] == "completed"


def test_async_search_document_download_follows_the_same_rules() -> None:
    """The async transport has its own redirect path, so it needs its own proof."""
    seen: list[tuple[str, str | None]] = []

    def api(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("X-API-Key")))
        return httpx.Response(302, headers={"location": "https://files.example/x?sig=1"})

    def storage(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("X-API-Key")))
        return httpx.Response(200, content=b"%PDF")

    async def scenario() -> Any:
        client = build_async_client(api)
        client._transport._storage = httpx.AsyncClient(transport=httpx.MockTransport(storage))
        try:
            return await client.search.get_search_document("SRCH-1", "ec.pdf")
        finally:
            await client.aclose()

    assert asyncio.run(scenario()) == b"%PDF"
    assert seen[0][1] == TEST_KEY, seen
    assert seen[1] == ("https://files.example/x?sig=1", None), "the signed URL gets no API key"


def test_async_check_connection_reports_each_host() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "legiscore.in":
            return httpx.Response(200, json={"data": {"balance": 7}})
        if request.url.path == "/api/v1/credits":
            return httpx.Response(200, json={"balance": 42})
        return httpx.Response(200, json=[{"code": "purchase"}])

    async def scenario() -> Any:
        client = build_async_client(handler)
        try:
            return await client.check_connection()
        finally:
            await client.aclose()

    report = asyncio.run(scenario())
    assert report["ok"] is True, report
    assert report["search"]["ok"] is True, report
    assert report["search"]["base_url"] == "https://legiscore.in", report


def test_async_unkeyed_write_follows_the_same_retry_rule() -> None:
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(502, json={"detail": "bad gateway"}, headers={"Retry-After": "0"})

    async def scenario() -> None:
        client = build_async_client(handler)
        try:
            await client.search.submit_search(body={"state": "telangana"})
        except LegiScoreError:
            pass
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert attempts["n"] == 1, attempts


def test_the_async_transport_validates_its_base_url_too() -> None:
    try:
        AsyncTransport(TEST_KEY, base_url="http://evil.example")
    except ValueError:
        return
    raise AssertionError("the async transport must reject an unencrypted base URL")


def main() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        sample = Path(directory) / "sale-deed.pdf"
        sample.write_bytes(b"%PDF-1.4 sample")
        failures = 0
        for name, test in sorted(globals().items()):
            if not name.startswith("test_"):
                continue
            try:
                test(sample) if "tmp_file" in test.__code__.co_varnames else test()
                print(f"  ok    {name}")
            except Exception as exc:  # noqa: BLE001 - a self-check reports, it does not re-raise
                failures += 1
                print(f"  FAIL  {name}: {exc}")
    print("all green" if not failures else f"{failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
