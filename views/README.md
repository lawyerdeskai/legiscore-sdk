# @legiscore/views

Drop-in React screens for the LegiScore report lifecycle: status, the three review pauses, and
the finished report. They are the same flows the LegiScore product runs, unstyled enough to
look like yours.

```bash
npm install @legiscore/views   # peer: react >= 18
```

Dropping it into a Next.js 15 App Router page:

```tsx
// app/cases/[caseId]/page.tsx  — a Server Component
import { ReportFlow, createProxyReports } from "@legiscore/views";
import "@legiscore/views/styles.css";

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const api = createProxyReports("/legiscore");   // your own backend, not the LegiScore API
  return <ReportFlow api={api} caseId={caseId} />;
}
```

`ReportFlow` and every screen it renders carry `"use client"`, so a Server Component can render
them directly — no wrapper component and no `"use client"` of your own.

That renders the case, polls while it moves, shows whichever review pause it stops at, submits
the answer, and renders the report when it is ready.

## Your key never reaches the browser

`lsk_` keys are server-side secrets, and this package never sees one. Nothing in
`views/src` reads an API key, an environment variable or browser storage, and the only
network calls it makes are same-origin calls to your own backend.
`createProxyReports(basePath)` calls
`<basePath>/api/cases/...`, the API's own path shape, so the proxy is a pass-through that only
adds the Authorization header. In Next.js that is one file:

```ts
// app/legiscore/api/[...path]/route.ts
import { LegiScore } from "@legiscore/sdk";

const client = new LegiScore();   // reads LEGISCORE_API_KEY

export async function GET(request: Request, { params }: { params: { path: string[] } }) {
  // Check YOUR session here first. This route is the boundary: without it, any visitor
  // reaches every case your key can see.
  return Response.json(await forward(request, params.path));
}
```

Rendering on the server instead? `client.reports` from `@legiscore/sdk` already has this shape:
`const api = client.reports as unknown as ReportsApi`.

## What each piece does

| Export | Role |
|---|---|
| `ReportFlow` | The whole lifecycle. Start here. |
| `useCase(api, caseId)` | The state behind it: status, pause, payload, submit callbacks. Poll interval configurable, set `pollIntervalMs: 0` when you use webhooks. |
| `CaseStatusBar` | State badge, progress, message. |
| `MissingDocumentsView` | Pause 1. Per document: skip it, or leave a note. Pass `onUpload` to attach files. |
| `DocumentReviewView` | Pause 2. Edits what we read out of each document, submits only what changed. |
| `AcknowledgementsView` | Pause 3. Accept, reject or leave undecided, with a reason. |
| `CaseResultView` | The report. Renders whatever sections it holds, so a new section shows up without a release here. |
| `createProxyReports`, `pauseOf`, `buildAckSubmission` | The wiring, usable on their own. |

Answering one pause can surface the next, so the flow re-reads the case after every submit
rather than assuming it is finished.

## Making it yours

Three levels, in order of effort:

1. **Restyle.** Every rule in `styles.css` reads a `--lsc-*` variable. Redefine `--lsc-accent`
   and the palette on any ancestor, or drop the stylesheet and target the `lsc-` classes.
2. **Swap a screen.** Render `useCase` yourself and mix your components with ours.
   `<ReportFlow>{state => ...}</ReportFlow>` hands you the same state.
3. **Keep the logic only.** `pauseOf`, `ackItems` and `buildAckSubmission` are plain functions.
   The last one matters: the API stores the acknowledgement list verbatim, so it spreads each
   generated item rather than picking fields off it, and lets the server derive `is_bypassed`
   from your `decision`. A hand-rolled payload usually drops `ack_id` and `source_documents`.

Acknowledgements are title risks a human is agreeing to live with. Do not decide them in code.

## Development

```bash
cd views && npm install && npm test    # type-checks, then runs the checks
```
