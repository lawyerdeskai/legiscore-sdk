// Self-check for the two replies to a pause that are not "it worked": the 422 refusal and the
// 200 that parked the case for a second approver.
//   npm test   (tsc, then node --test dist/test/)
import assert from "node:assert/strict";
import { test } from "node:test";

import { LegiScore } from "../src/index.js";
import {
  buildDocumentReviewAnnotations,
  isPendingSecondApproval,
  readPauseGateRefusal,
  readReviewFindings,
  PAUSE_GATE_UNMET,
} from "../src/pauses.js";
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

// One document-analysis pause as the API actually answers it: a finding to tick, one already
// resolved by its own recorded answer, and one ticked on an earlier round.
const REVIEW_PAYLOAD = {
  case_id: "RPT-2026-EXAMPLE1",
  status: "awaiting_document_review",
  documents: [],
  editable_fields: ["document_number", "document_date"],
  review_findings: [
    {
      fingerprint: "1a2b3c4d",
      finding_kind: "review_flag",
      document_id: "22222222-2222-4222-8222-222222222222",
      label: "Ownership mismatch",
      resolved: false,
      acknowledged: false,
    },
    {
      fingerprint: "5e6f7a8b",
      finding_kind: "irrelevant",
      document_id: null,
      label: "May not relate to this property",
      resolved: true,
      acknowledged: false,
    },
    {
      fingerprint: "9c0d1e2f",
      finding_kind: "missing_fields",
      document_id: "33333333-3333-4333-8333-333333333333",
      label: "Survey number not read",
      resolved: false,
      acknowledged: true,
    },
  ],
};

/** Answers every call with `payload` and keeps the request bodies it was sent. */
function recordingFetch(payload: unknown) {
  const sent: unknown[] = [];
  const impl = async (_url: string | URL, init: RequestInit = {}) => {
    if (typeof init.body === "string") sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { sent, impl: impl as unknown as typeof globalThis.fetch };
}

test("review findings are read off the pause payload", async () => {
  const client = new LegiScore({
    apiKey: API_KEY,
    fetch: replyOnce(200, REVIEW_PAYLOAD),
    maxRetries: 0,
  });
  const findings = readReviewFindings(await client.reports.getDocumentReview(CASE_ID));

  assert.deepEqual(
    findings.map((finding) => finding.fingerprint),
    ["1a2b3c4d", "5e6f7a8b", "9c0d1e2f"],
  );
  assert.equal(findings[0].finding_kind, "review_flag");
  assert.equal(findings[0].label, "Ownership mismatch");
  assert.equal(findings[0].resolved, false);
  assert.equal(findings[0].acknowledged, false);
  // A case-level finding names no document.
  assert.equal(findings[1].document_id, null);
  assert.equal(findings[1].resolved, true);
  assert.equal(findings[2].acknowledged, true);
  // The list on its own reads the same, for a server that proxies the call to its front end.
  assert.deepEqual(readReviewFindings(REVIEW_PAYLOAD.review_findings), findings);
});

test("a backend without the field yields no findings", () => {
  // An older deployment omits the key; an org that never made the pause strict sends [].
  const { review_findings: _omitted, ...withoutTheKey } = REVIEW_PAYLOAD;
  assert.deepEqual(readReviewFindings(withoutTheKey), []);
  assert.deepEqual(readReviewFindings({ ...REVIEW_PAYLOAD, review_findings: [] }), []);
  assert.deepEqual(readReviewFindings({ review_findings: null }), []);
  assert.deepEqual(readReviewFindings(null), []);
  assert.deepEqual(readReviewFindings("awaiting_document_review"), []);
});

test("a malformed finding is skipped rather than thrown on", () => {
  const findings = readReviewFindings({
    review_findings: [
      null,
      "review_flag",
      { label: "No fingerprint, so nothing can tick it" },
      { fingerprint: "   " },
      { fingerprint: 12345 },
      {
        fingerprint: " 4d5e6f70 ",
        finding_kind: 7,
        document_id: "",
        label: null,
        resolved: "yes",
        acknowledged: 1,
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].fingerprint, "4d5e6f70");
  assert.equal(findings[0].finding_kind, null);
  assert.equal(findings[0].document_id, null);
  assert.equal(findings[0].label, "");
  // Anything but a real boolean true is not a tick, and not an answer either.
  assert.equal(findings[0].resolved, false);
  assert.equal(findings[0].acknowledged, false);
});

test("annotations skip what the gate already counts as seen", () => {
  const findings = readReviewFindings(REVIEW_PAYLOAD);
  assert.deepEqual(buildDocumentReviewAnnotations(findings), [
    { fingerprint: "1a2b3c4d", acknowledged: true },
  ]);
  // Nothing outstanding is an empty list, not an error.
  assert.deepEqual(buildDocumentReviewAnnotations([]), []);
  assert.deepEqual(buildDocumentReviewAnnotations(findings.slice(1)), []);
});

test("annotations reach the submit body unchanged", async () => {
  const { sent, impl } = recordingFetch({ success: true, case_id: CASE_ID });
  const client = new LegiScore({ apiKey: API_KEY, fetch: impl, maxRetries: 0 });
  const annotations = buildDocumentReviewAnnotations(readReviewFindings(REVIEW_PAYLOAD));
  await client.reports.submitDocumentReview(CASE_ID, {
    proceed_to_searches: true,
    document_review_annotations: annotations,
  });

  assert.equal(sent.length, 1);
  const body = sent[0] as { document_review_annotations: unknown; proceed_to_searches: unknown };
  assert.deepEqual(body.document_review_annotations, [
    { fingerprint: "1a2b3c4d", acknowledged: true },
  ]);
  assert.equal(body.proceed_to_searches, true);
});
