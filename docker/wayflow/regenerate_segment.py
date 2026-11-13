"""The Regenerate segment run, the runtime's half (cinatra#4264, slice B1b).

A Regenerate reruns ONE producing step of the run that produced a reviewed
revision, and the node that files the artifact, of the SAME flow version that
produced it. The application sends, on the run's initial message metadata,

    cinatra_regenerate_segment: {step, artifactNode, noteInput, noteStartOutput,
                                 flowSha256,
                                 snapshots: [{node, inputs_json, sha256}]}

and puts the note, under ``noteStartOutput`` (the flow's original start
output that feeds (step, noteInput)), and the typed repair request in the
message inputs. The
runtime then:

1. refuses with ``REGENERATE_FLOW_CHANGED`` before any step when the mounted
   agent's flow version (the composed document's sha256, else the source
   fingerprint) differs from ``flowSha256``;
2. re-verifies each snapshot's sha256 over the bytes it received;
3. derives a segment flow from the mounted (pre-substitution) document
   (``derive_regenerate_segment``, pure, cached per (flowSha256, step,
   artifactNode, noteInput)): a start node ``cinatra_segment_start``, the two
   nodes verbatim, an end node ``cinatra_segment_end`` exposing the filing
   node's outputs. Control: start -> step -> artifactNode -> end (start -> node
   -> end when step equals artifactNode). Data: every step -> artifactNode edge
   verbatim; (step, noteInput) from the start output ``cinatra_seg_note``; a
   platform port (``cinatra_run_id``, ``agent_run_id``) from the start output of
   the same name; every other input port of the two nodes from
   ``cinatra_seg_<i>``, i = its index in the sorted (node, port) list. The
   start outputs are reserved names only, so no node id or port name can
   collide with them;
4. fills ``cinatra_seg_note`` from the message input under the carried
   ``noteStartOutput``, which must be an output of the mounted flow's start
   node AND the one that feeds (step, noteInput); and ``cinatra_seg_<i>`` from
   that port's value in the node's snapshot. A missing or empty carried name,
   a name that fails either check, or a missing value refuses with
   ``REGENERATE_SEGMENT_INVALID`` before any step;
5. after the segment finishes, puts a receipt on the last message metadata
   (``cinatra_segment_receipt``): ``{step, artifactNode, flowSha256,
   attestation}`` with ``attestation = "g1:" + hex(hmac_sha256(key,
   "g1\\n<run_id>\\n<step>\\n<artifactNode>\\n<flowSha256>"))``. The
   application refiles the segment's write only with a valid receipt.

The derivation refuses (``REGENERATE_SEGMENT_INVALID``) when a node is missing
or not top-level, an id is duplicated in the document, there is no
step -> artifactNode data edge (unless they are equal), there is not exactly
one note edge into (step, noteInput) or it does not start at the flow's start
node, a port of the two nodes is fed by an edge but not declared, or the step
leaves through a named branch.

Standard library only, so its tests run without the runtime; ``agent_loader``
wires it into the run.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
from typing import Any, Dict, List, Optional, Set, Tuple

REGENERATE_SEGMENT_METADATA_KEY = "cinatra_regenerate_segment"
SEGMENT_RECEIPT_METADATA_KEY = "cinatra_segment_receipt"
#: The capability ``/.health`` lists; the application dispatches a segment run
#: only to a runtime that lists it.
REGENERATE_SEGMENT_CAPABILITY = "regenerate_segment/1"
RUNTIME_CAPABILITIES: Tuple[str, ...] = (REGENERATE_SEGMENT_CAPABILITY,)

SEGMENT_START_ID = "cinatra_segment_start"
SEGMENT_END_ID = "cinatra_segment_end"
SEGMENT_NOTE_OUTPUT = "cinatra_seg_note"
SEGMENT_PORT_PREFIX = "cinatra_seg_"
#: Ports the platform feeds from the start output of the same name.
PLATFORM_PORT_KEYS = frozenset({"cinatra_run_id", "agent_run_id"})

REGENERATE_SEGMENT_INVALID = "REGENERATE_SEGMENT_INVALID"
REGENERATE_FLOW_CHANGED = "REGENERATE_FLOW_CHANGED"

_SHA256_HEX = re.compile(r"[0-9a-f]{64}")


class RegenerateSegmentError(ValueError):
    """A segment run refused before any step runs. ``code`` is one of the
    two codes above; the message never carries an input value."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _invalid(detail: str) -> RegenerateSegmentError:
    return RegenerateSegmentError(REGENERATE_SEGMENT_INVALID, detail)


