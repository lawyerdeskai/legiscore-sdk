# Build a LegiScore integration

Paste everything below into Claude Code, Cursor, or any coding agent. It is written for the
agent, not for a person. It carries the traps that a partner's first integration usually falls
into, so the agent writes working code on the first attempt instead of after three support emails.

---

You are integrating **LegiScore** into this codebase. LegiScore produces legal opinion reports on
Indian property from uploaded documents, and runs government record searches against the state
portals. Read every rule below before writing code. The rules exist because each one has broken a
real integration.

## 1. Install and authenticate

```bash
pip install legiscore          # Python 3.10+
npm install @legiscore/sdk     # Node 20+, ESM and CJS, edge-runtime safe
```

The key looks like `lsk_live_...`. Read it from the environment, never hardcode it. The SDK reads
`LEGISCORE_API_KEY` on its own if you pass nothing.

```python
from legiscore import LegiScore
client = LegiScore()                    # reads LEGISCORE_API_KEY
```

If the host app is async, use `AsyncLegiScore` instead — same methods, same names, awaited. In TypeScript every method already returns a promise, `verifyWebhook` included: await it.

The key identifies the organisation. There is no account id, tenant id, or org id to pass anywhere.
If you find yourself adding one, you have misread the API.

## 2. Always start with a connection check

Never let the first API call a user makes be a real, billable one. Run this at startup or in a
setup command, and surface the result:

```python
report = client.check_connection()
if not report["ok"]:
    raise SystemExit(f"LegiScore is not reachable: {report['problem']}")
print(f"Connected. Credits: {report['credits']}")
```

`check_connection()` returns a dict and never raises. `ok` is False with a plain-English `problem`
when the key is wrong, revoked, or lacks a permission.

## 3. A report is a long-running job that can stop and ask you questions

This is the single most important thing to understand. A case takes minutes and has five public
states:

| State | Meaning | Your move |
|---|---|---|
| `queued` | accepted, not started | wait |
| `running` | working | wait |
| `awaiting_review` | **stopped, waiting on you** | answer, then wait again |
| `completed` | report ready | fetch the result |
| `failed` | dead | read `message`, do not retry blindly |

Never write code that assumes `create` is followed by `completed`. Never treat `awaiting_review`
as an error. Never poll faster than every 10 seconds.

## 4. The three pauses, and how to answer each

When the state is `awaiting_review`, **read `status["internal_status"]` to find out which pause it
is**. Do not probe all three endpoints: asking about a pause the case is not in returns **400**,
not an empty result.

| `internal_status` | Ask | Answer with |
|---|---|---|
| `awaiting_documents` | `reports.get_missing_documents(case_id)` → key **`missing_documents`** | `reports.continue_case(case_id, body={"new_document_ids": [...]})` or `{"proceed_anyway": True}` |
| `awaiting_document_review` | `reports.get_document_review(case_id)` → key `documents` | `reports.submit_document_review(case_id, body={"updates": [...], "proceed_to_searches": True})` |
| `awaiting_acknowledgements` | `reports.get_acknowledgements(case_id)` | `reports.submit_acknowledgements(case_id, body={"acknowledgements": [...]})` |

Three details that will otherwise cost you an afternoon:

- The missing-documents key is **`missing_documents`**, not `documents`.
- The acknowledgements payload **nests**. `response["acknowledgements"]` is a dict, and its own
  `"acknowledgements"` key holds the list. Iterating the outer dict gives you its string keys and
  then `item["id"]` raises `TypeError`.
- Each acknowledgement takes a **`decision`** of `"accepted"`, `"rejected"` or `"undecided"`.
  There is no `accepted: true` field. **An item sent without a `decision` passes through untouched
  and acknowledges nothing**, so a case can appear answered while nothing was actually decided.

**Never auto-accept acknowledgements.** They are title risks a human is agreeing to live with, on a
property someone is lending against. Surface them and let a person decide. Code that accepts them
in a loop turns a legal opinion into a rubber stamp, and it will be your integration's name on it.

**After answering, wait again.** Answering one pause can surface the next. A loop that answers once
and then reads the result will read nothing. Bound the loop (5 rounds is plenty) so a stuck case
cannot spin forever.

**Two replies mean the case did not move.** Handle both or your loop will spin.

- **422 with `.code == PAUSE_GATE_UNMET`.** The organisation requires every item at the pause to
  be actioned before the case may advance, and something is outstanding.
  `read_pause_gate_refusal(error)` returns the stage and a list of plain sentences saying what.
  **Do not retry**: the same body is refused again. Action what the reasons name, then call again.
  On the document-analysis pause the findings are marked as seen in the web application, so a
  refusal there is answered by a person, not by your code.
