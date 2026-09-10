"use client";
// React hooks and browser state: this file is a client boundary in the Next.js App Router.

/**
 * The whole report lifecycle in one component: status, whichever review pause the case is
 * sitting in, and the finished report. Drop it on a page, give it a case id, done.
 *
 * Every part is exported separately, so replace one screen by rendering the pieces yourself
 * rather than forking this file.
 */
import type { ReactNode } from "react";

import type { AcknowledgementsPayload, CaseResult, DocumentReviewPayload, MissingDocumentsPayload, ReportsApi } from "./api.js";
import { useCase, type UseCaseOptions, type UseCaseResult } from "./useCase.js";
import { AcknowledgementsView, CaseResultView, CaseStatusBar, DocumentReviewView, MissingDocumentsView } from "./views.js";

export interface ReportFlowProps extends UseCaseOptions {
  api: ReportsApi;
  caseId: string;
  /** Passed through to the missing documents screen. See MissingDocumentsViewProps. */
  onUpload?(files: File[]): Promise<string[]>;
  /** Rendered instead of the built-in screens, for a fully custom layout on the same state. */
  children?(state: UseCaseResult): ReactNode;
  className?: string;
}

export function ReportFlow({ api, caseId, onUpload, children, className, ...options }: ReportFlowProps) {
  const state = useCase(api, caseId, options);
  if (children) return <>{children(state)}</>;

  return (
    <div className={["lsc-flow", className].filter(Boolean).join(" ")}>
      <CaseStatusBar status={state.status} />
      {state.error ? <p className="lsc-note lsc-note-error">{state.error.message}</p> : null}
      {state.pendingApproval ? (
        <p className="lsc-note">Sent for approval. The case moves on once a colleague approves it.</p>
      ) : null}
      {state.loading ? <p className="lsc-note">Loading the case.</p> : null}

      {state.pause === "missing_documents" && state.payload ? (
        <MissingDocumentsView
          data={state.payload as MissingDocumentsPayload}
          onSubmit={state.continueCase}
          busy={state.busy}
          onUpload={onUpload}
        />
      ) : null}

      {state.pause === "document_review" && state.payload ? (
        <DocumentReviewView
          data={state.payload as DocumentReviewPayload}
          onSubmit={state.submitDocumentReview}
          busy={state.busy}
        />
      ) : null}

      {state.pause === "acknowledgements" && state.payload ? (
        <AcknowledgementsView
          data={state.payload as AcknowledgementsPayload}
          onSubmit={state.submitAcknowledgements}
          busy={state.busy}
        />
      ) : null}

      {state.status?.state === "completed" && state.payload ? (
        <CaseResultView result={state.payload as CaseResult} />
      ) : null}
    </div>
  );
}
