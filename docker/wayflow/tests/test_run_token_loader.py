"""#1193 run-token spine (W2) — loader-side pop + ContextVar + header attach.

W1 (merged) mints a per-run token and embeds the RAW value in the initial A2A
message under the reserved key ``__cinatra_run_token__``. This wave makes the
loader:

  1. POP that key out of the initial message (``_pop_run_token_from_message``)
     BEFORE the message is parsed for Flow inputs or converted + appended to the
     WayFlow conversation — the bearer must never enter prompt/history/
     persistence. The scrub preserves every other key (run id, binding, inputs).
  2. Hold the raw token in the per-task ``_WAYFLOW_RUN_TOKEN`` ContextVar.
  3. Attach it as ``X-Cinatra-Run-Token`` on host-anchored context-resolve /
     context-finalize callbacks and (W3) the llm-bridge call — the first-party
     run-token consumer surfaces. External hosts never receive it.

The header-attach test stubs ``wayflowcore.steps`` exactly like
``test_bridge_token.py`` so it runs without the real wayflowcore package.
"""

import asyncio
import json
import sys
from typing import Any, Dict
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# _pop_run_token_from_message — pure scrub helper (no wayflowcore needed).
# ---------------------------------------------------------------------------


def _msg(payload: dict) -> dict:
    """An A2A message whose first text part is the dispatcher's JSON payload."""
    return {
        "role": "user",
        "parts": [{"kind": "text", "text": json.dumps(payload)}],
    }


def test_pop_extracts_token_and_scrubs_message() -> None:
    from agent_loader import (
        _pop_run_token_from_message,
        CINATRA_RUN_TOKEN_MESSAGE_KEY,
    )

    original = _msg(
        {
            CINATRA_RUN_TOKEN_MESSAGE_KEY: "raw-bearer-abc",
            "cinatra_run_id": "run-1",
            "cinatra_run_binding": "sig",
            "topic": "hello",
        }
    )
    token, scrubbed = _pop_run_token_from_message(original)

    assert token == "raw-bearer-abc"
    # The reserved key is gone from the scrubbed message; everything else stays.
    reparsed = json.loads(scrubbed["parts"][0]["text"])
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY not in reparsed
    assert reparsed == {
        "cinatra_run_id": "run-1",
        "cinatra_run_binding": "sig",
        "topic": "hello",
    }
    # The caller's message is never mutated in place (immutable scrub).
    assert CINATRA_RUN_TOKEN_MESSAGE_KEY in json.loads(original["parts"][0]["text"])


def test_pop_is_noop_when_key_absent() -> None:
    from agent_loader import _pop_run_token_from_message

    original = _msg({"cinatra_run_id": "run-1"})
    token, scrubbed = _pop_run_token_from_message(original)
    assert token == ""
    # Unchanged message returned (same object identity, no needless copy).
    assert scrubbed is original


def test_pop_fails_safe_on_non_json_and_missing_parts() -> None:
    from agent_loader import _pop_run_token_from_message

    # Non-JSON text part.
    bad = {"role": "user", "parts": [{"kind": "text", "text": "not json {"}]}
    assert _pop_run_token_from_message(bad) == ("", bad)
    # No message / no parts.
    assert _pop_run_token_from_message(None) == ("", None)
    assert _pop_run_token_from_message({"parts": []}) == ("", {"parts": []})
    # Non-string token value ⇒ treated as absent bearer ("") but still popped.
    weird = _msg({"__cinatra_run_token__": 123, "k": "v"})
    token, scrubbed = _pop_run_token_from_message(weird)
    assert token == ""
    assert "__cinatra_run_token__" not in json.loads(scrubbed["parts"][0]["text"])


# ---------------------------------------------------------------------------
# Header attach — X-Cinatra-Run-Token on host-anchored context callbacks only.
# ---------------------------------------------------------------------------


def _install_patched_step(monkeypatch):
    """Stub wayflowcore.steps.ApiCallStep + patch it; return the fake class."""

    class FakeApiCallStep:
        async def _execute_request(self, request: Dict[str, Any]) -> str:
            return "ok"

    fake_steps = MagicMock()
    fake_steps.ApiCallStep = FakeApiCallStep
    fake_wf = MagicMock()
    fake_wf.steps = fake_steps
    monkeypatch.setitem(sys.modules, "wayflowcore", fake_wf)
    monkeypatch.setitem(sys.modules, "wayflowcore.steps", fake_steps)
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "test-token-abc-123")
    monkeypatch.delenv("CINATRA_BASE_URL", raising=False)  # default internal host

    from agent_loader import _patch_api_call_step_bridge_token

    _patch_api_call_step_bridge_token()
    return FakeApiCallStep


def _drive(step, url: str) -> Dict[str, Any]:
    request: Dict[str, Any] = {"url": url}
    asyncio.run(step._execute_request(request))
    return request


def test_run_token_header_attached_on_context_callbacks(monkeypatch) -> None:
    from agent_loader import _WAYFLOW_RUN_TOKEN

    FakeApiCallStep = _install_patched_step(monkeypatch)
    step = FakeApiCallStep()
    tok = _WAYFLOW_RUN_TOKEN.set("raw-bearer-xyz")
    try:
        base = "http://host.docker.internal:3000"
        # context-resolve + context-finalize ⇒ attached.
        for path in ("/api/context-resolve", "/api/context-finalize"):
            req = _drive(step, base + path)
            assert req["headers"]["X-Cinatra-Run-Token"] == "raw-bearer-xyz", path
        # llm-bridge is a host-anchored run-token consumer as of W3 ⇒ attached
        # (its run selection resolves token-first off the one verifier).
        req = _drive(step, base + "/api/llm-bridge")
        assert req["headers"]["X-Cinatra-Run-Token"] == "raw-bearer-xyz"
        # External host ⇒ nothing internal injected (fail closed).
        ext = _drive(step, "https://api.openai.com/v1/context-resolve")
        assert "X-Cinatra-Run-Token" not in ext.get("headers", {})
    finally:
        _WAYFLOW_RUN_TOKEN.reset(tok)


def test_run_token_header_absent_when_contextvar_empty(monkeypatch) -> None:
    from agent_loader import _WAYFLOW_RUN_TOKEN

    FakeApiCallStep = _install_patched_step(monkeypatch)
    step = FakeApiCallStep()
    tok = _WAYFLOW_RUN_TOKEN.set("")  # no token for this task
    try:
        req = _drive(step, "http://host.docker.internal:3000/api/context-resolve")
        assert "X-Cinatra-Run-Token" not in req["headers"]
    finally:
        _WAYFLOW_RUN_TOKEN.reset(tok)
