"""#1193 RESUME run-token carrier — loader-side metadata pop + storage scrub.

The dispatch-minted run token used to ride ONLY the initial A2A message, so a
RESUMED task carried no credential at all. Because the compiled context subflow
interrupts at its HITL gate, ``/api/context-finalize`` ALWAYS runs in a resumed
task — the loader must therefore pop the token from the RESUME carrier too.

The resume carrier is ``message["metadata"]`` (not the text): the resume text is
the operator's answer, delivered verbatim to the gate's ``InputMessageNode``, and
the artifact-review path delivers a typed decision envelope byte-for-byte.

This module covers:
  1. ``_pop_run_token_from_metadata``  — the resume carrier pop + scrub.
  2. ``_extract_and_scrub_run_token``  — carrier precedence and the fail-closed
     rule when both carriers disagree; BOTH are always scrubbed.
  3. ``_scrub_run_token_from_message_for_storage`` — what the ``submit_task``
     patch persists, i.e. the token never reaches the A2A task-history row.
"""

import json

from agent_loader import (
    CINATRA_RUN_TOKEN_MESSAGE_KEY,
    _extract_and_scrub_run_token,
    _pop_run_token_from_metadata,
    _scrub_run_token_from_message_for_storage,
)


def _text_msg(payload: dict, metadata: dict | None = None) -> dict:
    """An INITIAL-style message: dispatcher JSON in the first text part."""
    msg = {"role": "user", "parts": [{"kind": "text", "text": json.dumps(payload)}]}
    if metadata is not None:
        msg["metadata"] = metadata
    return msg


def _resume_msg(text: str, metadata: dict | None = None) -> dict:
    """A RESUME-style message: plain operator text, credential in metadata."""
    msg = {"role": "user", "parts": [{"kind": "text", "text": text}]}
    if metadata is not None:
        msg["metadata"] = metadata
    return msg


# ---------------------------------------------------------------------------
# 1. The resume carrier pop
# ---------------------------------------------------------------------------


def test_metadata_pop_extracts_token_and_scrubs_it() -> None:
    original = _resume_msg(
        "[Approved by operator]",
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "raw-resume-token", "keep": "me"},
    )
    token, scrubbed = _pop_run_token_from_metadata(original)

    assert token == "raw-resume-token"
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in scrubbed["metadata"]
    # Unrelated metadata survives (A2A metadata is a shared extension surface).
    assert scrubbed["metadata"]["keep"] == "me"
    # The caller's dict is never mutated in place — the broker still forwards the
    # ORIGINAL object, which must keep the raw token for the ContextVar.
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY in original["metadata"]


def test_metadata_pop_leaves_the_resume_text_byte_identical() -> None:
    answer = '{"review":{"decision":"rejected"},"note":"needs work"}'
    original = _resume_msg(answer, {CINATRA_RUN_TOKEN_MESSAGE_KEY: "tok"})
    _, scrubbed = _pop_run_token_from_metadata(original)
    # The artifact-review resume path delivers this verbatim by contract.
    assert scrubbed["parts"][0]["text"] == answer


def test_metadata_pop_is_noop_when_absent() -> None:
    original = _resume_msg("plain text", {"other": "value"})
    token, scrubbed = _pop_run_token_from_metadata(original)
    assert token == ""
    assert scrubbed is original  # no needless copy


def test_metadata_pop_fails_safe_on_odd_shapes() -> None:
    assert _pop_run_token_from_metadata(None) == ("", None)
    bare = _resume_msg("hi")
    assert _pop_run_token_from_metadata(bare) == ("", bare)
    not_a_dict = {"role": "user", "parts": [], "metadata": "nope"}
    assert _pop_run_token_from_metadata(not_a_dict) == ("", not_a_dict)


def test_metadata_pop_scrubs_a_non_string_token_but_reports_absent() -> None:
    original = _resume_msg("hi", {CINATRA_RUN_TOKEN_MESSAGE_KEY: 12345})
    token, scrubbed = _pop_run_token_from_metadata(original)
    # Not a usable bearer ...
    assert token == ""
    # ... but it must NOT be left behind in the message.
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in scrubbed["metadata"]


# ---------------------------------------------------------------------------
# 2. Carrier precedence + the fail-closed disagreement rule
# ---------------------------------------------------------------------------