- **200 carrying `pending_checker: true`.** Your answer was recorded and the case is held at the
  same pause until a second person approves it. `is_pending_second_approval(reply)` reports it.
  The case stays `awaiting_review`, so a loop that waits again without checking waits for a
  colleague rather than for the platform. Stop and tell the caller.

```python
from legiscore import LegiScoreError, is_pending_second_approval, read_pause_gate_refusal

try:
    reply = client.reports.continue_case(case_id, body={"new_document_ids": ids})
except LegiScoreError as error:
    refused = read_pause_gate_refusal(error)
    if refused is None:
        raise
    return show_to_a_person(refused.reasons)      # not retryable by code

if is_pending_second_approval(reply):
    return waiting_on_an_approver()               # the case has not advanced
```

## 5. Rules that are not guessable

- **`propertyFocus` is an object, not a string.** Use `{"address": "Sy. No. 123, Example Village, Telangana"}`.
  A bare string returns 422. The SDK's `create_report` helper wraps a string for you; the raw
  `reports.create_case` does not.
- **Uploads are three calls, not one.** presign, PUT the bytes to the returned URL, complete. Use
  `client.upload_document(path)`, which does all three and returns a `document_id`. Files go
  straight to storage, so a 90 MB scan never passes through the API.
- **These four endpoints take file uploads, not JSON**: `translate.translate_docx`,
  `translate.submit_translation`, `extraction.create_property_extraction` and
  `search.assist_search`. They take `files={"field": "path.pdf"}` plus keyword form fields.
- **`download_case_files_zip` and `search.get_search_document` return bytes, not JSON.** Write
  them to a file.
- **A 400 on a pause endpoint is not a bug.** It means the case is not in that pause. Dispatch on
  `internal_status`, per section 4.
- **404 means "not found or not yours".** Deliberately identical, so one tenant cannot probe
  another's case ids. Do not retry a 404.
- **The `translate` module needs a translation permission on the key**, not just a valid key. A
  403 there means asking LegiScore to enable it, not a code bug. The same is true of
  `reports.link_documents_to_missing_slot`.

## 6. Searches are a second product, not part of a report

`client.search` runs one government record search and hands back what the source returned. It is
not the report flow and does not share its money:

- **Its own credit balance.** `search.get_search_credits()`, not `core.get_credits()`. A search
  can never spend the credits bought for reports. Out of them is **402** with the code
  `insufficient_credits`.
- **Its own host**, which the SDK already points at. Do not build these URLs yourself.
- **Flat price per search**, stated by `search.get_search_catalog()`. Read it; never hardcode it.
  Charged when the search is accepted, and returned if the source cannot be reached.

The flow is submit, then poll:

```python
run = client.search.submit_search(body={"state": "andhra", "search_type": "ec", "params": {...}})
search_id = run["data"]["searches"][0]["id"]

while (found := client.search.get_search(search_id)["data"]["search"])["status"] not in (
    "succeeded", "failed", "cancelled"
):
    time.sleep(5)
```

Five rules that are not guessable:

- **`found: false` on a succeeded search is an answer, not a failure.** The source was reached and
  holds nothing against that property. Do not retry it, and do not report it as an error.
- **Lookup fields are picked, not typed.** `get_search_catalog()` says which fields a state and
  search type take and which need a lookup; `get_search_lookups(state=..., dim=...)` returns the
  values. Spread the option's `meta` into `params` alongside its `value` — those are the codes the
  source actually keys on.
- **A batch is not all-or-nothing.** Up to 25 under `searches`. Read `rejected`, which names the
  index of each item that failed validation; the rest ran.
- **`replayed` means the source was never touched.** An identical search of yours from the last 24
  hours answered this one, free. Treat it as a normal result.
- **`search.get_search_document(search_id, filename)` returns bytes**, with `filename` taken from
  the search's `documents` list. The API answers with a redirect to a signed URL and the SDK
  follows it without your key. Never write that fetch yourself: a custom auth header is forwarded
  across a cross-origin redirect, so following it by hand hands your key to a storage host.

`assist_search` proposes parameters from a document and never submits them; a person confirms
before you spend a search on them. `recover_search` re-runs a finished search against related
identifiers and is priced separately. Both are optional; ignore them unless asked.

## 7. Errors

