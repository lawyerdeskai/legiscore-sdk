"use client";
// React hooks and browser state: this file is a client boundary in the Next.js App Router.

/**
 * The screens. Every one is presentational and fully controlled: it takes a payload and a
 * callback, holds only the edits the user is making right now, and owns no fetching. Style
 * them by overriding the CSS variables in styles.css, or ignore that file and target the
 * `lsc-` classes with your own.
 */
import { useMemo, useState, type ReactNode } from "react";

import {
  ackItems,
  ackKey,
  type AckDecision,
  type AcknowledgementItem,
  type AcknowledgementsPayload,
  type CaseResult,
  type CaseStatus,
  type DocumentAnnotation,
  type DocumentReviewPayload,
  type FieldUpdate,
  type MissingDocumentsPayload,
} from "./api.js";

const STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "In progress",
  awaiting_review: "Waiting on you",
  completed: "Report ready",
  failed: "Failed",
};

export function CaseStatusBar({ status, className }: { status: CaseStatus | null; className?: string }) {
  if (!status) return null;
  const progress = Math.max(0, Math.min(100, status.progress ?? 0));
  return (
    <div className={cx("lsc-status", className)}>
      <span className={`lsc-badge lsc-badge-${status.state}`}>{STATE_LABELS[status.state] ?? status.state}</span>
      <div className="lsc-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className="lsc-progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="lsc-status-meta">{status.message ?? `${progress}%`}</span>
    </div>
  );
}

// -- pause 1: missing documents ---------------------------------------------

export interface MissingDocumentsViewProps {
  data: MissingDocumentsPayload;
  onSubmit(body: { new_document_ids?: string[]; proceed_anyway?: boolean; document_annotations?: DocumentAnnotation[] }): void;
  busy?: boolean;
  /**
   * Optional. Uploading needs a presign plus a PUT to storage, which needs the API key, so it
   * has to run through your backend. Leave it out and the view asks the user to upload
   * wherever they normally do, then continue.
   */
  onUpload?(files: File[]): Promise<string[]>;
  className?: string;
}

