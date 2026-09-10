# LegiScore Property Due-Diligence API

**For:** your engineering team
**Prepared by:** LegiScore (a brand of LawyerDesk Advocacy Pvt Ltd)
**Scope:** the property due-diligence report flow — start a report, move through the review checkpoints, pull the final report, and receive webhook callbacks — plus the government record search product in section 13, which is a separate product on a separate host. This is a focused subset of the full API.
**Base URL (production):** `https://opinion.legiscore.in` — except section 13, which is served from `https://legiscore.in`
**API version:** `2026-04-26` (sent back in every webhook as `api_version`)

> This is the narrative guide. The machine-readable contract is `spec/legiscore-openapi.json`, which the SDKs and the reference Postman collection are generated from. Where this guide and the spec disagree, the spec wins.

---

## 1. How the integration works

LegiScore turns a property and its documents into a structured legal due-diligence report. The flow is **asynchronous**:

1. You upload the base document(s) and create a report.
2. The platform runs document analysis, then automated government-record searches across the relevant state portals (EC, revenue records, RERA, property tax, prohibited lists, eCourts, etc.).
3. The report passes through **three optional human-review checkpoints** — document analysis, missing documents, and risk acknowledgement. You can drive these over the API, or switch them off for a fully unattended straight-through run.
4. When done, you pull the final report as **JSON**, plus the **source/search artifacts**.
5. **Webhooks** call your server at each pause and on completion, so you do not have to poll if you do not want to.

```
                                    (optional checkpoints)
  upload docs ─▶ create report ─▶ Phase 1 ──▶ [1] doc analysis ──▶ searches
                                                                       │
                       completed ◀── Phase 2 ◀── [3] risk ack ◀── [2] missing docs
                          │
                          ├─▶ GET /result        (final report JSON)
                          └─▶ GET /files, /files/zip   (source + search artifacts)

  Webhooks fire at: each checkpoint pause  +  report.completed  +  report.failed
```

**Two ways to integrate:**

| Mode | When to use | How |
|---|---|---|
| **Interactive** (default) | You want a human (yours or ours) to review at each checkpoint. | Leave `enable*Review` flags at `true`. React to pauses via webhook or status polling, then call the matching submit endpoint. |
| **Straight-through (unattended)** | Full automation, no human in the loop. | Set `enableDocumentAnalysisReview`, `enableMissingDocumentReview`, `enableAcknowledgementReview` all to `false` at creation. The report runs end to end and only fires `report.completed` / `report.failed`. |

---

## 2. Authentication

Every request is authenticated with a partner API key (prefix `lsk_`). We issue this to you.

| | |
|---|---|
| Header (preferred) | `X-API-Key: lsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| Header (alternative) | `Authorization: Bearer lsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| Default rate limit | 60 requests / minute per key |
| Missing credential | `401 missing_authentication` |
| Invalid / revoked / expired key | `401 invalid_api_key` |
| Domain allowlist | Optional. If set on your key, requests must carry a matching `Origin`/`Referer`. Left empty for server-to-server use. |

Your key is bound to your organisation, so report credits, default scenario, custom fields and webhook configuration are all resolved automatically from your org.

> **Checkpoint permissions.** Driving the review checkpoints over the API (Section 6) needs your key to be issued with checkpoint permissions. The read-only surface (`/status`, `/result`, `/files`) is always available. A `403` on a submit endpoint means asking us to enable it, not a bad request — or run in straight-through mode with the checkpoints off.

---

## 3. Step 1 — Upload the base document(s)

Documents are uploaded to object storage first, then referenced by `document_id` when you create the report. Three sub-steps per file.

### 3.1 `POST /api/v1/uploads/presign`

Request:

| Field | Type | Required | Notes |
|---|---|---|---|
| `fileName` | string | yes | 1–256 chars |
| `fileSize` | integer | yes | bytes; > 0 and ≤ the per-type cap below |
| `contentType` | string | yes | must be in the allowlist below |

Allowed content types and size caps:

