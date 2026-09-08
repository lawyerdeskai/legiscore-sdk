// Self-check for the hand-written parts: transport retries, errors, multi-step flows.
//   npm test   (tsc, then node --test dist/test/)
// No network — a stub fetch answers the calls.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LegiScore } from "../src/index.js";
import { LegiScoreError, Transport } from "../src/transport.js";

const API_KEY = "lsk_fake_0000000000000000000000000000";

type Reply = { status?: number; json?: unknown; body?: Uint8Array; headers?: Record<string, string> };

/** Records every call and replays scripted replies, so tests assert on the call sequence. */
function stubFetch(replies: Reply[] | ((url: string) => Reply)) {
  const calls: { url: string; method: string; body?: string }[] = [];
  let index = 0;
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    const target = url.toString();
    calls.push({ url: target, method: init.method ?? "GET", body: init.body as string | undefined });
    const reply = typeof replies === "function" ? replies(target) : replies[Math.min(index++, replies.length - 1)];
    const isJson = reply.json !== undefined;
    const payload = (isJson ? JSON.stringify(reply.json) : (reply.body ?? new Uint8Array())) as BodyInit;
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: {
        "content-type": isJson ? "application/json" : "application/zip",
        ...(reply.headers ?? {}),
      },
    });
  };
  return { calls, impl: impl as unknown as typeof globalThis.fetch };
}

function client(fetchImpl: typeof globalThis.fetch, maxRetries = 3) {
  return new LegiScore({ apiKey: API_KEY, fetch: fetchImpl, maxRetries });
}

test("an empty API key is rejected before any request goes out", () => {
  assert.throws(() => new Transport(""), /API key is required/);
});

test("a plaintext baseUrl is refused, and localhost is allowed", () => {
  // The key travels in a header, so http:// would put it on the wire in the clear.
  assert.throws(() => new Transport(API_KEY, { baseUrl: "http://opinion.legiscore.in" }), /https/);
  assert.throws(() => new Transport(API_KEY, { baseUrl: "not-a-url" }), /valid URL/);
  assert.equal(new Transport(API_KEY, { baseUrl: "http://localhost:8000" }).baseUrl, "http://localhost:8000");
  assert.equal(
    new Transport(API_KEY, { baseUrl: "https://opinion.legiscore.in/" }).baseUrl,
    "https://opinion.legiscore.in",
  );
});

test("the key and the path reach the server", async () => {
  const { calls, impl } = stubFetch([{ json: { state: "queued" } }]);
  await client(impl).reports.getCaseStatus("RPT-2026-ABC12345");
  assert.equal(calls[0].url, "https://opinion.legiscore.in/api/cases/RPT-2026-ABC12345/status");
});

test("redirects are never followed", async () => {
  // Following one would forward X-API-Key to whatever the Location header names.
  let redirectMode = "";
  const impl = (async (_url: string, init: RequestInit = {}) => {
    redirectMode = String(init.redirect ?? "");
    return new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } });
  }) as unknown as typeof globalThis.fetch;

  await assert.rejects(client(impl).reports.getCaseStatus("RPT-1"), /redirect/);
  assert.equal(redirectMode, "manual");
});

test("a failure carries its status and body", async () => {
  const { impl } = stubFetch([{ status: 402, json: { detail: "insufficient credits" } }]);
  await assert.rejects(client(impl).reports.getCaseStatus("RPT-1"), (error: LegiScoreError) => {
    assert.equal(error.status, 402);
    assert.deepEqual(error.body, { detail: "insufficient credits" });
    return true;
  });
});

test("an error never carries the API key or the request headers", async () => {
  const { impl } = stubFetch([{ status: 401, json: { detail: "rejected" } }]);
  await assert.rejects(client(impl).reports.getCaseStatus("RPT-1"), (error: LegiScoreError) => {
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(API_KEY));
    return true;
  });
});