def segment_port_output(index: int) -> str:
    return f"{SEGMENT_PORT_PREFIX}{index}"


# ---------------------------------------------------------------------------
# The request on the message.
# ---------------------------------------------------------------------------


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def read_segment_request(message: Any) -> Optional[Dict[str, Any]]:
    """The segment request of an A2A message, or None when the message carries
    none (an ordinary run). A request that is present but malformed refuses:
    a run the application asked to be a segment never runs as a whole flow."""
    if not isinstance(message, dict):
        return None
    metadata = message.get("metadata")
    if not isinstance(metadata, dict) or REGENERATE_SEGMENT_METADATA_KEY not in metadata:
        return None
    raw = metadata[REGENERATE_SEGMENT_METADATA_KEY]
    if not isinstance(raw, dict):
        raise _invalid("the segment request is not an object")
    for name in ("step", "artifactNode", "noteInput", "noteStartOutput"):
        if not _nonempty_str(raw.get(name)):
            raise _invalid(f"the segment request has no {name}")
    flow_sha = raw.get("flowSha256")
    if not isinstance(flow_sha, str) or not _SHA256_HEX.fullmatch(flow_sha):
        raise _invalid("the segment request's flowSha256 is not a sha256 hex")
    snapshots = raw.get("snapshots")
    if not isinstance(snapshots, list) or not snapshots:
        raise _invalid("the segment request carries no snapshot")
    clean: List[Dict[str, str]] = []
    for snap in snapshots:
        if not isinstance(snap, dict):
            raise _invalid("a snapshot is not an object")
        node, inputs_json, sha = snap.get("node"), snap.get("inputs_json"), snap.get("sha256")
        if not _nonempty_str(node) or not isinstance(inputs_json, str):
            raise _invalid("a snapshot has no node or no inputs")
        if not isinstance(sha, str) or not _SHA256_HEX.fullmatch(sha):
            raise _invalid(f"the snapshot of {node!r} has no sha256 hex")
        clean.append({"node": node, "inputs_json": inputs_json, "sha256": sha})
    return {
        "step": raw["step"],
        "artifactNode": raw["artifactNode"],
        "noteInput": raw["noteInput"],
        "noteStartOutput": raw["noteStartOutput"],
        "flowSha256": flow_sha,
        "snapshots": clean,
    }


def check_segment_request(request: Dict[str, Any], mounted_flow_sha256: str) -> Dict[str, Dict[str, Any]]:
    """The version check, then each snapshot re-verified over its bytes.
    Returns ``{node: parsed inputs}``. The flow version is checked FIRST:
    a run of another flow version never gets as far as reading inputs."""
    if not isinstance(mounted_flow_sha256, str) or not hmac.compare_digest(
        mounted_flow_sha256, request["flowSha256"]
    ):
        raise RegenerateSegmentError(
            REGENERATE_FLOW_CHANGED,
            "the mounted flow is not the version that produced the reviewed revision",
        )
    by_node: Dict[str, Dict[str, Any]] = {}
    for snap in request["snapshots"]:
        node = snap["node"]
        if node in by_node:
            raise _invalid(f"two snapshots of {node!r}")
        raw = snap["inputs_json"].encode("utf-8")
        if hashlib.sha256(raw).hexdigest() != snap["sha256"]:
            raise _invalid(f"the snapshot of {node!r} does not match its sha256")
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise _invalid(f"the snapshot of {node!r} is not JSON") from None
        if not isinstance(parsed, dict):
            raise _invalid(f"the snapshot of {node!r} is not an object")
        by_node[node] = parsed
    return by_node


# ---------------------------------------------------------------------------
# The derivation (pure).
# ---------------------------------------------------------------------------


