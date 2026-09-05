/**
 * The data contract the views render against, and a browser client for it.
 *
 * The views never hold an API key. `lsk_` keys are server-side secrets, so the browser
 * talks to YOUR backend and your backend talks to LegiScore with the key attached.
 * `createProxyReports("/legiscore")` expects paths that mirror the API's own, so the
 * whole proxy can be a pass-through that only adds the Authorization header.
 */

export type CaseState = "queued" | "running" | "awaiting_review" | "completed" | "failed";

/** Which of the three review pauses a case is sitting in, if any. */
export type Pause = "missing_documents" | "document_review" | "acknowledgements" | null;

/**
 * `state: "awaiting_review"` says only that the case stopped; `internal_status` says which
 * pause. Asking about a pause the case is not in returns 400, so dispatch — never probe.
 * Acknowledgements answer to two spellings; both are live in the API.
 */
const PAUSES: Record<string, Exclude<Pause, null>> = {
  awaiting_documents: "missing_documents",
  awaiting_document_review: "document_review",
  awaiting_acknowledgements: "acknowledgements",
  awaiting_acknowledgement: "acknowledgements",
};

export function pauseOf(status: { state?: string; internal_status?: string | null } | null | undefined): Pause {
  if (!status || status.state !== "awaiting_review") return null;
  return PAUSES[status.internal_status ?? ""] ?? null;
}

export interface CaseStatus {
  case_id: string;
  state: CaseState;
  internal_status?: string | null;
  progress?: number;
  message?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MissingDocument {
  document_type?: string;
  document_number?: string | null;
  reason?: string | null;
  criticality?: string | null;
  slot_id?: string | null;
  [key: string]: unknown;
}

export interface MissingDocumentsPayload {
  case_id: string;
  missing_documents: MissingDocument[];
  missing_document_annotations?: DocumentAnnotation[];
  iteration?: number;
  max_iterations?: number;
  pause_message?: string | null;
  [key: string]: unknown;
}

export interface DocumentAnnotation {
  document_type: string;
  document_number?: string | null;
  ignored?: boolean;
  instructions?: string | null;
  slot_id?: string | null;
}

export interface ReviewDocument {
  document_id: string;
  document_name?: string | null;
  document_type?: string | null;
  document_summary?: string | null;
  [field: string]: unknown;
}

export interface DocumentReviewPayload {
  case_id: string;
  documents: ReviewDocument[];
  /** The server decides what may be edited. Never hard-code this list. */
  editable_fields: string[];
  duplicate_documents?: unknown[];
  schema_mismatch_documents?: unknown[];
  [key: string]: unknown;
}

export interface FieldUpdate {
  document_id: string;
  field_name: string;
  new_value: unknown;
}

export type AckDecision = "accepted" | "rejected" | "undecided";

export interface AcknowledgementItem {
  statement: string;
  original_statement?: string;
  category?: string;
  severity?: "Critical" | "Major" | "Minor" | string;
  suggested_responses?: string[];
  decision?: AckDecision;
  is_bypassed?: boolean;
  bypass_reason?: string | null;
  source_documents?: { document_id: string; document_name?: string | null; filename?: string | null }[] | null;
  ack_id?: string;
  [key: string]: unknown;
}

export interface AcknowledgementsPayload {
  case_id: string;
  /** Either the bare list or the generated block that wraps it. `ackItems` unwraps both. */
  acknowledgements: AcknowledgementItem[] | { acknowledgements?: AcknowledgementItem[]; [key: string]: unknown };
  user_bypasses?: { acknowledgements?: AcknowledgementItem[]; [key: string]: unknown };
  pause_message?: string | null;
  [key: string]: unknown;
}

export interface CaseResult {
  case_id: string;
  state?: CaseState;
  report?: Record<string, unknown>;
  property_score?: Record<string, unknown>;
  report_generated_at?: string | null;
  [key: string]: unknown;
}

/**
 * What a view needs. `client.reports` from `@legiscore/sdk` satisfies this shape on a
 * server; in a browser use `createProxyReports`.
 */
export interface ReportsApi {
  getCaseStatus(caseId: string): Promise<CaseStatus>;
  getMissingDocuments(caseId: string): Promise<MissingDocumentsPayload>;
  getDocumentReview(caseId: string): Promise<DocumentReviewPayload>;
  getAcknowledgements(caseId: string): Promise<AcknowledgementsPayload>;
  getCaseResult(caseId: string): Promise<CaseResult>;
  continueCase(caseId: string, body: { new_document_ids?: string[]; proceed_anyway?: boolean; document_annotations?: DocumentAnnotation[] }): Promise<unknown>;
  submitDocumentReview(caseId: string, body: { updates: FieldUpdate[]; proceed_to_searches?: boolean }): Promise<unknown>;
  submitAcknowledgements(caseId: string, body: { acknowledgements: AcknowledgementItem[] }): Promise<unknown>;
}

export class ViewsError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, options: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "ViewsError";
    this.status = options.status;
    this.body = options.body;
  }
}