test("a rate limit is retried, then succeeds", async () => {
  const { calls, impl } = stubFetch([
    { status: 429, json: { detail: "slow down" }, headers: { "Retry-After": "0" } },
    { status: 429, json: { detail: "slow down" }, headers: { "Retry-After": "0" } },
    { json: { state: "completed" } },
  ]);
  const status = (await client(impl).reports.getCaseStatus("RPT-1")) as { state: string };
  assert.equal(calls.length, 3);
  assert.equal(status.state, "completed");
});

test("exhausted retries still raise", async () => {
  const { impl } = stubFetch([{ status: 503, json: { detail: "down" }, headers: { "Retry-After": "0" } }]);
  await assert.rejects(client(impl, 1).reports.getCaseStatus("RPT-1"), /503/);
});

test("a ZIP download is not parsed as JSON", async () => {
  const { impl } = stubFetch([{ body: new Uint8Array([80, 75, 3, 4]) }]);
  const payload = await client(impl).reports.downloadCaseFilesZip("RPT-1");
  assert.deepEqual(payload, new Uint8Array([80, 75, 3, 4]));
});

test("uploadDocument runs presign, PUT, complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legiscore-"));
  const file = join(directory, "sale-deed.pdf");
  await writeFile(file, "%PDF-1.4 sample");

  const { calls, impl } = stubFetch((url) =>
    url.endsWith("/presign")
      ? { json: { uploadUrl: "https://storage.example/put", objectName: "org/abc.pdf" } }
      : { json: { document_id: "doc-42" } },
  );

  const documentId = await client(impl).uploadDocument(file);
  assert.equal(documentId, "doc-42");
  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    ["POST /api/v1/uploads/presign", "PUT /put", "POST /api/v1/uploads/complete"],
  );
});

