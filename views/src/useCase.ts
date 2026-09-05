"use client";
// React hooks and browser state: this file is a client boundary in the Next.js App Router.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ackItems,
  buildAckSubmission,
  pauseOf,
  type AckDecision,
  type AcknowledgementItem,
  type AcknowledgementsPayload,
  type CaseResult,
  type CaseStatus,
  type DocumentAnnotation,
  type DocumentReviewPayload,
  type FieldUpdate,
  type MissingDocumentsPayload,
  type Pause,
  type ReportsApi,
} from "./api.js";

export type StagePayload = MissingDocumentsPayload | DocumentReviewPayload | AcknowledgementsPayload | CaseResult | null;

export interface UseCaseOptions {
  /** Polling is the fallback. Configure a webhook and call `reload()` on delivery instead. */
  pollIntervalMs?: number;
}

export interface UseCaseResult {
  status: CaseStatus | null;
  pause: Pause;
  /** The payload for whatever the case is currently showing: a pause, or the result. */
  payload: StagePayload;
  loading: boolean;
  busy: boolean;
  error: Error | null;
  reload(): Promise<void>;
  continueCase(body: { new_document_ids?: string[]; proceed_anyway?: boolean; document_annotations?: DocumentAnnotation[] }): Promise<void>;
  submitDocumentReview(updates: FieldUpdate[], proceedToSearches?: boolean): Promise<void>;
  submitAcknowledgements(answers: Record<string, { decision?: AckDecision; bypass_reason?: string | null }>): Promise<void>;
}

/**
 * One case, loaded and kept current.
 *
 * Fetches the status, then the payload for whichever stage the case is in, and polls while
 * it is still moving. Answering one pause can surface the next, so every submit re-reads the
 * status rather than assuming the case is done.
 */
export function useCase(api: ReportsApi, caseId: string, options: UseCaseOptions = {}): UseCaseResult {
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const [status, setStatus] = useState<CaseStatus | null>(null);
  const [payload, setPayload] = useState<StagePayload>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // A reload that resolves after the component unmounts must not setState; and a slow
  // response overtaken by a newer one must not overwrite it.
  const live = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++live.current;
    try {
      const next = await api.getCaseStatus(caseId);
      if (live.current !== generation) return;
      setStatus(next);
      setPayload(await loadStage(api, caseId, next));
      if (live.current !== generation) return;
      setError(null);
    } catch (caught) {
      if (live.current === generation) setError(asError(caught));
    } finally {
      if (live.current === generation) setLoading(false);
    }
  }, [api, caseId]);

  useEffect(() => {
    setLoading(true);
    void reload();
    return () => {
      live.current++;
    };
  }, [reload]);

  const moving = status?.state === "queued" || status?.state === "running";
  useEffect(() => {
    if (!moving || pollIntervalMs <= 0) return;
    const timer = setInterval(() => void reload(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [moving, pollIntervalMs, reload]);

  const submit = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        setError(null);
        await reload();
      } catch (caught) {
        setError(asError(caught));
        throw caught;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return {
    status,
    pause: pauseOf(status),
    payload,
    loading,
    busy,
    error,
    reload,
    continueCase: (body) => submit(() => api.continueCase(caseId, body)),
    submitDocumentReview: (updates, proceedToSearches = true) =>
      submit(() => api.submitDocumentReview(caseId, { updates, proceed_to_searches: proceedToSearches })),
    submitAcknowledgements: (answers) =>
      submit(() => {
        const items = ackItems(payload as AcknowledgementsPayload);
        return api.submitAcknowledgements(caseId, { acknowledgements: buildAckSubmission(items, answers) });
      }),
  };
}

async function loadStage(api: ReportsApi, caseId: string, status: CaseStatus): Promise<StagePayload> {
  switch (pauseOf(status)) {
    case "missing_documents":
      return api.getMissingDocuments(caseId);
    case "document_review":
      return api.getDocumentReview(caseId);
    case "acknowledgements":
      return api.getAcknowledgements(caseId);
    default:
      return status.state === "completed" ? api.getCaseResult(caseId) : null;
  }
}

function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

export type { AcknowledgementItem };
