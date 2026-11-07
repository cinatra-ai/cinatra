"""Regression test for `wayflow-docker-no-start`.

Mount-loads every discoverable ``oas.json`` through AgentSpecLoader the SAME way
``agent_loader._mount_one_sync`` does at container start — i.e. through the real
pre-load pipeline (context-subflow injection → HITL gate reconcile →
placeholder substitution), not a bare ``AgentSpecLoader().load_json``. Loading
the raw OAS directly diverges from the runtime path and would (a) false-fail on
the #1794 declared-inputs HITL gate form (repaired at load by
``_reconcile_input_message_gates``, cinatra#1830) and (b) miss any failure the
injection step introduces.

This catches whole-stack startup failures (the boolean-vs-string
``InputMessageNode.outputs`` mismatch that broke 6 of 7 wayflow containers; the
declared-gate-input rejection of cinatra#1830).

Discovery reuses the runtime's OWN ``agent_loader.discover_agents`` two-level
walk (``<agents_dir>/<vendor>/<slug>/cinatra/oas.json``) so the guard can never
drift from the set the loader actually mounts. By default it scans the in-repo
multi-vendor ``extensions`` root — the exact tree docker-compose bind-mounts at
``/agents``. Set ``CINATRA_AGENTS_DIR`` to the INSTALLED standalone-extension
tree (the very path the container mounts at ``/agents``, materialized from the
dev-lock) so CI exercises the exact installed OAS artifacts rather than only the
vendored copies — closing the "vendored ≠ installed" gap called out in
cinatra#1830. The ``agents-run``/``works-after`` container CI points this at the
mounted ``/agents`` tree (see ``scripts/ci/works-after/wayflow.sh``), so the same
``CINATRA_AGENTS_DIR`` value drives both the runtime boot and this guard.

An agent whose gate is a KNOWN, separately-tracked mount failure is allowlisted
as a strict ``xfail`` (see ``_KNOWN_FAILING_GATE_AGENTS``) so its red stays
VISIBLE without failing the whole guard — and a surprise PASS forces the entry's
removal.

Runs only where wayflowcore + pyagentspec are installed. Skipped otherwise.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

_ENV_DIR = os.environ.get("CINATRA_AGENTS_DIR")
_HERE = Path(__file__).resolve()
# parents[3] = repo root when this file lives at ``<repo>/docker/wayflow/tests/``.
# In the wayflow image the file lives at ``/app/tests/`` (only two levels deep),
# so ``parents[3]`` would IndexError at import — guard it. The container ALWAYS
# sets ``CINATRA_AGENTS_DIR=/agents``, so the repo-root default is never needed
# there; a shallow mount with no override simply has nothing to scan.
_REPO_ROOT = _HERE.parents[3] if len(_HERE.parents) > 3 else None
if _ENV_DIR:
    AGENTS_DIR = Path(_ENV_DIR)
elif _REPO_ROOT is not None:
    # Default to the multi-vendor ``extensions`` root — the SAME tree
    # docker-compose bind-mounts at ``/agents`` and that ``discover_agents``
    # two-level-walks.
    AGENTS_DIR = _REPO_ROOT / "extensions"
else:
    AGENTS_DIR = Path("/__no_agents_dir__")  # shallow mount, no override → inert

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only inside the container
    AgentSpecLoader = None  # type: ignore[assignment]

# Reuse the loader's own pre-load transforms + discovery so this guard tracks
# the exact runtime mount path. Guarded: agent_loader pulls in the full runtime
# import surface (starlette/uvicorn/wayflowcore), so on a host that lacks it the
# whole suite skips rather than erroring at collection.
try:
    import agent_loader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only where the runtime deps exist
    agent_loader = None  # type: ignore[assignment]

try:  # context-subflow injection ships next to agent_loader in the image
    from context_subflow_injection import inject_context_subflows  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    inject_context_subflows = None  # type: ignore[assignment]


# Agents whose gate is KNOWN to still fail this mount guard, pending a separate
# fix — allowlisted as a strict ``xfail`` so the red stays VISIBLE (the suite
# reports it, it does not silently pass) while CI stays green, rather than
# masking it or hard-failing the whole guard. ``strict`` flips an unexpected
# PASS into a FAILURE, so the day a listed agent starts mounting this guard
# forces its allowlist entry to be removed.
#
# EMPTY. auditor-agent formerly sat here (cinatra#1625 / cinatra#1830). Both of
# its known ``review_gate`` forms mount, so no conditional is warranted:
#   - auditor-agent revision ``179a7d13`` declares NO gate ``inputs`` (the
#     renderer ``inputMessageSchema`` lives under ``metadata.cinatra``); with no
#     ``{{placeholder}}`` ``message`` pyagentspec 26.1.2 infers an empty input
#     set, so the gate mounts NATIVELY and ``_reconcile_input_message_gates``
#     (which only touches an ``InputMessageNode`` with non-empty ``inputs``) is a
#     no-op. A strict-xfail entry against this form XPASSes and FAILS the guard.
#   - the cinatra#1625 HITL gate re-encode moves those to declared,
#     DataFlowEdge-fed inputs with plain ``[A-Za-z_]\w*`` titles
#     (``prompts``/``preview``) — which the shim folds into a
#     ``PluginInputMessageNode`` ``message_template`` (covered by
#     test_input_message_gate_reconcile.py), so that form mounts too.
# A conditional xfail would have no failing state to represent and could conceal
# a future regression, so the entry is removed unconditionally.
#
# ``security-reviewer-agent`` also formerly sat here (cinatra#2140): the FIRST run
# of this guard against the real pinned extension tree — see the
# ``validate-wayflow-mount`` job in .github/workflows/validate-agents.yml, which
# that issue wired up — surfaced one genuine pre-existing mount failure. It was
# NOT a HITL-gate defect: at pin ``aa44488c`` the ``review`` node's ``data.system``
# prompt contained a LITERAL ``{{ ... }}`` inside prose ("interpolate untrusted
# input via ``{{ ... }}``"), which wayflowcore parses as a Jinja expression and
# rejects with ``TemplateSyntaxError: unexpected '.'`` — so the agent never
# mounted. The fix belonged in the agent repo and LANDED there
# (security-reviewer-agent#33, escaping the literal moustache example); the pin
# moved to ``8e978e46`` in the same core change that removes this entry, so the
# agent mounts and the strict xfail would XPASS-red. Removed exactly as designed:
# the allowlist never outlives the failure it records.
#
# The allowlist maps slug → a SUBSTRING of the expected failure, and the check is
# BOUNDED (below): only that exact failure xfails. A different exception on an
# allowlisted agent is a real FAILURE (a blanket slug xfail would have masked it),
# and an allowlisted agent that starts mounting fails too, forcing the entry out.
_KNOWN_FAILING_GATE_AGENTS: dict[str, str] = {}
_KNOWN_FAILING_REASON = (
    "known-failing mount (see _KNOWN_FAILING_GATE_AGENTS) — awaits a "
    "separately-tracked fix; the bounded xfail keeps the red visible without "
    "failing the guard, and only for the recorded failure."
)


def _agent_oas_params() -> list["pytest.ParameterSet"]:
    """Enumerate every mountable OAS via the runtime's own ``discover_agents``
    two-level walk, so the guard's parametrization is byte-identical to the set
    the loader mounts at boot. Each param is keyed by the canonical ``slug``
    (from ``metadata.cinatra.packageName``). A known-failing agent is NOT marked
    here: the xfail is applied in the test body so it can be bounded to the
    recorded failure instead of blanketing the slug."""
    # No point discovering (and parsing OAS) when the suite can't mount anyway —
    # keeps collection inert on a host missing the runtime deps.
    if agent_loader is None or AgentSpecLoader is None or not AGENTS_DIR.is_dir():
        return []
    out: list["pytest.ParameterSet"] = []
    for vendor, slug, oas_path, _sha in agent_loader.discover_agents(AGENTS_DIR):
        out.append(pytest.param(oas_path, slug, id=f"{vendor}/{slug}"))
    return out


def _runtime_preload(raw_text: str, label: str) -> str:
    """Apply the pre-``load_json`` transforms of ``_mount_one_sync``, in its
    order: context-subflow injection, HITL gate reconcile, then env
    substitution. It omits the bridge ``output_schema`` derivation
    (``_derive_bridge_output_schemas``), which only adds ``data.output_schema``
    to model-bridge ApiNodes."""
    parsed = json.loads(raw_text)
    if isinstance(parsed, dict):
        if inject_context_subflows is not None:
            composed, report = inject_context_subflows(parsed, label)
            if report:
                parsed = composed
        agent_loader._reconcile_input_message_gates(parsed, label)
        raw_text = json.dumps(parsed)
    return agent_loader._substitute_placeholders(raw_text)


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
@pytest.mark.parametrize("oas_path,slug", _agent_oas_params())
def test_oas_loads_via_agentspec_loader(oas_path: Path, slug: str) -> None:
    """Each discoverable oas.json must mount through the real runtime pre-load
    pipeline + AgentSpecLoader without exception."""
    raw = oas_path.read_text(encoding="utf-8")
    label = oas_path.parent.parent.name
    substituted = _runtime_preload(raw, label)
    expected_failure = _KNOWN_FAILING_GATE_AGENTS.get(slug)
    try:
        agent = AgentSpecLoader().load_json(substituted)
    except Exception as exc:  # noqa: BLE001 — the message decides the verdict
        if expected_failure is not None and expected_failure in str(exc):
            pytest.xfail(f"{slug}: {_KNOWN_FAILING_REASON} [{expected_failure}]")
        raise
    assert agent is not None, f"AgentSpecLoader returned None for {oas_path}"
    if expected_failure is not None:
        pytest.fail(
            f"{slug} is in _KNOWN_FAILING_GATE_AGENTS but now mounts — remove its "
            f"entry (the allowlist must never outlive the failure it records)."
        )


# ---------------------------------------------------------------------------
# cinatra#4154 — the signed step id IS the flow document's node id.
#
# On a passthrough call to the application's own host (CINATRA_BASE_URL), the
# runtime signs the executing step's own id (`self.id`) when the bridge token,
# the attestation key, the run's context id and that step id are all set;
# otherwise it signs nothing (agent_loader.py, cinatra#3745). The application
# decides which package's tool a signed call reaches by finding that id in the
# INSTALLED flow document. That holds only if the real loader compiles each
# passthrough ApiNode to a step whose `id` is that node's own `id`. The
# structural pre-load transforms (context-subflow injection, the HITL gate
# reconcile and the bridge `output_schema` derivation) assign no existing
# node's `id`. The env substitution rewrites a placeholder in any string, an
# `id` included, so the test reads the document AFTER it, as the loader does.
# The mapping inside `AgentSpecLoader` is the library's, so it is pinned here,
# per mounted agent, after the same pre-load pipeline as the mount test above.
# That pipeline omits one of the four transforms of `_mount_one_sync`:
# `_derive_bridge_output_schemas` only adds `data.output_schema` to
# model-bridge ApiNodes and assigns no `id`.
#
# The test compares each passthrough node with its compiled step, not two sets
# of ids. A node is keyed by its `id`, its `name`, the ids of the flows whose
# `nodes` hold it and a digest of its method, url and body; a compiled
# ApiCallStep by the same of its own (the flows whose `steps` hold it). So it
# is red when a node has no compiled step of its id, when two different nodes
# compile under one id, and when a step carries the id of another node that
# differs from its own in name, flow, method, url or body (two ids swapped). A
# reference under `$referenced_components` that no instantiated component
# reaches, and a node under `metadata`, compile to nothing and are not counted.
# The compiled walk follows every instance attribute of every wayflowcore
# object it reaches (a flow's `steps`, a sub-flow, an `AgentExecutionStep`'s
# `agent`, a tool), not a fixed list of attribute names. The synthetic tests at
# the end of this file pin those cases without wayflowcore.
#
# Where this can fail on the mounted tree: an agent whose document holds a
# passthrough node is red when its compiled steps do not match it. An agent
# with no passthrough node and no compiled passthrough step passes with two
# EMPTY sets, so a tree without such an agent proves nothing here (the
# single-agent fixture tree of the works-after proof is one). The one anchor is
# the outreach agent at the disk path `cinatra-ai/email-outreach-agent`: its
# document must hold the passthrough node `sender-file_recipients` and a
# compiled step must carry that id, so a walker that sees nothing is red there.
# In the mount-guard job, assert_mount_health.py requires that path in the tree
# before this file runs.
# ---------------------------------------------------------------------------

_PASSTHROUGH_PATH = "/agents/passthrough"
#: The disk label (`<vendor>/<slug dir>`, the basis of assert_mount_health.py's
#: REQUIRED_LABELS) of the agent that anchors the test, and its passthrough node.
_ANCHOR_DISK_LABEL = "cinatra-ai/email-outreach-agent"
_ANCHOR_NODE_ID = "sender-file_recipients"


def _passthrough_key(
    node_id: object, name: object, flows: object, method: object, url: object, data: object
) -> tuple:
    """`(id, name, flow ids, digest)`: the digest covers the method, the url and
    the body. A failure message prints only this key, never a substituted url or
    body."""
    if not data:
        body = None  # the loader passes an empty body on as None
    elif isinstance(data, bytes):
        body = ["bytes", data.decode("utf-8", "replace")]
    elif isinstance(data, str):
        body = ["str", data]
    else:
        body = ["json", data]
    material = json.dumps([method, url, body], sort_keys=True, default=repr)
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
    return (node_id, name, tuple(sorted(flows)), digest)  # type: ignore[call-overload]


def _oas_passthrough_nodes(doc: object) -> set[tuple]:
    """The key of every passthrough ApiNode an instantiated component of the
    pre-loaded document reaches. The walk starts at the root, follows each
    `$component_ref` into the referenced components (pyagentspec merges every
    level of `$referenced_components` into one map) and does not enter
    `$referenced_components` or `metadata` directly. An unresolved reference
    fails loudly."""
    refs: dict[str, object] = {}
    stack: list[object] = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            level = node.get("$referenced_components")
            if isinstance(level, dict):
                refs.update(level)
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)

    def resolve(entry: object) -> object:
        ref = entry.get("$component_ref") if isinstance(entry, dict) else None
        if not isinstance(ref, str):
            return entry
        assert ref in refs, f"`$component_ref` {ref!r} names no referenced component"
        return refs[ref]

    found: list[dict] = []
    owners: dict[int, set[str]] = {}
    seen: set[int] = set()
    pending: list[object] = [doc]
    while pending:
        node = resolve(pending.pop())
        if isinstance(node, list):
            pending.extend(node)
            continue
        if not isinstance(node, dict) or id(node) in seen:
            continue
        seen.add(id(node))
        members = node.get("nodes")
        if isinstance(members, list) and isinstance(node.get("id"), str):
            for entry in members:
                owners.setdefault(id(resolve(entry)), set()).add(node["id"])
        if (
            node.get("component_type") == "ApiNode"
            and isinstance(node.get("id"), str)
            and _PASSTHROUGH_PATH in str(node.get("url", ""))
        ):
            found.append(node)
        pending.extend(v for k, v in node.items() if k not in ("$referenced_components", "metadata"))
    return {
        _passthrough_key(
            n["id"], n.get("name"), owners.get(id(n), set()), n.get("http_method"), n.get("url"), n.get("data")
        )
        for n in found
    }


def _is_wayflowcore_object(obj: object) -> bool:
    return type(obj).__module__.split(".", 1)[0] == "wayflowcore"


def _compiled_passthrough_steps(
    agent: object,
    *,
    api_call_step_cls: type | None = None,
    is_runtime_object=_is_wayflowcore_object,
) -> set[tuple]:
    """The key of every compiled ApiCallStep on the passthrough road. The walk
    follows every instance attribute of every runtime object it reaches, and
    the values of every list, tuple, set and dict among them."""
    if api_call_step_cls is None:
        from wayflowcore.steps import ApiCallStep as api_call_step_cls  # type: ignore[import-not-found]

    found: list[object] = []
    owners: dict[int, set[str]] = {}
    pending: list[object] = [agent]
    seen: set[int] = set()
    while pending:
        obj = pending.pop()
        if obj is None or isinstance(obj, (str, bytes, int, float)) or id(obj) in seen:
            continue
        seen.add(id(obj))
        if isinstance(obj, dict):
            pending.extend(obj.values())
            continue
        if isinstance(obj, (list, tuple, set, frozenset)):
            pending.extend(obj)
            continue
        if not is_runtime_object(obj):
            continue
        if isinstance(obj, api_call_step_cls) and _PASSTHROUGH_PATH in str(getattr(obj, "url", "")):
            found.append(obj)
        attrs = getattr(obj, "__dict__", None)
        if not isinstance(attrs, dict):
            continue
        held = attrs.get("steps")
        flow_id = attrs.get("id")
        if isinstance(flow_id, str) and isinstance(held, (dict, list, tuple)):
            for step in held.values() if isinstance(held, dict) else held:
                owners.setdefault(id(step), set()).add(flow_id)
        pending.extend(attrs.values())
    return {
        _passthrough_key(
            getattr(s, "id", None),
            getattr(s, "name", None),
            owners.get(id(s), set()),
            getattr(s, "method", None),
            getattr(s, "url", None),
            getattr(s, "data", None),
        )
        for s in found
    }


def _passthrough_mismatch(doc: object, agent: object, **walk: object) -> str | None:
    """None when every passthrough node of `doc` has exactly its compiled step
    in `agent` and no compiled step is left over; otherwise what differs."""
    expected = _oas_passthrough_nodes(doc)
    compiled = _compiled_passthrough_steps(agent, **walk)  # type: ignore[arg-type]
    if compiled == expected:
        return None
    return (
        f"only in the document: {sorted(expected - compiled, key=repr)}; "
        f"only compiled: {sorted(compiled - expected, key=repr)} "
        "(key: id, name, flow ids, digest of method, url and body)"
    )


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
@pytest.mark.parametrize("oas_path,slug", _agent_oas_params())
def test_passthrough_step_ids_are_the_document_node_ids(oas_path: Path, slug: str) -> None:
    """cinatra#4154: each passthrough ApiNode compiles to a step whose `id` is the
    node's own id, so the signed step id re-anchors in the installed document."""
    if slug in _KNOWN_FAILING_GATE_AGENTS:
        pytest.skip(f"{slug} does not mount (see _KNOWN_FAILING_GATE_AGENTS)")
    raw = oas_path.read_text(encoding="utf-8")
    label = oas_path.parent.parent.name
    substituted = _runtime_preload(raw, label)
    doc = json.loads(substituted)
    agent = AgentSpecLoader().load_json(substituted)
    mismatch = _passthrough_mismatch(doc, agent)
    assert mismatch is None, f"{slug}: compiled passthrough steps differ from the document's nodes: {mismatch}"
    if f"{oas_path.parents[2].name}/{oas_path.parents[1].name}" == _ANCHOR_DISK_LABEL:
        assert _ANCHOR_NODE_ID in {key[0] for key in _oas_passthrough_nodes(doc)}, (
            f"{_ANCHOR_DISK_LABEL}: the document holds no passthrough node `{_ANCHOR_NODE_ID}`, "
            "so the test has no non-empty anchor (cinatra#4154)"
        )
        assert _ANCHOR_NODE_ID in {key[0] for key in _compiled_passthrough_steps(agent)}, (
            f"{_ANCHOR_DISK_LABEL}: the embedded delivery step `{_ANCHOR_NODE_ID}` must compile "
            "to a step of that id (cinatra#4154)"
        )


