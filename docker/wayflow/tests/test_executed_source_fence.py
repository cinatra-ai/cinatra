"""cinatra#3745 dispatch fence: the mount that receives a run's first task runs it
only when the host bound that mount's own source.

The host selects the loader's source binding on the composed-OAS route, binds
it to the run, then sends the first task. A reload between the select and the
send can route the send to another mount of the same agent, and during a reload
the registry can already name the new mount while the router still serves the
prior one. So the host names the bound source in the first message, under a
reserved key, and the mount that receives the task compares it with its own
frozen binding before any step runs: a mismatch fails the task.
"""

import json
import re
from pathlib import Path
from types import MappingProxyType

import pytest

LOADER = Path(__file__).resolve().parent.parent / "agent_loader.py"

BINDING = {
    "sourceSha256": "a" * 64,
    "executedSourceSha256": "b" * 64,
    "declarationSourceSha256": "c" * 64,
    "declarationSource": "{}",
}


class _Assistant:
    pass


def _mounted(binding=BINDING):
    assistant = _Assistant()
    if binding is not None:
        assistant._cinatra_executed_source = MappingProxyType(dict(binding))
    return assistant


def _expected(**change):
    value = {k: BINDING[k] for k in ("sourceSha256", "executedSourceSha256", "declarationSourceSha256")}
    value.update(change)
    return value


def _first_message(expected):
    from agent_loader import CINATRA_EXPECTED_SOURCE_MESSAGE_KEY

    payload = {"cinatra_run_id": "run-1", "topic": "hello", CINATRA_EXPECTED_SOURCE_MESSAGE_KEY: expected}
    return {"role": "user", "parts": [{"kind": "text", "text": json.dumps(payload)}]}


def test_the_key_is_the_hosts_key() -> None:
    from agent_loader import CINATRA_EXPECTED_SOURCE_MESSAGE_KEY

    assert CINATRA_EXPECTED_SOURCE_MESSAGE_KEY == "__cinatra_expected_source__"


def test_a_first_task_for_the_mounts_own_source_runs_and_the_key_is_removed() -> None:
    from agent_loader import CINATRA_EXPECTED_SOURCE_MESSAGE_KEY, _take_expected_source

    original = _first_message(_expected())
    fenced = _take_expected_source(original, _mounted())
    payload = json.loads(fenced["parts"][0]["text"])
    assert CINATRA_EXPECTED_SOURCE_MESSAGE_KEY not in payload
    assert payload == {"cinatra_run_id": "run-1", "topic": "hello"}
    # The caller's message is never changed in place.
    assert CINATRA_EXPECTED_SOURCE_MESSAGE_KEY in json.loads(original["parts"][0]["text"])


@pytest.mark.parametrize(
    "expected",
    [
        _expected(sourceSha256="d" * 64),
        _expected(executedSourceSha256="d" * 64),
        _expected(declarationSourceSha256="d" * 64),
        _expected(extra="x"),
        {"sourceSha256": "a" * 64, "executedSourceSha256": "b" * 64},
        _expected(sourceSha256=None),
        "a" * 64,
        None,
    ],
)
def test_a_first_task_bound_to_another_source_fails_before_any_step(expected) -> None:
    from agent_loader import _take_expected_source

    with pytest.raises(ValueError, match="executed_source_mismatch"):
        _take_expected_source(_first_message(expected), _mounted())


def test_a_mount_without_a_frozen_binding_refuses_a_bound_task() -> None:
    from agent_loader import _take_expected_source

    with pytest.raises(ValueError, match="executed_source_mismatch"):
        _take_expected_source(_first_message(_expected()), _mounted(None))
    plain = _Assistant()
    plain._cinatra_executed_source = dict(BINDING)  # not the read-only snapshot the mount attaches
    with pytest.raises(ValueError, match="executed_source_mismatch"):
        _take_expected_source(_first_message(_expected()), plain)


def test_a_message_without_the_key_is_returned_unchanged() -> None:
    from agent_loader import _take_expected_source

    resume = {"role": "user", "parts": [{"kind": "text", "text": "[Resumed by operator after stop]"}]}
    assert _take_expected_source(resume, _mounted()) is resume
    unbound = {"role": "user", "parts": [{"kind": "text", "text": json.dumps({"cinatra_run_id": "r"})}]}
    assert _take_expected_source(unbound, _mounted(None)) is unbound
    assert _take_expected_source(None, _mounted()) is None


def test_the_worker_checks_the_fence_before_it_loads_or_starts_a_conversation() -> None:
    source = LOADER.read_text(encoding="utf-8")
    start = source.index("async def _patched_run_task(")
    body = source[start:source.index("_patched_run_task.__cinatra_patched__", start)]
    fence = body.find("_take_expected_source(")
    assert fence > -1
    assert fence > body.index("_extract_and_scrub_run_token(")
    assert fence < body.index("load_context_conversation(")
    assert fence < body.index("start_conversation(")
    # The fence reads the assistant of THIS worker (the mount that received the task).
    assert re.search(r"_take_expected_source\(\s*params\.get\(\"message\"\),\s*self\.assistant\s*\)", body)
