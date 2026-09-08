# @legiscore/sdk

Node SDK for the [LegiScore](https://legiscore.in) partner API — legal opinion reports and
government record searches on Indian property.

**Node 20+. Zero runtime dependencies. ESM and CommonJS both work.** Nothing is imported from
`node:` at load time, so the same package runs unchanged in a Next.js 15 App Router app (Server
Components, Route Handlers, Server Actions, Middleware), on Vercel Edge, in a Cloudflare Worker,
in Deno and in Bun.

```bash
npm install @legiscore/sdk
```

```ts
import { LegiScore } from "@legiscore/sdk";        // ESM
const { LegiScore } = require("@legiscore/sdk");   // CommonJS
```

## Quick start

```ts
import { LegiScore } from "@legiscore/sdk";

const client = new LegiScore({ apiKey: process.env.LEGISCORE_API_KEY });

const created = await client.createReport({
  propertyFocus: "Sy. No. 123, Example Village, Telangana",
  files: ["sale-deed.pdf", "encumbrance-certificate.pdf"],
});
const status = await client.waitForCase(created.case_id);

if (status.state === "completed") {
  const report = await client.reports.getCaseResult(created.case_id);
} else if (status.state === "awaiting_review") {
  const missing = await client.reports.getMissingDocuments(created.case_id);
  await client.reports.continueCase(created.case_id, { new_document_ids: [] });
}
```

Endpoints are grouped by module: `client.core`, `client.reports`, `client.search`,
`client.translate`, `client.extraction`, `client.webhooks`. Every method takes an optional
`{ signal }` as its last argument, merged with the client timeout.

`client.search` is the government-record search product: its own credit balance, its own flat
per-search price from `getSearchCatalog`, and its own host, which the client already points at.
Submit a search, then poll `getSearch` until its status is `succeeded`, `failed` or `cancelled`,
then pull each file with `getSearchDocument`, which resolves to bytes. Override the host with
`searchBaseUrl` only if you have been told to.

A case can pause and wait for you — `awaiting_review` means it needs missing documents, a document
review, or risk acknowledgements before it can finish. Each pause has a matching resume method.
Polling with `waitForCase` is the fallback; configure a webhook and the transitions are pushed to
you instead.

## Next.js 15

The API key is a server-side secret. Keep every call in a Route Handler, a Server Action or a
Server Component — never in a Client Component.

### Webhooks — `app/api/legiscore/webhook/route.ts`

```ts
import { verifyWebhook, InvalidSignature } from "@legiscore/sdk";

export async function POST(request: Request) {
  // The raw body, byte for byte. Parsing and re-serialising changes it and the check fails.
  const rawBody = await request.text();

  try {
    const event = await verifyWebhook(rawBody, request.headers, {
      secret: process.env.LEGISCORE_WEBHOOK_SECRET!,
    });
    if (event.isPause) await handlePause(event.caseId);
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof InvalidSignature) return new Response(null, { status: 400 });
    throw error;
  }
}
```

`verifyWebhook` is async — it uses Web Crypto, which is what makes it work on the Edge runtime.
Deliveries older than five minutes are rejected as replays, and an empty secret fails closed rather
than trusting the delivery.

### A Server Action that opens a case

```ts
"use server";

import { LegiScore } from "@legiscore/sdk";

export async function createTitleReport(formData: FormData): Promise<string> {
  const client = new LegiScore({ apiKey: process.env.LEGISCORE_API_KEY });
  const file = formData.get("deed") as File;

  const { case_id } = await client.createReport({
    propertyFocus: formData.get("address") as string,
    files: [file], // a File from the form — no filesystem involved
  });
  return case_id;
}
```

### Edge runtime

Everything works on Edge except one thing: passing a **filesystem path** to an upload. That branch
needs `node:fs`, so on Edge pass a `Blob`, a `File`, a `Uint8Array`/`ArrayBuffer`, or
`{ data, fileName, contentType }` instead. Uploads accept all five forms on every runtime.

### Custom fetch

Pass your own `fetch` to pick up Next.js caching and revalidation semantics, or to instrument the
calls:

```ts
const client = new LegiScore({
  apiKey: process.env.LEGISCORE_API_KEY,
  fetch: (url, init) => fetch(url, { ...init, next: { revalidate: 60 } }),
});
```

## Errors and retries

Failures throw `LegiScoreError`, which carries `.status`, `.body` and, when the API sent one,
`.code` — a stable string such as `insufficient_credits`. Branch on `.code`, not on the message.

> **Do not log `error.body` raw.** It is the API's own response, which on a case route contains
> property, borrower and document details. Log `error.status` and `error.message`. The API key and
> the request headers are never attached to an error.

Retries are deliberately asymmetric, because replaying a write can cost money:

| Call | Replayed on |
|---|---|
| Reads (`GET`) | 429, 502, 503, 504 |
| Writes carrying an `Idempotency-Key` (case creation, upload completion) | 429, 502, 503, 504 |
| Every other write | **429 only** — the one status that proves the server refused the request before running it |
| `rotateWebhookSecret` | never |

`Retry-After` is honoured when the server sends one, clamped to 60 seconds; otherwise the backoff
is exponential with jitter. `baseUrl` and `searchBaseUrl` must both be `https` (or `localhost`).

Redirects are never followed on an authenticated request — following one would forward your key to
wherever `Location` points, because `fetch` carries custom headers across a cross-origin redirect
even though it drops `Authorization`. `getSearchDocument` is the one route that answers with a
redirect by design: the SDK reads the signed URL and fetches it on a second request with **no key
attached**, and refuses a target that is not `https`.

## Verifying webhooks outside Next.js

```ts
import { verifyWebhook, InvalidSignature } from "@legiscore/sdk";

try {
  const event = await verifyWebhook(rawBody, request.headers, { secret: WEBHOOK_SECRET });
  if (event.isPause) await handlePause(event.caseId);
} catch (error) {
  if (error instanceof InvalidSignature) return reply.code(400).send();
  throw error;
}
```

`rawBody` may be a string, a `Uint8Array` or an `ArrayBuffer`, and must be the **raw request
bytes**. In Express, that means `express.raw({ type: "application/json" })` on this route.

**Setting the webhook up.** Create it in the LegiScore dashboard with auth type **HMAC**. The secret
it shows you is `WEBHOOK_SECRET`; there is no other place to get it, and a webhook created with any
other auth type sends no `X-LegiScore-Signature` at all, so verification will reject every delivery.

**Leave "Allowed domains" empty on a server-side key.** A non-empty list is checked against the
`Origin` or `Referer` header, which a server-to-server call does not send, so every request returns
403 no matter how valid the key is.

## Checking the connection

```ts
const report = await client.checkConnection();   // resolves, never throws
if (!report.ok) throw new Error(report.problem);
if (!report.search.ok) console.warn(`Searches unavailable: ${report.search.problem}`);
```

The two products run on two hosts and fail independently, usually because a network allows one and
not the other. `ok` is the reports host; `search.ok` is the search host. Gate on the one you are
about to use.

## License

Apache-2.0. Copyright 2026 LawyerDesk Advocacy Pvt Ltd.
