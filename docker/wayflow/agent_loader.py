"""Production multi-tenant WayFlow agent loader.

Hosts N WayFlow A2AServer instances behind ONE Starlette parent app, with each
agent mounted at `/agents/<vendor>/<slug>/`.

Architecture:

    Starlette parent app
        ├── Mount /agents/<vendor>/<slug>   →  A2AServer().get_app(...)   (one per agent)
        ├── Mount /agents/<vendor>/<slug>   →  A2AServer().get_app(...)
        └── Route /.health                  →  health()

Per-agent mounts isolate state: each A2AServer has its own task broker, worker,
storage, and AgentCard. The verified ASGI accessor on A2AServer 26.1.x is
`server.get_app(host, port)`.

Bridge-token patches are applied ONCE (idempotently, via the
`__cinatra_patched__` sentinel) before any agent is mounted. They mutate
class methods on ApiCallStep + httpx.AsyncClient + A2AAgent + A2AServer, so
a single application protects every A2AServer instance built afterwards.

`/.health` returns a degraded-aware shape:
    { "status": "ok"|"degraded", "agents": N, "failed": M, "failed_agents": [...] }
where `failed_agents` lists `<vendor>/<slug>` paths whose load raised.

Security-sensitive properties preserved from the legacy single-agent loader:
  - Path-traversal guard in discover_agents (resolved.relative_to(agents_base))
  - 1 MB OAS file size cap
  - No implicit `-agent` suffix probe
  - No hardcoded vendor name (multi-vendor agent layout)

Patches preserved (all use the `__cinatra_patched__` sentinel):
  - _patch_api_call_step_bridge_token (X-Cinatra-Bridge-Token on ApiCallStep)
  - _patch_a2a_agent_bridge_token (X-Cinatra-Bridge-Token on httpx.AsyncClient)
  - _patch_a2a_agent_no_shared_conversation (skip init messages)
  - _patch_serve_agent_flow_validation (ApiNode-only flow bypass)
  - ContextVar propagation (X-Cinatra-A2A-Context-Id on llm-bridge ApiNode calls)
  - _patch_pyagentspec_deserialization_error_mask (unmask pyagentspec
    26.1.0's `'error' required in context` TypeError so the real validation
    message reaches operators). Remove once pyagentspec ships the ctx=error
    fix and Dockerfile pyagentspec pin is bumped past it.

Startup guard (runs once after the patches inside `build_parent_app`):
  - _validate_live_class_names raises RuntimeError naming the wayflowcore
    version + every missing symbol if any of the patched methods or chat-step
    classes named in `_is_apinode_only_flow` have been renamed/removed. This
    catches the silent-failure surface where the predicate compares
    `type(step).__name__` to a hard-coded string set. When bumping wayflowcore, re-run
    `pytest docker/wayflow/tests/test_live_class_names.py` against the new
    pin before merging.

Other loader patches are intentionally out of scope here unless the runtime
surface they protect is present in this multi-tenant loader.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import datetime as _datetime
import hashlib
import hmac
import inspect
import json
import os
import re
import urllib.parse as _urlparse
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

try:  # pragma: no cover — exercised inside the Docker image only
    from wayflowcore.agentserver import A2AServer  # type: ignore[import-not-found]
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — host-side typecheck fallback
    A2AServer = None  # type: ignore[assignment]
    AgentSpecLoader = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# ContextVar for propagating the current WayFlow task context_id to
# ApiCallStep._execute_request so it can inject X-Cinatra-A2A-Context-Id.
# ---------------------------------------------------------------------------

#: Stores the fasta2a context_id for the task currently executing in this
#: asyncio task / coroutine chain. Reset to "" between tasks.
_WAYFLOW_CONTEXT_ID: contextvars.ContextVar[str] = contextvars.ContextVar(
    "_WAYFLOW_CONTEXT_ID", default=""
)

#: Default HTTP timeout (in seconds) applied to any ApiNode call that does
#: not declare its own. 24 hours — matches the OpenAI batch API SLA upper
#: bound. The caller (BullMQ worker / A2A request) imposes its own job
#: timeout, so this only bounds a single in-flight HTTP request, not the
#: total agent run. See `_patch_apinode_bridge_token` body for rationale.
_DEFAULT_APINODE_TIMEOUT_SECONDS: float = 86_400.0

#: Default timeout for direct httpx.AsyncClient calls (A2AAgent agent-card
#: discovery + send_message, MCP transports). Same SLA as ApiNode — the
#: A2A protocol does not bound individual call duration; batch-LLM agents
#: that call out to other agents need to wait for sub-agent runs.
_DEFAULT_HTTPX_TIMEOUT_SECONDS: float = 86_400.0

#: WayFlow's blocking-task timeout. Aligned with the ApiNode/httpx SLA so
#: blocking agent steps that wait on a batch LLM finish naturally rather than
#: emitting a -32603 "Time out error".
_DEFAULT_BLOCKING_TIMEOUT_SECONDS: int = 86_400

# ---------------------------------------------------------------------------
# Extract A2A user-message JSON inputs for start_conversation.
#
# Cinatra dispatcher (packages/agents/src/execution.ts L1053) sends
# `inputParams` plus `cinatra_run_id` as a JSON-stringified text part on the
# initial A2A user message. This helper preserves `cinatra_run_id`, aliases it
# to `agent_run_id` when needed, and keeps the original lift behavior for all
# other keys.
# ---------------------------------------------------------------------------


def _extract_start_inputs(message: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Parse the A2A user message's first text part as a JSON object.

    Returns the parsed dict (with run-id aliasing applied), or None when the
    message body isn't a usable JSON-object payload — caller should fall
    back to messages-only ``start_conversation`` behavior.

    Run-id propagation policy:
      - Preserve ``cinatra_run_id`` in the result (do NOT strip).
      - When the parsed dict carries ``cinatra_run_id`` but no
        ``agent_run_id``, copy the value across so Flow agents that declare
        ``agent_run_id`` as input (the legacy spelling) also get a usable
        run id.

    NOTE: WayFlow's ``Flow.start_conversation(inputs=...)`` STRICTLY rejects
    any key the Flow does not declare (raises ``ValueError: Input 'X'
    passed to start conversation is not an expected input of the Flow``).
    This helper does NOT filter against the Flow schema — that's the
    job of ``_filter_inputs_to_flow_schema`` at the call site. Both
    ``cinatra_run_id`` and the aliased ``agent_run_id`` survive here
    intentionally so the filter can keep whichever the target Flow
    declares.

    Failure modes that return None (caller falls back to messages-only):
      - ``message`` is None or has no ``parts``
      - ``parts[0]`` isn't a text part
      - ``parts[0].text`` isn't valid JSON
      - The decoded JSON isn't an object (e.g. a bare string or array)
      - The decoded object is empty after parsing
    """
    if not isinstance(message, dict):
        return None
    parts = message.get("parts") or []
    if not parts:
        return None
    p0 = parts[0]
    if not (
        isinstance(p0, dict)
        and p0.get("kind") == "text"
        and isinstance(p0.get("text"), str)
    ):
        return None
    try:
        parsed = json.loads(p0["text"])
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict) or not parsed:
        return None

    start_inputs: Dict[str, Any] = dict(parsed)
    cri = start_inputs.get("cinatra_run_id")
    if cri and "agent_run_id" not in start_inputs:
        start_inputs["agent_run_id"] = cri
    return start_inputs


def _filter_inputs_to_flow_schema(
    start_inputs: Optional[Dict[str, Any]],
    assistant: Any,
) -> Optional[Dict[str, Any]]:
    """Drop keys that aren't declared on the Flow's StartNode schema.

    WayFlow's ``Flow.start_conversation(inputs=...)`` raises
    ``ValueError: Input 'X' passed to start conversation is not an
    expected input of the Flow`` for any key the Flow does not declare.
    The Cinatra dispatcher always carries ``cinatra_run_id`` and may
    carry the ``agent_run_id`` alias added by ``_extract_start_inputs``;
    one or both are unknown to a given Flow depending on its naming
    convention.

    Returns the filtered dict, or None when ``start_inputs`` is falsy.

    Defensive: if ``assistant`` exposes no ``input_descriptors_dict``
    (older wayflowcore builds, non-Flow assistants), returns the inputs
    unchanged so we don't accidentally drop valid keys on a build where
    we can't introspect the schema. The caller's
    ``except TypeError``/``ValueError`` handlers cover any drift.
    """
    if not start_inputs:
        return start_inputs
    declared = getattr(assistant, "input_descriptors_dict", None)
    if not isinstance(declared, dict):
        return start_inputs
    declared_keys = set(declared.keys())
    return {k: v for k, v in start_inputs.items() if k in declared_keys}


# Surface EndNode declared outputs as a structured A2A DataPart so the Cinatra
# dispatcher can persist them into `agent_runs.step_results[0].output_data`
# without parsing the text history. Without this hook, structured EndNode
# outputs (e.g. web-research-agent's `items`/`failures`/`extractionNotes`,
# media-transcript-agent's `transcript`/`kind`) are only reachable by JSON-
# parsing the final assistant text, which is lossy and best-effort.
# ---------------------------------------------------------------------------


CINATRA_ENDNODE_OUTPUTS_SENTINEL = "__cinatra_endnode_outputs__"