# ---------------------------------------------------------------------------
# cinatra#4154 — synthetic cases of the two walks. They need no wayflowcore: the
# compiled side is built from the stand-in classes below, which the walk is
# told to treat as the runtime's ApiCallStep and runtime objects.
# ---------------------------------------------------------------------------

_SYN_URL = "{{CINATRA_BASE_URL}}/api/agents/passthrough"


class _SynRuntime:
    def __init__(self, **attrs: object) -> None:
        self.__dict__.update(attrs)


class _SynApiCallStep(_SynRuntime):
    pass


_SYN_WALK = {"api_call_step_cls": _SynApiCallStep, "is_runtime_object": lambda o: isinstance(o, _SynRuntime)}


def _syn_node(node_id: str, name: str, tool: str) -> dict:
    return {
        "component_type": "ApiNode",
        "id": node_id,
        "name": name,
        "url": _SYN_URL,
        "http_method": "POST",
        "data": {"tool": tool, "args": "{{ args }}"},
    }


def _syn_step(node_id: str, name: str, tool: str) -> _SynApiCallStep:
    return _SynApiCallStep(
        id=node_id, name=name, url=_SYN_URL, method="POST", data={"tool": tool, "args": "{{ args }}"}
    )


def _syn_flow(flow_id: str, *members: dict) -> dict:
    return {"component_type": "Flow", "id": flow_id, "name": flow_id, "nodes": [{"$component_ref": m["id"]} for m in members]}