| contentType | Max size |
|---|---|
| `application/pdf` | 500 MB |
| `image/jpeg`, `image/jpg`, `image/png` | 50 MB |
| `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | 100 MB |
| `text/plain` | 10 MB |

Response:

```json
{
  "success": true,
  "uploadUrl": "https://storage.example.com/...signed-PUT-url...",
  "objectName": "<your-profile-id>/<file>",
  "bucketName": "<bucket>",
  "expiresIn": 3600,
  "metadata": {
    "fileName": "sale_deed.pdf",
    "fileSize": 248213,
    "contentType": "application/pdf",
    "sanitizedFileName": "sale_deed.pdf"
  }
}
```

### 3.2 `PUT <uploadUrl>` (raw bytes)

Upload the file bytes directly to object storage using the `uploadUrl` (a presigned PUT, valid 3600 s). This call goes to object storage, not to the API. Set `Content-Type` to the same value you presigned with.

### 3.3 `POST /api/v1/uploads/complete`

Request:

| Field | Type | Required | Notes |
|---|---|---|---|
| `objectName` | string | yes | the `objectName` from presign; must start with your profile id |
| `fileName` | string | yes | |
| `fileSize` | integer | yes | |
| `contentType` | string | yes | |
| `success` | boolean | no (default `true`) | |
| `content_hash` | string | no | optional integrity hash |

Response:

```json
{
  "success": true,
  "document_id": "7d6e1f2a-0c3b-4a91-9b2e-3f5a6c7d8e90",
  "filename": "sale_deed.pdf",
  "objectName": "<your-profile-id>/sale_deed.pdf",
  "status": "uploaded"
}
```

Keep the `document_id`. Repeat for every base document.

> **Idempotency.** `/api/v1/uploads/complete` and the create-report call (Section 4) both accept an `Idempotency-Key` header. Re-sending the same key returns the original result instead of creating a duplicate.

---

## 4. Step 2 — Create the report

### `POST /api/requests`

The minimum you need is the documents and the property. Everything else has a sensible default resolved from your org.

**Minimal request:**

```json
{
  "documentIds": ["7d6e1f2a-0c3b-4a91-9b2e-3f5a6c7d8e90"],
  "propertyFocus": {
    "property_type": "building",
    "state": "Andhra Pradesh",
    "state_id": 2,
    "property_details": {
      "house_no": "1-23",
      "survey_nos": "123",
      "village_city": "Example Village",
      "district": "Example District"
    }
  }
}
```

**Fuller request (named report, explicit scenario, checkpoints on, partner correlation id):**

```json
{
  "documentIds": ["7d6e1f2a-0c3b-4a91-9b2e-3f5a6c7d8e90"],
  "propertyFocus": {
    "property_type": "building",
    "state": "Andhra Pradesh",
    "state_id": 2,
    "property_details": {
      "house_no": "1-23",
      "survey_nos": "123",
      "village_city": "Example Village",
      "district": "Example District"
    },
    "kb_config": { "use_kb": true, "kb_central": true, "kb_state": true, "kb_category": "all" }
  },
  "scenario_code": "HL_NEW_APARTMENT",
  "case_name": "Loan #REF-0000-00000 - Example District",
  "purpose": "mortgage_verification",
  "enableDocumentAnalysisReview": true,
  "enableMissingDocumentReview": true,
  "enableAcknowledgementReview": true,
  "metadata": {
    "your_reference_id": "REF-0000-00000",
    "loan_id": "LN-000000",
    "callback_owner": "your-company"
  }
}
```

**Request fields (most-used first):**

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `documentIds` | string[] | **yes** | — | `document_id`s from Section 3. Each is validated to exist and belong to you before any credit is charged. |
| `propertyFocus` | object | **yes** | — | The property block. See Section 9 for its shape. |
| `scenario_code` | string | no | org default | The diligence template/config to run, by **code** (not id). See Section 8. |
| `case_name` | string | no | null | Display name. |
| `purpose` | string | no | from scenario | Display label. |
| `enableDocumentAnalysisReview` | boolean | no | `true` | Checkpoint 1 on/off. |
| `enableMissingDocumentReview` | boolean | no | `true` | Checkpoint 2 on/off. |
| `enableAcknowledgementReview` | boolean | no | `true` | Checkpoint 3 on/off. |
| `metadata` | object | no | null | **Your correlation blob.** Stored verbatim and echoed back in `/status`, `/result`, and every webhook. Put your own reference ids here. |
| `custom_field_schema_ids` | string[] | no | from scenario | Override which custom-field schemas to extract. See Section 10. |
| `custom_field_value_seed` | object | no | null | Pre-seed custom-field values you already hold (your values win over AI extraction). See Section 10. |
| `special_upload_assignments` | object | no | null | `{ "slot_key": "document_id" }` for reference-document slots. |
| `split_document_ids` | string[] | no | null | Document ids to bundle-split before analysis. |
| `recipient_contacts` | object[] | no | null | External recipients `{ name, phone, email, role?, preferred_channels? }`. |

(Billing fields — `payment_order_id`, `credit_source`, `credit_source_org_id`, `credit_source_branch_id` — exist but for an org-bound key the org is charged automatically; you normally omit them.)

**Response:**

```json
{
  "success": true,
  "case_id": "RPT-2026-EXAMPLE1",
  "task_id": "c1a2b3d4-...",
  "message": "Case created successfully with 1 documents"
}
```

**`case_id`** is the handle for every subsequent call. Treat it as an opaque string. A malformed `metadata` returns `422 INVALID_PARTNER_METADATA`.

---

## 5. Step 3 — Track status (polling)

### `GET /api/cases/{case_id}/status`

Lightweight, built for frequent polling. (Webhooks, Section 7, are the push alternative.)

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "state": "awaiting_review",
  "internal_status": "awaiting_document_review",
  "progress": 35,
  "message": "Waiting for document analysis review",
  "created_at": "2026-06-17T10:00:00Z",
  "completed_at": null,
  "metadata": { "your_reference_id": "REF-0000-00000" }
}
```

