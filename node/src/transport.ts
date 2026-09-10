// HTTP transport: auth, retries, errors. Hand-written; the method surface is generated.
//
// Nothing here imports a `node:` module at load time. The one filesystem branch — an upload
// given as a path string — loads `node:fs/promises` through a dynamic import, so the module
// graph stays loadable on Vercel Edge, Cloudflare Workers, Deno, Bun and the browser.

export const DEFAULT_BASE_URL = "https://opinion.legiscore.in";
/**
 * Search is a separate product on a separate host. The spec says so per path, so the generated
 * methods ask for this base by name rather than every caller having to know which is which.
 */
export const DEFAULT_SEARCH_BASE_URL = "https://legiscore.in";

/** Methods that change nothing server-side, so replaying one is free. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A read may replay on any of these. */
const READ_RETRY_STATUSES = new Set([429, 502, 503, 504]);
/**
 * A write with no `Idempotency-Key` may replay on 429 alone. 429 is the only status that says
 * the server refused the request instead of running it; on a 502 or a 504 the work may already
 * have happened, and replaying a credit-spending POST would charge for it twice.
 */
const UNKEYED_WRITE_RETRY_STATUSES = new Set([429]);
/**
 * The routes that accept an `Idempotency-Key`. The SDK generates one per call and reuses it
 * across that call's retries, so the server recognises a repeat as the same request.
 */
const IDEMPOTENT_WRITE_PATHS = new Set(["/api/requests", "/api/v1/uploads/complete"]);
/** Writes that create nothing server-side, so replaying one is as safe as replaying a read. */
const HARMLESS_WRITE_PATHS = new Set(["/api/v1/uploads/presign"]);
/** Rotating a secret issues a new one every time it runs, so a replay would strand the caller. */
const NEVER_RETRY_PATH_SUFFIX = "/rotate-secret";

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/** Uploads are large; give them room but never let one hang forever. */
const UPLOAD_TIMEOUT_MS = 300_000;

const RETRY_BASE_MS = 1_000;
const RETRY_AFTER_MAX_SECONDS = 60;
/** Backoff keeps at least half its slot and jitters the rest, so throttled clients spread out. */
const JITTER_FLOOR = 0.5;

const MILLISECONDS_PER_SECOND = 1_000;

/** Hosts allowed to speak plain HTTP: only a developer's own machine. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * A LegiScore API call failed. `status` and `body` let callers branch on the reason.
 *
 * The API key and the request headers are never attached to an error. `body` is the API's own
 * response, which on a case route contains property, borrower and document details — log
 * `error.status` and `error.message`, not `error.body` raw.
 */
export class LegiScoreError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  /**
   * The API's own error code when it sent one, e.g. `insufficient_credits`. Stable, and the
   * thing to branch on: `message` is written for a person and may be reworded.
   */
  readonly code?: string;

  constructor(message: string, options: { status?: number; body?: unknown; code?: string } = {}) {
    super(message);
    this.name = "LegiScoreError";
    this.status = options.status;
    this.body = options.body;
    this.code = options.code;
  }
}

/** Per-call knobs every generated method accepts. */
export interface RequestOptions {
  /** Cancel from the caller's side. Merged with the client's own timeout. */
  signal?: AbortSignal;
}

/**
 * Which host to send to. Generated methods set it from the spec; callers never pass it.
 * An unknown name falls back to `baseUrl` rather than throwing, so an older client paired
 * with a newer spec still reaches something.
 */
interface BaseSelector {
  base?: string;
}

/** Internal. Set only by `requestDownload`, for the one route that answers with a redirect. */
interface RedirectOption {
  allowRedirect?: boolean;
}

export interface TransportOptions {
  baseUrl?: string;
  /** Override the host the search module talks to. Same https-or-localhost rule as baseUrl. */
  searchBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Use a different `fetch` — a Next.js patched fetch with caching or revalidation semantics,
   * an instrumented one, or a stub in tests. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}

