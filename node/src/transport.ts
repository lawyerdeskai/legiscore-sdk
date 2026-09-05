// HTTP transport: auth, retries, errors. Hand-written; the method surface is generated.
//
// Nothing here imports a `node:` module at load time. The one filesystem branch — an upload
// given as a path string — loads `node:fs/promises` through a dynamic import, so the module
// graph stays loadable on Vercel Edge, Cloudflare Workers, Deno, Bun and the browser.

export const DEFAULT_BASE_URL = "https://opinion.legiscore.in";

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

  constructor(message: string, options: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "LegiScoreError";
    this.status = options.status;
    this.body = options.body;
  }
}

/** Per-call knobs every generated method accepts. */
export interface RequestOptions {
  /** Cancel from the caller's side. Merged with the client's own timeout. */
  signal?: AbortSignal;
}

export interface TransportOptions {
  baseUrl?: string;
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
  readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(apiKey: string, options: TransportOptions = {}) {
    if (!apiKey) {
      throw new Error("An API key is required. Pass apiKey or set LEGISCORE_API_KEY.");
    }
    // `private` is erased at runtime, so console.log(client) or JSON.stringify(client) would
    // print the key. Non-enumerable keeps it out of both.
    Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false, writable: false });
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request(
    method: string,
    path: string,
    options: { body?: Record<string, unknown>; query?: Query } & RequestOptions = {},
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

  /** Send a file upload. `files` maps a field name to one or more documents. */
  async requestMultipart(
    method: string,
    path: string,
    files: Record<string, UploadFile | UploadFile[]> = {},
    form: Record<string, string | number | boolean> = {},
    options: RequestOptions = {},
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
    options: RequestOptions,
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
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

      rejectRedirect(response, url.pathname);
      if (retryOn.has(response.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, response.headers.get("Retry-After")));
        continue;
      }
      return unwrap(response, url.pathname);
    }
    throw new LegiScoreError(`Request to ${url.pathname} failed after retries: ${String(lastError)}`);
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
 * A 3xx is never a legitimate API response. `redirect: "manual"` hands it back as a 3xx on
 * Node, Bun and Deno and as an opaque status 0 in a browser; both mean the same thing here.
 */
function rejectRedirect(response: Response, path: string): void {
  const redirected =
    response.type === "opaqueredirect" ||
    (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX);
  if (!redirected) return;
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

async function unwrap(response: Response, path: string): Promise<unknown> {
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const payload: unknown = contentType.endsWith("json")
    ? await response.json().catch(() => undefined)
    : new Uint8Array(await response.arrayBuffer()); // ZIP downloads and other binaries

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? String((payload as { detail: unknown }).detail)
        : path;
    throw new LegiScoreError(`${response.status} ${response.statusText}: ${detail}`, {
      status: response.status,
      body: payload,
    });
  }
  return payload;
}