**`state`** is a stable 5-value vocabulary — poll on this:

| `state` | Meaning |
|---|---|
| `queued` | Accepted, not started. |
| `running` | Processing (Phase 1/2, searches, generation). |
| `awaiting_review` | **Paused at one of the three checkpoints** — read `internal_status` to know which. |
| `completed` | Report ready → call `/result`. |
| `failed` | Terminal failure. |

**`internal_status`** disambiguates a pause:

| `internal_status` | Checkpoint |
|---|---|
| `awaiting_document_review` | 1 — Document analysis |
| `awaiting_documents` | 2 — Missing documents |
| `awaiting_acknowledgements` | 3 — Risk acknowledgement |

---

## 6. The three review checkpoints

Each checkpoint has a **GET** to read what needs review and a **POST** to approve/continue. You only hit these in interactive mode. (Submit endpoints need checkpoint permissions on your key — see Section 2.)

### Checkpoint 1 — Document analysis (`internal_status = awaiting_document_review`)

**Read:** `GET /api/cases/{case_id}/document-review`

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "status": "awaiting_document_review",
  "documents": [ { "document_id": "…", "document_number": "…", "document_date": "…", "parties": [ … ], "survey_number": "…", "house_number": "…" } ],
  "editable_fields": ["document_number", "document_date", "parties", "survey_number", "house_number"],
  "awaiting_since": "2026-06-17T10:05:00Z",
  "duplicate_documents": [],
  "schema_mismatch_documents": []
}
```

**Approve:** `POST /api/cases/{case_id}/submit-document-review`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `updates` | object[] | `[]` | Field corrections. Each: `{ "document_id": "...", "field_name": "<one of editable_fields>", "new_value": <any> }` |
| `proceed_to_searches` | boolean | `true` | Continue to external searches after applying edits. |

```json
{ "updates": [], "proceed_to_searches": true }
```

Response: `{ "success": true, "case_id": "...", "task_id": "...", "message": "...", "updates_applied": 0 }`.

### Checkpoint 2 — Missing documents (`internal_status = awaiting_documents`)

**Read:** `GET /api/cases/{case_id}/missing-documents`

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "status": "awaiting_documents",
  "missing_documents": [ { "document_type": "EC", "reason": "…" } ],
  "iteration": 0,
  "max_iterations": 3,
  "awaiting_since": "2026-06-17T10:20:00Z",
  "pause_message": "…",
  "auto_progress_decision": { }
}
```

**(Optional) attach newly uploaded docs to a specific slot:**
`PATCH /api/cases/{case_id}/missing-documents/{slot_index}/link` with `{ "document_ids": ["<uuid>"] }`.

**Approve / continue:** `POST /api/cases/{case_id}/continue`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `new_document_ids` | string[] | `[]` | Newly uploaded `document_id`s to attach (upload first via Section 3). |
| `proceed_anyway` | boolean | `false` | Continue without supplying the remaining missing docs. |
| `document_annotations` | object[] | `[]` | Per-missing-doc notes: `{ "document_type": "...", "document_number": "...", "ignored": false, "instructions": "..." }` |
| `split_document_ids` | string[] | `[]` | Doc ids to bundle-split. |

```json
{ "new_document_ids": [], "proceed_anyway": true }
```

Response: `{ "success": true, "case_id": "...", "task_id": "...", "message": "...", "new_documents_count": 0, "proceed_anyway": true }`. Returns `400` if the case is not actually awaiting documents, `422` with `PAUSE_GATE_UNMET` if your organisation still needs items actioned, and a `200` carrying `pending_checker` if the answer is waiting on a second approver. See 12.0.

### Checkpoint 3 — Risk acknowledgement (`internal_status = awaiting_acknowledgements`)

**Read:** `GET /api/cases/{case_id}/acknowledgements`

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "status": "awaiting_acknowledgements",
  "acknowledgements": { },
  "user_bypasses": { },
  "pause_message": "…",
  "auto_progress_decision": { }
}
```

**Approve:** `POST /api/cases/{case_id}/submit-acknowledgements`

| Field | Type | Meaning |
|---|---|---|
| `acknowledgements` | object[] | One item per risk, sent back **whole** with a `decision` added. `decision` is `"accepted"`, `"rejected"` or `"undecided"`; `bypass_reason` (string) records why. |

```json
{ "acknowledgements": [ { "id": "risk_1", "decision": "accepted", "bypass_reason": "Accepted by credit team" } ] }
```

Three rules that decide whether this call does anything at all:

- Spread the item you got from the GET and add `decision` to it. A hand-built payload usually drops fields the report needs.
- An item sent **without** a `decision` acknowledges nothing, so a case can look answered while nothing was decided.
- Do **not** send `is_bypassed`. The server derives it from `decision`, and sending both is rejected when they disagree.

Submitting moves the case to `processing` and launches final report generation (Phase 2). Response: `{ "success": true, "case_id": "...", "task_id": "...", "message": "...", "bypassed_count": 1, "total_acknowledgements": 1 }`.

---

## 7. Step 4 — Get the final report

### 7.1 Final report as JSON — `GET /api/cases/{case_id}/result`

Returns `409 case_not_ready` (with the current `state`) until the report is `completed`. Once complete:

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "state": "completed",
  "completed_at": "2026-06-17T10:45:00Z",
  "report": { "...": "the full structured report (~30 sections)" },
  "property_score": { "...": "LegiScore scorecard — pillars, tier, overall" },
  "report_generated_at": "2026-06-17T10:45:00Z",
  "metadata": { "your_reference_id": "REF-0000-00000" }
}
```

