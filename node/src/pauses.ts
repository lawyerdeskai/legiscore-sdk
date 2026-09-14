/**
 * The answers to a pause that are not "it worked", and how to clear a strict gate.
 *
 * A case pauses three times and each pause has a matching resume call. Three things can come
 * back from one of those calls that a caller reading only the HTTP status will get wrong:
 *
 * 1. **422 with a structured body.** Your organisation can require every item at a pause to be
 *    actioned before the case may advance. When something is outstanding the API refuses the
 *    resume with 422 and a machine-readable reason list. Retrying sends the same body and is
 *    refused again; the fix is to action the items the reasons name and call again.
 * 2. **200 that did not advance the case.** Where a second person has to approve the answer,
 *    the resume call records it and parks the case at the same pause. The reply carries
 *    `pending_checker: true` and the case stays in `awaiting_review` until the approver acts.
 * 3. **A strict document-analysis pause refuses until its findings are acknowledged.** The
 *    findings, and the fingerprint each one is ticked by, come back on
 *    `reports.getDocumentReview` as `review_findings`. Tick the ones you accept and send them
 *    to `reports.submitDocumentReview` as `document_review_annotations`. The fingerprint is a
 *    hash the server computes over the finding's own content; it is the only thing the gate
 *    matches on, and it is never computed on this side, so a finding that changed cannot carry
 *    a stale tick.
 *
 * None of this is an SDK invention: it is the API's own wire contract, and the web application
 * reads it the same way.
 */
import { LegiScoreError } from "./transport.js";

/** The error code the three resume calls answer with when a pause is not fully actioned. */
export const PAUSE_GATE_UNMET = "PAUSE_GATE_UNMET";

/** Which pause was refused. One value per pause a case can stop at. */
export const PAUSE_STAGES = ["upload_docs", "review_analysis", "submit_acks"] as const;
export type PauseStage = (typeof PAUSE_STAGES)[number];

/** A refused resume, read out of the 422. */
export interface PauseGateRefusal {
  /**
   * The pause that was refused. Typed as the wider `string` as well so a stage added later
   * reaches you as itself rather than being dropped.
   */
  stage: PauseStage | string;
  /**
   * Why, in plain sentences meant to be shown to whoever is answering the pause. Empty only
   * if the API sent none, which it does not do today.
   */
  reasons: string[];
}

/**
 * Read a pause refusal out of a failed call, or `null` if that is not what happened.
 *
 * Accepts the `LegiScoreError` the SDK throws, or a parsed response body, so the same function
 * works in a server that proxies these calls on to its own front end.
 *
 * ```ts
 * try {
 *   await client.reports.continueCase(caseId, { new_document_ids: ids });
 * } catch (error) {
 *   const refused = readPauseGateRefusal(error);
 *   if (refused) return showToUser(refused.reasons);
 *   throw error;
 * }
 * ```
 */
export function readPauseGateRefusal(error: unknown): PauseGateRefusal | null {
  const body = error instanceof LegiScoreError ? error.body : error;
  if (!body || typeof body !== "object") return null;

  const detail = (body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;

  const { code, stage, errors } = detail as { code?: unknown; stage?: unknown; errors?: unknown };
  if (code !== PAUSE_GATE_UNMET) return null;

  const reasons = Array.isArray(errors)
    ? errors
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) => reason.trim())
        .filter((reason) => reason !== "")
    : [];
  return { stage: typeof stage === "string" ? stage : "", reasons };
}

/**
 * True when a resume call succeeded but left the case where it was, waiting for a second
 * person to approve the answer.
 *
 * Check it on the reply to `continueCase`, `submitDocumentReview` and `submitAcknowledgements`.
 * A caller that treats every 200 as "advanced" will poll a case that is not moving, or answer
 * the same pause a second time.
 *
 * ```ts
 * const replied = await client.reports.submitAcknowledgements(caseId, { acknowledgements });
 * if (isPendingSecondApproval(replied)) return waitForYourColleagueToApprove();
 * ```
 */
export function isPendingSecondApproval(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  return (response as { pending_checker?: unknown }).pending_checker === true;
}

