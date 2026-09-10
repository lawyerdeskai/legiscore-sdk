/**
 * The two answers to a pause that are not "it worked".
 *
 * A case pauses three times and each pause has a matching resume call. Two things can come
 * back from one of those calls that a caller reading only the HTTP status will get wrong:
 *
 * 1. **422 with a structured body.** Your organisation can require every item at a pause to be
 *    actioned before the case may advance. When something is outstanding the API refuses the
 *    resume with 422 and a machine-readable reason list. Retrying sends the same body and is
 *    refused again; the fix is to action the items the reasons name and call again.
 * 2. **200 that did not advance the case.** Where a second person has to approve the answer,
 *    the resume call records it and parks the case at the same pause. The reply carries
 *    `pending_checker: true` and the case stays in `awaiting_review` until the approver acts.
 *
 * Neither is an SDK invention: both are the API's own wire contract, and the web application
 * reads them the same way.
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