- `report` is the full structured report object. Its inner keys are **scenario/template-dependent** — treat it as a structured object keyed by section. If you want a typed contract for the inner body, pin to one `scenario_code` and we will share a real example payload for that scenario.
- `property_score` is the LegiScore property scorecard.
- `metadata` is your correlation blob, echoed verbatim.

### 7.2 Source & search artifacts — `GET /api/cases/{case_id}/files`

Inventory of every file on the case, each with a short-lived (900 s) signed download URL. Optional `?kinds=` filter (comma-separated) over `uploaded`, `added_during_review`, `search_artifact`, `report_json`.

```json
{
  "case_id": "RPT-2026-EXAMPLE1",
  "files": [
    {
      "file_id": "…",
      "kind": "search_artifact",
      "filename": "encumbrance_certificate.pdf",
      "content_type": "application/pdf",
      "file_size": 51234,
      "download_url": "https://storage.example.com/...signed...",
      "uploaded_at": "2026-06-17T10:30:00Z",
      "note": null
    }
  ],
  "total": 6,
  "url_expires_in": 900,
  "available_kinds": ["uploaded", "added_during_review", "search_artifact", "report_json"],
  "unavailable_kinds": ["report_docx", "report_pdf"]
}
```

### 7.3 All artifacts as a ZIP — `GET /api/cases/{case_id}/files/zip`

Same `?kinds=` filter; streams a single ZIP of the selected artifacts.

### 7.4 Rendered PDF / Word report — `GET /api/v1/documents/{case_id}?format=pdf`

The polished, branded report document. `format` takes `pdf` or `docx`, and the response is the file itself, not JSON.

This is a **separate endpoint** from `/files`: the file list and the ZIP carry your uploads and the search artifacts, not the rendered report, which is why `report_pdf` / `report_docx` show under `unavailable_kinds` there.

---

## 8. Webhooks (push callbacks)

Instead of (or alongside) polling, LegiScore can call your server at each stage. You give us a callback URL; we configure it against your org. Your endpoint receives an HTTP `POST` with a JSON body.

### 8.1 Events

Subscribe to these canonical event keys. For the property due-diligence flow the live events are:

| Event | Fires when |
|---|---|
| `report.paused.review` | Paused at checkpoint 1 (document analysis / risks detected). |
| `report.paused.missing_documents` | Paused at checkpoint 2 (missing documents). |
| `report.paused.acknowledgements` | Paused at checkpoint 3 (risk acknowledgement). |
| `report.completed` | **Final report ready.** |
| `report.failed` | Report failed. |

> Three further keys exist in the catalogue — `asset.created`, `report.auto_triggered`, `report.started` — but are **not emitted by the pipeline yet**. Do not build on them as live; we will tell you when they go live.

### 8.2 Default payload (envelope)

By default your endpoint receives the full envelope:

```json
{
  "delivery_id": "8f14e45fceea167a5a36dedd4bea2543",
  "event": "report.completed",
  "api_version": "2026-04-26",
  "occurred_at": 1718600000,
  "data": {
    "case_id": "RPT-2026-EXAMPLE1",
    "status": "completed",
    "scenario": "HL_NEW_APARTMENT",
    "created_at": "2026-06-17T10:00:00Z",
    "report": { "...": "full structured report — report.completed only" },
    "custom_fields": { "...": "AI-extracted custom-field values — report.completed only" },
    "property_score": { "...": "LegiScore scorecard — report.completed only" },
    "metadata": { "your_reference_id": "REF-0000-00000" }
  }
}
```

- Top-level keys are always present: `delivery_id` (unique per delivery — use it to de-dupe), `event`, `api_version`, `occurred_at` (Unix epoch seconds), `data`.
- Inside `data`: `case_id`, `status`, `scenario`, `created_at` are always present; your `metadata` is echoed verbatim.
- `report`, `custom_fields`, `property_score` are included **only on `report.completed`**. Pause events carry just the identifiers plus the pause `stage`/`state`.
- The body is compact JSON with **alphabetically sorted keys**. Max payload 512 KB.

### 8.3 Custom payload mapping