/** Extension -> MIME type. Anything else is sent as `application/octet-stream`. */
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  // assistSearch accepts webp and rejects application/octet-stream, so guessing wrong here
  // turns a valid upload into a 400 the caller cannot see the cause of.
  ".webp": "image/webp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const UNNAMED_UPLOAD = "upload";

/** Registering a .docx as a PDF corrupts what the case thinks it holds, so guess by extension. */
export function contentTypeForFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const known = dot === -1 ? undefined : CONTENT_TYPES[fileName.slice(dot).toLowerCase()];
  return known ?? DEFAULT_CONTENT_TYPE;
}

/**
 * A document to upload. A `string` is a filesystem path and works on Node, Deno and Bun only;
 * every other form works everywhere, including Edge runtimes and the browser.
 */
export type UploadFile =
  | string
  | Blob
  | Uint8Array
  | ArrayBuffer
  | { data: Blob | Uint8Array | ArrayBuffer; fileName?: string; contentType?: string };

export interface ResolvedUpload {
  blob: Blob;
  fileName: string;
  contentType: string;
}

/**
 * Re-view bytes as an ArrayBuffer-backed array. Node's `Buffer` and any view whose backing store
 * the compiler cannot prove is unshared are rejected by the DOM `BufferSource` type even though
 * both are valid request bodies at runtime. This shares the same memory rather than copying,
 * which matters: a scanned title deed runs to tens of megabytes.
 */
