"""The step snapshots of a run, the runtime's half (cinatra#4264, slice B1a).

A Regenerate reruns ONE step of the run that produced a reviewed revision, with
every input but the note exactly as that run gave it. When the application
lists nodes in the message metadata (``cinatra_snapshot_nodes``, with the run id
under ``cinatra_snapshot_run_id``), the loader records, for each listed
TOP-LEVEL node of the root flow, the node's FULL resolved input dict, minus the
platform keys and minus every credential member at any depth (the repository's
recursive scrubber, ``cinatra_executors.input_message._scrub_credentials``),
serialized once by ``canonical_json_bytes``:

    json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
               allow_nan=False).encode("utf-8")

Those bytes are canonical: the application stores them verbatim and hashes the
same bytes, so no second language ever re-serializes them. A value that does
not serialize (a non-JSON type, NaN or Infinity, a lone surrogate at the UTF-8
encode) or is larger than ``STEP_SNAPSHOT_MAX_BYTES`` drops that node's
capture; the drop is logged.

Each snapshot is carried on the leg's last message metadata under
``cinatra_step_snapshots`` as ``{node, inputs_json, sha256, flow_sha256,
attestation}`` with ``attestation = "n1:" + hex(hmac_sha256(key,
"n1\\n<run_id>\\n<node>\\n<sha256>\\n<flow_sha256>"))``.

This module needs only the standard library and the scrubber (whose module
loads without wayflowcore), so its tests run without the runtime;
``agent_loader`` wires it into the run.
"""
from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import re
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

# The repository's ONE recursive credential-member strip (the HITL payload
# scrub); the application's persist check uses the same list
# (packages/agents/src/step-snapshots.ts scrubWayflowHistoryCredentials).
from cinatra_executors.input_message import _scrub_credentials

SNAPSHOT_NODES_METADATA_KEY = "cinatra_snapshot_nodes"
SNAPSHOT_RUN_METADATA_KEY = "cinatra_snapshot_run_id"
STEP_SNAPSHOTS_METADATA_KEY = "cinatra_step_snapshots"
#: Message id prefix of the carrier message added to a leg with no message of
#: its own; the application drops these messages from the stored history.
STEP_SNAPSHOTS_CARRIER_PREFIX = "cinatra-step-snapshots-"
STEP_SNAPSHOT_MAX_BYTES = 512 * 1024
#: The input keys the platform supplies to every node: never part of a snapshot.
#: The run-token key equals CINATRA_RUN_TOKEN_MESSAGE_KEY in agent_loader.
PLATFORM_INPUT_KEYS = frozenset({"cinatra_run_id", "agent_run_id", "__cinatra_run_token__"})
#: A flow version is a sha256 hex digest, as the application checks it.
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")
#: The parameters ``Step.invoke_async`` must take after ``self``, in order.
INVOKE_ASYNC_PARAMETERS = ("inputs", "conversation")


