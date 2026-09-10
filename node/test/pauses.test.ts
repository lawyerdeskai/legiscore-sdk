// Self-check for the two replies to a pause that are not "it worked": the 422 refusal and the
// 200 that parked the case for a second approver.
//   npm test   (tsc, then node --test dist/test/)
import assert from "node:assert/strict";
import { test } from "node:test";

import { LegiScore } from "../src/index.js";
import { isPendingSecondApproval, readPauseGateRefusal, PAUSE_GATE_UNMET } from "../src/pauses.js";
import { LegiScoreError } from "../src/transport.js";

const API_KEY = "lsk_fake_0000000000000000000000000000";
const CASE_ID = "11111111-1111-4111-8111-111111111111";

const REFUSAL = {
  detail: {
    code: PAUSE_GATE_UNMET,
    stage: "upload_docs",
    errors: ["2 missing documents are not yet actioned: Sale Deed, Encumbrance Certificate"],
  },
};

function replyOnce(status: number, json: unknown) {
  const impl = async () =>
    new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  return impl as unknown as typeof globalThis.fetch;
}

test("a refused resume keeps its code and stays readable in the message", async () => {
  const client = new LegiScore({ apiKey: API_KEY, fetch: replyOnce(422, REFUSAL), maxRetries: 0 });
  const failed = await client.reports
    .continueCase(CASE_ID, { proceed_anyway: true })
    .then(() => null)
    .catch((error: unknown) => error);

  assert.ok(failed instanceof LegiScoreError);
  assert.equal(failed.status, 422);
  // The bug this guards: String({...}) is "[object Object]", which loses the code entirely.
  assert.equal(failed.code, PAUSE_GATE_UNMET);
  assert.ok(!failed.message.includes("[object Object]"));
  assert.ok(failed.message.includes(PAUSE_GATE_UNMET));
  assert.ok(failed.message.includes("upload_docs"));
  // The reasons name documents on the case, so they belong on the body, not in what gets logged.
  assert.ok(!failed.message.includes("Sale Deed"));
});

test("readPauseGateRefusal reads the error, and the raw body just the same", () => {
  const error = new LegiScoreError("422", { status: 422, body: REFUSAL, code: PAUSE_GATE_UNMET });
  for (const input of [error, REFUSAL]) {
    const refused = readPauseGateRefusal(input);
    assert.ok(refused);
    assert.equal(refused.stage, "upload_docs");
    assert.equal(refused.reasons.length, 1);
    assert.match(refused.reasons[0], /Sale Deed/);
  }
});

test("readPauseGateRefusal says no to everything that is not a refusal", () => {
  assert.equal(readPauseGateRefusal(null), null);
  assert.equal(readPauseGateRefusal("422 Unprocessable Entity"), null);
  assert.equal(readPauseGateRefusal({ detail: "Case is not awaiting documents" }), null);
  // A field-validation 422 is a list, not the gate.
  assert.equal(readPauseGateRefusal({ detail: [{ loc: ["body"], msg: "field required" }] }), null);
  assert.equal(readPauseGateRefusal({ detail: { code: "something_else", errors: ["x"] } }), null);
  // The code with no reasons is still a refusal; the caller decides what to show.
  assert.deepEqual(readPauseGateRefusal({ detail: { code: PAUSE_GATE_UNMET } }), {
    stage: "",
    reasons: [],
  });
});

test("a field-validation 422 counts the fields instead of printing objects", async () => {
  const client = new LegiScore({
    apiKey: API_KEY,
    fetch: replyOnce(422, { detail: [{ loc: ["body", "documentIds"], msg: "field required" }] }),
    maxRetries: 0,
  });
  const failed = await client.reports
    .createCase({ propertyFocus: {} })
    .then(() => null)
    .catch((error: unknown) => error);

  assert.ok(failed instanceof LegiScoreError);
  assert.ok(!failed.message.includes("[object Object]"));
  assert.ok(failed.message.includes("1 field"));
});

test("a plain string detail is unchanged", async () => {
  const client = new LegiScore({
    apiKey: API_KEY,
    fetch: replyOnce(400, { detail: "Case is not awaiting documents" }),
    maxRetries: 0,
  });
  const failed = await client.reports
    .continueCase(CASE_ID, {})
    .then(() => null)
    .catch((error: unknown) => error);

  assert.ok(failed instanceof LegiScoreError);
  assert.equal(failed.code, undefined);
  assert.ok(failed.message.includes("Case is not awaiting documents"));
});

test("isPendingSecondApproval tells a parked answer from an advanced one", () => {
  assert.equal(isPendingSecondApproval({ success: true, pending_checker: true }), true);
  assert.equal(isPendingSecondApproval({ success: true, advanced: false, pending_checker: true }), true);
  assert.equal(isPendingSecondApproval({ success: true, task_id: "t" }), false);
  assert.equal(isPendingSecondApproval({ pending_checker: "true" }), false);
  assert.equal(isPendingSecondApproval(null), false);
});