function asBlobPart(data: Uint8Array | ArrayBuffer): BlobPart {
  if (data instanceof ArrayBuffer) return data;
  return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

/** Turn any accepted upload form into bytes, a name and a MIME type. */
export async function resolveUploadFile(
  file: UploadFile,
  contentTypeOverride?: string,
): Promise<ResolvedUpload> {
  if (typeof file === "string") {
    // A filesystem path only means something on a runtime that has one, so the node: modules
    // load here and nowhere else. A static import would break the Edge and browser bundles.
    const [{ readFile }, { basename }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const bytes = await readFile(file);
    const fileName = basename(file);
    const contentType = contentTypeOverride ?? contentTypeForFileName(fileName);
    return { blob: new Blob([asBlobPart(bytes)], { type: contentType }), fileName, contentType };
  }

  if (file instanceof Blob) {
    const fileName = (file as Blob & { name?: string }).name ?? UNNAMED_UPLOAD;
    const contentType = contentTypeOverride ?? file.type ?? "";
    const resolved = contentType || contentTypeForFileName(fileName);
    return {
      blob: file.type === resolved ? file : new Blob([file], { type: resolved }),
      fileName,
      contentType: resolved,
    };
  }

  if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
    const contentType = contentTypeOverride ?? DEFAULT_CONTENT_TYPE;
    return {
      blob: new Blob([asBlobPart(file)], { type: contentType }),
      fileName: UNNAMED_UPLOAD,
      contentType,
    };
  }

  const fileName = file.fileName ?? UNNAMED_UPLOAD;
  const contentType = contentTypeOverride ?? file.contentType ?? contentTypeForFileName(fileName);
  const { blob } = await resolveUploadFile(file.data, contentType);
  return { blob, fileName, contentType };
}

export class Transport {
  private readonly apiKey!: string;
  readonly baseUrl: string;
  /** Where the search module is sent. Exposed so a caller can print what it is talking to. */
  readonly searchBaseUrl: string;
  readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** Per-module host overrides, keyed by the name the generated methods ask for. */
  private readonly moduleBaseUrls: Record<string, string>;

  constructor(apiKey: string, options: TransportOptions = {}) {
    if (!apiKey) {
      throw new Error("An API key is required. Pass apiKey or set LEGISCORE_API_KEY.");
    }
    // `private` is erased at runtime, so console.log(client) or JSON.stringify(client) would
    // print the key. Non-enumerable keeps it out of both.
    Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false, writable: false });
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.searchBaseUrl = normalizeBaseUrl(options.searchBaseUrl ?? DEFAULT_SEARCH_BASE_URL);
    this.moduleBaseUrls = { search: this.searchBaseUrl };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private baseFor(base?: string): string {
    return (base ? this.moduleBaseUrls[base] : undefined) ?? this.baseUrl;
  }

  async request(
    method: string,
    path: string,
    options: {
      body?: Record<string, unknown>;
      query?: Query;
    } & BaseSelector &
      RequestOptions = {},
  ): Promise<unknown> {
    return this.send(
      method,
      path,
      options.query,
      {
        headers: options.body ? { "Content-Type": "application/json" } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
      options,
    );
  }

  /**
   * Fetch a file the API hands over by redirect, and resolve to its bytes.
   *
   * The route answers 302 with a short-lived signed URL. Following that on this request would
   * put `X-API-Key` on the wire to a storage host — fetch forwards custom headers across a
   * cross-origin redirect even though it drops `Authorization` — so the redirect is read here
   * and the signed URL is fetched on a second request that carries no key at all.
   */
  async requestDownload(
    method: string,
    path: string,
    options: { query?: Query } & BaseSelector & RequestOptions = {},
  ): Promise<unknown> {
    return this.send(method, path, options.query, {}, { ...options, allowRedirect: true });
  }

  /** Send a file upload. `files` maps a field name to one or more documents. */
  async requestMultipart(
    method: string,
    path: string,
    files: Record<string, UploadFile | UploadFile[]> = {},
    form: Record<string, string | number | boolean> = {},
    options: BaseSelector & RequestOptions = {},
  ): Promise<unknown> {
    const payload = new FormData();

    for (const [field, value] of Object.entries(files)) {
      for (const file of Array.isArray(value) ? value : [value]) {
        const resolved = await resolveUploadFile(file);
        payload.append(field, resolved.blob, resolved.fileName);
      }
    }
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined) payload.append(key, String(value));
    }
    // No Content-Type header: fetch sets the multipart boundary itself.
    return this.send(method, path, undefined, { body: payload }, options);
  }

  private async send(
    method: string,
    path: string,
    query: Query | undefined,
    init: { headers?: Record<string, string>; body?: BodyInit },
    options: BaseSelector & RedirectOption & RequestOptions,
  ): Promise<unknown> {
    const url = new URL(this.baseFor(options.base) + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const route = path.split("?")[0];
    const writes = !SAFE_METHODS.has(method.toUpperCase());
    const harmless = HARMLESS_WRITE_PATHS.has(route);
    const extraHeaders: Record<string, string> = {};
    if (writes && IDEMPOTENT_WRITE_PATHS.has(route)) {
      extraHeaders["Idempotency-Key"] = globalThis.crypto.randomUUID().replace(/-/g, "");
    }
    // A read, a write that creates nothing, and a write the server can recognise as a repeat
    // are all replayable. Everything else replays only when the server said it never ran.
    const keyed = extraHeaders["Idempotency-Key"] !== undefined;
    const retryOn = !writes || harmless || keyed ? READ_RETRY_STATUSES : UNKEYED_WRITE_RETRY_STATUSES;
    const maxRetries = route.endsWith(NEVER_RETRY_PATH_SUFFIX) ? 0 : this.maxRetries;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            "X-API-Key": this.apiKey,
            Accept: "application/json",
            ...extraHeaders,
            ...(init.headers ?? {}),
          },
          body: init.body,
          // The API never redirects. Following one would forward X-API-Key to wherever the
          // Location header points, which is how a key leaves the partner's control.
          redirect: "manual",
          signal: combineSignals(this.timeoutMs, options.signal),
        });
      } catch (error) {
        lastError = error;
        // A timeout or reset may mean the write landed and only the reply was lost.
        if (attempt === maxRetries || (writes && !harmless)) {
          throw new LegiScoreError(`Could not reach ${url.pathname}: ${String(error)}`);
        }
        await sleep(backoffMs(attempt, null));
        continue;
      }

      const location = readRedirect(response, url.pathname, options.allowRedirect === true);
      if (location !== null) return this.fetchSignedUrl(url, location, options);
      if (retryOn.has(response.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, response.headers.get("Retry-After")));
        continue;
      }
      return unwrap(response, url.pathname);
    }
    throw new LegiScoreError(`Request to ${url.pathname} failed after retries: ${String(lastError)}`);
  }

  /**
   * GET a signed URL the API redirected us to. No API key on this request: the URL carries its
   * own auth, and the host on the other end is not ours to hand a credential to.
   */
  private async fetchSignedUrl(
    from: URL,
    location: string,
    options: RequestOptions,
  ): Promise<Uint8Array> {
    const target = resolveSignedUrl(from, location);
    const response = await this.fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      // A document can be tens of megabytes, so give it the upload budget rather than the
      // ordinary one, and never less than the client's own timeout.
      signal: combineSignals(Math.max(this.timeoutMs, UPLOAD_TIMEOUT_MS), options.signal),
    });
    rejectRedirect(response, from.pathname);
    if (!response.ok) {
      throw new LegiScoreError(`Downloading ${from.pathname} failed: ${response.status}`, {
        status: response.status,
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** PUT bytes straight to presigned storage. No API key: the URL carries its own auth. */
  async putFile(
    uploadUrl: string,
    data: Blob | Uint8Array | ArrayBuffer,
    contentType: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const response = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: data instanceof Blob ? data : asBlobPart(data),
      redirect: "manual",
      signal: combineSignals(Math.max(this.timeoutMs, UPLOAD_TIMEOUT_MS), options.signal),
    });
    rejectRedirect(response, uploadUrl);
    if (!response.ok) {
      throw new LegiScoreError(`Upload to storage failed: ${response.status}`, {
        status: response.status,
        body: await response.text().catch(() => undefined),
      });
    }
  }
}

