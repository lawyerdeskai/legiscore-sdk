"""The two answers to a pause that are not "it worked".

A case pauses three times and each pause has a matching resume call. Two things can come back
from one of those calls that a caller reading only the HTTP status will get wrong:

1. **422 with a structured body.** Your organisation can require every item at a pause to be
   actioned before the case may advance. When something is outstanding the API refuses the
   resume with 422 and a machine-readable reason list. Retrying sends the same body and is
   refused again; the fix is to action the items the reasons name and call again.
2. **200 that did not advance the case.** Where a second person has to approve the answer, the
   resume call records it and parks the case at the same pause. The reply carries
   ``pending_checker: true`` and the case stays in ``awaiting_review`` until the approver acts.

Neither is an SDK invention: both are the API's own wire contract, and the web application
reads them the same way.
"""

from __future__ import annotations

from typing import Any, NamedTuple

from ._transport import LegiScoreError

__all__ = [
    "PAUSE_GATE_UNMET",
    "PAUSE_STAGES",
    "PauseGateRefusal",
    "is_pending_second_approval",
    "read_pause_gate_refusal",
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
