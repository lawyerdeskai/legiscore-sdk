# LegiScore SDKs

Official Python and TypeScript clients for the [LegiScore](https://legiscore.in) partner API:
legal opinion reports and government record searches on Indian property.

```bash
pip install legiscore          # Python 3.10+
npm install @legiscore/sdk     # Node 20+, ESM and CJS, edge-runtime safe, no runtime dependencies
```

```python
from legiscore import LegiScore

client = LegiScore()                      # reads LEGISCORE_API_KEY
print(client.check_connection())          # prove the key works before spending anything

case = client.create_report(
    property_focus={"address": "Sy. No. 123, Example Village, Telangana"},
    files=["sale-deed.pdf", "encumbrance-certificate.pdf"],
)
status = client.wait_for_case(case["case_id"])
```

`AsyncLegiScore` is the same surface on `async`/`await`. In TypeScript everything is already
promise-based, including `verifyWebhook`.

## A case is not a function call

A report takes minutes and can stop to ask you a question. Five public states:

| State | Meaning |
|---|---|
| `queued` / `running` | in progress, keep waiting |
| `awaiting_review` | **stopped, waiting on you** — read `internal_status` to see which pause |
| `completed` | report ready |
| `failed` | read `message` |

Three pauses can occur: missing documents, document review, and risk acknowledgements. Each has a
read method and a matching resume method. **Answering one can surface the next, so wait again after
every answer.** Asking about a pause the case is not in returns 400, so dispatch on
`internal_status` rather than probing.

Acknowledgements are title risks a human is agreeing to live with. Each takes a `decision` of
`accepted`, `rejected` or `undecided`, and an item sent without one acknowledges nothing. Do not
decide them in code.

## Modules

One key, six namespaces, identical in both languages (`client.reports.get_case_status` /
`client.reports.getCaseStatus`):

| Module | Ops | Covers |
|---|---|---|
| `core` | 5 | Uploads, credit balance, scenarios, custom field configs |
| `reports` | 13 | Case lifecycle, the three review pauses, case documents |
| `search` | 11 | Government record searches: submit, poll, cancel, documents, catalog, lookups, credits |
| `translate` | 6 | Document translation |
| `extraction` | 2 | Structured property details out of a document |
| `webhooks` | 5 | Manage your own delivery endpoints, including rotating the secret |

## Searches

`client.search` is the second product, not a helper on the first. It has its own credit balance,
its own flat per-search price, and its own host, which the SDK already points at. Submit a search,
poll it, read the records and the documents the source issued.

```python
import time
from pathlib import Path

from legiscore import LegiScore

client = LegiScore()

# Lookup fields are picked, never typed. getSearchCatalog names the dimension for each field.
office = client.search.get_search_lookups(state="andhra", dim="sro")["data"]["options"][0]

run = client.search.submit_search(body={
    "state": "andhra",
    "search_type": "ec",
    "params": {"sro": office["value"], **office["meta"], "doc_no": "1234", "year": "2018"},
})
search_id = run["data"]["searches"][0]["id"]

while True:
    found = client.search.get_search(search_id)["data"]["search"]
    if found["status"] in ("succeeded", "failed", "cancelled"):
        break
    time.sleep(5)

print(found["found"], found["record_count"])

for document in found["documents"]:
    # Answered with a redirect to a signed URL, which the SDK follows without your key.
    Path(document["filename"]).write_bytes(
        client.search.get_search_document(search_id, document["filename"])
    )
```

```ts
type Search = { id: string; status: string; found: boolean | null; record_count: number | null };
type Options = { data: { options: { value: string; meta: Record<string, string> }[] } };

const [office] = ((await client.search.getSearchLookups({
  state: "andhra",
  dim: "sro",
})) as Options).data.options;

const run = (await client.search.submitSearch({
  state: "andhra",
  search_type: "ec",
  params: { sro: office.value, ...office.meta, doc_no: "1234", year: "2018" },
})) as { data: { searches: Search[] } };

let search = run.data.searches[0];
while (!["succeeded", "failed", "cancelled"].includes(search.status)) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  search = ((await client.search.getSearch(search.id)) as { data: { search: Search } }).data.search;
}

console.log(search.found, search.record_count);

const [document] = ((await client.search.getSearch(search.id)) as {
  data: { search: { documents: { filename: string }[] } };
}).data.search.documents;
// Answered with a redirect to a signed URL, which the SDK follows without your key.
const bytes = (await client.search.getSearchDocument(search.id, document.filename)) as Uint8Array;
```

Five things that are not guessable:

- **Search credits are a separate balance** from the report credits `getCredits` returns. Read them
  with `getSearchCredits`. Running out returns **402** with the code `insufficient_credits`.
- **Price comes from `getSearchCatalog`**, flat per search. Charged when a search is accepted and
  returned if the source cannot be reached. Do not hardcode the number.
- **`found: false` on a succeeded search is an answer**, not a failure: the source was reached and
  holds nothing against that property.
- **A batch is not all-or-nothing.** Send up to 25 under `searches` and read `rejected` for the
  items that did not validate; the rest still ran.
- **`getSearchDocument` returns bytes.** The API answers with a redirect to a signed URL, and the
  SDK follows it on a connection that carries no API key. Do not build that fetch yourself: a
  custom auth header **is** forwarded across a cross-origin redirect.

## Helpers

| Helper | Collapses |
|---|---|
| `check_connection()` | proves the key works; returns a report, never raises |
| `upload_document(file)` | presign, PUT to storage, complete, returns a `document_id` |
| `create_report(...)` | uploads every file, then opens the case |
| `wait_for_case(id)` | polls to a terminal state |
| `verify_webhook(body, headers, secret=...)` | checks a delivery's signature and freshness |

Framework wiring — a Next.js route handler and a FastAPI endpoint — is in each package README:
[node/README.md](node/README.md) and [python/README.md](python/README.md).

## Views (React)

`views/` is a separate package, `@legiscore/views`: drop-in React screens for the report
lifecycle, so a partner integrating the API does not rebuild the three review pauses by hand.

```tsx
import { ReportFlow, createProxyReports } from "@legiscore/views";
const api = createProxyReports("/legiscore");   // your backend, holding the key
<ReportFlow api={api} caseId={caseId} />
```

Restyle it with CSS variables, swap one screen with the `useCase` hook, or take just the
payload builders. Your `lsk_` key stays server-side. See [views/README.md](views/README.md).

## Webhooks

Better than polling. Create one with `client.webhooks.create_webhook(...)`, or in the dashboard with
auth type **HMAC**. Either way the secret is returned **exactly once** — at create, and again only
if you rotate it. Store it then; there is no way to read it back. Pass the **raw request bytes** — re-serialising parsed JSON changes the byte
string and every check then fails. Deliveries older than five minutes are rejected as replays, and
an empty secret fails closed.

## Errors and retries

Failures raise `LegiScoreError` with the status, the decoded body and, when the API sent one, a
stable `code` such as `insufficient_credits`. Branch on the code, not the message.

**Do not wrap writes in your own retry loop.** The built-in policy is asymmetric on purpose: reads replay freely, while a write
replays only when the server can recognise the repeat — creating a case and completing an upload
carry an idempotency key across the retries of one call, and every other write replays only on a
status that proves the server refused it before running it. Adding a retry layer on top
reintroduces the double-charge this prevents.

Leave **Allowed domains empty** on a server-side key. A non-empty list turns the key into a
browser-only key, and a server-to-server call with one set is refused with 403.

## Building for an AI coding agent

`AI_PROMPT.md` is written to be pasted into Claude Code, Cursor, or any coding agent. It carries the
rules that are not guessable from the method names, so the agent writes a working integration on the
first attempt. `python/examples/end_to_end.py` is the runnable reference it points at.

## Postman and the partner pack

`integrations/` is what you hand someone before they write code:

| | |
|---|---|
| `legiscore.postman_collection.json` | The report flow, folders numbered in the order you run it. Requests chain themselves, so presign, upload, create and poll pass their ids along without you copying one. |
| `legiscore-reference.postman_collection.json` | Every operation in the spec, generated from it. |
| `legiscore-api-guide.md` | The written guide: flow, auth, endpoints, webhooks, payload mapping, errors. |

Import both collections and the shared environment, paste your key into `api_key`, and work down
the folders. See [integrations/README.md](integrations/README.md).

## Development

```bash
cd spec && python3 build_spec.py && python3 generate_clients.py   # spec, then both SDK surfaces
cd spec && python3 build_postman.py                              # rebuild the reference collection
cd spec && python3 build_spec.py --scan ..                       # the publication denylist
cd python && pip install -e '.[dev]' && pytest -q
cd node && npm ci && npm test && npm run check
cd views && npm ci && npm test
```

The per-endpoint method surface is generated from `spec/legiscore-openapi.json`, so it cannot drift.
Every description in that spec is written by hand in `spec/descriptions.json` and reapplied on every
build; transport, retries, errors and the multi-step helpers are hand-written too.

## Security

The SDK is a convenience layer, never a security boundary. It holds no secrets: your API key comes
from your environment and every limit, permission and ownership check is enforced server-side. See
[SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE). Copyright 2026 LawyerDesk Advocacy Pvt Ltd.