/**
 * The key travels in a header, so plain HTTP would put it on the wire in the clear. Only a
 * developer pointing at their own machine has a reason to use anything but https.
 */
function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && !LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `baseUrl must use https (or point at localhost): ${parsed.protocol}//${parsed.hostname}`,
    );
  }
  return parsed.href.replace(/\/$/, "");
}

/**
 * Where a redirect points, or null when the response is not one.
 *
 * Outside the one download route a 3xx is never a legitimate API response, so it throws unless
 * the caller asked for it. `redirect: "manual"` hands a redirect back as a 3xx on Node, Bun and
 * Deno and as an opaque status 0 in a browser; the opaque form exposes no headers at all, which
 * is why a browser cannot complete this download.
 */
function readRedirect(response: Response, path: string, allowed: boolean): string | null {
  if (!isRedirect(response)) return null;
  if (!allowed) {
    rejectRedirect(response, path);
    return null;
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new LegiScoreError(
      `${path} redirected to a location this runtime will not expose. Downloads need a runtime ` +
        "that can read a manual redirect's Location header, which a browser cannot.",
      { status: response.status },
    );
  }
  return location;
}

/** The absolute target of a redirect, refused unless it is encrypted. */
function resolveSignedUrl(from: URL, location: string): string {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new LegiScoreError(`${from.pathname} redirected to something that is not a URL.`);
  }
  if (target.protocol !== "https:" && !LOCAL_HOSTNAMES.has(target.hostname)) {
    throw new LegiScoreError(
      `${from.pathname} redirected to ${target.protocol}//${target.hostname}, which is not https.`,
    );
  }
  return target.toString();
}

function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX)
  );
}

/**
 * A 3xx is never a legitimate API response. `redirect: "manual"` hands it back as a 3xx on
 * Node, Bun and Deno and as an opaque status 0 in a browser; both mean the same thing here.
 */