export function MissingDocumentsView({ data, onSubmit, busy, onUpload, className }: MissingDocumentsViewProps) {
  const [notes, setNotes] = useState<Record<string, { ignored: boolean; instructions: string }>>(() =>
    seedAnnotations(data),
  );
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const docs = data.missing_documents ?? [];

  const annotations = (): DocumentAnnotation[] =>
    docs.map((doc, index) => ({
      document_type: String(doc.document_type ?? "other"),
      document_number: (doc.document_number as string) ?? null,
      slot_id: (doc.slot_id as string) ?? null,
      ignored: notes[slotKey(doc, index)]?.ignored ?? false,
      instructions: notes[slotKey(doc, index)]?.instructions || null,
    }));

  return (
    <section className={cx("lsc-panel", className)}>
      <header className="lsc-panel-head">
        <h2>Documents we still need</h2>
        {data.max_iterations ? (
          <span className="lsc-status-meta">
            Round {(data.iteration ?? 0) + 1} of {data.max_iterations}
          </span>
        ) : null}
      </header>
      {data.pause_message ? <p className="lsc-note">{data.pause_message}</p> : null}

      <ul className="lsc-list">
        {docs.map((doc, index) => {
          const key = slotKey(doc, index);
          const note = notes[key] ?? { ignored: false, instructions: "" };
          return (
            <li key={key} className={cx("lsc-item", note.ignored && "lsc-item-muted")}>
              <div className="lsc-item-head">
                <strong>{humanise(String(doc.document_type ?? "Document"))}</strong>
                {doc.document_number ? <code className="lsc-code">{String(doc.document_number)}</code> : null}
                {doc.criticality ? <span className="lsc-chip">{String(doc.criticality)}</span> : null}
              </div>
              {doc.reason ? <p className="lsc-item-body">{String(doc.reason)}</p> : null}
              <div className="lsc-item-actions">
                <label className="lsc-check">
                  <input
                    type="checkbox"
                    checked={note.ignored}
                    onChange={(event) => setNotes({ ...notes, [key]: { ...note, ignored: event.target.checked } })}
                  />
                  Not available, skip it
                </label>
                <input
                  className="lsc-input"
                  placeholder="Note for the analyst, optional"
                  value={note.instructions}
                  onChange={(event) => setNotes({ ...notes, [key]: { ...note, instructions: event.target.value } })}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {onUpload ? (
        <label className="lsc-upload">
          <input
            type="file"
            multiple
            disabled={uploading || busy}
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length === 0) return;
              setUploading(true);
              try {
                setUploaded([...uploaded, ...(await onUpload(files))]);
              } finally {
                setUploading(false);
                event.target.value = "";
              }
            }}
          />
          <span>{uploading ? "Uploading" : `Add documents${uploaded.length ? ` (${uploaded.length} added)` : ""}`}</span>
        </label>
      ) : null}

      <footer className="lsc-actions">
        <button
          type="button"
          className="lsc-btn lsc-btn-ghost"
          disabled={busy}
          onClick={() => onSubmit({ proceed_anyway: true, document_annotations: annotations() })}
        >
          Proceed without them
        </button>
        <button
          type="button"
          className="lsc-btn lsc-btn-primary"
          disabled={busy || (uploaded.length === 0 && !!onUpload)}
          onClick={() => onSubmit({ new_document_ids: uploaded, document_annotations: annotations() })}
        >
          {busy ? "Submitting" : "Continue"}
        </button>
      </footer>
    </section>
  );
}

// -- pause 2: document review -----------------------------------------------

export function DocumentReviewView({
  data,
  onSubmit,
  busy,
  className,
}: {
  data: DocumentReviewPayload;
  onSubmit(updates: FieldUpdate[], proceedToSearches?: boolean): void;
  busy?: boolean;
  className?: string;
}) {
  // Keyed "documentId::field" so an edit survives a re-render without a per-document state tree.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const fields = data.editable_fields ?? [];

  const updates = (): FieldUpdate[] =>
    Object.entries(edits).flatMap(([key, raw]) => {
      const separator = key.indexOf("::");
      const document_id = key.slice(0, separator);
      const field_name = key.slice(separator + 2);
      const original = data.documents.find((doc) => doc.document_id === document_id)?.[field_name];
      if (raw === display(original)) return [];
      // A field that arrived as a list goes back as a list. Sending the joined string would
      // turn three survey numbers into one.
      return [{ document_id, field_name, new_value: Array.isArray(original) ? splitList(raw) : raw }];
    });

  return (
    <section className={cx("lsc-panel", className)}>
      <header className="lsc-panel-head">
        <h2>Check what we read from your documents</h2>
        <span className="lsc-status-meta">{data.documents.length} documents</span>
      </header>
      {(data.duplicate_documents?.length ?? 0) > 0 ? (
        <p className="lsc-note lsc-note-warn">{data.duplicate_documents!.length} possible duplicates were detected.</p>
      ) : null}

      <div className="lsc-scroll">
        <table className="lsc-table">
          <thead>
            <tr>
              <th>Document</th>
              {fields.map((field) => (
                <th key={field}>{humanise(field)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.documents.map((doc) => (
              <tr key={doc.document_id}>
                <th scope="row">
                  <span className="lsc-doc-name">{doc.document_name ?? doc.document_id}</span>
                  {doc.document_type ? <span className="lsc-chip">{humanise(String(doc.document_type))}</span> : null}
                </th>
                {fields.map((field) => {
                  const key = `${doc.document_id}::${field}`;
                  const value = edits[key] ?? display(doc[field]);
                  return (
                    <td key={field}>
                      <input
                        className="lsc-input"
                        aria-label={`${humanise(field)} for ${doc.document_name ?? doc.document_id}`}
                        value={value}
                        onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="lsc-actions">
        <span className="lsc-status-meta">{updates().length} edits</span>
        <button type="button" className="lsc-btn lsc-btn-primary" disabled={busy} onClick={() => onSubmit(updates(), true)}>
          {busy ? "Submitting" : "Confirm and continue"}
        </button>
      </footer>
    </section>
  );
}

// -- pause 3: acknowledgements ----------------------------------------------

const SEVERITY_ORDER = ["Critical", "Major", "Minor"];

export function AcknowledgementsView({
  data,
  onSubmit,
  busy,
  className,
}: {
  data: AcknowledgementsPayload;
  onSubmit(answers: Record<string, { decision?: AckDecision; bypass_reason?: string | null }>): void;
  busy?: boolean;
  className?: string;
}) {
  const items = useMemo(() => sortBySeverity(ackItems(data)), [data]);
  const [answers, setAnswers] = useState<Record<string, { decision?: AckDecision; bypass_reason?: string | null }>>({});
  const answered = items.filter((item, index) => (answers[ackKey(item, index)]?.decision ?? item.decision) && (answers[ackKey(item, index)]?.decision ?? item.decision) !== "undecided").length;

  return (
    <section className={cx("lsc-panel", className)}>
      <header className="lsc-panel-head">
        <h2>Risks that need a decision</h2>
        <span className="lsc-status-meta">
          {answered} of {items.length} decided
        </span>
      </header>
      {data.pause_message ? <p className="lsc-note">{data.pause_message}</p> : null}

      <ul className="lsc-list">
        {items.map((item, index) => {
          const key = ackKey(item, index);
          const answer = answers[key] ?? { decision: item.decision, bypass_reason: item.bypass_reason };
          const set = (patch: Partial<typeof answer>) => setAnswers({ ...answers, [key]: { ...answer, ...patch } });
          return (
            <li key={key} className="lsc-item">
              <div className="lsc-item-head">
                <span className={`lsc-sev lsc-sev-${String(item.severity ?? "Minor").toLowerCase()}`}>
                  {item.severity ?? "Minor"}
                </span>
                {item.category ? <span className="lsc-chip">{item.category}</span> : null}
              </div>
              <p className="lsc-item-body">{item.statement}</p>

              {item.source_documents?.length ? (
                <p className="lsc-sources">
                  From: {item.source_documents.map((source) => source.document_name ?? source.filename ?? source.document_id).join(", ")}
                </p>
              ) : null}

              <div className="lsc-item-actions">
                {(["accepted", "rejected", "undecided"] as AckDecision[]).map((decision) => (
                  <label key={decision} className={cx("lsc-radio", answer.decision === decision && "lsc-radio-on")}>
                    <input
                      type="radio"
                      name={`ack-${key}`}
                      checked={answer.decision === decision}
                      onChange={() => set({ decision })}
                    />
                    {decision === "accepted" ? "Accept the risk" : decision === "rejected" ? "Not acceptable" : "Undecided"}
                  </label>
                ))}
              </div>

              {item.suggested_responses?.length ? (
                <div className="lsc-suggestions">
                  {item.suggested_responses.map((suggestion) => (
                    <button key={suggestion} type="button" className="lsc-chip lsc-chip-btn" onClick={() => set({ bypass_reason: suggestion })}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}

              <input
                className="lsc-input"
                placeholder="Reason, recorded on the report"
                value={answer.bypass_reason ?? ""}
                onChange={(event) => set({ bypass_reason: event.target.value })}
              />
            </li>
          );
        })}
      </ul>

      <footer className="lsc-actions">
        <button type="button" className="lsc-btn lsc-btn-primary" disabled={busy} onClick={() => onSubmit(answers)}>
          {busy ? "Submitting" : "Submit decisions"}
        </button>
      </footer>
    </section>
  );
}

// -- the finished report ----------------------------------------------------

export function CaseResultView({ result, className }: { result: CaseResult; className?: string }) {
  const score = result.property_score ?? {};
  const report = result.report ?? {};
  return (
    <section className={cx("lsc-panel", className)}>
      <header className="lsc-panel-head">
        <h2>Report</h2>
        {result.report_generated_at ? <span className="lsc-status-meta">{result.report_generated_at}</span> : null}
      </header>
      {Object.keys(score).length > 0 ? (
        <div className="lsc-score">
          {Object.entries(score)
            .filter(([, value]) => isScalar(value))
            .map(([label, value]) => (
              <div key={label} className="lsc-score-cell">
                <span className="lsc-score-value">{String(value)}</span>
                <span className="lsc-status-meta">{humanise(label)}</span>
              </div>
            ))}
        </div>
      ) : null}
      <Value value={report} />
    </section>
  );
}

/**
 * Renders whatever the report holds without knowing its schema: scalars as text, lists of
 * objects as tables, everything else as nested sections. A report gains sections over time
 * and a hard-coded renderer would quietly stop showing the new ones.
 */
function Value({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  if (isScalar(value)) return <p className="lsc-item-body">{String(value)}</p>;

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(isScalar)) {
      return (
        <ul className="lsc-bullets">
          {value.map((entry, index) => (
            <li key={index}>{String(entry)}</li>
          ))}
        </ul>
      );
    }
    const columns = Array.from(new Set(value.flatMap((row) => (isPlainObject(row) ? Object.keys(row) : [])))).filter(
      (column) => value.some((row) => isScalar(cellOf(row, column))),
    );
    return (
      <div className="lsc-scroll">
        <table className="lsc-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{humanise(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>{display(cellOf(row, column))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!isPlainObject(value)) return null;
  const Heading = (depth === 0 ? "h3" : "h4") as "h3" | "h4";
  return (
    <>
      {Object.entries(value).map(([key, child]) =>
        child === null || child === undefined || child === "" ? null : (
          <section key={key} className="lsc-section">
            <Heading className="lsc-section-title">{humanise(key)}</Heading>
            <Value value={child} depth={depth + 1} />
          </section>
        ),
      )}
    </>
  );
}

// -- helpers ----------------------------------------------------------------

function seedAnnotations(data: MissingDocumentsPayload) {
  const seeded: Record<string, { ignored: boolean; instructions: string }> = {};
  (data.missing_documents ?? []).forEach((doc, index) => {
    const saved = (data.missing_document_annotations ?? []).find(
      (annotation) => annotation.slot_id === doc.slot_id || annotation.document_type === doc.document_type,
    );
    seeded[slotKey(doc, index)] = { ignored: saved?.ignored ?? false, instructions: saved?.instructions ?? "" };
  });
  return seeded;
}

function slotKey(doc: { slot_id?: string | null; document_type?: unknown }, index: number): string {
  return String(doc.slot_id ?? `${doc.document_type ?? "doc"}#${index}`);
}

function sortBySeverity(items: AcknowledgementItem[]): AcknowledgementItem[] {
  return [...items].sort(
    (a, b) => rank(SEVERITY_ORDER.indexOf(String(a.severity))) - rank(SEVERITY_ORDER.indexOf(String(b.severity))),
  );
}

const rank = (index: number) => (index === -1 ? SEVERITY_ORDER.length : index);

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => (isScalar(entry) ? String(entry) : JSON.stringify(entry))).join(", ");
  if (isScalar(value)) return String(value);
  return JSON.stringify(value);
}

const splitList = (raw: string) => raw.split(",").map((part) => part.trim()).filter(Boolean);

const isScalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);

/** A report row is untyped JSON, so read a column off it only once it is known to be an object. */
const cellOf = (row: unknown, column: string): unknown => (isPlainObject(row) ? row[column] : undefined);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function humanise(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export { display, humanise };
