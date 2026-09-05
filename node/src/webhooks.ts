/**
 * Verify that a webhook really came from LegiScore.
 *
 * Getting this wrong is the most common integration bug we see, so the SDK does it.
 * `body` must be the RAW request bytes. Re-serialising parsed JSON changes the byte
 * string and every signature check then fails.
 *
 * The HMAC runs on Web Crypto, which every modern runtime has, so this works unchanged in a
 * Next.js Route Handler, on Vercel Edge, in a Cloudflare Worker, in Deno and in Bun.
 * `verifyWebhook` is async because `crypto.subtle` is.
 */

export const SIGNATURE_HEADER = "x-legiscore-signature";
export const TIMESTAMP_HEADER = "x-legiscore-timestamp";
export const EVENT_HEADER = "x-legiscore-event";
export const DELIVERY_HEADER = "x-legiscore-delivery";

/** The events a case can send. A pause event means the case is waiting on you. */
export const EVENTS = [
  "asset.created",
  "report.auto_triggered",
  "report.started",
  "report.paused.missing_documents",
  "report.paused.review",
  "report.paused.acknowledgements",
  "report.completed",
  "report.failed",
  // Legacy names the older dispatch path still emits.
  "case.paused",
  "case.completed",
] as const;

/** Every pause event starts with this, except the legacy name below. */
const PAUSE_EVENT_PREFIX = "report.paused.";
const LEGACY_PAUSE_EVENT = "case.paused";

/**
 * Replays older than this are rejected. Five minutes is generous for clock skew and still
 * short enough that a captured delivery cannot be resent tomorrow.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const MILLISECONDS_PER_SECOND = 1_000;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

/** The delivery did not come from LegiScore, or is too old to trust. */
export class InvalidSignature extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignature";
  }
}

export interface WebhookEvent {
  event: string;
  deliveryId: string;
  timestamp: number;
  caseId?: string;
  isPause: boolean;
  payload: Record<string, unknown>;
}

type HeaderSource = Record<string, string | string[] | undefined> | { get(name: string): string | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function header(headers: HeaderSource, name: string): string {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? "";
  }
  // Case-insensitive: every framework spells these differently.
  for (const [key, value] of Object.entries(headers as Record<string, string | string[]>)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? (value[0] ?? "") : String(value ?? "");
  }
  return "";
}

export async function verifyWebhook(
  body: Uint8Array | ArrayBuffer | string,
  headers: HeaderSource,
  options: { secret: string; toleranceSeconds?: number; now?: number },
): Promise<WebhookEvent> {
  const { secret, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = options;
  if (!secret) throw new InvalidSignature("No webhook secret configured");

  const raw = toBytes(body);
  const sent = header(headers, SIGNATURE_HEADER);
  const timestampHeader = header(headers, TIMESTAMP_HEADER);
  if (!sent || !timestampHeader) {
    throw new InvalidSignature("Delivery is missing its signature or timestamp header");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    throw new InvalidSignature(`Timestamp header is not a unix time: ${timestampHeader}`);
  }

  const nowSeconds = options.now ?? Date.now() / MILLISECONDS_PER_SECOND;
  const age = Math.abs(nowSeconds - timestamp);
  if (age > toleranceSeconds) {
    throw new InvalidSignature(
      `Delivery is ${Math.round(age)}s old, outside the ${toleranceSeconds}s window`,
    );
  }

  // Same construction as the sender: "<timestamp>." + raw body, HMAC-SHA256, hex, sha256= prefixed.
  const digest = await signHmacSha256(secret, concatBytes(encoder.encode(`${timestamp}.`), raw));
  const expected = encoder.encode(`sha256=${digest}`);
  const received = encoder.encode(sent);
  if (!equalsConstantTime(expected, received)) {
    throw new InvalidSignature("Signature does not match");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(raw));
  } catch (error) {
    throw new InvalidSignature(`Body is not valid JSON: ${String(error)}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvalidSignature("Body is not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  const event = header(headers, EVENT_HEADER) || String(record.event ?? "");
  const data = (record.data ?? {}) as Record<string, unknown>;
  return {
    event,
    deliveryId: header(headers, DELIVERY_HEADER) || String(record.delivery_id ?? ""),
    timestamp,
    caseId: (record.case_id ?? data.case_id) as string | undefined,
    isPause: event.startsWith(PAUSE_EVENT_PREFIX) || event === LEGACY_PAUSE_EVENT,
    payload: record,
  };
}

function toBytes(body: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function concatBytes(prefix: Uint8Array, rest: Uint8Array) {
  const joined = new Uint8Array(prefix.length + rest.length);
  joined.set(prefix, 0);
  joined.set(rest, prefix.length);
  return joined;
}

async function signHmacSha256(secret: string, payload: BufferSource): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, payload);
  return toHex(new Uint8Array(signature));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0");
  return hex;
}

/**
 * Compare with no early exit, so the time taken says nothing about how far the two digests
 * matched. Both operands are a fixed-length hex digest, so their length is public and testing
 * it first leaks nothing; the loop then runs the same number of iterations every time.
 */
function equalsConstantTime(expected: Uint8Array, received: Uint8Array): boolean {
  if (expected.length !== received.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected[index] ^ received[index];
  }
  return difference === 0;
}