def test_extract_reads_the_resume_carrier() -> None:
    msg = _resume_msg("answer", {CINATRA_RUN_TOKEN_MESSAGE_KEY: "resume-tok"})
    token, scrubbed = _extract_and_scrub_run_token(msg)
    assert token == "resume-tok"
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in scrubbed["metadata"]


def test_extract_reads_the_dispatch_carrier() -> None:
    msg = _text_msg({CINATRA_RUN_TOKEN_MESSAGE_KEY: "init-tok", "cinatra_run_id": "r1"})
    token, scrubbed = _extract_and_scrub_run_token(msg)
    assert token == "init-tok"
    reparsed = json.loads(scrubbed["parts"][0]["text"])
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in reparsed
    assert reparsed["cinatra_run_id"] == "r1"


def test_extract_scrubs_BOTH_carriers_even_when_only_one_supplies_the_token() -> None:
    # A duplicated carrier must never leave credential material behind.
    msg = _text_msg(
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "same-tok", "cinatra_run_id": "r1"},
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "same-tok"},
    )
    token, scrubbed = _extract_and_scrub_run_token(msg)
    assert token == "same-tok"
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in scrubbed["metadata"]
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in json.loads(scrubbed["parts"][0]["text"])


def test_extract_FAILS_CLOSED_when_the_two_carriers_disagree() -> None:
    # Two DIFFERENT credentials on one message is never legitimate. Honouring
    # either would let whoever can write the weaker carrier choose which run the
    # task authenticates as.
    msg = _text_msg(
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "text-tok", "cinatra_run_id": "r1"},
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "meta-tok"},
    )
    token, scrubbed = _extract_and_scrub_run_token(msg)
    assert token == ""
    # Both are still scrubbed.
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in scrubbed["metadata"]
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in json.loads(scrubbed["parts"][0]["text"])


def test_extract_never_reserialises_plain_resume_text() -> None:
    msg = _resume_msg("just a sentence", {CINATRA_RUN_TOKEN_MESSAGE_KEY: "t"})
    _, scrubbed = _extract_and_scrub_run_token(msg)
    assert scrubbed["parts"][0]["text"] == "just a sentence"


# ---------------------------------------------------------------------------
# 3. Persisted-task-history hygiene (the submit_task patch's payload)
# ---------------------------------------------------------------------------


def test_storage_scrub_removes_the_resume_carrier() -> None:
    original = _resume_msg("[Approved]", {CINATRA_RUN_TOKEN_MESSAGE_KEY: "raw-tok"})
    stored = _scrub_run_token_from_message_for_storage(original)

    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in stored["metadata"]
    assert "raw-tok" not in json.dumps(stored)
    # The caller's object still carries it — the broker hands THAT to the worker,
    # which needs the raw token for the ContextVar.
    assert original["metadata"][CINATRA_RUN_TOKEN_MESSAGE_KEY] == "raw-tok"


def test_storage_scrub_removes_the_dispatch_carrier_too() -> None:
    # This closes a PRE-EXISTING leak: A2AStorage.submit_task json.dumps-es the
    # inbound message into the task-history column BEFORE the worker's pop ever
    # runs, so the initial-dispatch token was durably persisted (and echoed in
    # the JSON-RPC response).
    original = _text_msg(
        {CINATRA_RUN_TOKEN_MESSAGE_KEY: "init-raw", "cinatra_run_id": "r1"}
    )
    stored = _scrub_run_token_from_message_for_storage(original)

    assert "init-raw" not in json.dumps(stored)
    assert json.loads(stored["parts"][0]["text"])["cinatra_run_id"] == "r1"
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY in json.loads(
        original["parts"][0]["text"]
    )


def test_storage_scrub_does_not_share_mutable_substructure_with_the_original() -> None:
    original = _resume_msg("hi", {CINATRA_RUN_TOKEN_MESSAGE_KEY: "t", "k": "v"})
    stored = _scrub_run_token_from_message_for_storage(original)
    # submit_task stamps task_id/context_id onto the dict it is handed; that must
    # not write through into the caller's metadata/parts.
    assert stored["metadata"] is not original["metadata"]
    assert stored["parts"] is not original["parts"]


def test_storage_scrub_passes_through_an_uncarried_message_unchanged() -> None:
    plain = _resume_msg("no credential here")
    assert _scrub_run_token_from_message_for_storage(plain) is plain
    assert _scrub_run_token_from_message_for_storage(None) is None