Every failure raises `LegiScoreError` with `.status_code`, `.body` and, when the API sent one,
`.code`, a stable string such as `insufficient_credits` or `PAUSE_GATE_UNMET`. Branch on `.code`,
never on the message; where the reason is a list rather than a sentence the message names the code
and leaves the detail on `.body`. Rate limits (429) and
transient 5xx are retried inside the SDK, honouring `Retry-After`, so an error that reaches your
code has already been retried and failed.

**Do not add your own retry layer around writes.** The SDK's retry policy is deliberately
asymmetric: reads replay freely, and writes replay only when the server will recognise the repeat.
Creating a case and completing an upload carry an `Idempotency-Key` that is reused across the
retries of one call, so a lost response cannot produce a second billable case. Every other write
replays only on a status that proves the server refused the request before running it. A naive
`for attempt in range(3)` wrapper around `create_case` reintroduces exactly the double-charge
this prevents.

Handle these explicitly and let everything else raise:

| Code | Meaning | Handling |
|---|---|---|
| 401 | key rejected | fail loudly at startup, not per request |
| 402 | out of credits | alert a human; nothing was charged. On a search, `.code` is `insufficient_credits` |
| 403 | missing permission | alert a human; not retryable |
| 422 | bad payload, **or** a pause the organisation refused to advance | if `.code` is `PAUSE_GATE_UNMET` read the reasons and stop, per section 4; otherwise log `error.body`, it names the field |
| 429 | sustained overrun | slow the caller down |

## 8. Webhooks instead of polling, when you can

Polling works but a webhook is better. **Always verify the signature. Never skip it.**

```python
from legiscore import verify_webhook, InvalidSignature

@app.post("/webhooks/legiscore")
def receive(request):
    try:
        event = verify_webhook(request.get_data(), request.headers, secret=WEBHOOK_SECRET)
    except InvalidSignature:
        return "", 400
    if event.is_pause:
        handle_pause(event.case_id)
    elif event.event == "report.completed":
        fetch_report(event.case_id)
    return "", 200
```

`body` must be the **raw request bytes**. Re-serialising parsed JSON changes the bytes and every
signature check then fails. This is the most common webhook bug.

Events you will actually receive today: `report.paused.missing_documents`,
`report.paused.review`, `report.paused.acknowledgements`, `report.completed`, `report.failed`.
`asset.created`, `report.auto_triggered` and `report.started` are in the catalogue but are not
emitted yet — do not build on them. An older dispatch path can still send the legacy names
`case.paused` and `case.completed`; treat `case.paused` as a pause and `case.completed` as a
completion rather than dropping them, and use `event.is_pause` rather than comparing strings.

A pause webhook tells you a pause happened, not which one. Read `internal_status` from
`reports.get_case_status(case_id)` before choosing an endpoint, exactly as in section 4.

Deliveries can repeat. Key your handling on `event.delivery_id` so a retry is idempotent.

**Setting the webhook up.** Either `client.webhooks.create_webhook(...)`, or the dashboard with auth
type **HMAC**. The secret comes back **exactly once**, from create or rotate — store it immediately,
because nothing can read it back afterwards. A webhook created with any other auth type sends no
`X-LegiScore-Signature` at all, so verification will reject every delivery.

**Leave "Allowed domains" empty on a server-side key.** Setting it makes the key browser-only, so
a server-to-server call is then refused with 403 no matter how valid the key is.


## 9. Reference implementation

`python/examples/end_to_end.py` is a complete, runnable version of everything above: connection
check, upload, create, wait, answer every pause, bounded rounds, fetch the report and the files.
Read it before writing your own, and adapt it rather than starting from scratch.

## 10. What to build

Unless told otherwise:

1. A thin wrapper module that owns the client and the connection check.
2. One function that takes documents plus a property description and drives the case to completion,
   dispatching on `internal_status` with a bounded loop. It handles the document pauses itself and
   **hands acknowledgements to a human** rather than deciding them.
3. A webhook endpoint with signature verification, if the app has somewhere to put one.
4. Real error handling for 401, 402, 403 and 422, branching on `error.code` where the API sends
   one. No bare `except`.
5. Structured logs at each state transition, including `case_id`, so a stuck case is diagnosable.

Do not build: a retry layer (the SDK has one), a polling loop faster than 10 seconds, a cache of
report results without a documented invalidation rule, or your own HTTP calls to endpoints the SDK
already covers.

## 11. Modules

`client.core` uploads, credits, scenarios, field configs. `client.reports` the case lifecycle.
`client.search` government record searches, on their own host and their own credits.
`client.translate` document translation. `client.extraction` property details out of a document.
`client.webhooks` manage your own delivery endpoints. 42 methods total. Python is snake_case,
TypeScript is camelCase; the names are otherwise identical.
