# legiscore

Python SDK for the [LegiScore](https://legiscore.in) partner API — title search and legal
opinion reports on Indian property.

- **Python 3.10+**, one dependency (`httpx`)
- **Sync and async**, same method names on both clients
- **Typed**: ships a `py.typed` marker, so mypy and pyright see every annotation
- **Webhook verification built in**, because that is the step integrations get wrong

```bash
pip install legiscore
```

## Quickstart

<table>
<tr><th>Sync</th><th>Async</th></tr>
<tr valign="top"><td>

```python
from legiscore import LegiScore

with LegiScore(api_key="lsk_...") as client:
    case = client.create_report(
        property_focus="Sy. No. 123, Example Village, Telangana",
        files=["sale-deed.pdf", "ec.pdf"],
    )
    status = client.wait_for_case(case["case_id"])

    if status["state"] == "completed":
        report = client.reports.get_case_result(case["case_id"])
```

</td><td>

```python
from legiscore import AsyncLegiScore

async with AsyncLegiScore(api_key="lsk_...") as client:
    case = await client.create_report(
        property_focus="Sy. No. 123, Example Village, Telangana",
        files=["sale-deed.pdf", "ec.pdf"],
    )
    status = await client.wait_for_case(case["case_id"])

    if status["state"] == "completed":
        report = await client.reports.get_case_result(case["case_id"])
```

</td></tr>
</table>

Set `LEGISCORE_API_KEY` in the environment and you can drop the `api_key=` argument entirely.

A case can pause and wait for you. `awaiting_review` means it needs missing documents, a document
review, or risk acknowledgements before it can finish, and each pause has a matching resume
method:

```python
if status["state"] == "awaiting_review":
    missing = client.reports.get_missing_documents(case["case_id"])
    client.reports.continue_case(case["case_id"], body={"new_document_ids": [...]})
```

`examples/end_to_end.py` in the repository walks one report through every pause.

## The six modules

Endpoints are grouped by module, on both clients:

| Namespace | What it covers |
|---|---|
| `client.core` | Credits, scenarios, custom field configs, document uploads |
| `client.reports` | Cases: create, status, result, files, and every pause/resume step |
| `client.search` | Raw searches over the state portals, plus the state and lookup catalogues |
| `client.translate` | Document translation sessions |
| `client.extraction` | Property extraction from a document |
| `client.webhooks` | List, create, update, delete and rotate the secret on your webhooks |

The client itself adds the multi-step helpers: `create_report`, `upload_document`,
`wait_for_case` and `check_connection`.

## Concurrency

`LegiScore` holds one connection pool and is safe to share across threads. `AsyncLegiScore` holds
one pool per event loop and is safe to share across tasks. Use either as a context manager, or
call `client.close()` / `await client.aclose()` when you are finished, so the pool is released.

## Errors and retries

Failures raise `LegiScoreError`, which carries `.status_code` and `.body`.

> `error.body` is the API's reply verbatim and may contain customer data — names, identifiers,
> document text. Log `error.status_code` and `str(error)`, which carry neither customer data nor
> your API key; do not log `.body` raw.

Retries are conservative on purpose, because a repeated write can spend credits twice:

| Call | Replayed on |
|---|---|
| Reads (`GET`) | 429, 502, 503, 504 |
| Writes that carry an `Idempotency-Key` (creating a case, completing an upload) | 429, 502, 503, 504 |
| Every other write | **429 only** — any other failure may mean the work was done and only the reply was lost |
| `rotate-secret` | never — a rotation returns the new secret exactly once |
| Presigned storage uploads | 429, 502, 503, 504 |

Backoff is exponential with jitter, honours `Retry-After` in both its seconds and HTTP-date forms,
and never waits more than a minute between attempts. Three retries is the default; change it with
`LegiScore(max_retries=...)`.

`base_url` must be `https://` (or `http://localhost` for local development) — the API key travels
in a header and the SDK refuses to send it unencrypted.

## Verifying webhooks

```python
from fastapi import FastAPI, Request, Response
from legiscore import InvalidSignature, verify_webhook

app = FastAPI()


@app.post("/webhooks/legiscore")
async def receive(request: Request) -> Response:
    try:
        event = verify_webhook(
            await request.body(),  # RAW bytes, not the parsed JSON
            request.headers,
            secret=WEBHOOK_SECRET,
        )
    except InvalidSignature:
        return Response(status_code=400)

    if event.is_pause:
        handle_pause(event.case_id)
    return Response(status_code=204)
```

`body` must be the **raw request bytes**. Re-serialising parsed JSON changes the byte string and
the signature check then fails — this is the single most common integration bug. Deliveries older
than five minutes are rejected as replays, and an empty secret fails closed rather than trusting
the delivery. Deliveries can repeat, so key your own processing on `event.delivery_id`.

**Setting the webhook up.** Create it in the LegiScore dashboard with auth type **HMAC**. The secret
it shows you is `WEBHOOK_SECRET`; there is no other place to get it, and a webhook created with any
other auth type sends no `X-LegiScore-Signature` at all, so verification will reject every delivery.

**Leave "Allowed domains" empty on a server-side key.** A non-empty list is checked against the
`Origin` or `Referer` header, which a server-to-server call does not send, so every request returns
403 no matter how valid the key is.

## Checking the connection

```python
report = client.check_connection()  # returns a dict, never raises
if not report["ok"]:
    raise SystemExit(report["problem"])
```

## Dependencies

The only runtime dependency is `httpx>=0.27,<1`. If you pin your own transitive dependencies, keep
`h11>=0.16` — older releases carry a request-smuggling advisory, and a fresh install picks a safe
version on its own.