If you want the callback shaped to your own system's schema rather than our envelope, we configure a `payload_config` on your webhook. It supports: fixed literals, dot-path field mapping (`{ "out": "ReferenceId", "path": "data.case_id" }`), `coalesce` (first non-null of several paths), value transforms (`upper`, `bool_yes_no`, `join`, `year`, `capitalize`), nested objects (dotted `out` builds nesting), arrays from a source list (`each` + `fields`), fixed-row arrays (`rows`), and an `envelope: "raw"` option so the POST body *is* your mapped object with no wrapper.

Example mapping config:

```json
{
  "mode": "mapped",
  "envelope": "raw",
  "static_values": { "source": "LEGISCORE" },
  "mappings": [
    { "out": "ReferenceId", "path": "data.case_id" },
    { "out": "Status",      "path": "data.status",            "transform": "upper" },
    { "out": "Score",       "coalesce": ["data.property_score.overall", "data.report.property_score"] },
    { "out": "RiskFlag",    "path": "data.report.has_risks",  "transform": "bool_yes_no" },
    { "out": "Borrower.Name", "path": "data.metadata.borrower_name" }
  ]
}
```

Resulting POST body to your endpoint:

```json
{
  "source": "LEGISCORE",
  "ReferenceId": "RPT-2026-EXAMPLE1",
  "Status": "COMPLETED",
  "Score": 72,
  "RiskFlag": "yes",
  "Borrower": { "Name": "A. N. Example" }
}
```

Tell us your target schema and we will build the mapping for you.

### 8.4 Headers on every delivery

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `LegiScore-Webhook/1.0` |
| `X-LegiScore-Event` | the canonical event, e.g. `report.completed` |
| `X-LegiScore-Delivery` | the `delivery_id` |
| `X-LegiScore-Timestamp` | Unix epoch seconds |
| `X-LegiScore-Signature` | `sha256=<hex>` HMAC (when HMAC auth is enabled) |

### 8.5 Authentication of the callback

We support, per your preference:

| Mode | What your server receives |
|---|---|
| `none` | No auth header (rely on a secret URL + TLS). |
| `hmac` | `X-LegiScore-Signature: sha256=<hex>` — verify it (see below). |
| `bearer` | `Authorization: Bearer <token>` (token you give us). |
| `basic` | `Authorization: Basic base64(user:pass)`. |
| `custom_headers` | Any fixed header(s) you specify, e.g. `X-Api-Key: …`. |

**HMAC verification** (recommended). The signature is HMAC-SHA256 over the string `"<X-LegiScore-Timestamp>." + <raw request body bytes>`, hex-encoded, prefixed `sha256=`:

```python
import hmac, hashlib

def verify(raw_body: bytes, timestamp: str, signature_header: str, secret: str) -> bool:
    msg = timestamp.encode() + b"." + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

Verify against the **raw received body** (do not re-serialise — it is compact, sorted-key JSON), using the `X-LegiScore-Timestamp` header. Reject large timestamp skews to protect against replay.

### 8.6 Delivery, retries, and what to return

- Transport: HTTP `POST`, 30 s timeout per attempt.
- **Return `2xx`** to acknowledge.
- `4xx` is treated as a permanent config error — **not retried**.
- `5xx` or a network/timeout error is **retried up to 5 times** with exponential backoff (~30 min total).
- Every attempt is logged on our side so a failing endpoint is diagnosable. If all retries fail you can always re-fetch with `GET /api/cases/{case_id}/result`.

---

## 9. Reference — `propertyFocus` (property block)

Sent as the `propertyFocus` object on create. Loosely typed; the canonical shape is:

| Field | Type | Required | Notes |
|---|---|---|---|
| `property_type` | string | yes | one of `building`, `sites`, `agricultural` (default `building`). |
| `state` | string | yes | full state name, e.g. `"Andhra Pradesh"`. |
| `state_id` | integer | yes | numeric state id (e.g. AP = 2, Maharashtra = 21). We will share the id table. |
| `property_details` | object | yes | **free-form** key/value bag — survey number, district, village, house no, door no, etc. Any portal-specific field goes here verbatim. |
| `kb_config` | object | no | knowledge-base control. Default `{ "use_kb": true, "kb_central": true, "kb_state": true, "kb_category": "all" }`. |
| `additional_search_options` | object | no | pre-selected search ids: `ec_search_id`, `prohibited_search_id`, `district_court_search_id`, `property_tax_search_id`, `rera_search_id`, etc. Usually omitted — the platform discovers what to search. |
| `extraction_hints` | object | no | hints to bias AI extraction (e.g. survey prefixes). |

`property_details` example:

```json
{ "house_no": "1-23", "survey_nos": "123", "village_city": "Example Village", "district": "Example District" }
```

---

## 10. Reference — scenarios and custom fields

### Scenarios (`scenario_code`)

A *scenario* is the diligence template/config a report runs against — it controls the AI scenario prompt, which government-record searches and knowledge-base sources are used, the criticality rules at each checkpoint, the custom fields extracted, and the final document template. It is identified by a **string code**, not a UUID.

Examples of scenario codes: `HL_NEW_APARTMENT`, `HL_INDEPENDENT_HOUSE`, `LAP_ABSOLUTE_OWNER`, `LAP_SUCCESSION_WILL`, `WAREHOUSE_LOGISTICS`, `TRUST_PROPERTY`, `SOCIETY_PROPERTY`, `MINOR_OWNER`, `SELLER_DECEASED`, `LIT_SARFAESI`, `UNAUTHORIZED_CONSTRUCTION`.

Omit `scenario_code` to use your org's default. We will configure a default scenario (and any bespoke ones) for you during onboarding.

### Custom fields

Scenarios can define org-specific intake/extraction fields. Two controls on the create request:

- **`custom_field_schema_ids`** (string[]): override which custom-field schemas to extract for this report (UUIDs of schemas). Omit to use the scenario's defaults.
- **`custom_field_value_seed`** (object): pre-seed values you already hold from your own system (e.g. from your LOS). These take precedence over AI extraction. Provided as a flat key/value object; we will share the exact key convention for your configured schemas during onboarding.

The AI-extracted custom-field values come back inside `data.custom_fields` on the `report.completed` webhook and inside the report on `/result`.

---

## 11. Supporting endpoints (optional)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/credits` | GET | Your wallet / prepaid credit balance. |
| `/api/v1/custom-field-configs` | GET | List custom-field schemas you can reference in `custom_field_schema_ids`. |
| `/api/v1/documents/{case_id}` | GET | The rendered report as PDF or DOCX (Section 7.4). |