def canonical_json_bytes(value: Any) -> bytes:
    """The one serialization. Raises TypeError / ValueError (including
    UnicodeEncodeError for a lone surrogate) for a value it cannot carry."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def snapshot_attestation(
    key: str, run_id: str, node: str, sha256: str, flow_sha256: str
) -> str:
    material = f"n1\n{run_id}\n{node}\n{sha256}\n{flow_sha256}".encode("utf-8")
    return "n1:" + hmac.new(key.encode("utf-8"), material, hashlib.sha256).hexdigest()


def read_snapshot_request(message: Any) -> Optional[Dict[str, Any]]:
    """``{"run_id": str, "nodes": frozenset}`` from an A2A message's metadata, or
    None when the message lists no node (the run then records nothing)."""
    if not isinstance(message, dict):
        return None
    metadata = message.get("metadata")
    if not isinstance(metadata, dict):
        return None
    nodes = metadata.get(SNAPSHOT_NODES_METADATA_KEY)
    run_id = metadata.get(SNAPSHOT_RUN_METADATA_KEY)
    if not isinstance(nodes, list) or not isinstance(run_id, str) or not run_id:
        return None
    # Every listed node, never a prefix: the application sends the complete
    # sorted union its Regenerate entries declare.
    picked = [n for n in nodes if isinstance(n, str) and n]
    if not picked:
        return None
    return {"run_id": run_id, "nodes": frozenset(picked)}


def capture_node_inputs(
    node: str,
    inputs: Any,
    *,
    run_id: str,
    flow_sha256: str,
    key: Optional[str],
    log: Any = print,
) -> Optional[Dict[str, str]]:
    """The signed snapshot of one node's FULL resolved inputs, or None when it
    cannot be recorded (no key, a flow version that is not 64 lowercase hex,
    not a dict, not serializable, too large). Platform keys are removed, then
    every credential member at any depth (``_scrub_credentials``, after one
    JSON round trip so a tuple is a list); the sha256 and the attestation are
    over the canonical bytes of that stripped object."""
    if not key or not key.strip() or not run_id or not node:
        return None
    if not isinstance(flow_sha256, str) or not _SHA256_HEX.fullmatch(flow_sha256):
        log(f"[step_snapshot] node={node}: the flow version is not a sha256 hex; not recorded")
        return None
    if not isinstance(inputs, dict):
        log(f"[step_snapshot] node={node}: inputs are not a dict; not recorded")
        return None
    kept = {k: v for k, v in inputs.items() if k not in PLATFORM_INPUT_KEYS}
    try:
        stripped = _scrub_credentials(json.loads(canonical_json_bytes(kept)))
        raw = canonical_json_bytes(stripped)
    except Exception as exc:
        # Any fault here (a non-JSON value, inputs nested too deep for the
        # recursion limit, a scrubber fault) means this run cannot be
        # recorded: the recorder then treats it as unrecordable, never as
        # absent, so an earlier run's claim cannot stand for this one.
        log(f"[step_snapshot] node={node}: inputs do not serialize ({type(exc).__name__}); not recorded")
        return None
    if len(raw) > STEP_SNAPSHOT_MAX_BYTES:
        log(f"[step_snapshot] node={node}: {len(raw)} bytes over the cap; not recorded")
        return None
    sha = hashlib.sha256(raw).hexdigest()
    return {
        "node": node,
        "inputs_json": raw.decode("utf-8"),
        "sha256": sha,
        "flow_sha256": flow_sha256,
        "attestation": snapshot_attestation(key, run_id, node, sha, flow_sha256),
    }


def attach_step_snapshots(
    messages: List[Any], snapshots: Iterable[Dict[str, str]], task_id: str
) -> List[Any]:
    """Put the snapshots on the LAST message's metadata (its other metadata
    kept). A leg with no message gets one carrier agent message with no parts,
    which the application drops from the stored history. No snapshot: the
    messages are returned unchanged."""
    snaps = list(snapshots)
    if not snaps or not isinstance(messages, list):
        return messages
    if not messages or not isinstance(messages[-1], dict):
        messages.append(
            {
                "kind": "message",
                "role": "agent",
                "message_id": f"{STEP_SNAPSHOTS_CARRIER_PREFIX}{task_id}",
                "parts": [],
            }
        )
    last = messages[-1]
    metadata = last.get("metadata")
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    existing = metadata.get(STEP_SNAPSHOTS_METADATA_KEY)
    metadata[STEP_SNAPSHOTS_METADATA_KEY] = (list(existing) if isinstance(existing, list) else []) + snaps
    last["metadata"] = metadata
    return messages


class SnapshotRecorder:
    """Per-leg state: which nodes to record, for which run, in which root
    conversation and root flow, and what was recorded. A node run twice in one
    leg (a self-loop) with the same recorded inputs stays one claim; with
    different inputs, or when one of its runs cannot be recorded, the node is
    AMBIGUOUS in that leg and carries no claim (fail closed). A different value
    from a later leg is marked ambiguous by the application."""

    def __init__(
        self,
        *,
        run_id: str,
        nodes: frozenset,
        flow_sha256: str,
        key: Optional[str],
        root_conversation: Any,
        root_steps: Iterable[Any],
        root_flow: Any = None,
        log: Any = print,
    ) -> None:
        self.run_id = run_id
        self.nodes = nodes
        self.flow_sha256 = flow_sha256
        self.key = key
        self.root_conversation = root_conversation
        #: The root flow's own Step objects, by identity: a step of a nested
        #: flow is never one of them, whatever its id.
        self._root_step_ids = frozenset(id(step) for step in root_steps)
        self._root_steps = tuple(root_steps)  # keeps the ids above alive
        #: The root flow object. For an Agent-wrapped root it may run in a
        #: conversation of its own whose component is this very flow.
        self.root_flow = root_flow
        self.log = log
        self.captured: Dict[str, Dict[str, str]] = {}
        #: Every listed node seen in this leg -> its recorded sha256, or None
        #: when that run could not be recorded.
        self._seen: Dict[str, Optional[str]] = {}
        self.ambiguous: Set[str] = set()

    def observe(self, step: Any, inputs: Any, conversation: Any) -> None:
        """Called before ``step`` runs. Records only a listed TOP-LEVEL node of
        the root flow: the step is one of the root flow's own Step objects AND
        it runs in the root conversation itself (or, for an Agent-wrapped root,
        in a conversation whose component is the root flow object)."""
        if conversation is not self.root_conversation and (
            self.root_flow is None or getattr(conversation, "component", None) is not self.root_flow
        ):
            return
        if id(step) not in self._root_step_ids:
            return
        step_id = getattr(step, "id", None)
        if not isinstance(step_id, str) or step_id not in self.nodes or step_id in self.ambiguous:
            return
        snap = capture_node_inputs(
            step_id,
            inputs,
            run_id=self.run_id,
            flow_sha256=self.flow_sha256,
            key=self.key,
            log=self.log,
        )
        sha = snap["sha256"] if snap is not None else None
        if step_id in self._seen:
            if sha is None or self._seen[step_id] != sha:
                self.ambiguous.add(step_id)
                self.captured.pop(step_id, None)
                self.log(f"[step_snapshot] node={step_id}: run again in this leg with other inputs; no claim")
            return
        self._seen[step_id] = sha
        if snap is not None:
            self.captured[step_id] = snap

    def snapshots(self) -> List[Dict[str, str]]:
        return [self.captured[n] for n in sorted(self.captured)]


def snapshot_recorder_for_leg(
    message: Any,
    *,
    flow_sha256: str,
    key: Optional[str],
    conversation: Any,
    log: Any = print,
) -> Optional[SnapshotRecorder]:
    """The recorder of one leg, or None when the message lists no node, the
    flow version is missing, or the conversation's component has no steps.
    The root flow is resolved as agent_loader.py:1541-1549 resolves it: the
    conversation's component when it has ``steps`` (a Flow root), else the
    component's ``flow`` (an Agent-wrapped root)."""
    request = read_snapshot_request(message)
    if request is None or not flow_sha256:
        return None
    resolved = root_flow_steps(getattr(conversation, "component", None))
    if resolved is None:
        log("[step_snapshot] the root conversation has no flow steps; nothing recorded")
        return None
    flow, steps = resolved
    return SnapshotRecorder(
        run_id=request["run_id"],
        nodes=request["nodes"],
        flow_sha256=flow_sha256,
        key=key,
        root_conversation=conversation,
        root_steps=steps,
        root_flow=flow,
        log=log,
    )


