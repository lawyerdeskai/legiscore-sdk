"""The answers to a pause that are not "it worked", and how to clear a strict gate.

A case pauses three times and each pause has a matching resume call. Three things can come
back from one of those calls that a caller reading only the HTTP status will get wrong:

1. **422 with a structured body.** Your organisation can require every item at a pause to be
   actioned before the case may advance. When something is outstanding the API refuses the
   resume with 422 and a machine-readable reason list. Retrying sends the same body and is
   refused again; the fix is to action the items the reasons name and call again.
2. **200 that did not advance the case.** Where a second person has to approve the answer, the
   resume call records it and parks the case at the same pause. The reply carries
   ``pending_checker: true`` and the case stays in ``awaiting_review`` until the approver acts.
3. **A strict document-analysis pause refuses until its findings are acknowledged.** The
   findings, and the fingerprint each one is ticked by, come back on
   ``reports.get_document_review`` as ``review_findings``. Tick the ones you accept and send
   them to ``reports.submit_document_review`` as ``document_review_annotations``. The
   fingerprint is a hash the server computes over the finding's own content; it is the only
   thing the gate matches on, and it is never computed on this side, so a finding that changed
   cannot carry a stale tick.

None of this is an SDK invention: it is the API's own wire contract, and the web application
reads it the same way.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, NamedTuple

from ._transport import LegiScoreError

__all__ = [
    "FINDING_KINDS",
    "PAUSE_GATE_UNMET",
    "PAUSE_STAGES",
    "PauseGateRefusal",
    "ReviewFinding",
    "build_document_review_annotations",
    "is_pending_second_approval",
    "read_pause_gate_refusal",
    "read_review_findings",
]

#: The error code the three resume calls answer with when a pause is not fully actioned.
PAUSE_GATE_UNMET = "PAUSE_GATE_UNMET"

#: Which pause was refused. One value per pause a case can stop at.
PAUSE_STAGES = ("upload_docs", "review_analysis", "submit_acks")


class PauseGateRefusal(NamedTuple):
    """A refused resume, read out of the 422.

    ``stage`` is the pause that was refused, one of :data:`PAUSE_STAGES`; a stage added later
    reaches you as itself rather than being dropped. ``reasons`` are plain sentences meant to be
    shown to whoever is answering the pause.
    """

    stage: str
    reasons: list[str]


def read_pause_gate_refusal(error: Any) -> PauseGateRefusal | None:
    """Read a pause refusal out of a failed call, or ``None`` if that is not what happened.

    Accepts the :class:`~legiscore.LegiScoreError` the SDK raises, or a parsed response body, so
    the same function works in a server that proxies these calls on to its own front end.

        try:
            client.reports.continue_case(case_id, {"new_document_ids": ids})
        except LegiScoreError as error:
            refused = read_pause_gate_refusal(error)
            if refused is None:
                raise
            show_to_user(refused.reasons)
    """
    body = error.body if isinstance(error, LegiScoreError) else error
    if not isinstance(body, dict):
        return None

    detail = body.get("detail")
    if not isinstance(detail, dict):
        return None
    if detail.get("code") != PAUSE_GATE_UNMET:
        return None

    raw_reasons = detail.get("errors")
    reasons = (
        [reason.strip() for reason in raw_reasons if isinstance(reason, str) and reason.strip()]
        if isinstance(raw_reasons, list)
        else []
    )
    stage = detail.get("stage")
    return PauseGateRefusal(stage=stage if isinstance(stage, str) else "", reasons=reasons)


def is_pending_second_approval(response: Any) -> bool:
    """True when a resume call succeeded but left the case where it was.

    The answer was recorded and is waiting for a second person to approve it. Check it on the
    reply to ``continue_case``, ``submit_document_review`` and ``submit_acknowledgements``. A
    caller that treats every 200 as "advanced" will poll a case that is not moving, or answer
    the same pause a second time.

        replied = client.reports.submit_acknowledgements(case_id, {"acknowledgements": items})
        if is_pending_second_approval(replied):
            return wait_for_your_colleague_to_approve()
    """
    return isinstance(response, dict) and response.get("pending_checker") is True


# --------------------------------------------------------------------------------------
# The document-analysis gate
# --------------------------------------------------------------------------------------

#: The kinds of finding a document-analysis pause can hold, so a caller can branch on one by
#: name. Read as plain strings: a kind added later arrives as itself rather than being dropped.
FINDING_KINDS = (
    "missing_fields",
    "duplicate_group",
    "review_flag",
    "irrelevant",
    "same_document",
    "anomaly",
)


class ReviewFinding(NamedTuple):
    """One document-analysis finding a strict pause gate checks before the case may advance.

    ``fingerprint`` is the server's hash of the finding's own content, and the only thing the
    gate matches on. Send it back to acknowledge the finding; never compute one on this side,
    because a client that recomputed the hash would drift from the server the first time the
    recipe changed, and would then be ticking nothing.

    ``label`` is display text, deliberately excluded from the hash so it can be reworded
    without invalidating a tick. ``resolved`` means the finding already carries its own
    recorded answer, so the gate counts it as seen and no tick is needed. ``acknowledged``
    means it was ticked on an earlier round.
    """

    fingerprint: str
    finding_kind: str | None
    document_id: str | None
    label: str
    resolved: bool
    acknowledged: bool


def _optional_text(value: Any) -> str | None:
    """A wire field that is a string or null, with an empty string read as null."""
    return (value.strip() or None) if isinstance(value, str) else None


def read_review_findings(response: Any) -> list[ReviewFinding]:
    """The findings on a document-analysis pause, or ``[]`` when there is nothing to tick.

    Accepts the ``reports.get_document_review`` body, or its ``review_findings`` list on its
    own, so the same function works in a server that proxies the call on to its own front end.

    Empty is a normal answer rather than a problem: an organisation that has not made the
    document-analysis pause strict has nothing to acknowledge, and a deployment older than the
    field omits it altogether. A malformed entry is skipped instead of raising, because this
    reads a pause a case is already sitting in and an exception here would strand it.

        review = client.reports.get_document_review(case_id)
        findings = read_review_findings(review)
    """
    if isinstance(response, list):
        entries: list[Any] = response
    elif isinstance(response, dict):
        raw = response.get("review_findings")
        entries = raw if isinstance(raw, list) else []
    else:
        return []

    findings: list[ReviewFinding] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        fingerprint = _optional_text(entry.get("fingerprint"))
        if fingerprint is None:
            continue
        label = entry.get("label")
        findings.append(
            ReviewFinding(
                fingerprint=fingerprint,
                finding_kind=_optional_text(entry.get("finding_kind")),
                document_id=_optional_text(entry.get("document_id")),
                label=label if isinstance(label, str) else "",
                resolved=entry.get("resolved") is True,
                acknowledged=entry.get("acknowledged") is True,
            )
        )
    return findings


def build_document_review_annotations(findings: Iterable[ReviewFinding]) -> list[dict[str, Any]]:
    """Turn findings into the ``document_review_annotations`` a submit carries.

    Every finding that is not already ``resolved`` or ``acknowledged`` becomes one tick, keyed
    on its fingerprint. Pure, and deliberately never called for you: acknowledging a finding
    asserts that a person at your organisation has read it and accepts it, on a property
    someone is lending against. Pass only what that person actually accepted.

        annotations = build_document_review_annotations(
            finding for finding in findings if a_person_accepted(finding)
        )
        client.reports.submit_document_review(
            case_id,
            {"proceed_to_searches": True, "document_review_annotations": annotations},
        )
    """
    return [
        {"fingerprint": finding.fingerprint, "acknowledged": True}
        for finding in findings
        if not finding.resolved and not finding.acknowledged
    ]