/**
 * Talks to your proxy at `<basePath>/api/cases/...`, the API's own path shape.
 * No retries: a browser tab with a user in front of it should surface the failure, and the
 * server-side SDK already owns the retry policy that keeps writes from double-billing.
 */
export function createProxyReports(basePath = "", fetchImpl: typeof fetch = fetch): ReportsApi {
  const root = basePath.replace(/\/$/, "");

  /** The proxy answers with the API's own JSON; the caller's declared shape is what we hand back. */
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) {
      const detail = errorDetail(parsed) ?? text.slice(0, 200);
      throw new ViewsError(detail || `${method} ${path} failed with ${response.status}`, {
        status: response.status,
        body: parsed,
      });
    }
    return parsed as T;
  }

  const id = encodeURIComponent;
  return {
    getCaseStatus: (c) => call("GET", `/api/cases/${id(c)}/status`),
    getMissingDocuments: (c) => call("GET", `/api/cases/${id(c)}/missing-documents`),
    getDocumentReview: (c) => call("GET", `/api/cases/${id(c)}/document-review`),
    getAcknowledgements: (c) => call("GET", `/api/cases/${id(c)}/acknowledgements`),
    getCaseResult: (c) => call("GET", `/api/cases/${id(c)}/result`),
    continueCase: (c, body) => call("POST", `/api/cases/${id(c)}/continue`, body),
    submitDocumentReview: (c, body) => call("POST", `/api/cases/${id(c)}/submit-document-review`, body),
    submitAcknowledgements: (c, body) => call("POST", `/api/cases/${id(c)}/submit-acknowledgements`, body),
  };
}

/** A proxy error body is whatever the partner's backend forwarded, so narrow before reading it. */
function errorDetail(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const detail = record.detail ?? record.message;
  return typeof detail === "string" && detail ? detail : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

/** The ack list arrives either bare or wrapped in the generated block. Read it one way. */
export function ackItems(payload: AcknowledgementsPayload | null | undefined): AcknowledgementItem[] {
  const raw = payload?.acknowledgements;
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.acknowledgements)) return raw.acknowledgements;
  return [];
}

/**
 * Build the submit payload for the acknowledgements pause.
 *
 * Spreads the generated item rather than picking fields off it: the backend stores this list
 * VERBATIM, and a whitelist here would silently drop `ack_id`, `source_documents`, and every
 * field added after this file was written. `is_bypassed` is deliberately not set — the server
 * derives it from `decision`, and sending both is a 400 when they disagree.
 */
export function buildAckSubmission(
  items: AcknowledgementItem[],
  answers: Record<string, { decision?: AckDecision; bypass_reason?: string | null }>,
): AcknowledgementItem[] {
  return items.map((item, index) => {
    const answer = answers[ackKey(item, index)] ?? {};
    const { is_bypassed, ...rest } = item;
    return {
      ...rest,
      decision: answer.decision ?? item.decision ?? "undecided",
      bypass_reason: answer.bypass_reason ?? item.bypass_reason ?? null,
    };
  });
}

/** Identity for an ack across a re-render: the stamped id, else its position. */
export function ackKey(item: AcknowledgementItem, index: number): string {
  return item.ack_id ?? `#${index}`;
}