---

## 12. Errors

### 12.0 Two replies that mean the case did not move

Every checkpoint in Section 6 is resumed by a `POST`, and two of its replies are not what a
caller reading only the status line will assume.

**422 `PAUSE_GATE_UNMET`.** Your organisation can require every item at a checkpoint to be
actioned before the case may advance. When something is outstanding, `POST .../continue`,
`POST .../submit-document-review` and `POST .../submit-acknowledgements` refuse with 422 and a
structured body rather than advancing:

```json
{
  "detail": {
    "code": "PAUSE_GATE_UNMET",
    "stage": "upload_docs",
    "errors": ["2 missing documents are not yet actioned: Sale Deed, Encumbrance Certificate"]
  }
}
```

`stage` is `upload_docs`, `review_analysis` or `submit_acks`. `errors` are plain sentences meant
to be shown to whoever is answering the checkpoint. **Retrying the same body is refused again.**
Action what the reasons name and call again. Test for this before any other non-2xx branch: a
`400` from these endpoints means the case already advanced, which is the opposite conclusion.

**200 with `pending_checker: true`.** Where a second person has to approve the answer, the reply
is `{"success": true, "advanced": false, "pending_checker": true, "stage": "...", ...}`. The answer
is recorded and the case is held at the same checkpoint until the approver acts, so the status
stays `awaiting_review`. Treating it as an advance leaves you polling a case that is not moving.

### 12.1 Codes



These are the report host's errors. The search product on `https://legiscore.in` uses a different envelope and its own codes — see 13.7.

Errors return a normalised code:

| Code | HTTP | Meaning |
|---|---|---|
| `missing_authentication` | 401 | No API key supplied. |
| `invalid_api_key` | 401 | Key invalid, revoked, or expired. |
| `case_not_found` | 404 | Unknown case (also returned for a case that is not yours — ids are not enumerable). |
| `case_not_ready` | 409 | `/result` called before the report is `completed`; body carries the current `state`. |
| `validation_failed` | 422 | Request body failed validation. |
| `PAUSE_GATE_UNMET` | 422 | A checkpoint was refused because items are still outstanding. Body carries `stage` and `errors`; see 12.0. Not retryable. |
| `INVALID_PARTNER_METADATA` | 422 | `metadata` blob malformed. |
| `unsupported_content_type` | 415 | Upload content type not in the allowlist. |
| `idempotency_conflict` | 409 | Same `Idempotency-Key` reused with a different body. |
| `internal` | 500 | Unexpected server error. |

---

## 13. Government record searches

A **separate product** from the report flow above, on a separate host, with a separate credit
balance. One `lsk_` key opens both.

| | Reports | Searches |
|---|---|---|
| Base URL | `https://opinion.legiscore.in` | `https://legiscore.in` |
| Auth | `X-API-Key` or `Authorization: Bearer lsk_…` | the same |
| Credits | `GET /api/v1/credits` | `GET /api/v1/search/credits` |
| Unit | 1 credit per report | flat per search, price from the catalog |
| Shape | varies per endpoint | always `{"data": …}` or `{"error": {"code","message"}}` |

A run of searches can never spend the credits bought for reports, and vice versa. A search is
charged when it is **accepted** and **returned** if the source cannot be reached.

