/**
 * React views for the LegiScore report lifecycle.
 *
 * ```tsx
 * import { ReportFlow, createProxyReports } from "@legiscore/views";
 * import "@legiscore/views/styles.css";
 *
 * const api = createProxyReports("/legiscore");   // your backend, holding the key
 * <ReportFlow api={api} caseId={caseId} />
 * ```
 */
export {
  ackItems,
  ackKey,
  buildAckSubmission,
  createProxyReports,
  isPendingSecondApproval,
  pauseOf,
  PAUSE_GATE_UNMET,
  readPauseGateRefusal,
  ViewsError,
  type AckDecision,
  type AcknowledgementItem,
  type AcknowledgementsPayload,
  type CaseResult,
  type CaseState,
  type CaseStatus,
  type DocumentAnnotation,
  type DocumentReviewPayload,
  type FieldUpdate,
  type MissingDocument,
  type MissingDocumentsPayload,
  type Pause,
  type PauseGateRefusal,
  type ReportsApi,
  type ReviewDocument,
} from "./api.js";
export { useCase, type StagePayload, type UseCaseOptions, type UseCaseResult } from "./useCase.js";
export { ReportFlow, type ReportFlowProps } from "./ReportFlow.js";
export {
  AcknowledgementsView,
  CaseResultView,
  CaseStatusBar,
  DocumentReviewView,
  MissingDocumentsView,
  type MissingDocumentsViewProps,
} from "./views.js";
