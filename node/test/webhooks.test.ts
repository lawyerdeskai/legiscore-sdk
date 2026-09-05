// Self-check for webhook verification. Run with: npm test
// The SDK signs with Web Crypto; this file re-derives the signature with node:crypto, so the
// test would catch a drift between the two implementations rather than repeating one of them.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { InvalidSignature, verifyWebhook } from "../src/webhooks.js";

const SECRET = "whsec_fake_00000000000000000000000000";

/** Reproduces the documented signing scheme exactly. */
function sign(body: Buffer, timestamp: number, secret = SECRET): Record<string, string> {
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest("hex");
  return {
    "X-LegiScore-Signature": `sha256=${digest}`,
    "X-LegiScore-Timestamp": String(timestamp),
    "X-LegiScore-Event": "report.completed",
    "X-LegiScore-Delivery": "d-1",
  };
}

const bodyOf = (extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ event: "report.completed", case_id: "RPT-1", ...extra }));

test("a genuine delivery verifies", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  const event = await verifyWebhook(body, sign(body, now), { secret: SECRET });
  assert.equal(event.caseId, "RPT-1");
  assert.equal(event.deliveryId, "d-1");
  assert.equal(event.isPause, false);
});

test("a pause event is flagged", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  const headers = { ...sign(body, now), "X-LegiScore-Event": "report.paused.review" };
  assert.equal((await verifyWebhook(body, headers, { secret: SECRET })).isPause, true);
});

test("the legacy case.paused event is flagged too", async () => {
  // Parity with the Python client: the older dispatch path still emits this name, and a
  // partner who does not resume on it leaves the case stuck.
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  const headers = { ...sign(body, now), "X-LegiScore-Event": "case.paused" };
  assert.equal((await verifyWebhook(body, headers, { secret: SECRET })).isPause, true);
});

test("headers are matched case insensitively, and Headers objects work", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  const signed = sign(body, now);
  const lowered = Object.fromEntries(Object.entries(signed).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal((await verifyWebhook(body, lowered, { secret: SECRET })).caseId, "RPT-1");
  assert.equal((await verifyWebhook(body, new Headers(signed), { secret: SECRET })).caseId, "RPT-1");
});

test("a string body and a Uint8Array body verify identically", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  const headers = sign(body, now);
  const asText = body.toString("utf8");
  const asBytes = new Uint8Array(body);
  assert.equal((await verifyWebhook(asText, headers, { secret: SECRET })).caseId, "RPT-1");
  assert.equal((await verifyWebhook(asBytes, headers, { secret: SECRET })).caseId, "RPT-1");
});

test("a tampered body is rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const headers = sign(bodyOf(), now);
  await assert.rejects(
    verifyWebhook(bodyOf({ case_id: "RPT-EVIL" }), headers, { secret: SECRET }),
    InvalidSignature,
  );
});

test("the wrong secret is rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  await assert.rejects(
    verifyWebhook(body, sign(body, now, "whsec_fake_11111111111111111111111111"), { secret: SECRET }),
    InvalidSignature,
  );
});

test("a replayed delivery is rejected", async () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const body = bodyOf();
  await assert.rejects(verifyWebhook(body, sign(body, old), { secret: SECRET }), /old/);
});

test("missing headers are rejected", async () => {
  for (const headers of [{}, { "X-LegiScore-Signature": "sha256=abc" }, { "X-LegiScore-Timestamp": "123" }]) {
    await assert.rejects(verifyWebhook(bodyOf(), headers, { secret: SECRET }), InvalidSignature);
  }
});

test("an empty secret fails closed rather than trusting", async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = bodyOf();
  await assert.rejects(verifyWebhook(body, sign(body, now), { secret: "" }), InvalidSignature);
});