test("uploadDocument accepts bytes and a Blob, not just a path", async () => {
  // Edge runtimes have no filesystem, so the byte forms are the ones that work everywhere.
  const sent: Record<string, unknown>[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const target = url.toString();
    if (init.body && typeof init.body === "string") sent.push(JSON.parse(init.body));
    const json = target.endsWith("/presign")
      ? { uploadUrl: "https://storage.example/put", objectName: "org/abc.pdf" }
      : { document_id: "doc-7" };
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;

  const bytes = new TextEncoder().encode("%PDF-1.4 sample");
  assert.equal(await client(impl).uploadDocument({ data: bytes, fileName: "ec.pdf" }), "doc-7");
  assert.equal(await client(impl).uploadDocument(new Blob([bytes], { type: "application/pdf" })), "doc-7");

  const presigned = sent.filter((body) => "fileSize" in body && "contentType" in body);
  assert.ok(presigned.length > 0);
  assert.equal(presigned[0].contentType, "application/pdf");
});

test("an unknown extension is sent as octet-stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legiscore-"));
  const file = join(directory, "scan.xyz");
  await writeFile(file, "bytes");

  const types: string[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    if (url.toString().endsWith("/presign")) {
      types.push(String((JSON.parse(init.body as string) as { contentType: string }).contentType));
      return new Response(JSON.stringify({ uploadUrl: "https://storage.example/put", objectName: "o" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ document_id: "doc-1" }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  await client(impl).uploadDocument(file);
  assert.deepEqual(types, ["application/octet-stream"]);
});

test("a case with no documents is rejected client-side", async () => {
  const { calls, impl } = stubFetch([{ json: {} }]);
  await assert.rejects(client(impl).createReport({ propertyFocus: "Sy. No. 123" }), /at least one document/);
  assert.equal(calls.length, 0);
});

test("an aborted signal cancels the call", async () => {
  const controller = new AbortController();
  const impl = (async (_url: string, init: RequestInit = {}) => {
    controller.abort();
    init.signal?.throwIfAborted();
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    client(impl, 0).reports.getCaseStatus("RPT-1", undefined, { signal: controller.signal }),
    /Could not reach/,
  );
});

test("waitForCase stops when the case pauses for review", async () => {
  const states = ["queued", "running", "awaiting_review"];
  let index = 0;
  const { impl } = stubFetch(() => ({ json: { state: states[index++] ?? "awaiting_review" } }));
  const status = await client(impl).waitForCase("RPT-1", { pollIntervalMs: 0 });
  assert.equal(status.state, "awaiting_review");
});

test("a case that never settles times out", async () => {
  const { impl } = stubFetch(() => ({ json: { state: "running" } }));
  await assert.rejects(
    client(impl).waitForCase("RPT-1", { pollIntervalMs: 0, timeoutMs: 0 }),
    /still "running"/,
  );
});

test("a multipart call sends the file and the form fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legiscore-"));
  const file = join(directory, "sale-deed.pdf");
  await writeFile(file, "%PDF-1.4 sample");

  let contentType = "";
  let body: FormData | undefined;
  const impl = (async (_url: string, init: RequestInit = {}) => {
    contentType = String((init.headers as Record<string, string>)["Content-Type"] ?? "");
    body = init.body as FormData;
    return new Response(JSON.stringify({ session_id: "t-1" }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  await client(impl).translate.translateDocx({ file }, { target_lang: "hi" });
  assert.equal(contentType, "", "fetch must set the multipart boundary itself");
  assert.equal((body?.get("file") as File).name, "sale-deed.pdf");
  assert.equal(body?.get("target_lang"), "hi");
});

test("a string propertyFocus is wrapped into the object the API wants", async () => {
  let sent: Record<string, unknown> = {};
  const { impl } = stubFetch(() => ({ json: { case_id: "RPT-1" } }));
  const wrapped = (async (url: string | URL, init: RequestInit = {}) => {
    if (url.toString().endsWith("/api/requests")) sent = JSON.parse(init.body as string);
    return impl(url, init);
  }) as unknown as typeof globalThis.fetch;

  await client(wrapped).createReport({ propertyFocus: "Sy. No. 123", documentIds: ["doc-1"] });
  assert.deepEqual(sent.propertyFocus, { address: "Sy. No. 123" });
});

/** Records headers as well as URLs, for the idempotency checks below. */
function recordingFetch(reply: (url: string, n: number) => { status?: number; json?: unknown }) {
  const calls: { url: string; key: string }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: url.toString(), key: headers["Idempotency-Key"] ?? "" });
    const r = reply(url.toString(), calls.length);
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", "Retry-After": "0" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

test("a write with no idempotency key is not replayed on a lost response", async () => {
  // A 504 on a search submit may mean the search WAS started. Replaying would start a second.
  const { calls, impl } = recordingFetch(() => ({ status: 504, json: { detail: "gateway timeout" } }));
  await assert.rejects(
    client(impl).search.submitSearch({ state: "telangana", search_type: "ec", params: {} }),
    /504/,
  );
  assert.equal(calls.length, 1, "a write with no idempotency key must not be replayed");
});

test("a write with no idempotency key is not replayed on a 502 either", async () => {
  // A 502 does not prove the server refused the work, so replaying could charge twice.
  const { calls, impl } = recordingFetch(() => ({ status: 502, json: { detail: "bad gateway" } }));
  await assert.rejects(
    client(impl).search.submitSearch({ state: "telangana", search_type: "ec", params: {} }),
    /502/,
  );
  assert.equal(calls.length, 1);
});

test("case creation carries an idempotency key and reuses it across retries", async () => {
  const { calls, impl } = recordingFetch((_url, n) =>
    n < 3 ? { status: 503, json: { detail: "unavailable" } } : { json: { case_id: "RPT-1" } },
  );
  const result = (await client(impl).reports.createCase({
    propertyFocus: {},
    documentIds: ["d"],
  })) as { case_id: string };

  assert.equal(result.case_id, "RPT-1");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.key.length > 0), "every attempt must carry an Idempotency-Key");
  assert.equal(new Set(calls.map((c) => c.key)).size, 1, "retries must reuse one key");
});

test("a 504 on case creation is replayed under the same idempotency key", async () => {
  // The route honours the key, so the server recognises the repeat instead of billing again.
  const { calls, impl } = recordingFetch((_url, n) =>
    n < 2 ? { status: 504, json: { detail: "gateway timeout" } } : { json: { case_id: "RPT-1" } },
  );
  const result = (await client(impl).reports.createCase({
    propertyFocus: {},
    documentIds: ["d"],
  })) as { case_id: string };
  assert.equal(result.case_id, "RPT-1");
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((c) => c.key)).size, 1);
});