function rejectRedirect(response: Response, path: string): void {
  if (!isRedirect(response)) return;
  throw new LegiScoreError(
    `${path} answered with a redirect (${response.status}); the LegiScore API never redirects. ` +
      "Check baseUrl.",
    { status: response.status },
  );
}

/** Merge the caller's cancellation with the client timeout, so either one aborts the call. */
function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

// The server's own pacing wins when it sends one; the key rate limit is per minute.
function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = parseRetryAfterSeconds(retryAfter);
  if (seconds !== null) {
    const clamped = Math.min(Math.max(seconds, 0), RETRY_AFTER_MAX_SECONDS);
    return clamped * MILLISECONDS_PER_SECOND;
  }
  // Jitter, so a fleet throttled by the same 429 does not come back in lockstep.
  return 2 ** attempt * RETRY_BASE_MS * (JITTER_FLOOR + Math.random() * JITTER_FLOOR);
}

/** RFC 9110 allows Retry-After as either a delay in seconds or an HTTP-date. */
function parseRetryAfterSeconds(retryAfter: string | null): number | null {
  if (retryAfter === null) return null;
  const value = retryAfter.trim();
  if (value === "") return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;

  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return (when - Date.now()) / MILLISECONDS_PER_SECOND;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull a code and a human message out of a failure body, whichever shape it arrived in.
 *
 * Four shapes are in use: `{ detail: "<sentence>" }` and `{ detail: { code, ... } }` from the
 * report modules, `{ detail: [ ... ] }` when a field fails validation, and
 * `{ error: { code, message } }` from search. A top-level `code` is read as well, so a
 * problem+json body is not lost.
 *
 * The object form is why this is not a one-liner. Stringifying it yields `"[object Object]"`,
 * which drops the code callers are told to branch on and leaves nothing readable behind. The
 * code is lifted into `LegiScoreError.code`; the reasons stay on `.body` rather than going into
 * the message, because the message is the part that gets logged and the reasons name documents
 * and risks on the case.
 */
function readFailure(payload: unknown): { code?: string; detail?: string } {
  if (!payload || typeof payload !== "object") return {};
  const body = payload as { detail?: unknown; code?: unknown; error?: unknown };

  const nested = body.error;
  if (nested && typeof nested === "object") {
    const { code, message } = nested as { code?: unknown; message?: unknown };
    return {
      code: typeof code === "string" ? code : undefined,
      detail: typeof message === "string" ? message : undefined,
    };
  }

  const detail = body.detail;
  if (Array.isArray(detail)) {
    const count = detail.length;
    return {
      code: typeof body.code === "string" ? body.code : undefined,
      detail: `${count} field${count === 1 ? "" : "s"} were rejected; the list is on error.body`,
    };
  }

  if (detail && typeof detail === "object") {
    const { code, stage } = detail as { code?: unknown; stage?: unknown };
    if (typeof code === "string") {
      const where = typeof stage === "string" && stage ? ` at the ${stage} checkpoint` : "";
      return { code, detail: `${code}${where}; the reasons are on error.body` };
    }
    return { code: typeof body.code === "string" ? body.code : undefined };
  }

  return {
    code: typeof body.code === "string" ? body.code : undefined,
    detail: detail === undefined ? undefined : String(detail),
  };
}

async function unwrap(response: Response, path: string): Promise<unknown> {
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const payload: unknown = contentType.endsWith("json")
    ? await response.json().catch(() => undefined)
    : new Uint8Array(await response.arrayBuffer()); // ZIP downloads and other binaries

  if (!response.ok) {
    const { code, detail } = readFailure(payload);
    throw new LegiScoreError(`${response.status} ${response.statusText}: ${detail ?? path}`, {
      status: response.status,
      body: payload,
      code,
    });
  }
  return payload;
}
