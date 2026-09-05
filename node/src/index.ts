/**
 * LegiScore partner SDK.
 *
 * ```ts
 * import { LegiScore } from "@legiscore/sdk";
 *
 * const client = new LegiScore({ apiKey: "lsk_..." });
 * const opened = await client.createReport({
 *   propertyFocus: "Sy. No. 123, Example Village, Telangana",
 *   files: ["sale-deed.pdf", "ec.pdf"],
 * });
 * const state = await client.waitForCase(opened.case_id);
 * ```
 *
 * Endpoints are grouped by module: `client.core`, `client.reports`, `client.search`,
 * `client.translate`, `client.extraction`, `client.webhooks`. Those methods are generated from the OpenAPI
 * spec; the helpers on the client itself collapse the multi-step flows.
 *
 * Nothing in this package imports a `node:` module at load time, so it runs unchanged on
 * Node 20+, Vercel Edge, Cloudflare Workers, Deno and Bun. Passing a file path to an upload is
 * the one exception: that branch needs a filesystem and loads `node:fs/promises` on demand.
 */
import {
  CoreOperations,
  ExtractionOperations,
  ReportsOperations,
  SearchOperations,
  TranslateOperations,
  WebhooksOperations,
} from "./operations.js";
import {
  DEFAULT_BASE_URL,
  LegiScoreError,
  Transport,
  contentTypeForFileName,
  resolveUploadFile,
  type RequestOptions,
  type TransportOptions,
  type UploadFile,
} from "./transport.js";

export { LegiScoreError, DEFAULT_BASE_URL };
export type { RequestOptions, TransportOptions, UploadFile };
export {
  verifyWebhook,
  InvalidSignature,
  EVENTS,
  DEFAULT_TOLERANCE_SECONDS,
  type WebhookEvent,
} from "./webhooks.js";

/** The public lifecycle vocabulary (PublicCaseState in the spec). */
export const CASE_STATES = ["queued", "running", "awaiting_review", "completed", "failed"] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** Nothing more happens without the partner: report ready, case failed, or paused for review. */
export const TERMINAL_CASE_STATES: ReadonlySet<string> = new Set([
  "awaiting_review",
  "completed",
  "failed",
]);

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_600_000;

export interface LegiScoreOptions extends TransportOptions {
  apiKey?: string;
}

export interface CreateReportOptions extends RequestOptions {
  /**
   * The property description object the API stores as `property_data`, e.g.
   * `{ address: "Sy. No. 123, Example Village, Telangana" }`. A plain string is accepted
   * and wrapped as `{ address }`, because that is the one field every caller sets and
   * sending a bare string would 422.
   */
  propertyFocus: string | Record<string, unknown>;
  files?: UploadFile[];
  documentIds?: string[];
  /** Anything else is passed straight through to the API. An unknown key is not an error. */
  [option: string]: unknown;
}

export class LegiScore {
  readonly core: CoreOperations;
  readonly reports: ReportsOperations;
  readonly search: SearchOperations;
  readonly translate: TranslateOperations;
  readonly extraction: ExtractionOperations;
  readonly webhooks: WebhooksOperations;
  private readonly transport: Transport;

  constructor(options: LegiScoreOptions = {}) {
    const { apiKey, ...transportOptions } = options;
    this.transport = new Transport(apiKey ?? readApiKeyFromEnvironment(), transportOptions);
    this.core = new CoreOperations(this.transport);
    this.reports = new ReportsOperations(this.transport);
    this.search = new SearchOperations(this.transport);
    this.translate = new TranslateOperations(this.transport);
    this.extraction = new ExtractionOperations(this.transport);
    this.webhooks = new WebhooksOperations(this.transport);
  }