test("rotating a webhook secret is never retried", async () => {
  // Each run issues a new secret, so a replay would hand back one the partner never saw.
  const { calls, impl } = recordingFetch(() => ({ status: 429, json: { detail: "slow down" } }));
  await assert.rejects(client(impl).webhooks.rotateWebhookSecret("wh-1"), /429/);
  assert.equal(calls.length, 1);
});

test("an error rendered as application/problem+json is parsed, not returned as bytes", async () => {
  const impl = (async () =>
    new Response(JSON.stringify({ code: "insufficient_credits", detail: "no credits" }), {
      status: 402,
      headers: { "content-type": "application/problem+json" },
    })) as unknown as typeof globalThis.fetch;

  await assert.rejects(client(impl).reports.getCaseStatus("RPT-1"), (error: LegiScoreError) => {
    assert.equal(error.status, 402);
    assert.deepEqual(error.body, { code: "insufficient_credits", detail: "no credits" });
    assert.match(error.message, /no credits/);
    return true;
  });
});

test("a rate limited write is still replayed", async () => {
  // 429 means it never ran, so replaying is safe even without an idempotency key.
  const { calls, impl } = recordingFetch((_url, n) =>
    n < 2 ? { status: 429, json: { detail: "slow down" } } : { json: { ok: true } },
  );
  await client(impl).search.submitSearch({ state: "telangana", search_type: "ec", params: {} });
  assert.equal(calls.length, 2);
});

// -- the search module, which is a separate product on a separate host --------------

test("a search goes to the search host, not the reports host, and carries the key", async () => {
  let seenKey = "";
  const { calls, impl } = stubFetch([{ status: 202, json: { data: { searches: [] } } }]);
  const recording = (async (url: string | URL, init: RequestInit = {}) => {
    seenKey = String((init.headers as Record<string, string>)["X-API-Key"] ?? "");
    return impl(url, init);
  }) as unknown as typeof globalThis.fetch;

  await client(recording).search.submitSearch({
    state: "andhra",
    search_type: "ec",
    params: { sro: "1" },
  });

  assert.equal(calls[0].url, "https://legiscore.in/api/v1/search");
  assert.equal(seenKey, API_KEY);
});

test("a report call still goes to the reports host", async () => {
  // The override is per operation, so adding one host must not move the other module.
  const { calls, impl } = stubFetch([{ json: { state: "queued" } }]);
  await client(impl).reports.getCaseStatus("RPT-1");
  assert.ok(calls[0].url.startsWith("https://opinion.legiscore.in/"), calls[0].url);
});

test("searchBaseUrl is overridable and validated like baseUrl", async () => {
  assert.throws(() => new Transport(API_KEY, { searchBaseUrl: "http://legiscore.in" }), /https/);
  assert.equal(
    new Transport(API_KEY, { searchBaseUrl: "https://staging.example/" }).searchBaseUrl,
    "https://staging.example",
  );

  const { calls, impl } = stubFetch([{ status: 202, json: { data: {} } }]);
  const custom = new LegiScore({
    apiKey: API_KEY,
    fetch: impl,
    searchBaseUrl: "http://localhost:3000",
  });
  await custom.search.getSearchCatalog();
  assert.equal(calls[0].url, "http://localhost:3000/api/v1/search/catalog");
});

test("a 402 from search carries the code, not just the status", async () => {
  // Search fails as { error: { code, message } }; the reports modules fail as { detail }.
  // Both have to reach the caller as one error type with a code worth branching on.
  const { impl } = stubFetch([
    {
      status: 402,
      json: {
        error: {
          code: "insufficient_credits",
          message: "This run needs 20 search credits; 0 available.",
        },
      },
    },
  ]);

  await assert.rejects(
    client(impl).search.submitSearch({ state: "andhra", search_type: "ec", params: {} }),
    (error: LegiScoreError) => {
      assert.equal(error.status, 402);
      assert.equal(error.code, "insufficient_credits");
      assert.match(error.message, /search credits/);
      return true;
    },
  );
});