def _is_jsonable(value: Any) -> bool:
    """Cheap probe: is `value` a primitive/list/dict that json.dumps will accept?

    Walks containers up to a small depth to keep this O(1)-ish on huge
    payloads. Anything that doesn't pass is omitted from the sentinel
    DataPart so the dispatcher's persisted JSONB column never blows up
    on a Pydantic model / dataclass / set / bytes.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return True
    if isinstance(value, list):
        return all(_is_jsonable(v) for v in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _is_jsonable(v) for k, v in value.items())
    return False


def _extract_endnode_outputs(status: Any, conversation: Any, assistant: Any) -> Dict[str, Any]:
    """Pull EndNode declared output values out of a FinishedStatus.

    Canonical path (wayflowcore 26.1.x): ``FinishedStatus.output_values``
    is a ``Dict[str, Any]`` populated by the executor with the final
    EndNode's resolved outputs. Confirmed via runtime inspection inside
    the wayflow container 2026-05-13.

    Fallback chain (defensive — preserves behavior on older builds or
    non-Flow assistants):
      1. ``status.output_values`` (canonical)
      2. ``getattr(getattr(status, 'complete_step', None), 'values', None)``
         (pre-26.1 internal name)
      3. ``getattr(getattr(conversation, 'flow_run', None), 'output_values', None)``
      4. ``{}`` (no extraction — caller skips sentinel append)

    Filtered to ``assistant.output_descriptors_dict.keys()`` when
    available so we never leak internal flow state. Non-JSONable values
    are dropped (logged once per task on the caller side).
    """
    candidates: List[Optional[Dict[str, Any]]] = []

    output_values = getattr(status, "output_values", None)
    if isinstance(output_values, dict):
        candidates.append(output_values)

    complete_step = getattr(status, "complete_step", None)
    if complete_step is not None:
        cs_values = getattr(complete_step, "values", None)
        if isinstance(cs_values, dict):
            candidates.append(cs_values)

    flow_run = getattr(conversation, "flow_run", None)
    if flow_run is not None:
        fr_outputs = getattr(flow_run, "output_values", None)
        if isinstance(fr_outputs, dict):
            candidates.append(fr_outputs)

    raw: Dict[str, Any] = {}
    for candidate in candidates:
        if candidate:
            raw = candidate
            break

    if not raw:
        return {}

    declared_keys: Optional[set] = None
    descriptors = getattr(assistant, "output_descriptors_dict", None)
    if isinstance(descriptors, dict):
        declared_keys = set(descriptors.keys())

    filtered: Dict[str, Any] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        if declared_keys is not None and key not in declared_keys:
            continue
        if not _is_jsonable(value):
            continue
        filtered[key] = value

    return filtered


# Placeholder substitution.
# ---------------------------------------------------------------------------


def _json_escape(s: str) -> str:
    """JSON-escape `s` for embedding inside a JSON string literal.

    Uses `json.dumps` and strips the surrounding quotes so every control
    character, quote, backslash, and Unicode escape is handled correctly per
    RFC 8259. Manual replace-chain misses `\\t`, `\\b`, `\\f`, and 0x00–0x1F
    controls.
    """
    return json.dumps(s)[1:-1]


def _substitute_placeholders(content: str) -> str:
    """Replace {{CINATRA_BASE_URL}} and any {{ENV_VAR}} placeholder in OAS text.

    WayFlow's A2AAgent constructor validates `agent_url` at load time using
    httpx URL parsing; an unsubstituted `{{CINATRA_BASE_URL}}/...` placeholder
    is rejected as malformed (Pitfall 2 / F-22). The legacy loader's behavior
    is preserved here so the loader loads the same agents the production
    loader did.

    Substitution rules:
      - {{CINATRA_BASE_URL}} → os.environ['CINATRA_BASE_URL']
        (default: http://host.docker.internal:3000)
      - {{ANY_OTHER_ENV_VAR}} → os.environ[name] if defined, else unchanged
      - Identifier syntax: uppercase letters, digits, underscore; must start
        with an UPPERCASE letter or underscore. Lowercase identifiers are
        intentionally rejected to keep substitutions explicit.

    Every substituted value is JSON-escaped via `_json_escape` so a
    misconfigured env var (e.g. `CINATRA_BASE_URL` containing a quote,
    backslash, newline, or control char) cannot corrupt the surrounding JSON
    document.
    """
    base_url = os.environ.get(
        "CINATRA_BASE_URL", "http://host.docker.internal:3000"
    )
    content = content.replace("{{CINATRA_BASE_URL}}", _json_escape(base_url))

    def _repl(m: "re.Match[str]") -> str:
        var_name = m.group(1)
        raw = os.environ.get(var_name)
        if raw is None:
            return m.group(0)
        return _json_escape(raw)

    return re.sub(r"\{\{([A-Z_][A-Z0-9_]*)\}\}", _repl, content)


# ---------------------------------------------------------------------------
# Bridge-token patches and supporting compatibility patches. All use the
# `__cinatra_patched__` idempotent sentinel.
#
# Each patch:
#   1. Imports its target class lazily (so host-side typecheck doesn't fail).
#   2. Checks for the sentinel and short-circuits if already applied.
#   3. Sets the sentinel on the new method object after re-binding.
# ---------------------------------------------------------------------------


def _patch_api_call_step_bridge_token() -> None:
    """Inject X-Cinatra-Bridge-Token on every outbound ApiNode HTTP call.

    Wraps ApiCallStep._execute_request to add the header before delegating.
    The token is read once at patch time (env vars don't change at runtime).
    No-op when the env var is unset; logs a one-line warning.
    """
    token = os.environ.get("CINATRA_BRIDGE_TOKEN")
    if not token:
        print(
            "[agent_loader] CINATRA_BRIDGE_TOKEN unset — X-Cinatra-Bridge-Token "
            "header NOT injected on ApiCallStep calls. Cinatra rejects requests "
            "with HTTP 403 when the token is missing or wrong "
            "(no BYPASS / XFF fallback). Set CINATRA_BRIDGE_TOKEN in this "
            "container's env to restore connectivity."
        )
        return

    try:
        from wayflowcore.steps import ApiCallStep  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover
        print(f"[agent_loader] WARNING: bridge token patch import failed: {exc}")
        return

    if getattr(ApiCallStep._execute_request, "__cinatra_patched__", False):
        return  # idempotent

    _original = ApiCallStep._execute_request

    async def _patched(self: Any, request: Dict[str, Any]) -> Any:
        # request["headers"] may be absent when the ApiNode declares no
        # headers. setdefault preserves any agent.json-declared headers and
        # adds ours.
        request.setdefault("headers", {})
        request["headers"]["X-Cinatra-Bridge-Token"] = token
        # Inject X-Cinatra-A2A-Context-Id for the internal bridge/context
        # ApiNode calls so the run context can be resolved + bound server-side.
        # The context routes (context-resolve/context-finalize) fail closed when
        # the header is present-but-unresolvable, so injecting it for every
        # in-conversation call keeps them context-bound (not body-trusting).
        _ctx_id = _WAYFLOW_CONTEXT_ID.get()
        _ctx_url = str(request.get("url", ""))
        if _ctx_id and (
            "llm-bridge" in _ctx_url
            or "context-resolve" in _ctx_url
            or "context-finalize" in _ctx_url
        ):
            request["headers"]["X-Cinatra-A2A-Context-Id"] = _ctx_id
        # ApiNode timeout policy — aligned for batch LLM workloads.
        #
        # Default httpx timeout is 5 s. Real-world ApiNode calls span:
        #   - LLM-driven web_search calls: ~57 s
        #   - OpenAI batch API polling: minutes to 24 h
        #   - Streaming MCP tool responses: 60-300 s
        #
        # Setting a 24 h (86_400 s) default ApiNode timeout supports the
        # worst case (batch LLM SLA). Cinatra does not configure an
        # explicit BullMQ job timeout (src/lib/background-jobs.ts), so
        # this 24 h ceiling IS the practical upper bound for a single
        # in-flight ApiNode call. Operators who need a shorter cap should
        # declare it explicitly on the ApiNode in the OAS — `setdefault`
        # honors any caller-declared timeout.
        request.setdefault("timeout", _DEFAULT_APINODE_TIMEOUT_SECONDS)
        return await _original(self, request)

    _patched.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched.__wrapped__ = _original  # type: ignore[attr-defined]
    ApiCallStep._execute_request = _patched  # type: ignore[method-assign]
    print(
        "[agent_loader] ApiCallStep._execute_request patched "
        "(X-Cinatra-Bridge-Token injection enabled)"
    )


def _patch_a2a_agent_bridge_token() -> None:
    """Inject X-Cinatra-Bridge-Token on A2AAgent outbound A2A protocol calls.

    A2AAgent's HTTP calls (agent-card discovery GET + send_message POST) go
    through httpx.AsyncClient directly and bypass ApiCallStep. Wrap
    httpx.AsyncClient.send so any request whose host:port matches
    CINATRA_BASE_URL gets the token. External provider calls (openai.com,
    anthropic.com, etc.) do not match and are unaffected.
    """
    token = os.environ.get("CINATRA_BRIDGE_TOKEN")
    if not token:
        print(
            "[agent_loader] _patch_a2a_agent_bridge_token: "
            "CINATRA_BRIDGE_TOKEN unset — skipping"
        )
        return

    base_url = os.environ.get(
        "CINATRA_BASE_URL", "http://host.docker.internal:3000"
    )
    parsed = _urlparse.urlparse(base_url)
    proxy_host = (parsed.hostname or "host.docker.internal").lower()
    proxy_port = parsed.port or 3000

    try:
        import httpx as _httpx
    except Exception as exc:  # pragma: no cover
        print(
            f"[agent_loader] WARNING: _patch_a2a_agent_bridge_token: "
            f"httpx import failed: {exc}"
        )
        return

    if getattr(_httpx.AsyncClient.send, "__cinatra_patched__", False):
        return  # idempotent

    _orig_send = _httpx.AsyncClient.send

    async def _patched_send(self: Any, request: Any, **kwargs: Any) -> Any:
        if (
            (request.url.host or "").lower() == proxy_host
            and request.url.port == proxy_port
        ):
            request.headers["X-Cinatra-Bridge-Token"] = token
        return await _orig_send(self, request, **kwargs)

    _patched_send.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched_send.__wrapped__ = _orig_send  # type: ignore[attr-defined]
    _httpx.AsyncClient.send = _patched_send  # type: ignore[method-assign]
    print(
        f"[agent_loader] httpx.AsyncClient.send patched (bridge token, "
        f"target {proxy_host}:{proxy_port})"
    )


def _patch_a2a_agent_no_shared_conversation() -> None:
    """Skip init-messages on A2AAgent.start_conversation.

    When AgentExecutionStep uses _share_conversation=True (the default), the
    full parent flow conversation is passed as init_messages to
    A2AAgent.start_conversation. A2AAgentExecutor.execute_async then sends ALL
    these messages to the remote A2A server (last_message_idx=-1 means 'send
    everything'), causing the child agent to receive the parent flow's full
    conversation history as separate send_message calls.

    Fix: initialize last_message_idx to len(messages)-1 so only messages
    added AFTER the A2AAgent conversation was created are sent.
    """
    try:
        from wayflowcore.a2a.a2aagent import A2AAgent  # type: ignore[import-not-found]
        from wayflowcore.messagelist import MessageList  # type: ignore[import-not-found]
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_a2a_agent_no_shared_conversation: "
            f"import failed: {exc}"
        )
        return

    if getattr(A2AAgent.start_conversation, "__cinatra_patched__", False):
        return  # idempotent

    _orig_start = A2AAgent.start_conversation

    def _patched_start(
        self: Any, inputs: Any = None, messages: Any = None, **kw: Any
    ) -> Any:
        conv = _orig_start(self, inputs=inputs, messages=messages, **kw)
        # Advance last_message_idx to skip all init messages so execute_async
        # only sends messages added AFTER this conversation was started.
        if messages is not None:
            if isinstance(messages, MessageList):
                init_count = len(messages.messages)
            elif isinstance(messages, list):
                init_count = len(messages)
            else:
                init_count = 0
            if init_count > 0:
                conv.state.last_message_idx = init_count - 1
        return conv

    _patched_start.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched_start.__wrapped__ = _orig_start  # type: ignore[attr-defined]
    A2AAgent.start_conversation = _patched_start  # type: ignore[method-assign]
    print(
        "[agent_loader] A2AAgent.start_conversation patched "
        "(no shared conversation — init messages skipped)"
    )


def _patch_wayflow_flow_skip_pre_execute() -> None:
    """Skip the pre-execute phase in A2AAgentWorker for WayflowFlow agents.

    WayFlow 26.1.x pre-executes a WayflowFlow up to its first InputMessageStep
    before appending the caller's initial message. This sets
    `asked_user = True` inside the step, so the very next execute_async() call
    treats the caller's trigger message as the user's form response rather than
    a trigger.

    For Cinatra flows the trigger message is not form data. The correct
    behaviour is for the first execute_async() (after the trigger is appended)
    to hit the InputMessageStep in its INITIAL state (`asked_user` unset), so
    it yields and the task transitions to `input-required`. Cinatra then shows
    the HITL form, collects real form data, and resumes the task.

    Upstream issue: https://github.com/oracle/wayflow/issues/151
    """
    try:
        from wayflowcore.agentserver.a2a._worker import (  # type: ignore[import-not-found]
            A2AAgentWorker,
        )
        from wayflowcore.flow import Flow as WayflowFlow  # type: ignore[import-not-found]
        from wayflowcore.steps import InputMessageStep  # type: ignore[import-not-found]
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_wayflow_flow_skip_pre_execute: "
            f"import failed: {exc}"
        )
        return

    if getattr(A2AAgentWorker.run_task, "__cinatra_patched__", False):
        return  # idempotent

    _orig_run_task = A2AAgentWorker.run_task

    async def _patched_run_task(self: Any, params: Any) -> None:
        # Temporarily suppress the pre-execute for WayflowFlow agents that
        # start with an InputMessageStep. We do this by monkey-patching the
        # `isinstance` check: before calling the original run_task, we mark
        # the assistant so the pre-execute block is skipped, then remove the
        # mark immediately after.
        #
        # Simpler approach: replace run_task wholesale, replicating its logic
        # minus the pre-execute block. We copy the upstream implementation
        # rather than wrapping so any future upstream change is visible at the
        # call site (the validate_live_class_names guard will catch renames).
        from typing import cast

        from wayflowcore.agentserver.a2a._converter import (  # type: ignore[import-not-found]
            _convert_a2a_messages_to_wayflow_messages,
            _convert_wayflow_messages_to_a2a_messages,
        )
        from wayflowcore.executors.executionstatus import (  # type: ignore[import-not-found]
            FinishedStatus,
            ToolRequestStatus,
            UserMessageRequestStatus,
        )

        # Capture task_id BEFORE any await — the outer finally must always
        # be able to notify, even if `storage.load_task` itself raises.
        _task_id_for_notify = params["id"]

        try:
            task = await self.storage.load_task(params["id"])
            if task is None:
                raise ValueError(f'Task {params["id"]} not found')
            if task["status"]["state"] not in ["submitted"]:
                raise ValueError(
                    f'Task {params["id"]} has already been processed '
                    f'(state: {task["status"]["state"]})'
                )

            await self.storage.update_task(task_id=task["id"], state="working")

            # Propagate context_id to ApiCallStep via ContextVar so
            # X-Cinatra-A2A-Context-Id is injected on llm-bridge calls.
            _ctx_token = _WAYFLOW_CONTEXT_ID.set(task.get("context_id", "") or "")

            prioritize_task = params.get("metadata", {}).get("prioritize_task", False)
            tools_dict = self.assistant._referenced_tools_dict()
            if prioritize_task:
                conversation = await self.storage.load_task_conversation(
                    task_id=task["id"],
                    tools_dict=tools_dict,
                )
            else:
                conversation = await self.storage.load_context_conversation(
                    context_id=task["context_id"],
                    tools_dict=tools_dict,
                )

            needs_new_conv = conversation is None or not isinstance(
                conversation.status, UserMessageRequestStatus
            )

            if needs_new_conv:
                messages = None if conversation is None else conversation.message_list
                # Lift Cinatra dispatcher's JSON message body into
                # `start_conversation(inputs=...)`. See the
                # `_extract_start_inputs` docstring above for the run-id
                # propagation policy (preserve `cinatra_run_id`; alias to
                # `agent_run_id` when missing).
                _raw_start_inputs = _extract_start_inputs(params.get("message"))

                # WayFlow's `Flow.start_conversation(inputs=...)` raises
                # `ValueError: Input 'X' passed to start conversation is not
                # an expected input of the Flow` for ANY key not declared on
                # the Flow. Cinatra's dispatcher always sends
                # `cinatra_run_id`, and the run-id alias above adds
                # `agent_run_id` defensively — but the two are mutually
                # exclusive across our agent catalog (each flow declares
                # ONE or the OTHER, never both). Filter the parsed inputs
                # down to the keys this specific flow actually declares so
                # passing both aliases is safe regardless of convention.
                _start_inputs = _filter_inputs_to_flow_schema(
                    _raw_start_inputs, self.assistant
                )

                if _start_inputs:
                    try:
                        conversation = self.assistant.start_conversation(
                            messages=messages, inputs=_start_inputs
                        )
                    except TypeError as _start_exc:
                        # WayFlow signatures vary across pyagentspec / wayflowcore
                        # versions: 26.1.x accepts `inputs=`; older builds raise
                        # `TypeError: start_conversation() got an unexpected
                        # keyword argument 'inputs'`. Fall back ONLY for that
                        # exact signature mismatch — any other TypeError
                        # (e.g. a real bug inside start_conversation) must
                        # propagate. Other TypeErrors must surface normally.
                        _msg_str = str(_start_exc)
                        if "unexpected keyword argument" in _msg_str and "'inputs'" in _msg_str:
                            print(
                                "[agent_loader] start_conversation does not accept "
                                "inputs= on this wayflowcore build — falling back "
                                "to messages-only. Flow agents with required "
                                "StartNode inputs will hard-fail until the "
                                "wayflowcore pin is bumped."
                            )
                            conversation = self.assistant.start_conversation(
                                messages=messages
                            )
                        else:
                            raise
                else:
                    conversation = self.assistant.start_conversation(messages=messages)
                # Intentionally skip the upstream pre-execute block here.
                # See _patch_wayflow_flow_skip_pre_execute docstring and
                # https://github.com/oracle/wayflow/issues/151 for rationale.

            from typing import cast as _cast
            conversation = _cast(object, conversation)

            a2a_input_message = params["message"]
            wayflow_input_message = _convert_a2a_messages_to_wayflow_messages(
                [a2a_input_message]
            )[0]
            conversation.append_message(wayflow_input_message)  # type: ignore[union-attr]

            try:
                status = await conversation.execute_async()  # type: ignore[union-attr]

                new_wayflow_messages = []
                for message in reversed(conversation.get_messages()):  # type: ignore[union-attr]
                    if message.role == "assistant":
                        new_wayflow_messages.append(message)
                    else:
                        break
                new_wayflow_messages.reverse()

                new_a2a_messages = _convert_wayflow_messages_to_a2a_messages(
                    new_wayflow_messages
                )
            except Exception as _exc:
                import traceback as _tb
                print(f"[agent_loader] _patched_run_task EXCEPTION task={task['id']}: {_exc}")
                print(_tb.format_exc())
                await self.storage.update_task(task["id"], state="failed")
                raise
            else:
                if isinstance(status, UserMessageRequestStatus) or isinstance(
                    status, ToolRequestStatus
                ):
                    task_state = "input-required"
                elif isinstance(status, FinishedStatus):
                    task_state = "completed"
                    # Prepend (NOT append) a synthetic A2A DataPart message
                    # carrying the EndNode declared output values under the sentinel key
                    # `__cinatra_endnode_outputs__`. The Cinatra
                    # dispatcher
                    # (packages/agents/src/execution.ts:handleWayflowTaskState)
                    # recognizes the sentinel, surfaces the structured
                    # values as `stepResults[0].output_data`, and strips
                    # the sentinel from the persisted history so chat UIs
                    # never render it.
                    #
                    # Insertion position matters for mixed-version tolerance:
                    # older TS consumers walk
                    # `history.slice().reverse().find(role===agent)` to find
                    # the last assistant text. If the sentinel message
                    # (role="agent", DataPart-only, no TextPart) were appended
                    # last, older code would read finalText as empty. Inserting
                    # at index 0 keeps the real final-assistant text at the tail
                    # of history, while newer code can still find the sentinel.
                    #
                    # Defensive: only fires for FinishedStatus (never
                    # partial / interrupt / failed); extraction failures
                    # are swallowed so a missing/renamed wayflowcore
                    # attribute can't destabilize the completion path.
                    try:
                        end_outputs = _extract_endnode_outputs(
                            status, conversation, self.assistant
                        )
                        if end_outputs:
                            new_a2a_messages.insert(
                                0,
                                {
                                    "kind": "message",
                                    "role": "agent",
                                    "message_id": f"cinatra-endnode-outputs-{task['id']}",
                                    "parts": [
                                        {
                                            "kind": "data",
                                            "data": {
                                                CINATRA_ENDNODE_OUTPUTS_SENTINEL: end_outputs,
                                            },
                                        }
                                    ],
                                },
                            )
                    except Exception as _outputs_exc:
                        print(
                            f"[agent_loader] _patched_run_task: end-node "
                            f"outputs extraction failed task={task['id']}: "
                            f"{_outputs_exc}"
                        )
                else:
                    task_state = "completed"

                await self.storage.update_task(
                    task["id"],
                    state=task_state,
                    new_messages=new_a2a_messages,
                )
                await self.storage.update_task_conversation(
                    context_id=task["context_id"],
                    task_id=task["id"],
                    conv=conversation,
                )
        except Exception as _outer_exc:
            # CINATRA HANG FIX: a raise from BEFORE the inner try-block (e.g.
            # `start_conversation`, `_referenced_tools_dict`, conversion or
            # `append_message`) would otherwise leave the blocking-mode
            # handler waiting up to 24h. fasta2a's
            # `Worker._handle_task_operation` swallows the exception and
            # only marks the task failed in storage — it does NOT call
            # `notifier.notify`, so `TaskManager.send_message`'s
            # `notifier.wait_for(task_id, timeout=86400)` never wakes up.
            # Mark the task failed defensively, then re-raise. The outer
            # `finally` block guarantees `notify` runs on any exit path.
            import traceback as _tb_outer
            print(
                f"[agent_loader] _patched_run_task OUTER EXCEPTION "
                f"task={_task_id_for_notify}: {_outer_exc}"
            )
            print(_tb_outer.format_exc())
            try:
                await self.storage.update_task(_task_id_for_notify, state="failed")
            except Exception as _store_exc:
                print(
                    f"[agent_loader] _patched_run_task: storage.update_task "
                    f"to failed also raised for task={_task_id_for_notify}: "
                    f"{_store_exc}"
                )
            raise
        finally:
            # CINATRA HANG FIX: always notify, regardless of success/failure
            # path. anyio.Event.set() is idempotent, so success paths that
            # already notified are unaffected. This guarantees blocking-mode
            # HTTP requests return promptly when the task transitions to a
            # terminal state — defense-in-depth against any early-raise path
            # not anticipated above.
            try:
                await self.notifier.notify(_task_id_for_notify)
            except Exception as _notify_exc:
                print(
                    f"[agent_loader] _patched_run_task: notifier.notify "
                    f"raised for task={_task_id_for_notify}: {_notify_exc}"
                )

    _patched_run_task.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched_run_task.__wrapped__ = _orig_run_task  # type: ignore[attr-defined]
    A2AAgentWorker.run_task = _patched_run_task  # type: ignore[method-assign]
    print(
        "[agent_loader] A2AAgentWorker.run_task patched "
        "(WayflowFlow pre-execute skipped — see github.com/oracle/wayflow/issues/151)"
    )


# ---------------------------------------------------------------------------


def _is_apinode_only_flow(agent: Any) -> bool:
    """Return True if `agent` is a Flow whose steps lack BOTH InputMessageStep AND AgentExecutionStep.

    Replaces the fragile `"Only support Flow" not in str(exc)` substring match
    with a structural check.

    Inverts the predicate from a positive allowlist, which silently rejected
    `StartStep`, `OutputMessageStep`, and `CompleteStep` even though a flow
    containing those still lacks the chat steps wayflowcore requires. The
    wayflowcore validation rejects any flow without an InputMessageStep OR
    AgentExecutionStep — so the correct bypass condition is exactly
    `flow has neither step type`. Any other shape falls through and re-raises
    the original ValueError.

    The check inspects `agent.steps` (when `agent` IS a Flow) or
    `agent.flow.steps` (when the agent wraps a flow). False when there are
    no steps to inspect (defensive — let the unrelated ValueError bubble up
    unchanged).
    """
    # Flow may be the agent itself (drupal/wordpress content editors are
    # `component_type: Flow` at the OAS root) or nested under `agent.flow`.
    steps = getattr(agent, "steps", None)
    if steps is None:
        flow = getattr(agent, "flow", None)
        if flow is None:
            return False
        steps = getattr(flow, "steps", None)
    if isinstance(steps, dict):
        step_iter = list(steps.values())
    elif isinstance(steps, (list, tuple)):
        step_iter = list(steps)
    else:
        return False
    if not step_iter:
        return False
    chat_step_classes = {"InputMessageStep", "AgentExecutionStep"}
    for step in step_iter:
        if type(step).__name__ in chat_step_classes:
            return False
    return True


def _patch_serve_agent_flow_validation() -> None:
    """Bypass serve_agent validation for ApiNode-only flows (content editors).

    WayFlow 26.1.x raises ValueError inside serve_agent when a Flow has no
    InputMessageStep or AgentExecutionStep. One-shot content-editor flows
    (drupal/wordpress) use only ApiNode and are valid but fail this check.

    Gate the bypass on a STRUCTURAL check (`_is_apinode_only_flow`) rather
    than a substring of the upstream error message. Unrelated ValueErrors are
    re-raised unchanged. We also assert `self.agent` is set before relying on
    it, so a future wayflowcore change that rearranges serve_agent's assignment
    order surfaces loudly rather than constructing a worker with a None
    assistant.
    """
    try:
        from wayflowcore.agentserver.server import (  # type: ignore[import-not-found]
            A2AServer as _Server,
        )
        from wayflowcore.agentserver.a2a._task_manager import (  # type: ignore[import-not-found]
            TaskNotifier,
        )
        from wayflowcore.agentserver.a2a._worker import (  # type: ignore[import-not-found]
            A2AAgentWorker,
        )
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_serve_agent_flow_validation: "
            f"import failed: {exc}"
        )
        return

    if getattr(_Server.serve_agent, "__cinatra_patched__", False):
        return  # idempotent

    _orig = _Server.serve_agent

    def _patched(self: Any, agent: Any, url: Any = None) -> None:
        try:
            _orig(self, agent, url)
            return
        except ValueError as exc:
            # Structural gate. Unrelated ValueErrors propagate.
            if not _is_apinode_only_flow(agent):
                raise
            # Defensive: serve_agent's upstream impl is expected to set
            # self.agent BEFORE raising. If a future wayflowcore version
            # rearranges this, fall back to the input parameter and log
            # loudly so the regression is visible at startup.
            if getattr(self, "agent", None) is None:
                print(
                    "[agent_loader] WARNING: serve_agent raised before "
                    "assigning self.agent; using input agent as fallback. "
                    f"Original error: {exc}"
                )
                self.agent = agent
            self._task_notifier = TaskNotifier()
            self._worker = A2AAgentWorker(
                broker=self._broker,
                storage=self._storage,
                assistant=self.agent,
                notifier=self._task_notifier,
            )
            self.url = url
            print(
                f"[agent_loader] serve_agent validation bypassed for "
                f"ApiNode-only flow: {getattr(agent, 'id', '?')}"
            )

    _patched.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched.__wrapped__ = _orig  # type: ignore[attr-defined]
    _Server.serve_agent = _patched  # type: ignore[method-assign]
    print(
        "[agent_loader] A2AServer.serve_agent patched "
        "(ApiNode-only flow validation bypassed)"
    )


# ---------------------------------------------------------------------------
# Module-level helpers for in-progress-marker bookkeeping.
#
# Lifted out of the closure in `_patch_pyagentspec_deserialization_error_mask`
# so they can be unit-tested directly. The closure-internal version
# can't be exercised in isolation because the patched `deserialize`
# captures `_orig_deserialize` at patch-installation time; any attempt
# to stub-out the recovery path post-installation re-enters the same
# closure-captured fallback. Hoisting these to module scope gives the
# regression test a clean seam.
#
# `_DeserializationInProgressMarker` is imported lazily at first call
# (NOT at module load) so the import failure mode is no different from
# inside the closure: if the symbol moves or disappears in a future
# pyagentspec release, the helpers no-op gracefully and the cycle
# false-positive may resurface — error path is no worse than the stock
# container.
# ---------------------------------------------------------------------------


def _resolve_inprogress_marker_class() -> Optional[type]:
    """Lazy lookup of `_DeserializationInProgressMarker`.

    Returns None on layout drift so callers can short-circuit cleanly.
    """
    try:
        from pyagentspec.serialization.deserializationcontext import (  # type: ignore[import-not-found]
            _DeserializationInProgressMarker,
        )
    except Exception:
        return None
    return _DeserializationInProgressMarker


def _snapshot_inprogress_marker_keys(deserialization_context: Any) -> set:
    """Return the set of `loaded_references` keys whose value is currently
    an in-progress marker. Empty set on any layout drift.
    """
    marker_cls = _resolve_inprogress_marker_class()
    if marker_cls is None:
        return set()
    ctx_refs = getattr(deserialization_context, "loaded_references", None)
    if not isinstance(ctx_refs, dict):
        return set()
    return {k for k, v in ctx_refs.items() if isinstance(v, marker_cls)}


def _scrub_stale_inprogress_markers(
    deserialization_context: Any, baseline_keys: set
) -> None:
    """Remove `_DeserializationInProgressMarker` entries from
    `loaded_references` whose key is NOT in `baseline_keys`.

    Used by `_patch_pyagentspec_deserialization_error_mask` to scrub
    markers added during a failed first pass of
    `_resolve_content_and_build` so the `_orig_deserialize` retry does
    not re-enter `_load_reference` on a stale marker and raise a
    false-positive circular-dependency error that masks the real
    underlying ValidationError / TypeError. Defensive on layout drift:
    silently no-ops if `_DeserializationInProgressMarker` import fails
    or `loaded_references` is not a dict.

    See `_patch_pyagentspec_deserialization_error_mask` for the full diagnosis.
    """
    marker_cls = _resolve_inprogress_marker_class()
    if marker_cls is None:
        return
    ctx_refs = getattr(deserialization_context, "loaded_references", None)
    if not isinstance(ctx_refs, dict):
        return
    stale = {
        k
        for k, v in ctx_refs.items()
        if isinstance(v, marker_cls) and k not in baseline_keys
    }
    for k in stale:
        del ctx_refs[k]


def _patch_pyagentspec_deserialization_error_mask() -> None:
    """Unmask pyagentspec 26.1.0's `'error' required in context`.

    Upstream defect in
    `pyagentspec/serialization/pydanticdeserializationplugin.py:52-60`:
    on validation failure, the plugin constructs
    `InitErrorDetails(type=e.type, loc=e.loc, input=())` and feeds it to
    `ValidationError.from_exception_data(...)`. Pydantic v2 raises
    `TypeError: ValueError: 'error' required in context` whenever
    `type == "value_error"` and `ctx['error']` is missing — the real
    validation message is swallowed inside the secondary TypeError.

    This patch wraps the plugin's `deserialize` so that when it constructs
    `InitErrorDetails` for a `value_error`, we inject
    `ctx={"error": ValueError(<msg>)}` (preserving any pre-existing `ctx`).
    Non-`value_error` types are passed through unchanged. The result: the
    real pyagentspec validation message surfaces directly to the
    `agent_loader` per-agent loop instead of the misleading TypeError.

    Implementation notes:
    - Idempotent via the `_cinatra_error_mask_patch_applied` sentinel on
      the plugin class — re-imports are a no-op.
    - Touches `deserialize` only. `_partial_deserialize` already returns
      `validation_errors` as a list (no raise), so it's unaffected.
    - Preserves the original method signature exactly.
    - Diagnostic-only: does not change which agents mount or what
      validation rules apply; just makes the existing rejection legible.
    - If the upstream layout changes (no `InitErrorDetails` import,
      attribute renamed, etc.), the broad `except Exception` falls back
      to logging a warning and leaves the original `deserialize` in
      place. `_validate_live_class_names` will then catch the missing
      binding at startup.

    Remove this helper once pyagentspec ships the fix upstream and the
    pinned version in docker/wayflow/Dockerfile is bumped past it.
    """
    try:
        from pyagentspec.serialization.pydanticdeserializationplugin import (  # type: ignore[import-not-found]
            PydanticComponentDeserializationPlugin,
        )
        from pydantic_core import (  # type: ignore[import-not-found]
            InitErrorDetails,
            ValidationError,
        )
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_pyagentspec_deserialization_error_mask: "
            f"import failed: {exc}"
        )
        return

    if getattr(
        PydanticComponentDeserializationPlugin,
        "_cinatra_error_mask_patch_applied",
        False,
    ):
        return  # idempotent — re-import / test re-run safe

    _orig_deserialize = PydanticComponentDeserializationPlugin.deserialize

    def _patched_deserialize(
        self: Any,
        serialized_component: Dict[str, Any],
        deserialization_context: Any,
    ) -> Any:
        # Snapshot in-progress marker keys BEFORE the first pass so we can
        # scrub markers added during a failed pass before the
        # `_orig_deserialize` retry.
        _baseline_inprogress = _snapshot_inprogress_marker_keys(
            deserialization_context
        )
        # Fast path: try the real deserialize. Almost all calls succeed
        # without producing validation_errors, so we should not impose
        # any cost on the success path.
        try:
            component, validation_errors = self._resolve_content_and_build(
                serialized_component=serialized_component,
                deserialization_context=deserialization_context,
            )
        except Exception:
            # Signature drift in `_resolve_content_and_build` (positional vs
            # keyword args, return-shape change, etc.) or inner
            # ValidationError / TypeError raised during a partial first pass
            # should fall back to the original `deserialize` so the loader
            # fails closed in exactly the same way as a stock container — but
            # scrub any in-progress markers placed during the failed pass FIRST
            # so the retry doesn't hit a false-positive `_load_reference` cycle
            # on the stale marker.
            _scrub_stale_inprogress_markers(
                deserialization_context, _baseline_inprogress
            )
            return _orig_deserialize(
                self, serialized_component, deserialization_context
            )
        if len(validation_errors) == 0:
            return component

        # Rewrap pyagentspec's `validation_errors` list with the missing
        # ctx so pydantic_core stops raising TypeError instead of the
        # real ValidationError. Mirrors the upstream code exactly except
        # for the value_error ctx injection.
        try:
            line_errors = []
            for e in validation_errors:
                kwargs: Dict[str, Any] = {
                    "type": e.type,
                    "loc": e.loc,
                    "input": (),
                }
                existing_ctx = getattr(e, "ctx", None)
                if e.type == "value_error":
                    merged_ctx: Dict[str, Any] = (
                        dict(existing_ctx)
                        if isinstance(existing_ctx, dict)
                        else {}
                    )
                    if "error" not in merged_ctx:
                        merged_ctx["error"] = ValueError(getattr(e, "msg", ""))
                    kwargs["ctx"] = merged_ctx
                elif isinstance(existing_ctx, dict):
                    kwargs["ctx"] = dict(existing_ctx)
                line_errors.append(InitErrorDetails(**kwargs))

            raise ValidationError.from_exception_data(
                title=component.__class__.__name__,
                line_errors=line_errors,
            )
        except (TypeError, KeyError, AttributeError) as exc:
            # `InitErrorDetails(**kwargs)` constructor drift or attribute
            # rename on `PyAgentSpecErrorDetails` means our rewrap path
            # broke. Fall back to the original `deserialize` — operators
            # see the original masked TypeError (no worse than the stock
            # container) and the breakage surfaces loudly on the next
            # rebuild via `_validate_live_class_names`.
            # Scrub stale markers from the failed first pass so the fallback
            # retry doesn't false-positive a cycle.
            _scrub_stale_inprogress_markers(
                deserialization_context, _baseline_inprogress
            )
            print(
                f"[agent_loader] WARNING: pyagentspec error-mask fallback "
                f"engaged ({type(exc).__name__}: {exc}); delegating to "
                f"upstream PydanticComponentDeserializationPlugin.deserialize"
            )
            return _orig_deserialize(
                self, serialized_component, deserialization_context
            )

    _patched_deserialize.__wrapped__ = _orig_deserialize  # type: ignore[attr-defined]
    PydanticComponentDeserializationPlugin.deserialize = _patched_deserialize  # type: ignore[method-assign]
    PydanticComponentDeserializationPlugin._cinatra_error_mask_patch_applied = True  # type: ignore[attr-defined]
    print(
        "[agent_loader] PydanticComponentDeserializationPlugin.deserialize patched "
        "(unmask pyagentspec 'error' required in context)"
    )


# ---------------------------------------------------------------------------
# Live-class-name guard. Runs once at startup after all patches are applied.
#
# Why: the four method-level patches above fail loudly if the bound method
# disappears (`Class.method = patched` raises AttributeError). The single
# string-name predicate `_is_apinode_only_flow` does NOT — it compares
# `type(step).__name__` against a hard-coded set, so a wayflowcore rename
# would silently misclassify flows. This guard fails the container at startup
# with an actionable message instead of letting requests silently route through
# the wrong branch in production.
# ---------------------------------------------------------------------------


# Symbols the loader binds against. Each tuple: (qualified import path,
# attribute name to verify on the imported class). Method bindings cover the
# four patches; the bare-class entries cover the string-name predicate set.
_LIVE_CLASS_BINDINGS: Tuple[Tuple[str, str, Optional[str]], ...] = (
    ("wayflowcore.steps", "ApiCallStep", "_execute_request"),
    ("wayflowcore.steps", "InputMessageStep", None),
    ("wayflowcore.steps", "AgentExecutionStep", None),
    ("wayflowcore.a2a.a2aagent", "A2AAgent", "start_conversation"),
    ("wayflowcore.agentserver", "A2AServer", "serve_agent"),
    (
        "pyagentspec.serialization.pydanticdeserializationplugin",
        "PydanticComponentDeserializationPlugin",
        "deserialize",
    ),
    # wayflowcore Extended ParallelFlowNode ordering patch. Bound at
    # `_patch_parallel_flow_node_extended_order`. We list both the basic and
    # Extended pyagentspec classes (bare-class entries, `method_attr=None`) so
    # a future wayflowcore bump that renames or removes either trips
    # `_validate_live_class_names` at startup instead of silently letting the
    # Extended class go unhandled.
    (
        "pyagentspec.flows.nodes.parallelflownode",
        "ParallelFlowNode",
        None,
    ),
    (
        "wayflowcore.agentspec.components",
        "ExtendedParallelFlowNode",
        None,
    ),
    (
        "wayflowcore.steps.parallelflowexecutionstep",
        "ParallelFlowExecutionStep",
        None,
    ),
    # pyagentspec `_is_python_primitive_type` guard. Bound at
    # `_patch_pyagentspec_is_python_primitive_type_guard`. The patched method
    # lives on the private `_DeserializationContextImpl` subclass; if
    # pyagentspec ever renames or hoists the method to a different class, the
    # patch installation logs a warning and skips, but the startup guard
    # surfaces the binding loss explicitly.
    (
        "pyagentspec.serialization.deserializationcontext",
        "_DeserializationContextImpl",
        "_is_python_primitive_type",
    ),
    # pyagentspec A2A timeout defaults patched in
    # `_patch_a2a_pydantic_timeouts`. If pyagentspec renames these classes the
    # patch silently skips; the live class-name guard surfaces the binding loss
    # at startup instead.
    (
        "pyagentspec.a2aagent",
        "A2ASessionParameters",
        None,
    ),
    (
        "pyagentspec.a2aagent",
        "A2AConnectionConfig",
        None,
    ),
)


def _wayflowcore_version() -> str:
    try:
        from importlib.metadata import version  # type: ignore[import-not-found]

        return version("wayflowcore")
    except Exception:  # pragma: no cover — defensive
        return "unknown"


def _patch_blocking_timeout() -> None:
    """Raise wayflowcore's blocking-task timeout to the batch-LLM SLA
    (`_DEFAULT_BLOCKING_TIMEOUT_SECONDS`, currently 24 h).

    When a WayFlow task uses configuration.blocking=True the task manager
    waits up to _BLOCKING_REQUESTS_MAX_TIME_SECONDS before returning a
    -32603 "Time out error". This patch aligns it with the ApiNode + A2A
    Pydantic timeouts so a blocking step in a batch-LLM-orchestrating flow can
    wait for the batch to land (up to 24 h per OpenAI batch SLA). The A2A spec
    does not mandate a particular blocking-timeout value — this is a
    wayflowcore implementation detail, so extending it is spec-compliant. Cinatra
    does NOT currently configure a BullMQ job timeout, so this 24 h
    ceiling IS the practical upper bound for a single blocking task
    slot; operators who want a shorter cap should declare it explicitly
    on the WayFlow request or upstream (MCP `agent_run.timeoutSeconds`
    accepts values 1-86400).
    """
    try:
        import wayflowcore.agentserver.a2a._task_manager as _tm  # type: ignore[import-not-found]
    except Exception as exc:
        print(f"[agent_loader] WARNING: blocking-timeout patch import failed: {exc}")
        return

    current = getattr(_tm, "_BLOCKING_REQUESTS_MAX_TIME_SECONDS", None)
    if current is None:
        print(
            "[agent_loader] WARNING: _BLOCKING_REQUESTS_MAX_TIME_SECONDS not found in "
            "_task_manager — blocking timeout not patched"
        )
        return

    _tm._BLOCKING_REQUESTS_MAX_TIME_SECONDS = _DEFAULT_BLOCKING_TIMEOUT_SECONDS
    print(
        f"[agent_loader] _BLOCKING_REQUESTS_MAX_TIME_SECONDS patched "
        f"{current} → {_DEFAULT_BLOCKING_TIMEOUT_SECONDS} s "
        f"(aligned with ApiNode SLA for batch LLM workloads)"
    )


def _patch_a2a_pydantic_timeouts() -> None:
    """Align pyagentspec A2A Pydantic default timeouts with the global batch
    LLM SLA.

    Two pyagentspec defaults are too short for batch-LLM workflows:
      - A2ASessionParameters.timeout = 60.0   — overall session timeout
      - A2AConnectionConfig.timeout  = 600.0  — per-HTTP-request timeout

    A batch-LLM-orchestrating A2A agent flow can take 24 h. Both defaults
    trip well before that, surfacing as cryptic `session timed out` errors.
    Patch the field defaults at module load so any A2AAgent declared in an
    OAS Flow without explicit `connection_config`/`session_parameters`
    inherits the longer SLA. Operators who NEED a shorter timeout for a
    specific A2A delegation still get it via explicit OAS declaration.

    Idempotent (no-op if already patched).
    """
    try:
        from pyagentspec.a2aagent import (  # type: ignore[import-not-found]
            A2AConnectionConfig,
            A2ASessionParameters,
        )
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: a2a-timeout patch import failed: {exc}"
        )
        return

    patched_any = False
    for cls, field_name, target in (
        (A2ASessionParameters, "timeout", _DEFAULT_HTTPX_TIMEOUT_SECONDS),
        (A2AConnectionConfig, "timeout", _DEFAULT_HTTPX_TIMEOUT_SECONDS),
    ):
        try:
            field = cls.model_fields[field_name]
            current = field.default
        except (AttributeError, KeyError) as exc:
            print(
                f"[agent_loader] WARNING: a2a-timeout patch: "
                f"{cls.__name__}.{field_name} not introspectable ({exc})"
            )
            continue
        if current == target:
            continue  # already aligned (idempotent)
        field.default = target
        try:
            cls.model_rebuild(force=True)
        except Exception as exc:
            # model_rebuild may fail in obscure ways; the field-default
            # mutation alone is usually sufficient for the runtime
            # behavior. Log + continue.
            print(
                f"[agent_loader] WARNING: a2a-timeout: model_rebuild for "
                f"{cls.__name__} raised ({exc}); field default still set"
            )
        patched_any = True
        print(
            f"[agent_loader] {cls.__name__}.{field_name} default patched "
            f"{current} → {target} s (batch LLM SLA)"
        )

    if not patched_any:
        print(
            "[agent_loader] a2a-timeout patch: no fields needed update (idempotent)"
        )


def _patch_pyagentspec_is_python_primitive_type_guard() -> None:
    """Guard `_is_python_primitive_type` against non-class annotations.

    Upstream defect in
    `pyagentspec/serialization/deserializationcontext.py:163` (26.1.0):

        def _is_python_primitive_type(self, annotation):
            if annotation is None:
                return False
            return issubclass(annotation, (bool, int, float, str))

    `issubclass()` raises `TypeError: issubclass() arg 1 must be a class`
    whenever `annotation` is a typing construct such as
    `Annotated[Enum, SerializeAsEnum(...)]` (the shape used by
    wayflowcore's `ExtendedAgentNode.caller_input_mode`). The TypeError
    propagates up through `_load_field` → `_load_component_with_plugin`
    and back into the patched `deserialize`, whose broad `except Exception`
    catches it and falls back to `_orig_deserialize`.
    The fallback re-enters `_load_reference` with a stale in-progress
    marker on the parent component, raising a *false-positive* cycle
    error that masks the real TypeError.

    Sibling fix to `_patch_pyagentspec_deserialization_error_mask` and the
    marker-cleanup logic inside it: this guard makes the TypeError disappear
    at its source so the failure path becomes "annotation not supported, try
    the next Union member" — pyagentspec's intended behavior at this code site.

    Implementation notes:
    - Idempotent via the `_cinatra_primitive_type_guard_patch_applied`
      sentinel on the deserialization context class.
    - Defensive imports: layout drift in the deserializer module is a
      warning-only no-op; the deserializer falls back to the upstream
      method and any new failure mode surfaces via
      `_validate_live_class_names` at startup.
    - Preserves the upstream method signature exactly.

    Remove once pyagentspec ships the guard upstream and the pinned
    version in `docker/wayflow/Dockerfile` is bumped past it.
    """
    try:
        from pyagentspec.serialization.deserializationcontext import (  # type: ignore[import-not-found]
            _DeserializationContextImpl,
        )
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_pyagentspec_is_python_primitive_type_guard: "
            f"import failed: {exc}"
        )
        return

    if getattr(
        _DeserializationContextImpl,
        "_cinatra_primitive_type_guard_patch_applied",
        False,
    ):
        return  # idempotent — re-import / test re-run safe

    _orig_method = _DeserializationContextImpl._is_python_primitive_type

    def _patched_is_python_primitive_type(self: Any, annotation: Optional[type]) -> bool:
        if annotation is None:
            return False
        try:
            return issubclass(annotation, (bool, int, float, str))
        except TypeError:
            # Annotation is not a class (typing construct like
            # `Annotated[Enum, SerializeAsEnum(...)]`). Treat as "not a
            # python primitive" so the caller falls through to the
            # next Union member / explicit error path instead of
            # crashing the whole load with the stale-marker side
            # effect.
            return False

    _patched_is_python_primitive_type.__wrapped__ = _orig_method  # type: ignore[attr-defined]
    _DeserializationContextImpl._is_python_primitive_type = _patched_is_python_primitive_type  # type: ignore[method-assign]
    _DeserializationContextImpl._cinatra_primitive_type_guard_patch_applied = True  # type: ignore[attr-defined]
    print(
        "[agent_loader] _DeserializationContextImpl._is_python_primitive_type patched "
        "(guard against TypeError on non-class annotations)"
    )


def _patch_parallel_flow_node_extended_order() -> None:
    """Fix Extended/Basic elif-ordering for ParallelFlowNode.

    Mirror of the documented `AgentSpecAgentNode` / `AgentSpecExtendedAgentNode`
    ordering bug. wayflowcore 26.1.1
    `_builtins_deserialization_plugin.py::convert_to_wayflow` checks
    `isinstance(comp, AgentSpecParallelFlowNode)` BEFORE the analogous
    `AgentSpecExtendedParallelFlowNode` branch. Because Extended* inherits
    from the basic class, the basic branch fires first for any Extended
    instance and the extended branch is unreachable.

    Concrete failure: the basic branch constructs
    `RuntimeParallelFlowExecutionStep(flows=[convert(sf) for sf in
    agentspec_component.subflows], max_workers=None, **_get_node_arguments(...))`
    — it never reads `inputs` / `outputs` / `max_workers` from the
    Extended class. So any OAS that declares `ParallelFlowNode.inputs` /
    `.outputs` to bridge parent DataFlowEdges loses those declarations
    silently and the parallel container runs with empty descriptors.

    Any OAS that uses the Extended ParallelFlowNode shape relies on the
    Extended fields. Without this patch, declared DataFlowEdges into the
    parallel container would silently lose their descriptors at runtime.

    This patch wraps the plugin's `convert_to_wayflow` so that when the
    incoming `agentspec_component` is an `AgentSpecExtendedParallelFlowNode`,
    we construct the runtime step ourselves using the Extended-shape
    fields (`flows`, `max_workers`, `_get_rt_nodes_arguments`). All other
    component types delegate to the upstream method unchanged.

    Implementation notes:
    - Idempotent via `_cinatra_parallel_extended_patch_applied` sentinel
      on the plugin class — re-imports / test re-runs are no-ops.
    - Defensive imports: if the wayflowcore layout drifts (module renamed,
      class missing, method missing), the broad `except Exception` falls
      back to logging a warning and leaving the original method in place.
      `_validate_live_class_names` then catches the missing binding at
      startup so operators see the regression loudly.
    - Preserves the original method signature exactly via `*args, **kwargs`.

    Remove this helper once wayflowcore ships the elif-ordering fix
    upstream and the pinned version in docker/wayflow/Dockerfile is bumped
    past it.
    """
    try:
        from wayflowcore.serialization import (  # type: ignore[import-not-found]
            _builtins_deserialization_plugin as _plugin_mod,
        )
        from pyagentspec.flows.nodes.parallelflownode import (  # type: ignore[import-not-found]
            ParallelFlowNode as AgentSpecParallelFlowNode,
        )
        from wayflowcore.agentspec.components import (  # type: ignore[import-not-found]
            ExtendedParallelFlowNode as AgentSpecExtendedParallelFlowNode,
        )
        from wayflowcore.steps.parallelflowexecutionstep import (  # type: ignore[import-not-found]
            ParallelFlowExecutionStep as RuntimeParallelFlowExecutionStep,
        )
    except Exception as exc:
        print(
            f"[agent_loader] WARNING: _patch_parallel_flow_node_extended_order: "
            f"import failed: {exc}"
        )
        return

    # Locate the deserialization plugin class. The exported class name in
    # wayflowcore 26.1.1 is `BuiltinsDeserializationPlugin`; fall back to
    # scanning the module if a future bump renames it.
    plugin_cls = getattr(_plugin_mod, "BuiltinsDeserializationPlugin", None)
    if plugin_cls is None:
        for attr in dir(_plugin_mod):
            obj = getattr(_plugin_mod, attr, None)
            if (
                isinstance(obj, type)
                and "Plugin" in attr
                and hasattr(obj, "convert_to_wayflow")
            ):
                plugin_cls = obj
                break
    if plugin_cls is None or not hasattr(plugin_cls, "convert_to_wayflow"):
        print(
            "[agent_loader] WARNING: _patch_parallel_flow_node_extended_order: "
            "deserialization-plugin class with convert_to_wayflow not found "
            "in wayflowcore.serialization._builtins_deserialization_plugin"
        )
        return

    if getattr(plugin_cls, "_cinatra_parallel_extended_patch_applied", False):
        return  # idempotent — re-import / test re-run safe

    _orig_convert = plugin_cls.convert_to_wayflow

    def _patched_convert(self: Any, *args: Any, **kwargs: Any) -> Any:
        # The basic-branch shadow ONLY triggers for genuine Extended
        # instances. For everything else (StartNode, AgentNode, ApiNode,
        # plain ParallelFlowNode, FlowNode, …) delegate to upstream
        # unchanged so the rest of the elif chain runs intact.
        comp = args[0] if args else kwargs.get("agentspec_component")
        if not isinstance(comp, AgentSpecExtendedParallelFlowNode):
            return _orig_convert(self, *args, **kwargs)

        # Mirror lines 1140-1148 of the upstream Extended branch verbatim.
        # `conversion_context.convert` is the canonical recursion the plugin
        # uses for sub-Flows, so we re-use it here. `metadata_info` is
        # consumed by `_get_rt_nodes_arguments`; the upstream caller passes
        # it via a positional/keyword arg that the wrapper relays.
        conversion_context = (
            args[1] if len(args) > 1 else kwargs.get("conversion_context")
        )
        tool_registry = (
            args[2] if len(args) > 2 else kwargs.get("tool_registry")
        )
        converted_components = (
            args[3] if len(args) > 3 else kwargs.get("converted_components")
        )
        metadata_info = (
            args[4] if len(args) > 4 else kwargs.get("metadata_info", None)
        )
        try:
            flows = [
                conversion_context.convert(f, tool_registry, converted_components)
                for f in comp.flows
            ]
            return RuntimeParallelFlowExecutionStep(
                flows=flows,
                max_workers=comp.max_workers,
                **self._get_rt_nodes_arguments(comp, metadata_info),
            )
        except (AttributeError, TypeError) as exc:
            # DO NOT delegate Extended instances to the original
            # `convert_to_wayflow` on layout drift. The original is the
            # known-bad basic-branch shadow path — falling back here would
            # silently strip the Extended fields. Raise a clear RuntimeError so
            # operators see the regression immediately and
            # `_validate_live_class_names` can corroborate which symbol drifted.
            raise RuntimeError(
                f"[agent_loader] Extended ParallelFlowNode patch failed to construct "
                f"ParallelFlowExecutionStep for ExtendedParallelFlowNode "
                f"(layout drift: {type(exc).__name__}: {exc}). Refusing to "
                f"delegate to the known-bad basic branch of "
                f"{plugin_cls.__name__}.convert_to_wayflow — that would drop "
                f"the Extended inputs/outputs silently. Rebuild the WayFlow "
                f"container against a compatible wayflowcore version, or "
                f"update _patch_parallel_flow_node_extended_order to match "
                f"the new layout."
            ) from exc

    # Silence the otherwise-unused class reference: imported for symmetry
    # with the basic branch and for clarity at the call site, but the
    # patched function only needs the Extended class to decide who owns
    # the conversion.
    _ = AgentSpecParallelFlowNode

    _patched_convert.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched_convert.__wrapped__ = _orig_convert  # type: ignore[attr-defined]
    plugin_cls.convert_to_wayflow = _patched_convert  # type: ignore[method-assign]
    plugin_cls._cinatra_parallel_extended_patch_applied = True  # type: ignore[attr-defined]
    print(
        f"[agent_loader] {plugin_cls.__name__}.convert_to_wayflow patched "
        f"(ExtendedParallelFlowNode wins over basic ParallelFlowNode "
        f"in convert_to_wayflow elif chain)"
    )


def _validate_live_class_names() -> None:
    """Assert every wayflowcore symbol the loader depends on still exists.

    Raises RuntimeError listing every missing symbol so an operator bumping
    wayflowcore sees the full delta in one message rather than discovering
    breakage one bug at a time.
    """
    import importlib

    missing: List[str] = []
    for module_path, class_name, method_name in _LIVE_CLASS_BINDINGS:
        try:
            mod = importlib.import_module(module_path)
        except ImportError as exc:
            missing.append(f"{module_path} (ImportError: {exc})")
            continue
        cls = getattr(mod, class_name, None)
        if cls is None:
            missing.append(f"{module_path}.{class_name}")
            continue
        if method_name is not None and not hasattr(cls, method_name):
            missing.append(f"{module_path}.{class_name}.{method_name}")

    if missing:
        version = _wayflowcore_version()
        details = "\n  - ".join(missing)
        raise RuntimeError(
            f"[agent_loader] wayflowcore class-name guard failed against "
            f"wayflowcore=={version}. The following symbols the Cinatra "
            f"loader binds against are missing — patches and/or the "
            f"_is_apinode_only_flow predicate will not work as intended. "
            f"Update _LIVE_CLASS_BINDINGS and the affected patch/predicate "
            f"to match the new wayflowcore surface, then re-run the "
            f"smoke test:\n  - {details}"
        )

    print(
        f"[agent_loader] live-class-name guard passed "
        f"(wayflowcore=={_wayflowcore_version()}, "
        f"{len(_LIVE_CLASS_BINDINGS)} bindings verified)"
    )


# ---------------------------------------------------------------------------
# Draft/published separation via hash-signed marker file.
#
# The WayFlow runtime only mounts agents whose source dir has a valid
# `.cinatra-published.json` marker AND whose `cinatra/oas.json` hash matches
# the marker's `oasSha256`. Drafts written by `agent_source_write` overwrite
# the oas.json without updating the marker — the hash mismatch
# auto-invalidates the marker, so the loader treats the dir as unpublished
# until the next publish refreshes it.
#
# Marker file shape:
#   {
#     "packageName":    "@<vendor>/<slug>",
#     "packageVersion": "<semver>",
#     "oasSha256":      "<hex>",
#     "publishedAt":    "<ISO 8601>"
#   }
# ---------------------------------------------------------------------------

_PUBLISHED_MARKER_FILENAME = ".cinatra-published.json"

# In-progress marker. Written by `agent_source_write` immediately after each
# chat-builder OAS save; removed when `materializeAgentPackageToDisk` rebuilds
# the slug dir at publish time. Presence at the slug-dir level tells the reload
# reporter "this draft is intentional, not corruption" — surfaces a distinct
# `marker_in_progress_draft` kind_hint in the failed[] report (vs the alarming
# `marker_missing` / `marker_malformed` for genuinely corrupted or
# never-published dirs).
_IN_PROGRESS_MARKER_FILENAME = ".cinatra-in-progress.json"


def _has_in_progress_marker(slug_dir: Path) -> bool:
    """Return True iff `<slug_dir>/.cinatra-in-progress.json` exists.

    Cheap existence check — does NOT parse the marker. Used purely as a
    boolean signal to reclassify a marker-gate failure as a benign draft
    session vs marker corruption. We don't validate the contents because
    the in-progress signal is intent-annotation, not transaction state.
    """
    return (slug_dir / _IN_PROGRESS_MARKER_FILENAME).exists()


def _inspect_published_marker(
    slug_dir: Path,
    oas_path: Path,
    *,
    precomputed_oas_sha256: Optional[str] = None,
) -> Dict[str, Any]:
    """Inspect the marker for `slug_dir`; return structured outcome.

    Outcome shapes:
      { "status": "valid",        "marker": <parsed dict> }
      { "status": "missing"  }                       # no marker file on disk
      { "status": "malformed",    "error": str }     # marker JSON parse / schema fail
      { "status": "hash_mismatch","marker_sha": str, "actual_sha": str }
      { "status": "io_error",     "error": str }

    Callers gate mounting on `status == "valid"`. The reload-discovery path
    uses the `missing`/`malformed`/`hash_mismatch` distinction to surface a
    `draft_overrides_published` kind in the reload report.

    When the caller has already read the OAS bytes for some other purpose
    (fingerprint computation, etc.), it MUST pass that hash via
    `precomputed_oas_sha256` so this function does not re-read the file.
    Re-reading opens a TOCTOU window where the host backing the `:ro` mount can
    flip the file between marker validation and actual mount. Pinning the hash
    means the marker validates against EXACTLY the bytes the caller is about to
    use.
    """
    marker_path = slug_dir / _PUBLISHED_MARKER_FILENAME
    if not marker_path.exists():
        return {"status": "missing"}
    try:
        raw = marker_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"status": "io_error", "error": f"{type(exc).__name__}: {exc}"}
    except UnicodeDecodeError as exc:
        # Invalid UTF-8 in the marker file MUST surface as malformed, not
        # bubble up as an unhandled exception that would crash startup
        # discovery and 500 the reload endpoint.
        print(
            f"[agent_loader] WARNING: {marker_path} not valid UTF-8 — treating "
            f"as malformed: {exc}"
        )
        return {"status": "malformed", "error": f"UnicodeDecodeError: {exc}"}
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        print(
            f"[agent_loader] WARNING: {marker_path} parse failed — treating "
            f"as missing: {type(exc).__name__}: {exc}"
        )
        return {"status": "malformed", "error": str(exc)}
    if not isinstance(parsed, dict):
        return {"status": "malformed", "error": "marker is not a JSON object"}
    required_keys = {"packageName", "packageVersion", "oasSha256", "publishedAt"}
    missing_keys = required_keys - set(parsed.keys())
    if missing_keys:
        return {
            "status": "malformed",
            "error": f"marker missing required keys: {sorted(missing_keys)}",
        }
    marker_sha = parsed.get("oasSha256")
    if not isinstance(marker_sha, str):
        return {"status": "malformed", "error": "oasSha256 must be a string"}
    if precomputed_oas_sha256 is not None:
        actual_sha = precomputed_oas_sha256
    else:
        try:
            actual_sha = hashlib.sha256(oas_path.read_bytes()).hexdigest()
        except OSError as exc:
            return {"status": "io_error", "error": f"{type(exc).__name__}: {exc}"}
    if marker_sha != actual_sha:
        return {
            "status": "hash_mismatch",
            "marker_sha": marker_sha,
            "actual_sha": actual_sha,
        }
    return {"status": "valid", "marker": parsed}


def _read_published_marker(
    slug_dir: Path, oas_path: Path
) -> Optional[Dict[str, Any]]:
    """Convenience wrapper for `_inspect_published_marker` — returns the
    parsed marker dict if status is "valid", None otherwise.

    Used by `discover_agents` (startup) where the only decision is mount
    vs skip. Reload uses `_inspect_published_marker` directly to surface
    the distinct failure kinds (`draft_overrides_published`,
    `marker_missing`, `marker_malformed`, `marker_io_error`, and the
    `marker_in_progress_draft` override when `.cinatra-in-progress.json`
    is present).
    """
    inspect = _inspect_published_marker(slug_dir, oas_path)
    return inspect["marker"] if inspect["status"] == "valid" else None


def _resolve_package_version_for_backfill(
    slug_dir: Path, parsed_oas: Dict[str, Any]
) -> str:
    """Cascade resolution for packageVersion during backfill.

    Order:
      1. sibling `package.json` `version` field
      2. `metadata.cinatra.packageVersion` from oas.json (older agents)
      3. literal "0.0.0-backfill" fallback
    """
    pkg_json_path = slug_dir / "package.json"
    if pkg_json_path.exists():
        try:
            pkg = json.loads(pkg_json_path.read_text(encoding="utf-8"))
            v = pkg.get("version") if isinstance(pkg, dict) else None
            if isinstance(v, str) and v.strip():
                return v.strip()
        except (OSError, ValueError, UnicodeDecodeError):
            pass
    if isinstance(parsed_oas, dict):
        meta_cinatra = (parsed_oas.get("metadata") or {}).get("cinatra") or {}
        if isinstance(meta_cinatra, dict):
            v = meta_cinatra.get("packageVersion")
            if isinstance(v, str) and v.strip():
                return v.strip()
    return "0.0.0-backfill"


def _backfill_missing_markers(agents_dir: Path) -> int:
    """Walk the agents tree and write markers for any dir lacking one.

    Idempotent: dirs that already have a marker are left untouched (even if
    the marker is stale — the loader's hash-mismatch path handles that).

    Runs in `build_parent_app(agents_dir)`, NOT at module import — test
    fixtures that construct `discover_agents` directly are NOT affected by
    backfill unless they go through `build_parent_app`.

    Returns the count of markers written. Logs each backfill.
    """
    if not agents_dir.exists():
        return 0
    written = 0
    for vendor_entry in sorted(agents_dir.iterdir()):
        if vendor_entry.name.startswith(".") or not vendor_entry.is_dir():
            continue
        for slug_entry in sorted(vendor_entry.iterdir()):
            if slug_entry.name.startswith(".") or not slug_entry.is_dir():
                continue
            oas_path = slug_entry / "cinatra" / "oas.json"
            if not oas_path.exists():
                continue
            marker_path = slug_entry / _PUBLISHED_MARKER_FILENAME
            if marker_path.exists():
                continue  # already marked — leave alone
            try:
                raw_bytes = oas_path.read_bytes()
                oas_sha = hashlib.sha256(raw_bytes).hexdigest()
                parsed_oas = json.loads(raw_bytes.decode("utf-8"))
            except (OSError, ValueError, UnicodeDecodeError) as exc:
                print(
                    f"[agent_loader] backfill: skip {oas_path} "
                    f"({type(exc).__name__}: {exc})"
                )
                continue
            meta_cinatra = (
                parsed_oas.get("metadata") or {}
            ).get("cinatra") or {} if isinstance(parsed_oas, dict) else {}
            pkg_name = meta_cinatra.get("packageName") if isinstance(meta_cinatra, dict) else None
            if not isinstance(pkg_name, str) or not pkg_name.startswith("@"):
                # Backfill using disk path when OAS metadata lacks packageName.
                pkg_name = f"@{vendor_entry.name}/{slug_entry.name}"
            pkg_version = _resolve_package_version_for_backfill(slug_entry, parsed_oas)
            try:
                mtime = oas_path.stat().st_mtime
                published_at = _datetime.datetime.fromtimestamp(
                    mtime, tz=_datetime.timezone.utc
                ).isoformat()
            except OSError:
                published_at = _datetime.datetime.now(
                    _datetime.timezone.utc
                ).isoformat()
            marker = {
                "packageName": pkg_name,
                "packageVersion": pkg_version,
                "oasSha256": oas_sha,
                "publishedAt": published_at,
            }
            try:
                marker_path.write_text(
                    json.dumps(marker, indent=2) + "\n", encoding="utf-8"
                )
                written += 1
                print(
                    f"[agent_loader] backfill marker {vendor_entry.name}/{slug_entry.name} "
                    f"(oasSha256={oas_sha[:12]} version={pkg_version})"
                )
            except OSError as exc:
                print(
                    f"[agent_loader] backfill: failed to write {marker_path} "
                    f"({type(exc).__name__}: {exc})"
                )
    return written


# ---------------------------------------------------------------------------
# Discovery: walk agents/<vendor>/<slug>/cinatra/oas.json.
# ---------------------------------------------------------------------------


def extract_vendor_slug(oas_path: Path) -> Tuple[str, str]:
    """Read OAS JSON and return (vendor, slug) from metadata.cinatra.packageName.

    Format: `@<vendor>/<slug>` (npm scoped package name convention).

    Raises ValueError if metadata.cinatra.packageName is missing or malformed.
    """
    raw = oas_path.read_text(encoding="utf-8")
    substituted = _substitute_placeholders(raw)
    body = json.loads(substituted)
    md = body.get("metadata") or {}
    # Note: 'cinatra' here is the OAS metadata namespace key (per agent
    # packaging spec), NOT a vendor name. Vendor is derived from packageName.
    cmd = md.get("cinatra") or {}
    pkg = cmd.get("packageName")
    if not isinstance(pkg, str) or not pkg.startswith("@") or "/" not in pkg:
        raise ValueError(
            f"{oas_path}: metadata.cinatra.packageName missing or malformed "
            f"(expected '@<vendor>/<slug>', got {pkg!r})"
        )
    vendor, _, slug = pkg[1:].partition("/")
    if not vendor or not slug:
        raise ValueError(
            f"{oas_path}: metadata.cinatra.packageName empty vendor or slug "
            f"({pkg!r})"
        )
    return vendor, slug


def discover_agents(agents_dir: Path) -> List[Tuple[str, str, Path, str]]:
    """Two-level scan: agents_dir/<vendor>/<slug>/cinatra/oas.json.

    Returns a list of (vendor, slug, oas_path, oas_sha256) tuples. The SAME
    bytes used to validate the published-marker hash are pinned via this
    returned fingerprint, and `_mount_one_sync` re-verifies its own read
    against it before mounting. This pins the contract: marker validates →
    these bytes → these bytes mounted, with no window for a host-side writer
    to flip the file in between.

    Skips:
      - dotfiles (.DS_Store, .gitkeep)
      - non-directory entries
      - vendor directories with no agent subdirs
      - subdirectories without cinatra/oas.json (probe pattern)
      - paths that escape agents_dir (path-traversal guard)
      - OAS files larger than 1 MB

    Reconciles the on-disk vendor/slug with the OAS metadata. If they differ,
    the OAS metadata wins (the runtime needs to mount under the canonical
    packageName, not whatever the operator named the directory). A warning
    is printed so renames are surfaced rather than silenced.
    """
    if not agents_dir.exists():
        return []
    agents_base = agents_dir.resolve()

    def _safe_resolve(p: Path) -> "Path | None":
        if p.name.startswith("."):
            return None
        try:
            r = p.resolve(strict=True)
            r.relative_to(agents_base)  # path-traversal guard
            return r if r.is_dir() else None
        except (OSError, ValueError):
            return None

    results: List[Tuple[str, str, Path, str]] = []
    for vendor_entry in sorted(agents_dir.iterdir()):
        vendor_dir = _safe_resolve(vendor_entry)
        if vendor_dir is None:
            continue
        for slug_entry in sorted(vendor_dir.iterdir()):
            slug_dir = _safe_resolve(slug_entry)
            if slug_dir is None:
                continue
            # 'cinatra' here is the per-agent subdirectory marker baked into
            # the agent packaging spec, NOT a vendor name. Vendor is the
            # name of vendor_dir, NOT a literal here.
            oas_path = slug_dir / "cinatra" / "oas.json"
            if not oas_path.exists():
                continue  # probe pattern: skip dirs without oas.json
            try:
                if oas_path.stat().st_size > 1_048_576:
                    print(
                        f"[agent_loader] skipping {oas_path}: "
                        f"file exceeds 1 MB limit"
                    )
                    continue
            except OSError:
                continue
            # Read OAS bytes ONCE and bind the hash to the published-marker
            # check + downstream mount, closing the window for a host-side
            # writer to flip bytes in between.
            try:
                raw_bytes = oas_path.read_bytes()
            except OSError as exc:
                print(
                    f"[agent_loader] skipping {oas_path}: cannot read OAS "
                    f"bytes — {type(exc).__name__}: {exc}"
                )
                continue
            oas_sha256 = hashlib.sha256(raw_bytes).hexdigest()
            try:
                parsed_oas = json.loads(raw_bytes.decode("utf-8"))
                vendor, slug = _extract_vendor_slug_from_parsed(parsed_oas)
            except (ValueError, UnicodeDecodeError) as exc:
                print(
                    f"[agent_loader] skipping {oas_path}: cannot parse "
                    f"metadata.cinatra.packageName — {exc}"
                )
                continue
            disk_vendor = vendor_dir.name
            disk_slug = slug_dir.name
            if (vendor, slug) != (disk_vendor, disk_slug):
                print(
                    f"[agent_loader] WARNING: disk path "
                    f"{disk_vendor}/{disk_slug} does not match OAS "
                    f"packageName @{vendor}/{slug}; using OAS metadata "
                    f"(mount path will be /agents/{vendor}/{slug}/)"
                )
            # Gate on hash-signed marker, pinned to the bytes we just hashed.
            marker_inspect = _inspect_published_marker(
                slug_dir, oas_path, precomputed_oas_sha256=oas_sha256
            )
            if marker_inspect["status"] != "valid":
                print(
                    f"[agent_loader] skipping {disk_vendor}/{disk_slug}: "
                    f"marker status={marker_inspect['status']} — treating "
                    f"as draft/unpublished"
                )
                continue
            results.append((vendor, slug, oas_path, oas_sha256))
    return results


def _extract_vendor_slug_from_parsed(parsed_oas: Any) -> Tuple[str, str]:
    """Same as `extract_vendor_slug(oas_path)` but operates on already-parsed
    JSON and avoids a second read of oas.json.

    Raises ValueError on missing/malformed packageName.
    """
    if not isinstance(parsed_oas, dict):
        raise ValueError("oas.json is not a JSON object")
    meta = parsed_oas.get("metadata", {})
    cinatra = meta.get("cinatra", {}) if isinstance(meta, dict) else {}
    pkg = cinatra.get("packageName") if isinstance(cinatra, dict) else None
    if not isinstance(pkg, str) or not pkg.startswith("@"):
        raise ValueError(
            f"metadata.cinatra.packageName missing or invalid: {pkg!r}"
        )
    body = pkg[1:]
    if "/" not in body:
        raise ValueError(
            f"metadata.cinatra.packageName missing slash separator: {pkg!r}"
        )
    vendor, slug = body.split("/", 1)
    if not vendor or not slug:
        raise ValueError(
            f"metadata.cinatra.packageName empty vendor or slug: {pkg!r}"
        )
    return vendor, slug


# ---------------------------------------------------------------------------
# Parent Starlette app: per-agent Mount + /.health.
# ---------------------------------------------------------------------------


def _discover_a2a_asgi_app(server: Any, label: str) -> Any:
    """Return an A2AServer's ASGI app, probing the wayflowcore 26.1.x surface.

    Discovery order:
      1. server.get_app(host, port)  — wayflowcore 26.1.x (verified accessor;
         returns a fresh A2AApp instance whose lifespan starts the worker).
      2. getattr(server, 'app', None) — legacy attribute, kept for forward
         compat with hypothetical wayflowcore versions that switch back.
      3. getattr(server, 'asgi_app', None) / server._app — same.
      4. Introspection: any callable attribute with a `router` attr.

    Note on get_app(host, port): `host` and `port` are used ONLY when
    `server.url` is None — to synthesize an AgentCard fallback URL. Since
    `serve_agent(agent, url=mount_url)` sets `server.url`, the host/port we
    pass here are effectively ignored. We still pass localhost defaults for
    safety.
    """
    if hasattr(server, "get_app") and callable(server.get_app):
        try:
            app = server.get_app(host="127.0.0.1", port=8000)
            print(f"[agent_loader] {label}: ASGI accessor = server.get_app()")
            return app
        except Exception as exc:  # pragma: no cover
            print(
                f"[agent_loader] {label}: server.get_app() raised "
                f"{type(exc).__name__}: {exc}; falling back to attribute probe"
            )

    # Deterministic attribute probe in a fixed order. Reject bound methods
    # (those would be method objects, not ASGI apps — `Mount(..., app=method)`
    # raises at first request, not at startup). We accept any attribute whose
    # value has a `router` (ASGI app shape).
    for attr_name in ("app", "asgi_app", "_app"):
        candidate = getattr(server, attr_name, None)
        if (
            candidate is not None
            and hasattr(candidate, "router")
            and not inspect.ismethod(candidate)
            and not inspect.isfunction(candidate)
        ):
            print(
                f"[agent_loader] {label}: ASGI accessor = server.{attr_name}"
            )
            return candidate

    raise RuntimeError(
        f"No ASGI accessor found on A2AServer for {label} "
        f"(tried .get_app(), .app, .asgi_app, ._app)"
    )


# ---------------------------------------------------------------------------
# Disk-walk discovery for hot-reload.
#
# `discover_agents()` (above) is the STARTUP discovery — it reconciles disk
# path vs OAS `metadata.cinatra.packageName` and uses OAS metadata for the
# mount label when they differ. That reconciliation is safe at startup but
# unsafe for reload: an existing-mounted agent whose oas.json becomes
# malformed mid-flight would be SKIPPED by `discover_agents()` and the
    # reload diff would treat it as removed, unmounting a still-serving agent.
#
# For reload, we walk the disk by DIRECTORY STRUCTURE (vendor/slug from the
# path itself) and split into two buckets:
#   - valid: file exists AND parses → eligible for mount/remount
#   - parse_failed: file exists but cannot be parsed → preserve any prior
#     mount, report the failure
#
# A label is considered "absent from disk" (true removed) ONLY if it appears
# in neither bucket. The reload diff uses (parsed + parse_failed) as the
# "present on disk" set.
# ---------------------------------------------------------------------------


def discover_agents_for_reload(
    agents_dir: Path,
) -> Tuple[
    List[Tuple[str, str, Path, str]],  # valid: (vendor, slug, oas_path, fingerprint)
    List[Tuple[str, str, Path, str, Optional[str]]],  # parse_failed: (vendor, slug, oas_path, error, kind_hint)
]:
    """Reload-time discovery — directory-keyed, parse-failure-preserving.

    Walks `agents_dir/<vendor>/<slug>/cinatra/oas.json`. Returns two lists
    (valid, parse_failed). All present-on-disk labels (that should be
    reportable) appear in one of the two — labels absent from both buckets
    are eligible to be unmounted by the caller.

    Keys by DISK path (not OAS metadata), so two dirs whose OAS metadata
    claims the same packageName mount at distinct paths and don't collide at
    the label level.

    Gates on the `.cinatra-published.json` marker. Per-dir outcomes:
      - marker valid (hash match)        → emit to `valid`
      - marker missing/malformed AND label IS currently mounted
                                         → emit to parse_failed with
                                           kind_hint="draft_overrides_published"
        (the caller will surface this kind in the report AND preserve the
        prior live mount).
      - marker missing/malformed AND label is NOT currently mounted
                                         → silent skip (never been
        published; staying that way is correct).
      - actual JSON / file-read failures → emit to parse_failed with
                                           kind_hint=None (caller derives
                                           parse_failed / parse_failed_new).

    Note: this function does NOT know which labels are currently mounted.
    The caller (`MountedAgentRegistry.reload`) carries the
    `currently_mounted_labels` set in via a parameter. The function returns
    BOTH "valid" and "parse_failed" plus, separately, a third list of
    `unpublished_silent` labels — labels that have a present dir but lack a
    marker AND are not in the currently_mounted_labels. To keep the call
    site simple and the tuple shapes stable, we return `parse_failed`
    entries with `kind_hint="draft_overrides_published"` ONLY when the
    caller's mounted set includes the label; otherwise the function silently
    skips. To preserve a no-knowledge mode (tests calling this function
    directly without a caller), we accept an optional argument.
    """
    return _discover_agents_for_reload_inner(agents_dir, currently_mounted=frozenset())


def _discover_agents_for_reload_inner(
    agents_dir: Path,
    currently_mounted: "frozenset[str]",
) -> Tuple[
    List[Tuple[str, str, Path, str]],
    List[Tuple[str, str, Path, str, Optional[str]]],
]:
    """Internal reload discovery that knows which labels are currently
    mounted. Lets `discover_agents_for_reload` (no arg) keep its no-knowledge
    behavior — useful for tests — while `MountedAgentRegistry.reload` passes
    the live set so `draft_overrides_published` can be reported on labels
    that ARE in the registry.
    """
    valid: List[Tuple[str, str, Path, str]] = []
    parse_failed: List[Tuple[str, str, Path, str, Optional[str]]] = []
    if not agents_dir.exists():
        return valid, parse_failed
    agents_base = agents_dir.resolve()

    def _safe_resolve(p: Path) -> "Path | None":
        if p.name.startswith("."):
            return None
        try:
            r = p.resolve(strict=True)
            r.relative_to(agents_base)  # path-traversal guard
            return r if r.is_dir() else None
        except (OSError, ValueError):
            return None

    for vendor_entry in sorted(agents_dir.iterdir()):
        vendor_dir = _safe_resolve(vendor_entry)
        if vendor_dir is None:
            continue
        for slug_entry in sorted(vendor_dir.iterdir()):
            slug_dir = _safe_resolve(slug_entry)
            if slug_dir is None:
                continue
            oas_path = slug_dir / "cinatra" / "oas.json"
            if not oas_path.exists():
                continue
            disk_vendor = vendor_dir.name
            disk_slug = slug_dir.name
            # Containment check on oas_path itself — a symlinked oas.json
            # could otherwise escape agents_dir.
            try:
                resolved_oas = oas_path.resolve(strict=True)
                resolved_oas.relative_to(agents_base)
            except (OSError, ValueError) as guard_exc:
                parse_failed.append(
                    (
                        disk_vendor,
                        disk_slug,
                        oas_path,
                        f"path-traversal guard: {type(guard_exc).__name__}: {guard_exc}",
                        None,
                    )
                )
                continue
            try:
                raw_bytes = oas_path.read_bytes()
            except OSError as exc:
                parse_failed.append(
                    (
                        disk_vendor,
                        disk_slug,
                        oas_path,
                        f"{type(exc).__name__}: {exc}",
                        None,
                    )
                )
                continue
            if len(raw_bytes) > 1_048_576:
                parse_failed.append(
                    (
                        disk_vendor,
                        disk_slug,
                        oas_path,
                        f"file exceeds 1 MB limit ({len(raw_bytes)} bytes)",
                        None,
                    )
                )
                continue
            fingerprint = hashlib.sha256(raw_bytes).hexdigest()
            # JSON parse here is the gate, not a side effect. Parse failures
            # go into parse_failed (not valid) so downstream diff treats them
            # as parse-failed-but-present.
            try:
                parsed = json.loads(raw_bytes.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                parse_failed.append(
                    (
                        disk_vendor,
                        disk_slug,
                        oas_path,
                        f"{type(exc).__name__}: {exc}",
                        None,
                    )
                )
                continue
            # Metadata-vs-disk warning is informational only — disk path wins
            # as the mount label.
            meta = (
                parsed.get("metadata", {}).get("cinatra", {})
                if isinstance(parsed, dict)
                else {}
            )
            pkg_name = meta.get("packageName") if isinstance(meta, dict) else None
            if isinstance(pkg_name, str) and pkg_name.startswith("@"):
                meta_label = pkg_name[1:]
                if meta_label != f"{disk_vendor}/{disk_slug}":
                    print(
                        f"[agent_loader] WARNING: disk path "
                        f"{disk_vendor}/{disk_slug} differs from OAS "
                        f"packageName @{meta_label}; mounting at disk "
                        f"path (disk path wins for reload)"
                    )
            # Gate on hash-signed marker. Drafts and stale post-publish edits
            # don't get mounted. If a currently-mounted label fails the gate,
            # we report it via parse_failed with a kind_hint that distinguishes
            # the FOUR failure modes so the caller can tell a benign draft
            # override from real corruption.
            marker_inspect = _inspect_published_marker(
                slug_dir, oas_path, precomputed_oas_sha256=fingerprint
            )
            marker_status = marker_inspect["status"]
            if marker_status != "valid":
                label = f"{disk_vendor}/{disk_slug}"
                if label in currently_mounted:
                    # In-progress marker overrides all other kinds. When
                    # `agent_source_write` wrote the `.cinatra-in-progress.json`
                    # marker, the draft is intentional — distinguish from
                    # genuine corruption.
                    in_progress = _has_in_progress_marker(slug_dir)
                    if in_progress:
                        kind_hint = "marker_in_progress_draft"
                    else:
                        # Map marker status → reload report kind.
                        kind_for_status = {
                            "hash_mismatch": "draft_overrides_published",
                            "missing": "marker_missing",
                            "malformed": "marker_malformed",
                            "io_error": "marker_io_error",
                        }
                        kind_hint = kind_for_status.get(marker_status, "marker_invalid")
                    parse_failed.append(
                        (
                            disk_vendor,
                            disk_slug,
                            oas_path,
                            f"marker status={marker_status}"
                            f"{' (in-progress draft)' if in_progress else ''} "
                            f"(prior mount preserved)",
                            kind_hint,
                        )
                    )
                # else: silently skip — never been mounted; staying that way
                # is correct. Don't pollute the reload report.
                continue
            valid.append((disk_vendor, disk_slug, oas_path, fingerprint))
    return valid, parse_failed


# ---------------------------------------------------------------------------
# MountedAgentRegistry + reload endpoint.
# ---------------------------------------------------------------------------


class MountedAgent:
    """A single mounted agent's runtime state.

    `stack` is None during the brief window between `_mount_one_sync` (called
    from `build_parent_app`) and `registry.start()` (which enters the lifespan
    via `_enter_lifespan`). After startup, all `_active` agents have a stack.
    """

    __slots__ = (
        "label",
        "vendor",
        "slug",
        "oas_path",
        "fingerprint",
        "server",
        "sub_app",
        "stack",
        "mount",
    )

    def __init__(
        self,
        vendor: str,
        slug: str,
        oas_path: Path,
        fingerprint: str,
        server: Any,
        sub_app: Any,
        mount: Mount,
    ) -> None:
        self.label = f"{vendor}/{slug}"
        self.vendor = vendor
        self.slug = slug
        self.oas_path = oas_path
        self.fingerprint = fingerprint
        self.server = server
        self.sub_app = sub_app
        self.stack: Optional[contextlib.AsyncExitStack] = None
        self.mount = mount


def _read_bridge_token() -> Optional[str]:
    """Return the bridge token, or None if unset or whitespace-only."""
    tok = os.environ.get("CINATRA_BRIDGE_TOKEN") or ""
    tok = tok.strip()
    return tok or None


def _mount_one_sync(
    loader: Any, vendor: str, slug: str, oas_path: Path, fingerprint: str, base_url: str
) -> MountedAgent:
    """Build A2AServer + sub_app + Mount synchronously. No lifespan entered.

    Raises on any error — the caller decides whether to log + skip or
    propagate (used by both startup and reload paths).

    Re-read the OAS bytes here and refuse to mount if the hash doesn't match
    the fingerprint the caller already validated against the published marker.
    This pins the contract: marker validated against THESE exact bytes → only
    THESE exact bytes are mounted. Without this check, a host-side writer can
    flip the file between marker validation (discover) and mount (here) on a
    `:ro` container mount.
    """
    raw_bytes = oas_path.read_bytes()
    actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    if actual_sha256 != fingerprint:
        raise ValueError(
            f"OAS bytes changed between discovery and mount for "
            f"{vendor}/{slug}: expected sha256={fingerprint[:12]}… got "
            f"{actual_sha256[:12]}… (refusing to mount)"
        )
    raw_text = raw_bytes.decode("utf-8")
    substituted = _substitute_placeholders(raw_text)
    agent = loader.load_json(substituted)

    server = A2AServer()
    mount_url = f"{base_url}/agents/{vendor}/{slug}/"
    server.serve_agent(agent, url=mount_url)

    sub_app = _discover_a2a_asgi_app(server, f"{vendor}/{slug}")
    mount = Mount(f"/agents/{vendor}/{slug}", app=sub_app)
    return MountedAgent(
        vendor=vendor,
        slug=slug,
        oas_path=oas_path,
        fingerprint=fingerprint,
        server=server,
        sub_app=sub_app,
        mount=mount,
    )


class _LifecycleLane:
    """Single-task owner for all child A2AApp lifespan enter/exit operations.

    Why this exists:
        wayflowcore's A2AApp lifespan uses anyio internally. anyio binds
        cancel scopes to the task that enters them — exiting from a
        different task raises
        `RuntimeError: Attempted to exit cancel scope in a different task`.
        A naive design (enter from request handler task, defer close to a
        new asyncio.create_task) hits this. We funnel all enters and exits
        through ONE long-lived task so every cancel scope is opened and
        closed in the same task.

    Public surface:
        - await lane.start()           — spawn the worker
        - await lane.enter(agent)      — open the lifespan; agent.stack set on success
        - await lane.exit(agent)       — close the lifespan; agent.stack set to None
        - await lane.shutdown()        — close any remaining stacks (parent shutdown)

    Errors from enter/exit propagate to the caller via the result Future.
    """

    _SENTINEL_SHUTDOWN = object()

    def __init__(self) -> None:
        self._queue: Optional[asyncio.Queue] = None
        self._task: Optional[asyncio.Task] = None
        # Stacks are tracked by IDENTITY of the MountedAgent object, not by
        # label. Two MountedAgents for the same label (the "changed" reload
        # path) get independent stack records, so closing the prior agent's
        # stack never reaches into the new agent's stack.
        self._stacks: Dict[int, contextlib.AsyncExitStack] = {}

    async def start(self) -> None:
        if self._task is not None:
            return
        self._queue = asyncio.Queue()
        ready = asyncio.Event()
        self._task = asyncio.create_task(self._run(ready))
        await ready.wait()

    async def shutdown(self) -> None:
        if self._task is None or self._queue is None:
            return
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._queue.put(("shutdown", None, fut))
        await fut
        await self._task
        self._task = None
        self._queue = None

    async def enter(self, agent: "MountedAgent") -> None:
        await self._dispatch("enter", agent)

    async def exit(self, agent: "MountedAgent") -> None:
        await self._dispatch("exit", agent)

    async def _dispatch(self, op: str, agent: "MountedAgent") -> None:
        if self._queue is None:
            raise RuntimeError("_LifecycleLane not started")
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._queue.put((op, agent, fut))
        await fut

    async def _run(self, ready: asyncio.Event) -> None:
        assert self._queue is not None
        ready.set()
        try:
            while True:
                op, agent, fut = await self._queue.get()
                if op == "shutdown":
                    # Close every remaining stack in reverse insertion order.
                    for stack_key in list(self._stacks.keys())[::-1]:
                        stack = self._stacks.pop(stack_key, None)
                        if stack is None:
                            continue
                        try:
                            await stack.aclose()
                        except Exception as exc:  # noqa: BLE001
                            print(
                                f"[agent_loader] lane shutdown: aclose failed "
                                f"for {stack_key}: {type(exc).__name__}: {exc}"
                            )
                    if not fut.done():
                        fut.set_result(None)
                    return
                if op == "enter":
                    try:
                        stack = contextlib.AsyncExitStack()
                        child_ctx = agent.sub_app.router.lifespan_context(
                            agent.sub_app
                        )
                        await stack.enter_async_context(child_ctx)
                        # Key by agent identity, not label, so two
                        # MountedAgents for the same label (changed reload
                        # path) get independent records.
                        self._stacks[id(agent)] = stack
                        agent.stack = stack
                        if not fut.done():
                            fut.set_result(None)
                    except BaseException as exc:
                        # Cleanup any partial stack.
                        try:
                            await stack.aclose()  # type: ignore[possibly-undefined]
                        except Exception:
                            pass
                        if not fut.done():
                            fut.set_exception(exc)
                elif op == "exit":
                    try:
                        stack = self._stacks.pop(id(agent), None)
                        if stack is not None:
                            await stack.aclose()
                        agent.stack = None
                        if not fut.done():
                            fut.set_result(None)
                    except Exception as exc:  # noqa: BLE001
                        if not fut.done():
                            fut.set_exception(exc)
                else:
                    if not fut.done():
                        fut.set_exception(
                            RuntimeError(f"_LifecycleLane: unknown op {op!r}")
                        )
        except asyncio.CancelledError:
            # Parent shutdown without graceful drain — close remaining stacks
            # best-effort still inside this task.
            for stack_key in list(self._stacks.keys())[::-1]:
                stack = self._stacks.pop(stack_key, None)
                if stack is None:
                    continue
                try:
                    await stack.aclose()
                except Exception:
                    pass
            raise


async def _enter_lifespan(lane: _LifecycleLane, agent: "MountedAgent") -> None:
    """Open the child A2A lifespan via the lifecycle lane.

    On failure: re-raise. The lane owns the partial-stack cleanup.
    """
    await lane.enter(agent)


async def _deferred_close_via_lane(
    lane: _LifecycleLane,
    agents: List["MountedAgent"],
    delay_seconds: float,
) -> None:
    """Sleep then ask the lane to exit each agent's lifespan.

    Used after a reload route swap so in-flight requests against the
    now-replaced sub-app can complete cleanly. All actual stack closes
    happen in the lane task, avoiding the cross-task cancel-scope error.
    """
    try:
        await asyncio.sleep(delay_seconds)
    except asyncio.CancelledError:
        pass
    for agent in agents:
        try:
            await lane.exit(agent)
        except Exception as exc:  # noqa: BLE001
            print(
                f"[agent_loader] deferred lane.exit failed for {agent.label}: "
                f"{type(exc).__name__}: {exc}"
            )


class MountedAgentRegistry:
    """Owns all mounted agents + the per-agent AsyncExitStacks."""

    DEFERRED_CLOSE_SECONDS: float = 5.0

    def __init__(
        self,
        parent_app: Starlette,
        agents_dir: Path,
        base_url: str,
        loader: Any,
    ) -> None:
        self._parent_app = parent_app
        self._agents_dir = agents_dir
        self._base_url = base_url
        self._loader = loader
        # Agents that came in via build_parent_app (sync mount) but whose
        # lifespan hasn't been entered yet. registry.start() drains this.
        self._pending: Dict[str, MountedAgent] = {}
        # Live agents (lifespan entered). Mutated under self._lock.
        self._active: Dict[str, MountedAgent] = {}
        # Startup-time mount failures (carried into /.health).
        self._startup_failed: List[str] = []
        self._lock = asyncio.Lock()
        self._last_reload_at: Optional[str] = None
        self._base_routes: List[Any] = []
        # Single owner for all child lifespans.
        self._lane = _LifecycleLane()

    # ------------------------------------------------------------------
    # Build-time / sync API
    # ------------------------------------------------------------------

    def add_pending(self, agent: MountedAgent) -> None:
        """Register an initial-mount agent (lifespan deferred to start())."""
        self._pending[agent.label] = agent

    def record_startup_failure(self, label: str) -> None:
        self._startup_failed.append(label)

    def set_base_routes(self, base_routes: List[Any]) -> None:
        self._base_routes = list(base_routes)

    def current_routes(self) -> List[Any]:
        """Initial routes list at build time (lifespan not yet entered)."""
        return self._base_routes + [a.mount for a in self._pending.values()]

    # ------------------------------------------------------------------
    # Async lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Enter lifespans for all initial mounts. Called from parent_lifespan startup."""
        await self._lane.start()
        async with self._lock:
            for label, agent in list(self._pending.items()):
                try:
                    await _enter_lifespan(self._lane, agent)
                    self._active[label] = agent
                except Exception as exc:  # noqa: BLE001
                    print(
                        f"[agent_loader] FAILED to enter lifespan for {label}: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    self._startup_failed.append(label)
            self._pending.clear()

    async def stop(self) -> None:
        """Shut down the lifecycle lane (closes all active lifespans). Called from parent_lifespan shutdown."""
        async with self._lock:
            self._active.clear()
        await self._lane.shutdown()

    # ------------------------------------------------------------------
    # Reload
    # ------------------------------------------------------------------

    async def reload(self) -> Dict[str, Any]:
        """Diff disk vs active registry, mount added/changed, unmount removed.

        Returns a JSON-serializable report:
            {
              added:   [labels],
              changed: [labels],
              removed: [labels],
              failed:  [{label, kind, error}],
              agents:  N,
              last_reload_at: ISO,
            }
        """
        async with self._lock:
            # Pass the currently-mounted label set so the discovery can
            # surface `draft_overrides_published` only for labels we'd
            # otherwise unmount. New labels with no marker stay silent.
            currently_mounted = frozenset(self._active.keys())
            valid, parse_failed = _discover_agents_for_reload_inner(
                self._agents_dir, currently_mounted
            )
            valid_by_label = {
                f"{v}/{s}": (v, s, p, fp) for (v, s, p, fp) in valid
            }
            parse_failed_by_label = {
                f"{v}/{s}": (v, s, p, err, hint)
                for (v, s, p, err, hint) in parse_failed
            }
            present_labels = set(valid_by_label) | set(parse_failed_by_label)

            added: List[str] = []
            changed: List[str] = []
            removed: List[str] = []
            failed: List[Dict[str, str]] = []

            # Replaced/removed agents whose lifespans should close after the
            # route swap. Held until after the swap is published.
            agents_to_close: List[MountedAgent] = []

            # ADDED: in valid, not in active.
            for label, (vendor, slug, oas_path, fingerprint) in valid_by_label.items():
                if label in self._active:
                    continue
                try:
                    new_agent = _mount_one_sync(
                        self._loader, vendor, slug, oas_path, fingerprint, self._base_url
                    )
                    await _enter_lifespan(self._lane, new_agent)
                    self._active[label] = new_agent
                    added.append(label)
                except Exception as exc:  # noqa: BLE001
                    failed.append(
                        {
                            "label": label,
                            "kind": "added",
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )

            # CHANGED: in both, fingerprint differs.
            for label, (vendor, slug, oas_path, fingerprint) in valid_by_label.items():
                prior = self._active.get(label)
                if prior is None or prior.fingerprint == fingerprint:
                    continue
                try:
                    new_agent = _mount_one_sync(
                        self._loader, vendor, slug, oas_path, fingerprint, self._base_url
                    )
                    await _enter_lifespan(self._lane, new_agent)
                    # Success: replace; queue the old agent for deferred close.
                    self._active[label] = new_agent
                    agents_to_close.append(prior)
                    changed.append(label)
                except Exception as exc:  # noqa: BLE001
                    # Keep prior version live; report kind so callers know live
                    # version is stale.
                    failed.append(
                        {
                            "label": label,
                            "kind": "changed_failed_still_serving_previous",
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )

            # PARSE_FAILED: file exists but unreadable, OR marker is missing/
            # stale for a currently-mounted label. Preserve prior mount if
            # any; report. NEVER unmount a still-live agent for this.
            #
            # If discovery emitted a `kind_hint`
            # (e.g. "draft_overrides_published"), propagate it verbatim so the
            # report distinguishes "marker stale" from "JSON parse fail". When
            # `kind_hint` is None, fall back to the parse_failed /
            # parse_failed_new derivation by registry membership.
            for label, (_, _, _, err, kind_hint) in parse_failed_by_label.items():
                if kind_hint is not None:
                    kind = kind_hint
                else:
                    kind = "parse_failed" if label in self._active else "parse_failed_new"
                failed.append({"label": label, "kind": kind, "error": err})

            # REMOVED: in active, NOT in present_labels (disk absent — never
            # parse-failed). Unmount.
            for label in list(self._active.keys()):
                if label in present_labels:
                    continue
                prior = self._active.pop(label)
                agents_to_close.append(prior)
                removed.append(label)

            # Build new routes list and SWAP atomically.
            new_routes = self._base_routes + [
                a.mount for a in self._active.values()
            ]
            self._parent_app.router.routes = new_routes  # type: ignore[attr-defined]

            self._last_reload_at = _datetime.datetime.now(
                _datetime.timezone.utc
            ).isoformat()

            # Schedule deferred cleanup AFTER the swap so old mounts are no
            # longer reachable from new requests. The lane runs the actual
            # aclose() in its own task (avoids cross-task cancel-scope error).
            if agents_to_close:
                asyncio.create_task(
                    _deferred_close_via_lane(
                        self._lane, agents_to_close, self.DEFERRED_CLOSE_SECONDS
                    )
                )

            return {
                "added": added,
                "changed": changed,
                "removed": removed,
                "failed": failed,
                "agents": len(self._active),
                "last_reload_at": self._last_reload_at,
            }

    # ------------------------------------------------------------------
    # /.health support
    # ------------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        agents = len(self._active) if self._active else len(self._pending)
        failed = list(self._startup_failed)
        return {
            "status": "degraded" if failed else "ok",
            "agents": agents,
            "failed": len(failed),
            "failed_agents": failed,
            "last_reload_at": self._last_reload_at,
        }


def _build_health_handler(
    registry: MountedAgentRegistry,
) -> Callable[[Any], JSONResponse]:
    def _health(_request: Any) -> JSONResponse:
        return JSONResponse(registry.health())

    return _health


def _check_bridge_token(request: Request) -> Optional[JSONResponse]:
    """Return None if authorized, or a JSONResponse to short-circuit.

    Auth contract:
    - Token unset → 503 (auth disabled, never expose unauthenticated reload).
    - Header missing or mismatched → 403 (constant-time compare).
    """
    expected = _read_bridge_token()
    if expected is None:
        return JSONResponse(
            {
                "error": "reload_disabled",
                "detail": (
                    "CINATRA_BRIDGE_TOKEN is not set; the reload endpoint "
                    "is disabled. Set the env var in the wayflow container "
                    "to enable hot-reload."
                ),
            },
            status_code=503,
        )
    provided = request.headers.get("X-Cinatra-Bridge-Token", "")
    # Feed both buffers to compare_digest unconditionally so length mismatches
    # do NOT short-circuit before the constant-time pass. hmac.compare_digest
    # tolerates unequal lengths in CPython >=3.3 and returns False; the
    # length-leak path is eliminated.
    if not hmac.compare_digest(provided, expected):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    return None


def _build_reload_handler(
    registry: MountedAgentRegistry,
) -> Callable[[Request], Any]:
    async def _reload(request: Request) -> JSONResponse:
        guard = _check_bridge_token(request)
        if guard is not None:
            return guard
        try:
            report = await registry.reload()
            return JSONResponse(report)
        except Exception as exc:  # noqa: BLE001
            print(
                f"[agent_loader] reload endpoint internal failure: "
                f"{type(exc).__name__}: {exc}"
            )
            return JSONResponse(
                {"error": f"{type(exc).__name__}: {exc}"}, status_code=500
            )

    return _reload


def _build_parent_lifespan(
    registry: MountedAgentRegistry,
) -> Callable[[Starlette], Any]:
    """Single owner: delegate to registry.start()/stop()."""

    @contextlib.asynccontextmanager
    async def _lifespan(_parent_app: Starlette) -> AsyncIterator[None]:
        await registry.start()
        try:
            yield
        finally:
            await registry.stop()

    return _lifespan


def build_parent_app(agents_dir: Path) -> Starlette:
    """Build the parent Starlette app with per-agent Mounts + /.health + reload.

    Per-agent load failures are caught and surfaced via /.health
    (`failed_agents`) — never crash the whole runtime (Pitfall 6).
    """
    # Apply ALL global class-level patches once at module load.
    _patch_api_call_step_bridge_token()        # bridge token on ApiCallStep
    _patch_a2a_agent_bridge_token()            # bridge token on A2AAgent HTTP
    _patch_a2a_agent_no_shared_conversation()  # skip init messages
    _patch_serve_agent_flow_validation()       # ApiNode-only flow bypass
    _patch_wayflow_flow_skip_pre_execute()     # WayflowFlow pre-execute skip
    _patch_blocking_timeout()                  # batch-LLM blocking alignment
    _patch_a2a_pydantic_timeouts()             # batch-LLM A2A timeout alignment
    _patch_pyagentspec_deserialization_error_mask()  # pyagentspec error unmask
    _patch_pyagentspec_is_python_primitive_type_guard()  # non-class annotation guard
    _patch_parallel_flow_node_extended_order()       # Extended ParallelFlowNode order
    _validate_live_class_names()

    if A2AServer is None or AgentSpecLoader is None:
        raise RuntimeError(
            "wayflowcore is not available; install wayflowcore[a2a]==26.1.1"
        )

    base_url = os.environ.get(
        "WAYFLOW_BASE_URL", "http://localhost:3010"
    ).rstrip("/")
    loader = AgentSpecLoader()

    # Construct the parent app first with placeholder routes; the registry
    # mutates app.router.routes in-place (and during reload).
    parent_app = Starlette()
    registry = MountedAgentRegistry(
        parent_app=parent_app,
        agents_dir=agents_dir,
        base_url=base_url,
        loader=loader,
    )

    # Backfill markers for any agent dir on disk that lacks
    # `.cinatra-published.json`. Idempotent: existing markers are preserved
    # untouched. Runs ONCE per process boot; rolling out a new wayflow image
    # against an existing volume of agents marks them all as "published" by
    # treating their current oas.json hash as the source of truth.
    backfilled = _backfill_missing_markers(agents_dir)
    if backfilled > 0:
        print(
            f"[agent_loader] marker backfill complete: "
            f"{backfilled} marker(s) written"
        )

    # Initial population — sync mount per discovered agent. `discover_agents`
    # returns the validated fingerprint alongside each tuple so the same bytes
    # used to validate the marker are the bytes mounted. `_mount_one_sync`
    # re-verifies as defense-in-depth.
    for vendor, slug, oas_path, fingerprint in discover_agents(agents_dir):
        label = f"{vendor}/{slug}"
        try:
            agent = _mount_one_sync(
                loader, vendor, slug, oas_path, fingerprint, base_url
            )
            registry.add_pending(agent)
            print(
                f"[agent_loader] mounted {label} at /agents/{vendor}/{slug}/ "
                f"(card url = {base_url}/agents/{vendor}/{slug}/)"
            )
        except Exception as exc:  # noqa: BLE001
            registry.record_startup_failure(label)
            print(
                f"[agent_loader] FAILED to mount {label}: "
                f"{type(exc).__name__}: {exc}"
            )

    # Base routes (always present, regardless of mounted agents).
    base_routes: List[Any] = [
        Route(
            "/.health",
            _build_health_handler(registry),
            methods=["GET"],
        ),
        Route(
            "/.internal/reload-agents",
            _build_reload_handler(registry),
            methods=["POST"],
        ),
    ]
    registry.set_base_routes(base_routes)

    # Final routes = base + initial pending mounts.
    parent_app.router.routes = registry.current_routes()  # type: ignore[attr-defined]
    parent_app.router.lifespan_context = _build_parent_lifespan(registry)  # type: ignore[attr-defined]
    # Expose registry on app.state for tests / debugging.
    parent_app.state.registry = registry  # type: ignore[attr-defined]
    parent_app.state.agents_dir = agents_dir  # type: ignore[attr-defined]
    return parent_app


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------


def main() -> None:
    agents_dir = Path(os.environ.get("CINATRA_AGENTS_DIR", "/agents"))
    parent_app = build_parent_app(agents_dir)
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "3010"))
    print(f"[agent_loader] starting parent Starlette app on {host}:{port}")
    uvicorn.run(parent_app, host=host, port=port)


if __name__ == "__main__":
    main()