  /**
   * Preflight. Prove the key reaches us and report what it can do.
   * Resolves rather than throwing, so a setup script can print the result.
   */
  async checkConnection(options: RequestOptions = {}): Promise<{
    ok: boolean;
    base_url: string;
    credits?: unknown;
    scenarios?: number | unknown;
    problem?: string;
    status?: number;
  }> {
    const baseUrl = this.transport.baseUrl;
    try {
      const credits = await this.core.getCredits(undefined, options);
      let scenarios: unknown = null;
      try {
        const listed = await this.core.listScenarios(undefined, options);
        scenarios = Array.isArray(listed) ? listed.length : listed;
      } catch {
        // Not fatal: the key works, this org just cannot list scenarios.
      }
      return { ok: true, base_url: baseUrl, credits, scenarios };
    } catch (error) {
      if (error instanceof LegiScoreError) {
        const problems: Record<number, string> = {
          401: "The API key was rejected. Check it starts with lsk_ and has not been revoked.",
          403: "The key is valid but its profile lacks a required permission.",
        };
        return {
          ok: false,
          base_url: baseUrl,
          status: error.status,
          problem: problems[error.status ?? 0] ?? `Could not reach the API: ${error.message}`,
        };
      }
      throw error;
    }
  }

  // -- multi-step flows ----------------------------------------------------
  // Each of these is several API calls the partner would otherwise sequence by hand.

  /**
   * Presign, PUT the bytes to storage, register the upload. Resolves to a documentId.
   *
   * `file` may be a path (Node, Deno and Bun only), a `Blob`/`File`, raw bytes, or
   * `{ data, fileName, contentType }`.
   */
  async uploadDocument(
    file: UploadFile,
    contentType?: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const resolved = await resolveUploadFile(file, contentType);
    const fileName = resolved.fileName;
    const resolvedType = contentType ?? resolved.contentType ?? contentTypeForFileName(fileName);

    // Presign under a uuid-prefixed name, so two documents uploaded under the same filename
    // get distinct object keys. The real filename goes to `complete`, and that is what the
    // case displays.
    const presigned = (await this.core.presignUpload(
      {
        fileName: `${globalThis.crypto.randomUUID().replace(/-/g, "")}-${fileName}`,
        fileSize: resolved.blob.size,
        contentType: resolvedType,
      },
      undefined,
      options,
    )) as { uploadUrl: string; objectName: string };

    await this.transport.putFile(presigned.uploadUrl, resolved.blob, resolvedType, options);

    const registered = (await this.core.completeUpload(
      {
        objectName: presigned.objectName,
        fileName,
        fileSize: resolved.blob.size,
        contentType: resolvedType,
      },
      undefined,
      options,
    )) as { document_id: string };
    return registered.document_id;
  }

  /**
   * Upload documents and open a case in one call. Extra keys pass through to
   * POST /api/requests — caseName, scenario_code, template_id, metadata, the review flags.
   */
  async createReport(options: CreateReportOptions): Promise<{ case_id: string } & Record<string, unknown>> {
    const { propertyFocus, files = [], documentIds = [], signal, ...rest } = options;
    const uploaded = [];
    for (const file of files) uploaded.push(await this.uploadDocument(file, undefined, { signal }));

    const allIds = [...documentIds, ...uploaded];
    if (allIds.length === 0) {
      throw new Error("A case needs at least one document: pass files or documentIds.");
    }
    const focus = typeof propertyFocus === "string" ? { address: propertyFocus } : propertyFocus;
    return (await this.reports.createCase(
      {
        propertyFocus: focus,
        documentIds: allIds,
        ...rest,
      },
      undefined,
      { signal },
    )) as { case_id: string } & Record<string, unknown>;
  }

  /**
   * Poll until the case finishes, fails, or pauses for review.
   * Polling is the fallback — configure a webhook and the transition is pushed to you.
   */
  async waitForCase(
    caseId: string,
    options: { pollIntervalMs?: number; timeoutMs?: number } & RequestOptions = {},
  ): Promise<{ state: CaseState } & Record<string, unknown>> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

    for (;;) {
      const status = (await this.reports.getCaseStatus(caseId, undefined, {
        signal: options.signal,
      })) as { state: CaseState } & Record<string, unknown>;
      if (TERMINAL_CASE_STATES.has(status.state)) return status;
      if (Date.now() >= deadline) {
        throw new LegiScoreError(`Case ${caseId} was still "${status.state}" when the wait timed out`, {
          body: status,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

/** `process` does not exist on every runtime this SDK supports, so read it defensively. */
function readApiKeyFromEnvironment(): string {
  if (typeof process === "undefined") return "";
  return process.env?.LEGISCORE_API_KEY ?? "";
}
