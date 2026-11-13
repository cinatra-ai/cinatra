"""The step snapshots of a run, the runtime's half (cinatra#4264, slice B1a).

A Regenerate reruns ONE step of the run that produced a reviewed revision, with
every input but the note exactly as that run gave it. When the application
lists nodes in the message metadata (``cinatra_snapshot_nodes``, with the run id
under ``cinatra_snapshot_run_id``), the loader records, for each listed
TOP-LEVEL node of the root flow, the node's FULL resolved input dict, minus only
the platform keys, serialized once by ``canonical_json_bytes``:

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

This module is pure (standard library only) so its tests run without the
runtime; ``agent_loader`` wires it into the run.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Dict, Iterable, List, Optional

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
_MAX_NODES = 64


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
    picked = [n for n in nodes if isinstance(n, str) and n][:_MAX_NODES]
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
    cannot be recorded (no key or flow version, not a dict, not serializable,
    too large). Platform keys are removed; every other key stays."""
    if not key or not key.strip() or not flow_sha256 or not run_id or not node:
        return None
    if not isinstance(inputs, dict):
        log(f"[step_snapshot] node={node}: inputs are not a dict; not recorded")
        return None
    kept = {k: v for k, v in inputs.items() if k not in PLATFORM_INPUT_KEYS}
    try:
        raw = canonical_json_bytes(kept)
    except (TypeError, ValueError) as exc:
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
    conversation, and what was recorded. The first capture of a node in a leg
    wins; a node executed twice in one leg keeps its first inputs (the
    application marks a different second value from a later leg ambiguous)."""

    def __init__(
        self,
        *,
        run_id: str,
        nodes: frozenset,
        flow_sha256: str,
        key: Optional[str],
        root_conversation: Any,
        log: Any = print,
    ) -> None:
        self.run_id = run_id
        self.nodes = nodes
        self.flow_sha256 = flow_sha256
        self.key = key
        self.root_conversation = root_conversation
        self.log = log
        self.captured: Dict[str, Dict[str, str]] = {}

    def observe(self, step_id: Any, inputs: Any, conversation: Any) -> None:
        """Called before a step runs. Records only a listed TOP-LEVEL node of
        the root flow (its conversation is the root conversation itself)."""
        if conversation is not self.root_conversation:
            return
        if not isinstance(step_id, str) or step_id not in self.nodes or step_id in self.captured:
            return
        snap = capture_node_inputs(
            step_id,
            inputs,
            run_id=self.run_id,
            flow_sha256=self.flow_sha256,
            key=self.key,
            log=self.log,
        )
        if snap is not None:
            self.captured[step_id] = snap

    def snapshots(self) -> List[Dict[str, str]]:
        return [self.captured[n] for n in sorted(self.captured)]