def _syn_doc(*nodes: dict, extra_refs: dict | None = None) -> dict:
    doc = _syn_flow("root", *nodes)
    doc["$referenced_components"] = {n["id"]: n for n in nodes}
    doc["$referenced_components"].update(extra_refs or {})
    return doc


def test_synthetic_passthrough_nodes_that_compile_to_their_own_steps_match() -> None:
    doc = _syn_doc(_syn_node("a", "send_a", "tool_a"), _syn_node("b", "send_b", "tool_b"))
    agent = _SynRuntime(
        id="root", steps={"send_a": _syn_step("a", "send_a", "tool_a"), "send_b": _syn_step("b", "send_b", "tool_b")}
    )
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is None


def test_synthetic_two_swapped_step_ids_are_red() -> None:
    doc = _syn_doc(_syn_node("a", "send_a", "tool_a"), _syn_node("b", "send_b", "tool_b"))
    agent = _SynRuntime(
        id="root", steps={"send_a": _syn_step("b", "send_a", "tool_a"), "send_b": _syn_step("a", "send_b", "tool_b")}
    )
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is not None


def test_synthetic_swapped_ids_of_equal_nodes_in_two_flows_are_red() -> None:
    x, y = _syn_node("x-send", "send", "tool"), _syn_node("y-send", "send", "tool")
    doc = _syn_flow("root")
    doc["nodes"] = [{"$component_ref": "fx"}, {"$component_ref": "fy"}]
    doc["$referenced_components"] = {
        "fx": {"component_type": "FlowNode", "id": "fx", "name": "fx", "subflow": {"$component_ref": "flow_x"}},
        "fy": {"component_type": "FlowNode", "id": "fy", "name": "fy", "subflow": {"$component_ref": "flow_y"}},
        "flow_x": _syn_flow("flow_x", x),
        "flow_y": _syn_flow("flow_y", y),
        "x-send": x,
        "y-send": y,
    }
    agent = _SynRuntime(
        id="root",
        steps={
            "fx": _SynRuntime(id="fx", flow=_SynRuntime(id="flow_x", steps={"send": _syn_step("y-send", "send", "tool")})),
            "fy": _SynRuntime(id="fy", flow=_SynRuntime(id="flow_y", steps={"send": _syn_step("x-send", "send", "tool")})),
        },
    )
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is not None