test("a search document is fetched from the signed URL, without the API key", async () => {
  // The route answers 302. Following it on the same request would put X-API-Key on the wire to
  // a storage host, because fetch forwards custom headers across a cross-origin redirect.
  const seen: { url: string; key: string | undefined }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const target = url.toString();
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url: target, key: headers["X-API-Key"] });
    if (target.startsWith("https://legiscore.in/")) {
      return new Response(null, { status: 302, headers: { location: "https://files.example/x?sig=1" } });
    }
    return new Response(new Uint8Array([37, 80, 68, 70]), {
      headers: { "content-type": "application/pdf" },
    });
  }) as unknown as typeof globalThis.fetch;

  const bytes = await client(impl).search.getSearchDocument("SRCH-1", "ec.pdf");

  assert.deepEqual(bytes, new Uint8Array([37, 80, 68, 70]));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "https://legiscore.in/api/v1/search/SRCH-1/documents/ec.pdf");
  assert.equal(seen[0].key, API_KEY, "the API call itself is authenticated");
  assert.equal(seen[1].url, "https://files.example/x?sig=1");
  assert.equal(seen[1].key, undefined, "the signed URL must never receive the API key");
});

test("a filename cannot walk out of the search it belongs to", async () => {
  const { calls, impl } = stubFetch([{ status: 404, json: { error: { code: "not_found", message: "No such document on this search." } } }]);
  await assert.rejects(
    client(impl).search.getSearchDocument("SRCH-1", "../../secrets"),
    (error: LegiScoreError) => {
      assert.equal(error.code, "not_found");
      return true;
    },
  );
  assert.ok(calls[0].url.endsWith("/api/v1/search/SRCH-1/documents/..%2F..%2Fsecrets"), calls[0].url);
});

test("a redirect to plain http is refused rather than followed", async () => {
  const impl = (async (url: string | URL) =>
    url.toString().startsWith("https://legiscore.in/")
      ? new Response(null, { status: 302, headers: { location: "http://files.example/x" } })
      : new Response(new Uint8Array([1]))) as unknown as typeof globalThis.fetch;

  await assert.rejects(client(impl).search.getSearchDocument("SRCH-1", "ec.pdf"), /not https/);
});

test("a redirect anywhere else is still an error", async () => {
  // Only the download route opts in. Everything else keeps the old blanket refusal.
  const impl = (async () =>
    new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } })) as unknown as typeof globalThis.fetch;
  await assert.rejects(client(impl).search.getSearch("SRCH-1"), /redirect/);
});

test("checkConnection reports both hosts separately", async () => {
  const impl = (async (url: string | URL) => {
    const target = url.toString();
    if (target.startsWith("https://legiscore.in/")) {
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const body = target.includes("/api/v1/credits") ? { balance: 42 } : [{ code: "purchase" }];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;

  const report = await client(impl).checkConnection();
  assert.equal(report.ok, true, "the reports host answered, so ok stays true");
  assert.equal(report.base_url, "https://opinion.legiscore.in");
  assert.deepEqual(report.credits, { balance: 42 });
  assert.equal(report.search.ok, false);
  assert.equal(report.search.base_url, "https://legiscore.in");
  assert.equal(report.search.status, 401);
  assert.match(report.search.problem ?? "", /rejected/);
});

test("checkConnection reports both hosts working", async () => {
  const impl = (async (url: string | URL) => {
    const body = url.toString().includes("/scenarios") ? [{ code: "purchase" }, { code: "lease" }] : { balance: 7 };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;

  const report = await client(impl).checkConnection();
  assert.equal(report.ok, true);
  assert.equal(report.scenarios, 2);
  assert.equal(report.search.ok, true);
  assert.deepEqual(report.search.credits, { balance: 7 });
});

test("a 409 from search keeps its code too", async () => {
  const { impl } = stubFetch([
    { status: 409, json: { error: { code: "already_finished", message: "This search already succeeded." } } },
  ]);
  await assert.rejects(client(impl).search.cancelSearch("SRCH-1"), (error: LegiScoreError) => {
    assert.equal(error.code, "already_finished");
    return true;
  });
});