def root_flow_steps(component: Any) -> Optional[Tuple[Any, List[Any]]]:
    """``(root flow, its Step objects)`` of a conversation's component, or None
    when it has none: ``component.steps`` when present, else
    ``component.flow.steps``; a dict gives its values, a list or tuple its
    items (agent_loader.py:1547-1560)."""
    flow = component
    steps = getattr(component, "steps", None)
    if steps is None:
        flow = getattr(component, "flow", None)
        if flow is None:
            return None
        steps = getattr(flow, "steps", None)
    if isinstance(steps, dict):
        items = list(steps.values())
    elif isinstance(steps, (list, tuple)):
        items = list(steps)
    else:
        return None
    if not items:
        return None
    return flow, items


def install_invoke_capture(
    step_cls: Any, current_recorder: Callable[[], Any], log: Any = print
) -> None:
    """Wrap ``step_cls.invoke_async`` so the leg's recorder (from
    ``current_recorder()``) sees each step before it runs. Raises RuntimeError
    when the method is missing or its parameters after ``self`` do not begin
    with ``(inputs, conversation)``: a drifted signature must stop the runtime,
    never record the wrong values or nothing. Idempotent. No recorder: the step
    runs exactly as before. A recorder fault is logged and never fails the step."""
    original = getattr(step_cls, "invoke_async", None)
    if original is None:
        raise RuntimeError(
            "[step_snapshot] Step.invoke_async is missing: the step snapshot "
            "capture cannot be installed"
        )
    if getattr(original, "__cinatra_patched__", False):
        return
    try:
        signature = inspect.signature(original)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"[step_snapshot] Step.invoke_async signature unreadable: {exc}") from exc
    names = [p.name for p in signature.parameters.values()]
    if names[1 : 1 + len(INVOKE_ASYNC_PARAMETERS)] != list(INVOKE_ASYNC_PARAMETERS):
        raise RuntimeError(
            f"[step_snapshot] Step.invoke_async takes {tuple(names)}; the step "
            f"snapshot capture needs (self, {', '.join(INVOKE_ASYNC_PARAMETERS)}, ...)"
        )

    async def _patched(self: Any, *args: Any, **kwargs: Any) -> Any:
        recorder = current_recorder()
        if recorder is not None:
            try:
                bound = signature.bind_partial(self, *args, **kwargs).arguments
                recorder.observe(self, bound.get("inputs"), bound.get("conversation"))
            except Exception as exc:
                log(f"[step_snapshot] capture failed: {type(exc).__name__}")
        return await original(self, *args, **kwargs)

    _patched.__cinatra_patched__ = True  # type: ignore[attr-defined]
    _patched.__wrapped__ = original  # type: ignore[attr-defined]
    step_cls.invoke_async = _patched