def test_synthetic_two_nodes_compiled_under_one_id_are_red() -> None:
    doc = _syn_doc(_syn_node("a", "send_a", "tool_a"), _syn_node("b", "send_b", "tool_b"))
    agent = _SynRuntime(
        id="root", steps={"send_a": _syn_step("a", "send_a", "tool_a"), "send_b": _syn_step("a", "send_b", "tool_b")}
    )
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is not None


def test_synthetic_a_step_inside_an_agent_execution_step_is_walked() -> None:
    a = _syn_node("a", "send_a", "tool_a")
    doc = _syn_flow("root")
    doc["nodes"] = [{"$component_ref": "ask"}]
    doc["$referenced_components"] = {
        "ask": {
            "component_type": "AgentNode",
            "id": "ask",
            "name": "ask",
            "agent": {"component_type": "Agent", "id": "helper", "name": "helper", "tools": [{"flow": _syn_flow("inner", a)}]},
        },
        "a": a,
    }
    inner = _SynRuntime(id="inner", steps={"send_a": _syn_step("a", "send_a", "tool_a")})
    agent = _SynRuntime(id="root", steps={"ask": _SynRuntime(id="ask", agent=_SynRuntime(id="helper", tools=[_SynRuntime(flow=inner)]))})
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is None


def test_synthetic_an_unused_referenced_node_is_not_counted() -> None:
    doc = _syn_doc(_syn_node("a", "send_a", "tool_a"), extra_refs={"dead": _syn_node("dead", "send_dead", "tool_d")})
    doc["metadata"] = {"copy": _syn_node("meta", "send_meta", "tool_m")}
    agent = _SynRuntime(id="root", steps={"send_a": _syn_step("a", "send_a", "tool_a")})
    assert _passthrough_mismatch(doc, agent, **_SYN_WALK) is None


def test_synthetic_an_unresolved_reference_fails_loudly() -> None:
    doc = _syn_doc(_syn_node("a", "send_a", "tool_a"))
    doc["nodes"].append({"$component_ref": "missing"})
    agent = _SynRuntime(id="root", steps={"send_a": _syn_step("a", "send_a", "tool_a")})
    with pytest.raises(AssertionError, match="names no referenced component"):
        _passthrough_mismatch(doc, agent, **_SYN_WALK)