def _ref(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        ref = value.get("$component_ref")
        if isinstance(ref, str):
            return ref
    return None


def _resolve(value: Any, refs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ref = _ref(value)
    if ref is not None:
        found = refs.get(ref)
        return found if isinstance(found, dict) else None
    return value if isinstance(value, dict) else None


def _collect_ids(value: Any, out: List[str]) -> None:
    if isinstance(value, dict):
        if isinstance(value.get("component_type"), str) and isinstance(value.get("id"), str):
            out.append(value["id"])
        for key, item in value.items():
            if key == "$component_ref":
                continue
            _collect_ids(item, out)
    elif isinstance(value, list):
        for item in value:
            _collect_ids(item, out)


def _descriptors(items: Any, what: str, node: str) -> List[Dict[str, Any]]:
    if items is None:
        return []
    if not isinstance(items, list):
        raise _invalid(f"the {what} of {node!r} are not a list")
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or not _nonempty_str(item.get("title")):
            raise _invalid(f"a {what[:-1]} of {node!r} has no title")
        if item["title"] in seen:
            raise _invalid(f"two {what} of {node!r} are titled {item['title']!r}")
        seen.add(item["title"])
        out.append(item)
    return out


def _node_ports(comp: Dict[str, Any], refs: Dict[str, Any], what: str) -> List[Dict[str, Any]]:
    """A node's declared inputs or outputs; a FlowNode that lists none has its
    subflow's."""
    node = comp["id"]
    own = comp.get(what)
    if comp.get("component_type") == "FlowNode" and not own:
        sub = _resolve(comp.get("subflow"), refs)
        if sub is None:
            raise _invalid(f"the subflow of {node!r} is missing")
        return _descriptors(sub.get(what), what, node)
    return _descriptors(own, what, node)


def _closure(roots: List[Dict[str, Any]], refs: Dict[str, Any]) -> Dict[str, Any]:
    """Every root-level referenced component the given components reach."""
    keep: Dict[str, Any] = {}
    stack: List[Any] = list(roots)
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            ref = _ref(value)
            if ref is not None and len(value) == 1:
                if ref not in keep and isinstance(refs.get(ref), dict):
                    keep[ref] = refs[ref]
                    stack.append(refs[ref])
                continue
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    return keep


def _data_edge(edge_id: str, source: str, output: str, dest: str, port: str) -> Dict[str, Any]:
    return {
        "component_type": "DataFlowEdge",
        "id": edge_id,
        "name": edge_id,
        "description": "",
        "metadata": {},
        "source_node": {"$component_ref": source},
        "source_output": output,
        "destination_node": {"$component_ref": dest},
        "destination_input": port,
    }


def _control_edge(edge_id: str, source: str, dest: str) -> Dict[str, Any]:
    return {
        "component_type": "ControlFlowEdge",
        "id": edge_id,
        "name": edge_id,
        "description": "",
        "metadata": {},
        "from_node": {"$component_ref": source},
        "from_branch": None,
        "to_node": {"$component_ref": dest},
    }


def _titled(descriptor: Dict[str, Any], title: str) -> Dict[str, Any]:
    out = copy.deepcopy(descriptor)
    out["title"] = title
    return out


def derive_regenerate_segment(
    composed_doc: Any, step: str, artifact_node: str, note_input: str
) -> Dict[str, Any]:
    """The segment of ``composed_doc`` for one Regenerate entry.

    Returns ``{"doc", "note_source", "ports", "platform"}``: the segment flow
    document, the original start output that fed the note, the sorted
    ``(node, port)`` list behind ``cinatra_seg_<i>``, and the platform keys
    the segment start exposes. Raises RegenerateSegmentError
    (``REGENERATE_SEGMENT_INVALID``) for every refusal in the module header.
    """
    if not isinstance(composed_doc, dict) or composed_doc.get("component_type") != "Flow":
        raise _invalid("the mounted document is not a Flow")
    refs = composed_doc.get("$referenced_components") or {}
    if not isinstance(refs, dict):
        raise _invalid("the mounted document's referenced components are not an object")

    all_ids: List[str] = []
    _collect_ids(composed_doc, all_ids)
    if len(all_ids) != len(set(all_ids)):
        raise _invalid("an id appears twice in the mounted document")
    id_set = set(all_ids)
    for reserved in (SEGMENT_START_ID, SEGMENT_END_ID):
        if reserved in id_set:
            raise _invalid(f"the mounted document already uses the id {reserved!r}")

    components: Dict[str, Dict[str, Any]] = {}
    for entry in composed_doc.get("nodes") or []:
        comp = _resolve(entry, refs)
        if comp is None or not _nonempty_str(comp.get("id")):
            raise _invalid("a top-level node cannot be resolved")
        components[comp["id"]] = comp
    start = _resolve(composed_doc.get("start_node"), refs)
    if start is None or start.get("component_type") != "StartNode":
        raise _invalid("the flow has no start node")
    start_id = start["id"]
    start_outputs = sorted(
        {
            d["title"]
            for key in ("inputs", "outputs")
            for d in (start.get(key) or [])
            if isinstance(d, dict) and _nonempty_str(d.get("title"))
        }
    )

    for node in (step, artifact_node):
        comp = components.get(node)
        if comp is None:
            raise _invalid(f"{node!r} is not a top-level node of the flow")
        if comp.get("component_type") in ("StartNode", "EndNode"):
            raise _invalid(f"{node!r} is the flow's {comp['component_type']}")
    same = step == artifact_node
    seg_nodes = [step] if same else [step, artifact_node]

    edges: List[Tuple[str, str, str, str, Dict[str, Any]]] = []
    for edge in composed_doc.get("data_flow_connections") or []:
        if not isinstance(edge, dict):
            raise _invalid("a data edge is not an object")
        src, dst = _ref(edge.get("source_node")), _ref(edge.get("destination_node"))
        out, port = edge.get("source_output"), edge.get("destination_input")
        if not (src and dst and isinstance(out, str) and isinstance(port, str)):
            raise _invalid("a data edge has no source or destination")
        edges.append((src, out, dst, port, edge))

    for cedge in composed_doc.get("control_flow_connections") or []:
        if isinstance(cedge, dict) and _ref(cedge.get("from_node")) in seg_nodes:
            if cedge.get("from_branch") not in (None, "", "next"):
                raise _invalid(f"{_ref(cedge.get('from_node'))!r} leaves through a named branch")

    note_edges = [e for e in edges if e[2] == step and e[3] == note_input]
    if len(note_edges) != 1:
        raise _invalid(f"not exactly one edge feeds the note port {note_input!r} of {step!r}")
    if note_edges[0][0] != start_id:
        raise _invalid(f"the note port {note_input!r} of {step!r} is not fed by the flow's start")
    note_source = note_edges[0][1]

    links = [] if same else [e for e in edges if e[0] == step and e[2] == artifact_node]
    if not same and not links:
        raise _invalid(f"no data edge runs from {step!r} to {artifact_node!r}")
    linked_ports = {e[3] for e in links}

    inputs_of: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for node in seg_nodes:
        inputs_of[node] = {d["title"]: d for d in _node_ports(components[node], refs, "inputs")}
    for src, _out, dst, port, _edge in edges:
        if dst in inputs_of and port not in inputs_of[dst]:
            raise _invalid(f"an edge feeds {dst!r}.{port!r}, which {dst!r} does not declare")
    if note_input not in inputs_of[step]:
        raise _invalid(f"{step!r} declares no input {note_input!r}")

    ports: List[Tuple[str, str]] = []
    platform: Dict[str, Dict[str, Any]] = {}
    platform_edges: List[Tuple[str, str]] = []
    for node in seg_nodes:
        for port, desc in inputs_of[node].items():
            if node == step and port == note_input:
                continue
            if node == artifact_node and not same and port in linked_ports:
                continue
            if port in PLATFORM_PORT_KEYS:
                platform.setdefault(port, desc)
                platform_edges.append((node, port))
                continue
            ports.append((node, port))
    ports.sort()

    start_inputs: List[Dict[str, Any]] = [_titled(inputs_of[step][note_input], SEGMENT_NOTE_OUTPUT)]
    for i, (node, port) in enumerate(ports):
        start_inputs.append(_titled(inputs_of[node][port], segment_port_output(i)))
    for key in sorted(platform):
        start_inputs.append(_titled(platform[key], key))

    outputs = [copy.deepcopy(d) for d in _node_ports(components[artifact_node], refs, "outputs")]

    seg_start = {
        "component_type": "StartNode",
        "id": SEGMENT_START_ID,
        "name": SEGMENT_START_ID,
        "inputs": start_inputs,
    }
    seg_end = {
        "component_type": "EndNode",
        "id": SEGMENT_END_ID,
        "name": SEGMENT_END_ID,
        "outputs": outputs,
    }

    data_edges: List[Dict[str, Any]] = []
    counter = [0]

    def next_id() -> str:
        while True:
            counter[0] += 1
            candidate = f"{SEGMENT_PORT_PREFIX}edge_{counter[0]}"
            if candidate not in id_set:
                return candidate

    for _src, _out, _dst, _port, edge in links:
        data_edges.append(copy.deepcopy(edge))
    data_edges.append(_data_edge(next_id(), SEGMENT_START_ID, SEGMENT_NOTE_OUTPUT, step, note_input))
    for i, (node, port) in enumerate(ports):
        data_edges.append(_data_edge(next_id(), SEGMENT_START_ID, segment_port_output(i), node, port))
    for node, port in platform_edges:
        data_edges.append(_data_edge(next_id(), SEGMENT_START_ID, port, node, port))
    for desc in outputs:
        data_edges.append(_data_edge(next_id(), artifact_node, desc["title"], SEGMENT_END_ID, desc["title"]))

    chain = [SEGMENT_START_ID] + seg_nodes + [SEGMENT_END_ID]
    control_edges = [_control_edge(next_id(), a, b) for a, b in zip(chain, chain[1:])]

    seg_refs: Dict[str, Any] = {SEGMENT_START_ID: seg_start, SEGMENT_END_ID: seg_end}
    for node in seg_nodes:
        seg_refs[node] = copy.deepcopy(components[node])
    for ref_id, comp in _closure([components[n] for n in seg_nodes], refs).items():
        if ref_id not in seg_refs:
            seg_refs[ref_id] = copy.deepcopy(comp)

    flow_id = f"{composed_doc.get('id') or 'flow'}--cinatra-segment"
    if flow_id in id_set:
        raise _invalid(f"the mounted document already uses the id {flow_id!r}")
    doc: Dict[str, Any] = {
        "component_type": "Flow",
        "id": flow_id,
        "name": f"Regenerate {step} -> {artifact_node}",
        "description": "",
        "metadata": {},
        "inputs": [copy.deepcopy(d) for d in start_inputs],
        "outputs": [copy.deepcopy(d) for d in outputs],
        "start_node": {"$component_ref": SEGMENT_START_ID},
        "nodes": [{"$component_ref": n} for n in chain],
        "control_flow_connections": control_edges,
        "data_flow_connections": data_edges,
        "$referenced_components": seg_refs,
    }
    if "agentspec_version" in composed_doc:
        doc = {"agentspec_version": composed_doc["agentspec_version"], **doc}
    return {
        "doc": doc,
        "note_source": note_source,
        "start_outputs": start_outputs,
        "ports": ports,
        "platform": sorted(platform),
    }


_DERIVATION_CACHE: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
_DERIVATION_CACHE_MAX = 256


def derive_regenerate_segment_cached(
    flow_sha256: str, composed_doc: Any, step: str, artifact_node: str, note_input: str
) -> Dict[str, Any]:
    """``derive_regenerate_segment`` cached per (flowSha256, step,
    artifactNode, noteInput): one flow version derives one segment. A refusal
    is never cached. The caller must not change the returned value."""
    key = (flow_sha256, step, artifact_node, note_input)
    hit = _DERIVATION_CACHE.get(key)
    if hit is not None:
        return hit
    derived = derive_regenerate_segment(composed_doc, step, artifact_node, note_input)
    if len(_DERIVATION_CACHE) >= _DERIVATION_CACHE_MAX:
        _DERIVATION_CACHE.clear()
    _DERIVATION_CACHE[key] = derived
    return derived


def build_segment_inputs(
    derivation: Dict[str, Any],
    snapshots_by_node: Dict[str, Dict[str, Any]],
    message_inputs: Any,
    note_start_output: Any,
) -> Dict[str, Any]:
    """The segment start's inputs: the note from the message input under the
    carried start output name, each ``cinatra_seg_<i>`` from its node's
    snapshot, each platform key from the message. The carried name must be an
    output of the mounted start node and the one that feeds the note. A
    missing value or a name that fails either check refuses."""
    if not _nonempty_str(note_start_output):
        raise _invalid("the segment request names no start output for the note")
    if note_start_output not in derivation["start_outputs"]:
        raise _invalid(f"the flow's start node has no output {note_start_output!r}")
    if note_start_output != derivation["note_source"]:
        raise _invalid(f"the start output {note_start_output!r} does not feed the note")
    if not isinstance(message_inputs, dict):
        raise _invalid("the message carries no inputs")
    note = message_inputs.get(note_start_output)
    if not isinstance(note, str):
        raise _invalid(f"the message carries no note under {note_start_output!r}")
    inputs: Dict[str, Any] = {SEGMENT_NOTE_OUTPUT: note}
    for i, (node, port) in enumerate(derivation["ports"]):
        snap = snapshots_by_node.get(node)
        if snap is None:
            raise _invalid(f"no snapshot of {node!r}")
        if port not in snap:
            raise _invalid(f"the snapshot of {node!r} has no value for {port!r}")
        inputs[segment_port_output(i)] = copy.deepcopy(snap[port])
    for key in derivation["platform"]:
        value = message_inputs.get(key)
        if not _nonempty_str(value):
            raise _invalid(f"the message carries no {key}")
        inputs[key] = value
    return inputs


def prepare_segment_run(
    request: Dict[str, Any],
    *,
    mounted_flow_sha256: str,
    working_doc: Any,
    message_inputs: Any,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Everything before the first step, in order: the flow version, the
    snapshot bytes, the derivation, the inputs. Returns (derivation, inputs)."""
    snapshots = check_segment_request(request, mounted_flow_sha256)
    derivation = derive_regenerate_segment_cached(
        request["flowSha256"], working_doc, request["step"], request["artifactNode"], request["noteInput"]
    )
    return derivation, build_segment_inputs(derivation, snapshots, message_inputs, request.get("noteStartOutput"))


# ---------------------------------------------------------------------------
# The receipt.
# ---------------------------------------------------------------------------


def segment_receipt_attestation(
    key: str, run_id: str, step: str, artifact_node: str, flow_sha256: str
) -> str:
    material = f"g1\n{run_id}\n{step}\n{artifact_node}\n{flow_sha256}".encode("utf-8")
    return "g1:" + hmac.new(key.encode("utf-8"), material, hashlib.sha256).hexdigest()


def segment_receipt(key: Optional[str], run_id: Any, request: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """The signed receipt of a finished segment, or None without a key or a
    run id (the application then refiles nothing)."""
    if not key or not key.strip() or not _nonempty_str(run_id):
        return None
    return {
        "step": request["step"],
        "artifactNode": request["artifactNode"],
        "flowSha256": request["flowSha256"],
        "attestation": segment_receipt_attestation(
            key, run_id, request["step"], request["artifactNode"], request["flowSha256"]
        ),
    }


#: The id prefix of the carrier message a leg with no message of its own gets;
#: the application drops these messages from the stored history (the same
#: prefix as the step snapshots' carrier).
SEGMENT_RECEIPT_CARRIER_PREFIX = "cinatra-step-snapshots-"


def attach_segment_receipt(messages: List[Any], receipt: Optional[Dict[str, str]], task_id: str) -> List[Any]:
    """Put the receipt on the LAST message's metadata (its other metadata
    kept); a leg with no message gets one carrier message. No receipt: the
    messages are returned unchanged."""
    if receipt is None or not isinstance(messages, list):
        return messages
    if not messages or not isinstance(messages[-1], dict):
        messages.append(
            {
                "kind": "message",
                "role": "agent",
                "message_id": f"{SEGMENT_RECEIPT_CARRIER_PREFIX}{task_id}",
                "parts": [],
            }
        )
    last = messages[-1]
    metadata = last.get("metadata")
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    metadata[SEGMENT_RECEIPT_METADATA_KEY] = dict(receipt)
    last["metadata"] = metadata
    return messages
