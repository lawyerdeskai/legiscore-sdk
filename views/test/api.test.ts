// The logic worth a check: which pause a status means, and the ack payload that goes back.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ackItems,
  buildAckSubmission,
  createProxyReports,
  isPendingSecondApproval,
  pauseOf,
  PAUSE_GATE_UNMET,
  readPauseGateRefusal,
  ViewsError,
} from "../src/api.js";

test("pauseOf dispatches on internal_status, never on state alone", () => {
  assert.equal(pauseOf({ state: "awaiting_review", internal_status: "awaiting_documents" }), "missing_documents");
  assert.equal(pauseOf({ state: "awaiting_review", internal_status: "awaiting_document_review" }), "document_review");
  assert.equal(pauseOf({ state: "awaiting_review", internal_status: "awaiting_acknowledgements" }), "acknowledgements");
  // Both spellings are live in the API.
  assert.equal(pauseOf({ state: "awaiting_review", internal_status: "awaiting_acknowledgement" }), "acknowledgements");
  // Running and completed cases are not in any pause, and asking would 400.
  assert.equal(pauseOf({ state: "running", internal_status: "phase2_running" }), null);
  assert.equal(pauseOf({ state: "completed" }), null);
  assert.equal(pauseOf({ state: "awaiting_review", internal_status: "something_new" }), null);
  assert.equal(pauseOf(null), null);
});

test("ackItems reads the bare list and the generated block", () => {
  const item = { statement: "x" };
  assert.deepEqual(ackItems({ case_id: "c", acknowledgements: [item] }), [item]);
  assert.deepEqual(ackItems({ case_id: "c", acknowledgements: { acknowledgements: [item], opening_statement: "" } }), [item]);
  assert.deepEqual(ackItems({ case_id: "c", acknowledgements: {} }), []);
});

test("buildAckSubmission keeps every generated field and lets the server derive is_bypassed", () => {
  const generated = [
    {
      ack_id: "a1",
      statement: "GPA chain unverified",
      severity: "Critical",
      category: "Title",
      source_documents: [{ document_id: "d1", document_name: "Sale Deed" }],
      is_bypassed: false,
      a_field_added_next_year: "must survive",
    },
  ];
  const [sent] = buildAckSubmission(generated, { a1: { decision: "accepted", bypass_reason: "Indemnity taken" } });

  assert.equal(sent.decision, "accepted");
  assert.equal(sent.bypass_reason, "Indemnity taken");
  assert.equal(sent.ack_id, "a1");
  assert.deepEqual(sent.source_documents, generated[0].source_documents);
  // A whitelist here would drop unknown keys; the backend stores this list verbatim.
  assert.equal(sent.a_field_added_next_year, "must survive");
  // Sending both fields is a 400 when they disagree, so only `decision` goes back.
  assert.ok(!("is_bypassed" in sent));
});

test("an unanswered acknowledgement acknowledges nothing", () => {
  const [sent] = buildAckSubmission([{ statement: "s" }], {});
  assert.equal(sent.decision, "undecided");
  assert.equal(sent.bypass_reason, null);
});

test("items with no ack_id are still answered by position", () => {
  const items = [{ statement: "first" }, { statement: "second" }];
  const sent = buildAckSubmission(items, { "#1": { decision: "rejected" } });
  assert.equal(sent[0].decision, "undecided");
  assert.equal(sent[1].decision, "rejected");
});

test("the proxy client hits the API's own paths and raises the server's detail", async () => {
  const calls: string[] = [];
  const api = createProxyReports("/legiscore/", (async (url: string, init: any) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/status")) return new Response(JSON.stringify({ case_id: "c 1", state: "running" }));
    return new Response(JSON.stringify({ detail: "Case is not awaiting documents." }), { status: 400 });
  }) as unknown as typeof fetch);

  assert.equal((await api.getCaseStatus("c 1")).state, "running");
  await assert.rejects(() => api.getMissingDocuments("c 1"), (error: ViewsError) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, "Case is not awaiting documents.");
    return true;
  });
  assert.deepEqual(calls, ["GET /legiscore/api/cases/c%201/status", "GET /legiscore/api/cases/c%201/missing-documents"]);
});

test("a refused submit surfaces the server's reasons, not a bare status line", async () => {
  const refusal = {
    detail: {
      code: PAUSE_GATE_UNMET,
      stage: "upload_docs",
      errors: ["2 missing documents are not yet actioned: Sale Deed, Encumbrance Certificate"],
    },
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(refusal), {
      status: 422,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const api = createProxyReports("/legiscore", fetchImpl);
  const failed = await api
    .continueCase("c1", { proceed_anyway: true })
    .then(() => null)
    .catch((error: unknown) => error);

  assert.ok(failed instanceof ViewsError);
  assert.equal(failed.status, 422);
  // Without the structured read this said "POST /api/cases/c1/continue failed with 422".
  assert.match(failed.message, /Sale Deed/);

  const refused = readPauseGateRefusal(failed);
  assert.ok(refused);
  assert.equal(refused.stage, "upload_docs");
  assert.equal(refused.reasons.length, 1);
});

test("readPauseGateRefusal ignores everything that is not a refusal", () => {
  assert.equal(readPauseGateRefusal(null), null);
  assert.equal(readPauseGateRefusal({ detail: "Case is not awaiting documents" }), null);
  assert.equal(readPauseGateRefusal({ detail: [{ msg: "field required" }] }), null);
  assert.equal(readPauseGateRefusal({ detail: { code: "something_else" } }), null);
});

test("isPendingSecondApproval tells a parked answer from an advanced one", () => {
  assert.equal(isPendingSecondApproval({ success: true, pending_checker: true }), true);
  assert.equal(isPendingSecondApproval({ success: true, task_id: "t" }), false);
  assert.equal(isPendingSecondApproval(null), false);
});