> Every path in this section is on `https://legiscore.in`. Sending them to the reports host is a
> 404, and it is the single most common mistake here. In the Postman pack these live in folder 9
> and use `{{search_base_url}}`.

### 13.1 Endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/v1/search/catalog` | What can be searched, what each search needs, what it costs. **No key required.** |
| `GET` | `/api/v1/search/lookups` | Turn a district/mandal/village/office name into the codes a search needs. |
| `POST` | `/api/v1/search` | Run one search, or up to 25 in one call. |
| `GET` | `/api/v1/search/{search_id}` | Poll one search. |
| `GET` | `/api/v1/search` | List your searches, newest first. |
| `DELETE` | `/api/v1/search/{search_id}` | Ask a search still in flight to stop. |
| `GET` | `/api/v1/search/{search_id}/documents/{filename}` | Download a file the search produced. |
| `GET` | `/api/v1/search/credits` | Balance, what is spendable, recent movements. |
| `POST` | `/api/v1/search/{search_id}/otp` | Supply a one-time password to a waiting search. |
| `POST` | `/api/v1/search/{search_id}/recover` | Re-run a finished search against related identifiers. |
| `POST` | `/api/v1/search/assist` | Read a document and propose parameters. Never submits. |

### 13.2 Discover before you submit — catalog and lookups

`GET /api/v1/search/catalog` is the only unauthenticated call in the API. Build your form or your
parameter mapping from it rather than hardcoding anything:

```json
{
  "data": {
    "live_states": ["andhra", "telangana", "maharashtra"],
    "pricing": { "currency": "INR", "credits_per_rupee": 1, "search": 20, "ai_assist": 20, "ai_recovery": 50 },
    "source": { "status": "operational", "checked_at": "2026-09-08T09:12:00.000Z" },
    "searches": [
      {
        "state": "andhra",
        "search_type": "ec",
        "label": "Encumbrance Certificate",
        "credits": 20,
        "typical_seconds": 300,
        "fields": [
          { "name": "sro", "label": "Sub-Registrar Office", "type": "lookup", "required": true,
            "lookup": { "dim": "sro" } },
          { "name": "doc_no", "label": "Document Number", "type": "text", "required": false }
        ],
        "one_of": [{ "fields": ["doc_no", "applicant_name"], "message": "Give a document number or an applicant name." }]
      }
    ]
  }
}
```

Read `pricing.search` for the price; it is a commercial number and will change.
`source.status` of `unavailable` means searches will not consume credits, because the charge is
reversed the moment a job fails to reach the portal.

**A field with a `lookup` is picked, never typed.** Resolve it first:

```http
GET /api/v1/search/lookups?state=andhra&dim=sro&q=<partial name> HTTP/1.1
Host: legiscore.in
X-API-Key: lsk_…
```

```json
{ "data": { "options": [ { "value": "1503", "label": "<office name>", "meta": { "sro_code": "1503" } } ] } }
```

Send the option's `value` **and spread its `meta`** into `params`; those are the codes the source
keys on. A nested dimension needs its parent first — asking for a village without a district and
mandal returns `missing_parent`.

### 13.3 Submit — `POST /api/v1/search`

```json
{ "state": "andhra", "search_type": "ec", "params": { "sro": "1503", "doc_no": "1234", "year": "2018" }, "label": "your own reference" }
```

For a batch, send `{"searches": [ … ]}` instead, up to **25** per request. `label` is optional and
echoed back on every read.

**202 Accepted:**

```json
{
  "data": {
    "searches": [ { "id": "SRCH-2026-XXXXXXXX", "status": "queued", "credits_charged": 20, "replayed": false } ],
    "rejected": [],
    "replayed": { "free": 0, "billed": 0 },
    "credits_charged": 20,
    "batch_id": null
  }
}
```

Three things that catch people out:

- **A batch is not all-or-nothing.** Items that fail validation come back in `rejected`, each with
  the `index` it had in your request and a reason. The rest still ran. Check it every time.
- **`replayed`** counts searches answered from an identical run on your account in the last 24
  hours instead of from the source. Free when you are the one repeating it, and then `id` is your
  earlier search; charged normally when a colleague asked first. After 24 hours the same request
  runs fresh.
- **402** with `code: "insufficient_credits"` refuses the whole batch and charges nothing. A
  partial batch is far harder to reconcile than a clean rejection.

### 13.4 Poll — `GET /api/v1/search/{search_id}`

Repeat until `status` is `succeeded`, `failed` or `cancelled`. Size the interval against
`typical_seconds` from the catalog; every few seconds is sensible.

| `status` | Meaning |
|---|---|
| `queued`, `running` | in progress, keep polling |
| `awaiting_otp` | the source asked for a one-time password — see 13.6 |
| `succeeded` | finished; read `found`, `records`, `documents` |
| `failed` | read `error`; the charge is returned when the source could not be reached |
| `cancelled` | you stopped it |

