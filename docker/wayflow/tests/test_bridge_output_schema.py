"""Request-contract guard for cinatra#2949 — declared outputs must reach the bridge.

The `/api/llm-bridge` route accepts an optional `output_schema` and forwards it
to the orchestration layer, which is what makes a provider answer in the SHAPE
the calling node declared (`packages/llm/src/index.ts`; the scripted development
provider at `packages/llm/src/scripted-test-provider.ts` shapes its deterministic
answer from the same field). Authored agent OAS files never write that field, so
every bridge ApiNode used to ask for a free-text answer while DECLARING typed
outputs — the run then reported success with every declared output empty and
nothing to materialise an artifact from.

`agent_loader._derive_bridge_output_schemas` closes that at load time, in the
same family as `_reconcile_input_message_gates`: the shipped OAS is untouched on
disk, every installed agent benefits, and the derived schema follows the SAME
agentspec-property -> JSON-Schema convention the host compiler already uses for
an agent's own output schema (`packages/agents/src/oas-compiler.ts`, step 8
"Derive outputSchema").

These tests pin that contract so an agent whose node declares outputs can never
again receive shapeless prose while reporting success.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

import agent_loader  # type: ignore[import-not-found]


BRIDGE_URL = "{{CINATRA_BASE_URL}}/api/llm-bridge"


def _bridge_oas(outputs, *, url=BRIDGE_URL, data=None, include_outputs=True):
    """A minimal flow with ONE bridge-targeting ApiNode that declares outputs."""
    node = {
        "component_type": "ApiNode",
        "id": "write",
        "name": "Write via bridge",
        "url": url,
        "http_method": "POST",
        "data": {
            "agent_id": "fixture-agent",
            "system": "Return a single JSON object.",
            "user": "{{ idea }}",
            "agent_run_id": "{{ cinatra_run_id }}",
            "cinatra_llm": {"provider": "openai", "model": "test-model"},
        }
        if data is None
        else data,
        "inputs": [{"title": "idea", "type": "object"}],
    }
    if include_outputs:
        node["outputs"] = outputs
    return {
        "agentspec_version": "26.1.0",
        "component_type": "Flow",
        "id": "bridge-fixture-flow",
        "name": "Bridge fixture",
        "metadata": {
            "cinatra": {"type": "flow", "packageName": "@cinatra-ai/bridge-fixture"}
        },
        "start_node": {"$component_ref": "start"},
        "nodes": [{"$component_ref": n} for n in ("start", "write", "end")],
        "$referenced_components": {
            "start": {
                "component_type": "StartNode",
                "id": "start",
                "name": "Inputs",
                "inputs": [{"title": "idea", "type": "object"}],
            },
            "write": node,
            "end": {
                "component_type": "EndNode",
                "id": "end",
                "name": "End",
                "outputs": [{"title": "content", "type": "string"}],
            },
        },
    }


DRAFT_OUTPUTS = [
    {"title": "title", "type": "string"},
    {"title": "excerpt", "type": "string"},
    {"title": "content", "type": "string"},
    {
        "title": "sourcesUsed",
        "type": "array",
        "json_schema": {"items": {"type": "string"}},
    },
    {"title": "notes", "type": "string"},
]


def _write_node(doc):
    return doc["$referenced_components"]["write"]


# ---------------------------------------------------------------------------
# The derivation itself
# ---------------------------------------------------------------------------


def test_declared_outputs_become_the_request_output_schema():
    doc = _bridge_oas(DRAFT_OUTPUTS)
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")

    assert [r["node"] for r in report] == ["write"]
    schema = _write_node(doc)["data"]["output_schema"]
    assert schema == {
        "type": "object",
        "properties": {
            "title": {"type": "string", "title": "title"},
            "excerpt": {"type": "string", "title": "excerpt"},
            "content": {"type": "string", "title": "content"},
            "sourcesUsed": {
                "type": "array",
                "title": "sourcesUsed",
                "items": {"type": "string"},
            },
            "notes": {"type": "string", "title": "notes"},
        },
        "required": ["title", "excerpt", "content", "sourcesUsed", "notes"],
        "additionalProperties": False,
    }


def test_the_root_satisfies_the_strict_structured_output_contract():
    """cinatra#1891 walk-2 DEFECT-2 — this schema is forwarded VERBATIM into the
    OpenAI Responses API `text.format.json_schema`, where `required` must name
    EVERY key in `properties`; an under-specified `required` is a deterministic
    400 at the real provider. A declared output is never optional, so every
    property is required.
    """
    doc = _bridge_oas(DRAFT_OUTPUTS)
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    schema = _write_node(doc)["data"]["output_schema"]
    assert sorted(schema["required"]) == sorted(schema["properties"])
    assert schema["additionalProperties"] is False


def test_authored_subschemas_are_never_rewritten():
    """The pass adds no constraint BELOW the root: an authored `items` blob is
    what the agent declared, and inventing `required` inside it would send the
    provider something the agent never said.
    """
    authored_items = {"type": "object", "properties": {"title": {"type": "string"}}}
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": authored_items}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert (
        _write_node(doc)["data"]["output_schema"]["properties"]["ideas"]["items"]
        == authored_items
    )


def test_format_and_description_ride_through():
    doc = _bridge_oas(
        [
            {
                "title": "publishAt",
                "type": "string",
                "format": "date-time",
                "description": "When to publish.",
            }
        ]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["publishAt"] == {
        "type": "string",
        "title": "publishAt",
        "format": "date-time",
        "description": "When to publish.",
    }


def test_top_level_items_is_accepted_as_well_as_json_schema_items():
    doc = _bridge_oas([{"title": "tags", "type": "array", "items": {"type": "string"}}])
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["tags"]["items"] == {
        "type": "string"
    }


def test_the_pass_is_idempotent():
    doc = _bridge_oas(DRAFT_OUTPUTS)
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    once = copy.deepcopy(doc)
    second = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert second == []
    assert doc == once


# ---------------------------------------------------------------------------
# What the pass must NOT touch
# ---------------------------------------------------------------------------


def test_authored_output_schema_wins():
    authored = {"type": "object", "properties": {"handWritten": {"type": "string"}}}
    data = {
        "agent_id": "fixture-agent",
        "system": "s",
        "user": "{{ idea }}",
        "output_schema": authored,
    }
    doc = _bridge_oas(DRAFT_OUTPUTS, data=data)
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert report == []
    assert _write_node(doc)["data"]["output_schema"] == authored


def test_node_that_declares_no_outputs_is_untouched():
    doc = _bridge_oas([], include_outputs=False)
    before = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == before


def test_empty_outputs_list_is_untouched():
    doc = _bridge_oas([])
    before = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == before


def test_non_bridge_apinode_is_untouched():
    doc = _bridge_oas(DRAFT_OUTPUTS, url="{{CINATRA_BASE_URL}}/api/context-resolve")
    before = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == before


def test_output_without_a_usable_title_or_type_leaves_the_node_alone():
    doc = _bridge_oas([{"title": "title", "type": "string"}, {"type": "string"}])
    before = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == before


def test_apinode_without_data_is_untouched():
    doc = _bridge_oas(DRAFT_OUTPUTS)
    _write_node(doc).pop("data")
    before = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == before


# ---------------------------------------------------------------------------
# Nesting: a bridge ApiNode inside a subflow must be reached too
# ---------------------------------------------------------------------------


def test_bridge_apinode_nested_in_a_subflow_is_reached():
    doc = _bridge_oas(DRAFT_OUTPUTS)
    inner = copy.deepcopy(_write_node(doc))
    inner["id"] = "inner-write"
    doc["$referenced_components"]["sub"] = {
        "component_type": "Flow",
        "id": "sub",
        "name": "Subflow",
        "$referenced_components": {"inner-write": inner},
    }
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert sorted(r["node"] for r in report) == ["inner-write", "write"]
    assert (
        doc["$referenced_components"]["sub"]["$referenced_components"]["inner-write"][
            "data"
        ]["output_schema"]["properties"]["content"]
        == {"type": "string", "title": "content"}
    )


# ---------------------------------------------------------------------------
# The shipped tree (runs where the real agent tree is mounted, as the
# `WayFlow mount guard` CI job mounts it)
# ---------------------------------------------------------------------------


def _shipped_oas(package_dir: str):
    root = Path(os.environ.get("CINATRA_AGENTS_DIR", "/agents"))
    path = root / package_dir / "cinatra" / "oas.json"
    if not path.is_file():
        pytest.skip(f"agent tree not mounted at {root} — no {path}")
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "package_dir",
    ["cinatra-ai/blog-draft-writer-agent", "cinatra-ai/blog-pipeline-agent"],
)
def test_shipped_agents_ask_for_the_shape_they_declare(package_dir):
    """The two agents cinatra#2949 measured: every bridge node that declares
    outputs must leave this pass carrying a schema naming EXACTLY those outputs.
    """
    doc = _shipped_oas(package_dir)
    agent_loader._derive_bridge_output_schemas(doc, package_dir)

    declared_nodes = []

    def walk(obj):
        if isinstance(obj, dict):
            if obj.get("component_type") == "ApiNode" and agent_loader._targets_llm_bridge(
                obj.get("url")
            ):
                outputs = obj.get("outputs")
                if isinstance(outputs, list) and outputs:
                    declared_nodes.append(obj)
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(doc)
    assert declared_nodes, f"{package_dir} declares no bridge node with outputs"
    for node in declared_nodes:
        schema = node.get("data", {}).get("output_schema")
        assert isinstance(schema, dict), (
            f"{package_dir}: bridge node {node.get('id')!r} declares outputs but "
            f"would still ask for shapeless prose"
        )
        assert sorted(schema["properties"]) == sorted(
            o["title"] for o in node["outputs"]
        )
        # The real-provider contract holds for every shipped node, not only the
        # fixtures (cinatra#1891 walk-2 DEFECT-2).
        assert sorted(schema["required"]) == sorted(schema["properties"])
        assert schema["additionalProperties"] is False



# ---------------------------------------------------------------------------
# The mount seam — the document `load_json` receives is the one that carries the
# derived schema, so what the runtime EXECUTES (and therefore what its ApiNode
# posts to the bridge) is the mutated document, not the file on disk.
# ---------------------------------------------------------------------------


def test_the_mounted_document_carries_the_derived_schema(monkeypatch, tmp_path):
    import hashlib

    doc = _bridge_oas(DRAFT_OUTPUTS)
    oas_path = tmp_path / "cinatra" / "oas.json"
    oas_path.parent.mkdir(parents=True)
    raw = json.dumps(doc, indent=1)
    oas_path.write_text(raw, encoding="utf-8")
    fingerprint = hashlib.sha256(raw.encode("utf-8")).hexdigest()

    captured = {}

    class _FakeLoader:
        def load_json(self, text):
            captured["text"] = text

            class _Agent:
                pass

            return _Agent()

    class _FakeServer:
        def serve_agent(self, agent, url):
            self.agent = agent

    monkeypatch.setattr(agent_loader, "A2AServer", _FakeServer)
    monkeypatch.setattr(agent_loader, "_discover_a2a_asgi_app", lambda server, label: object())
    agent_loader._mount_one_sync(
        _FakeLoader(), "cinatra-ai", "under-test", oas_path, fingerprint, "http://x"
    )

    mounted = json.loads(captured["text"])
    schema = mounted["$referenced_components"]["write"]["data"]["output_schema"]
    assert sorted(schema["properties"]) == ["content", "excerpt", "notes", "sourcesUsed", "title"]
    assert sorted(schema["required"]) == sorted(schema["properties"])
    # The file on disk is untouched — the mount is what changed.
    assert "output_schema" not in json.loads(oas_path.read_text(encoding="utf-8"))["$referenced_components"]["write"]["data"]