// -- the document-analysis gate ------------------------------------------------------------

/** The kinds of finding a document-analysis pause can hold, so a caller can branch by name. */
export const FINDING_KINDS = [
  "missing_fields",
  "duplicate_group",
  "review_flag",
  "irrelevant",
  "same_document",
  "anomaly",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** One document-analysis finding a strict pause gate checks before the case may advance. */
export interface ReviewFinding {
  /**
   * The server's hash of the finding's own content, and the only thing the gate matches on.
   * Send it back to acknowledge the finding. Never compute one on this side: a client that
   * recomputed the hash would drift from the server the first time the recipe changed, and
   * would then be ticking nothing.
   */
  fingerprint: string;
  /**
   * Typed as the wider `string` as well so a kind added later reaches you as itself rather
   * than being dropped. `null` where the API sent none.
   */
  finding_kind: FindingKind | string | null;
  /** The document the finding is about, or `null` when it is about the case as a whole. */
  document_id: string | null;
  /**
   * Display text, deliberately excluded from the hash so it can be reworded without
   * invalidating a tick.
   */
  label: string;
  /**
   * The finding already carries its own recorded answer, so the gate counts it as seen and no
   * tick is needed.
   */
  resolved: boolean;
  /** It was ticked on an earlier round. */
  acknowledged: boolean;
}

/** One tick, as `document_review_annotations` carries it on a submit. */
export interface DocumentReviewAnnotation {
  fingerprint: string;
  acknowledged: boolean;
}

/** A wire field that is a string or null, with an empty string read as null. */
function readOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The findings on a document-analysis pause, or `[]` when there is nothing to tick.
 *
 * Accepts the `reports.getDocumentReview` body, or its `review_findings` list on its own, so
 * the same function works in a server that proxies the call on to its own front end.
 *
 * Empty is a normal answer rather than a problem: an organisation that has not made the
 * document-analysis pause strict has nothing to acknowledge, and a deployment older than the
 * field omits it altogether. A malformed entry is skipped instead of throwing, because this
 * reads a pause a case is already sitting in and an exception here would strand it.
 *
 * ```ts
 * const review = await client.reports.getDocumentReview(caseId);
 * const findings = readReviewFindings(review);
 * ```
 */
export function readReviewFindings(response: unknown): ReviewFinding[] {
  let entries: unknown[];
  if (Array.isArray(response)) {
    entries = response;
  } else if (response && typeof response === "object") {
    const raw = (response as { review_findings?: unknown }).review_findings;
    entries = Array.isArray(raw) ? raw : [];
  } else {
    return [];
  }

  const findings: ReviewFinding[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const fingerprint = readOptionalText(row.fingerprint);
    if (fingerprint === null) continue;
    findings.push({
      fingerprint,
      finding_kind: readOptionalText(row.finding_kind),
      document_id: readOptionalText(row.document_id),
      label: typeof row.label === "string" ? row.label : "",
      resolved: row.resolved === true,
      acknowledged: row.acknowledged === true,
    });
  }
  return findings;
}

/**
 * Turn findings into the `document_review_annotations` a submit carries.
 *
 * Every finding that is not already `resolved` or `acknowledged` becomes one tick, keyed on
 * its fingerprint. Pure, and deliberately never called for you: acknowledging a finding
 * asserts that a person at your organisation has read it and accepts it, on a property someone
 * is lending against. Pass only what that person actually accepted.
 *
 * ```ts
 * const annotations = buildDocumentReviewAnnotations(findings.filter(aPersonAccepted));
 * await client.reports.submitDocumentReview(caseId, {
 *   proceed_to_searches: true,
 *   document_review_annotations: annotations,
 * });
 * ```
 */
export function buildDocumentReviewAnnotations(
  findings: Iterable<ReviewFinding>,
): DocumentReviewAnnotation[] {
  const annotations: DocumentReviewAnnotation[] = [];
  for (const finding of findings) {
    if (finding.resolved || finding.acknowledged) continue;
    annotations.push({ fingerprint: finding.fingerprint, acknowledged: true });
  }
  return annotations;
}