```json
{
  "data": {
    "search": {
      "id": "SRCH-2026-XXXXXXXX",
      "status": "succeeded",
      "found": true,
      "record_count": 3,
      "records": [ … ],
      "documents": [ { "filename": "ec.pdf", "content_type": "application/pdf", "bytes": 184320 } ],
      "credits_charged": 20,
      "refunded": false,
      "completed_at": "2026-09-08T09:17:11.000Z"
    }
  }
}
```

> **`found: false` on a `succeeded` search is an answer, not a failure.** The source was reached
> and holds nothing on record against that property — for an encumbrance search that is the good
> outcome. Do not retry it and do not surface it as an error. `found` is `null` until the search
> settles.

`GET /api/v1/search` lists your searches newest first, with `limit`, `offset`, `status` and
`batch_id`. Anything still in flight is refreshed on the way past, so listing doubles as polling a
whole batch in one call.

### 13.5 Documents — `GET /api/v1/search/{search_id}/documents/{filename}`

`filename` is exactly as `documents[]` reports it. The response is **`302` to a signed URL that
expires in an hour**, not the bytes.

> **Do not follow that redirect on the same connection.** Your API key travels in a custom header,
> and a custom header **is** forwarded across a cross-origin redirect (unlike `Authorization`,
> which browsers and `fetch` drop). Following it hands your key to a storage host. Read the
> `Location` header and issue a second request with **no key attached**. Both SDKs do this for you;
> Postman follows redirects itself, so the request in folder 9 just works.

The file is resolved from the search's own document list rather than from the path, so a filename
that is not on that search is `404` — as is one belonging to another account, deliberately
indistinguishable.

### 13.6 Optional endpoints

| Endpoint | What it is |
|---|---|
| `DELETE /api/v1/search/{search_id}` | Stops a search still in flight. Returns the search with `cancelling: true`; the settled status arrives on a later poll and the credits come back if it never completed. A search already settled returns `409 already_finished`. |
| `POST /api/v1/search/{search_id}/otp` | Body `{"otp": "1234"}`, 4–8 digits, only while `status` is `awaiting_otp`. Most searches never reach that state. Any other status returns `409 not_waiting`. |
| `POST /api/v1/search/{search_id}/recover` | Re-runs a finished search against related identifiers when the first attempt came back thin. No request body. Priced separately from a plain search; nothing is charged when the source is unreachable or when there is nothing defensible to try. |
| `POST /api/v1/search/assist` | `multipart/form-data` with a `file` (PDF/PNG/JPEG/WebP, under 20 MB) or `text`, plus `state`. Proposes parameters with a confidence per field and **never submits them** — a wrong survey number does not fail loudly, it searches a different property and returns a confident, wrong clean result. A person confirms. A document nothing could be read from costs nothing. |

### 13.7 Errors

Every failure on this host has the same shape. Branch on `code`, never on `message`:

```json
{ "error": { "code": "insufficient_credits", "message": "This run needs 20 search credits; 0 available." } }
```

| `code` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Key missing, malformed or revoked. |
| `invalid_body` | 400 | Neither `searches` nor `state` + `search_type` + `params`. |
| `too_many` | 400 | More than 25 searches in one request. |
| `insufficient_credits` | 402 | Not enough search credits. Nothing was charged. |
| `not_found` | 404 | No such search or document — also returned for one that is not yours. |
| `unsupported_state`, `unknown_dim`, `missing_parent` | 404 / 400 | Lookup asked for something that does not exist, or without its parent. |
| `already_finished` | 409 | Cancel called on a search that already settled. |
| `not_waiting` | 409 | OTP sent to a search that is not waiting for one. |
| `not_finished`, `already_recovery`, `unknown_search` | 409 | Recovery called on a search that cannot be recovered. |
| `recovery_unavailable` | 503 | The source is down, so recovery cannot proceed. Nothing was charged. |
| `internal` | 500 | Unexpected server error. |

---

## 14. Using the Postman collection

Three files accompany this document:

- `legiscore.postman_collection.json` — every request in this flow, in order, with collection-level `X-API-Key` auth. Folders 0 to 8 are the report flow; folder 9 is the search product.
- `legiscore.postman_environment.json` — the shared environment. Every value ships **empty** except `base_url` and `search_base_url`; nothing in it is a live key or a real id.
- `legiscore-reference.postman_collection.json` — every operation the API exposes, generated from the spec, for looking things up.

To run:

1. Import all three files into Postman.
2. Select the **LegiScore (production)** environment.
3. Set `api_key` to the `lsk_` key we issue you. (`base_url` is preset to `https://opinion.legiscore.in`, and `search_base_url` to `https://legiscore.in` for folder 9.)
4. Run the requests top to bottom. The upload and create requests have test scripts that auto-capture `document_id` and `case_id` into the environment, so later requests resolve automatically.

A built-in **"Webhook envelope (reference)"** request documents the inbound callback shape; it is illustrative, not a call you make.

---

*Prepared by LegiScore. Questions: info@legiscore.in.*
