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


def test_a_declared_member_map_gets_the_SAME_shape_as_the_root():
    """A DECLARED `properties` map — at the root or anywhere below it — leaves
    this pass carrying `required` over every member and `additionalProperties:
    false`.

    This case previously asserted the opposite (authored subschemas ride through
    byte-identically). The reason it changed: the root carries those two
    keywords because the schema is forwarded VERBATIM into the strict
    structured-output surface, where `required` must name every key of a
    `properties` map (cinatra#1891 walk-2 DEFECT-2). That contract is not a
    root-only rule — it holds at every level that declares members, so a
    declared item map needs exactly what the root needs. What still rides
    through untouched is everything the author actually wrote (types, `enum`,
    `format`, `description`, bounds) and every level where the author declared
    NO members: see `test_free_form_members_stay_exactly_as_declared`.
    """
    authored_items = {"type": "object", "properties": {"title": {"type": "string"}}}
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": authored_items}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["ideas"]["items"] == {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": False,
    }


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


def _agents_root() -> Path:
    """Where the shipped agent tree really is, for THIS run.

    Inside the runtime image it is the mount (`CINATRA_AGENTS_DIR`, `/agents`).
    Run from a repository checkout there is no mount, but the same tree is on
    disk as the synced `extensions/` directory — so these cases exercise the
    shipped files there too instead of skipping and proving nothing.
    """
    mounted = Path(os.environ.get("CINATRA_AGENTS_DIR", "/agents"))
    if mounted.is_dir():
        return mounted
    # No mount: look for the checkout this file lives in. The repository root
    # is the ancestor that holds BOTH `extensions/` and `docker/wayflow/`, so a
    # lookalike directory somewhere above cannot be mistaken for it. Inside the
    # runtime image there is no such ancestor, and the unfound mount is
    # returned so the callers skip rather than fail on a missing tree.
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "extensions").is_dir() and (parent / "docker" / "wayflow").is_dir():
            return parent / "extensions"
    return mounted


def _shipped_oas(package_dir: str):
    root = _agents_root()
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


# ---------------------------------------------------------------------------
# Declared MEMBER shapes (cinatra#2949, second walk)
#
# The first walk gave the ROOT its shape and stopped there: a node declaring
# `ideas: array<object>` asked for an array and said NOTHING about what belongs
# in an entry, so a shaped answer came back as `{"ideas": [{}]}` — a non-empty
# list of empty entries, and the gate that offers those entries had nothing to
# offer. These cases pin the rest of the walk: a DECLARED member map reaches the
# request at every level, and a declaration that genuinely names no members
# stays free-form and is said out loud.
# ---------------------------------------------------------------------------


IDEA_ITEM = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "outline": {"type": "array", "items": {"type": "string"}},
    },
}


def test_declared_item_members_reach_the_request():
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": IDEA_ITEM}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["ideas"] == {
        "type": "array",
        "title": "ideas",
        "items": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "summary": {"type": "string"},
                "outline": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "summary", "outline"],
            "additionalProperties": False,
        },
    }


def test_declared_item_members_reach_the_request_via_top_level_items():
    doc = _bridge_oas([{"title": "ideas", "type": "array", "items": IDEA_ITEM}])
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    items = _write_node(doc)["data"]["output_schema"]["properties"]["ideas"]["items"]
    assert items["required"] == ["title", "summary", "outline"]
    assert items["additionalProperties"] is False


def test_declared_object_members_reach_the_request():
    doc = _bridge_oas(
        [
            {
                "title": "draft",
                "type": "object",
                "json_schema": {
                    "properties": {
                        "title": {"type": "string"},
                        "content": {"type": "string"},
                    }
                },
            }
        ]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["draft"] == {
        "type": "object",
        "title": "draft",
        "properties": {"title": {"type": "string"}, "content": {"type": "string"}},
        "required": ["title", "content"],
        "additionalProperties": False,
    }
    # The agentspec nesting key itself never reaches the provider.
    assert "json_schema" not in _write_node(doc)["data"]["output_schema"]["properties"]["draft"]


def test_every_declared_level_is_strict_not_just_the_first():
    nested = {
        "type": "object",
        "properties": {
            "meta": {"type": "object", "properties": {"lang": {"type": "string"}}},
            "rows": {
                "type": "array",
                "items": {"type": "object", "properties": {"cell": {"type": "string"}}},
            },
        },
    }
    doc = _bridge_oas(
        [{"title": "sheets", "type": "array", "json_schema": {"items": nested}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    item = _write_node(doc)["data"]["output_schema"]["properties"]["sheets"]["items"]
    assert item["required"] == ["meta", "rows"]
    assert item["additionalProperties"] is False
    assert item["properties"]["meta"]["required"] == ["lang"]
    assert item["properties"]["meta"]["additionalProperties"] is False
    assert item["properties"]["rows"]["items"]["required"] == ["cell"]
    assert item["properties"]["rows"]["items"]["additionalProperties"] is False


def test_what_the_author_wrote_below_the_root_rides_through_unchanged():
    """Only `required` / `additionalProperties` are supplied. Every keyword the
    author actually wrote reaches the provider exactly as written.
    """
    authored = {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["url", "object"],
                "description": "Where the row came from.",
            },
            "score": {"type": "number", "minimum": 0, "maximum": 1},
        },
    }
    doc = _bridge_oas(
        [{"title": "rows", "type": "array", "json_schema": {"items": authored}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    item = _write_node(doc)["data"]["output_schema"]["properties"]["rows"]["items"]
    assert item["properties"]["kind"] == {
        "type": "string",
        "enum": ["url", "object"],
        "description": "Where the row came from.",
    }
    assert item["properties"]["score"] == {"type": "number", "minimum": 0, "maximum": 1}


def test_a_narrower_authored_required_is_widened_to_every_declared_member():
    """The root's reading applied one level down: a member the node declares is
    a member it will read, and the strict surface has no notion of an optional
    key. An authored `required` that names a SUBSET is therefore widened, not
    obeyed — the same trade the root already makes.
    """
    authored = {
        "type": "object",
        "properties": {"type": {"type": "string"}, "ref": {"type": "string"}},
        "required": ["type"],
    }
    doc = _bridge_oas(
        [{"title": "sources", "type": "array", "json_schema": {"items": authored}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    item = _write_node(doc)["data"]["output_schema"]["properties"]["sources"]["items"]
    assert item["required"] == ["type", "ref"]


# ---------------------------------------------------------------------------
# A declaration that names no members is CLOSED for the strict contract — and
# is still said out loud
# ---------------------------------------------------------------------------


def test_a_free_form_object_member_is_closed_for_the_strict_contract():
    """cinatra#3133 — `{"type": "object"}` says nothing about what is inside,
    and the strict structured-output contract has no way to ask for that: it
    requires `additionalProperties: false` on EVERY object node, so there is no
    open map to request and ONE node missing the keyword makes the provider
    refuse the whole schema ("'additionalProperties' is required to be supplied
    and to be false").

    The pass therefore emits the CLOSED EMPTY object — it asks for an object and
    promises nothing inside it, which is exactly what the declaration said. It
    still invents no member, and it still names the path in the report so the
    load-time note can ask for the one declaration in the AGENT's own OAS that
    gives an answer somewhere to put its content.
    """
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": {"type": "object"}}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    prop = _write_node(doc)["data"]["output_schema"]["properties"]["ideas"]
    assert prop["items"] == {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }


def test_a_free_form_object_output_is_closed_for_the_strict_contract():
    """The OTHER branch, one level up: a whole declared OUTPUT of type `object`
    that names no members goes through `_output_property_json_schema`, not
    `_strict_declared_subschema`, and has to reach the provider just as closed.
    """
    doc = _bridge_oas([{"title": "draft", "type": "object"}])
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["draft"] == {
        "type": "object",
        "title": "draft",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }


def test_a_memberless_object_cannot_keep_a_contradictory_authored_shape():
    """The two keywords are SUPPLIED, not merely defaulted (cinatra#3133).

    An author can write a `required` naming keys the node never declares, or an
    `additionalProperties: true`; both are refused by the strict contract, and
    both used to ride through untouched because this branch set nothing at all.
    The emitted node now says the same thing its (empty) member map says.
    """
    doc = _bridge_oas(
        [
            {
                "title": "draft",
                "type": "object",
                "json_schema": {
                    "items": None,
                },
            }
        ]
    )
    _write_node(doc)["outputs"][0] = {
        "title": "draft",
        "type": "object",
        "required": ["headline"],
        "additionalProperties": True,
    }
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["data"]["output_schema"]["properties"]["draft"] == {
        "type": "object",
        "title": "draft",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }


def test_an_object_node_behind_a_branch_or_a_nullable_type_is_closed_too():
    """cinatra#3133 — `properties` and a single `items` are not the only roads
    to an object node. A branch list (`anyOf` / `oneOf` / `allOf`), the nullable
    `["object", "null"]` spelling and the tuple spelling of `items` all put an
    object where the provider validates one, and ONE such node without
    `additionalProperties` refuses the whole schema just as loudly. None of the
    shipped agents writes these forms today; the pass closes them anyway,
    because the cost of missing one is the entire request.
    """
    doc = _bridge_oas(
        [
            {
                "title": "branches",
                "type": "array",
                "json_schema": {
                    "items": {"anyOf": [{"type": "object"}, {"type": "null"}]}
                },
            },
            {
                "title": "rows",
                "type": "array",
                "json_schema": {"items": {"type": ["object", "null"]}},
            },
            {
                "title": "pairs",
                "type": "array",
                "json_schema": {"items": [{"type": "object"}, {"type": "string"}]},
            },
        ]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    props = _write_node(doc)["data"]["output_schema"]["properties"]

    closed = {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }
    assert props["branches"]["items"]["anyOf"] == [closed, {"type": "null"}]
    assert props["rows"]["items"] == dict(closed, type=["object", "null"])
    assert props["pairs"]["items"] == [closed, {"type": "string"}]


def test_a_reference_is_carried_as_written_because_the_pass_resolves_none():
    """The other half of the same decision, pinned so it is a decision and not
    an oversight: a `$ref` names a level this pass never emits — it resolves no
    references — so it rides through byte-for-byte. Closing what a reference
    points at is the AGENT's own declaration to make.
    """
    declared = {"$defs": {"Idea": {"type": "object"}}, "$ref": "#/$defs/Idea"}
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": declared}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert (
        _write_node(doc)["data"]["output_schema"]["properties"]["ideas"]["items"]
        == declared
    )


def _object_nodes(node, path="$"):
    """Every object-typed node in an emitted schema, with the path it sits at.

    Follows every road the provider's validator follows: member maps, list and
    tuple `items`, and the `anyOf` / `oneOf` / `allOf` branch lists — and reads
    the nullable `["object", "null"]` spelling as the object level it is. A
    walker that followed fewer roads could call a schema strict that the
    provider refuses.
    """
    if not isinstance(node, dict):
        return
    declared = node.get("type")
    types = (
        [declared]
        if isinstance(declared, str)
        else [entry for entry in declared if isinstance(entry, str)]
        if isinstance(declared, list)
        else []
    )
    if "object" in types:
        yield path, node
    members = node.get("properties")
    if isinstance(members, dict):
        for name, member in members.items():
            yield from _object_nodes(member, f"{path}.{name}")
    for keyword in ("anyOf", "oneOf", "allOf"):
        branches = node.get(keyword)
        if isinstance(branches, list):
            for index, branch in enumerate(branches):
                yield from _object_nodes(branch, f"{path}|{keyword}[{index}]")
    items = node.get("items")
    if isinstance(items, list):
        for index, item in enumerate(items):
            yield from _object_nodes(item, f"{path}[{index}]")
    elif items is not None:
        yield from _object_nodes(items, f"{path}[]")


def test_every_object_node_in_an_emitted_schema_is_strict():
    """The WHOLE emitted tree, not one branch (cinatra#3133): walk it and demand
    both strict keywords on every object node — the root, declared member maps
    and free-form levels alike — because that is what the provider validates and
    a single node without `additionalProperties` refuses the entire request.
    """
    doc = _bridge_oas(
        [
            {"title": "ideas", "type": "array", "json_schema": {"items": {"type": "object"}}},
            {"title": "draft", "type": "object"},
            {"title": "sheets", "type": "array", "json_schema": {"items": IDEA_ITEM}},
            {
                "title": "meta",
                "type": "object",
                "json_schema": {"properties": {"lang": {"type": "string"}}},
            },
            {"title": "notes", "type": "string"},
            {
                "title": "branches",
                "type": "array",
                "json_schema": {
                    "items": {"anyOf": [{"type": "object"}, {"type": "null"}]}
                },
            },
            {
                "title": "rows",
                "type": "array",
                "json_schema": {"items": {"type": ["object", "null"]}},
            },
        ]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    schema = _write_node(doc)["data"]["output_schema"]

    walked = list(_object_nodes(schema))
    # Every object node the fixture can produce is actually reached, so a green
    # run cannot mean the walk simply found nothing to check.
    assert [path for path, _ in walked] == [
        "$",
        "$.ideas[]",
        "$.draft",
        "$.sheets[]",
        "$.meta",
        "$.branches[]|anyOf[0]",
        "$.rows[]",
    ]
    for path, node in walked:
        assert node.get("additionalProperties") is False, (
            f"{path}: an object node the provider will refuse"
        )
        assert sorted(node.get("required", [])) == sorted(node.get("properties", {})), (
            f"{path}: `required` does not name every property declared under it"
        )


def test_an_array_with_no_declared_items_keeps_asking_for_an_unconstrained_list(capsys):
    """An `array` whose items the author never declared is the one shape this
    pass cannot describe at all: it emits no `items` (inventing one would send
    the provider a list shape the agent never said) and names the path.

    The consequence is stated rather than hidden: a request that carries an
    array without `items` is the weakest thing this pass can ask for, and a
    provider is free to answer with an empty list. Closing it is one
    declaration in the agent's own OAS, which is what the printed note asks
    for — and which this pass then carries verbatim.
    """
    doc = _bridge_oas([{"title": "tags", "type": "array"}])
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    prop = _write_node(doc)["data"]["output_schema"]["properties"]["tags"]
    assert prop == {"type": "array", "title": "tags"}
    assert report[0]["free_form"] == ["tags[]"]
    assert "tags[]" in capsys.readouterr().out


def test_free_form_members_are_named_in_the_report(capsys):
    doc = _bridge_oas(
        [
            {"title": "ideas", "type": "array", "json_schema": {"items": {"type": "object"}}},
            {"title": "draft", "type": "object"},
            {"title": "tags", "type": "array"},
            {"title": "notes", "type": "string"},
        ]
    )
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert report[0]["free_form"] == ["draft", "ideas[]", "tags[]"]
    said = capsys.readouterr().out
    assert "fixture/bridge" in said
    for path in ("draft", "ideas[]", "tags[]"):
        assert path in said


def test_a_fully_declared_node_reports_no_free_form_member(capsys):
    doc = _bridge_oas(DRAFT_OUTPUTS)
    report = agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert report[0]["free_form"] == []
    assert "free-form" not in capsys.readouterr().out


def test_the_pass_is_still_idempotent_with_declared_members():
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": IDEA_ITEM}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    once = copy.deepcopy(doc)
    assert agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge") == []
    assert doc == once


def test_the_declaration_on_disk_is_never_mutated_by_the_recursion():
    """The authored blob is READ, not adopted: the derived schema is a copy, so
    the document's own declaration still says exactly what the author wrote.
    """
    declared = copy.deepcopy(IDEA_ITEM)
    doc = _bridge_oas(
        [{"title": "ideas", "type": "array", "json_schema": {"items": declared}}]
    )
    agent_loader._derive_bridge_output_schemas(doc, "fixture/bridge")
    assert _write_node(doc)["outputs"][0]["json_schema"]["items"] == IDEA_ITEM


# ---------------------------------------------------------------------------
# The shipped tree — EVERY agent file on the mount, not only the two the issue
# measured. The invariants are derived from each file's own declaration, so a
# future agent that declares its member shapes flips from "free-form, reported"
# to "declared, strict" without editing this test.
# ---------------------------------------------------------------------------


def _shipped_agent_dirs():
    root = _agents_root()
    if not root.is_dir():
        return []
    found = []
    for vendor in sorted(p for p in root.iterdir() if p.is_dir()):
        for pkg in sorted(p for p in vendor.iterdir() if p.is_dir()):
            if (pkg / "cinatra" / "oas.json").is_file():
                found.append(f"{vendor.name}/{pkg.name}")
    return found


def _bridge_nodes_with_outputs(doc):
    found = []

    def walk(obj):
        if isinstance(obj, dict):
            if obj.get("component_type") == "ApiNode" and agent_loader._targets_llm_bridge(
                obj.get("url")
            ):
                outputs = obj.get("outputs")
                if isinstance(outputs, list) and outputs:
                    found.append(obj)
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(doc)
    return found


def _declared_members(node):
    """The member map an agentspec node declares, in either spelling."""
    if not isinstance(node, dict):
        return None
    props = node.get("properties")
    if not isinstance(props, dict):
        nested = node.get("json_schema")
        props = nested.get("properties") if isinstance(nested, dict) else None
    return props if isinstance(props, dict) and props else None


def _declared_items(node):
    if not isinstance(node, dict):
        return None
    items = node.get("items")
    if items is None:
        nested = node.get("json_schema")
        items = nested.get("items") if isinstance(nested, dict) else None
    return items


@pytest.mark.parametrize("package_dir", _shipped_agent_dirs() or ["<none mounted>"])
def test_every_shipped_agent_asks_for_exactly_the_members_it_declares(package_dir):
    if package_dir == "<none mounted>":
        pytest.skip("agent tree not mounted — nothing to walk")
    doc = _shipped_oas(package_dir)
    report = agent_loader._derive_bridge_output_schemas(doc, package_dir)
    reported = {r["node"]: set(r["free_form"]) for r in report}

    for node in _bridge_nodes_with_outputs(doc):
        schema = node.get("data", {}).get("output_schema")
        assert isinstance(schema, dict), (
            f"{package_dir}: bridge node {node.get('id')!r} declares outputs but "
            f"would still ask for shapeless prose"
        )
        free_form = reported.get(node.get("id"))
        assert free_form is not None, f"{package_dir}: {node.get('id')!r} is unreported"

        def check(derived, declared, path):
            members = _declared_members(declared)
            if members is not None:
                assert sorted(derived["properties"]) == sorted(members), (
                    f"{package_dir} {path}: the request names members the "
                    f"declaration does not"
                )
                assert sorted(derived["required"]) == sorted(derived["properties"])
                assert derived["additionalProperties"] is False
                assert path not in free_form
                for name, sub in members.items():
                    check(derived["properties"][name], sub, f"{path}.{name}")
            elif derived.get("type") == "object":
                # Nothing declared inside: the request asks for the CLOSED EMPTY
                # object the strict contract can carry (cinatra#3133) — no member
                # invented — and the pass must still have SAID so.
                assert derived["properties"] == {}
                assert derived["required"] == []
                assert derived["additionalProperties"] is False
                assert path in free_form
            declared_items = _declared_items(declared)
            if declared_items is not None:
                check(derived["items"], declared_items, f"{path}[]")
            elif derived.get("type") == "array":
                assert "items" not in derived
                assert f"{path}[]" in free_form

        for prop in node["outputs"]:
            check(schema["properties"][prop["title"]], prop, prop["title"])


@pytest.mark.parametrize("package_dir", _shipped_agent_dirs() or ["<none mounted>"])
def test_every_reported_free_form_path_is_genuinely_undeclared(package_dir):
    """The disclosure is not decoration: every path the pass names really has no
    member declaration in the agent's own file, so the list is exactly the work
    an agent author has to do to close it.
    """
    if package_dir == "<none mounted>":
        pytest.skip("agent tree not mounted — nothing to walk")
    doc = _shipped_oas(package_dir)
    report = agent_loader._derive_bridge_output_schemas(doc, package_dir)
    by_id = {n.get("id"): n for n in _bridge_nodes_with_outputs(doc)}

    for entry in report:
        node = by_id[entry["node"]]
        declared = {o["title"]: o for o in node["outputs"]}
        for path in entry["free_form"]:
            cursor = None
            for i, part in enumerate(path.split(".")):
                name = part[:-2] if part.endswith("[]") else part
                cursor = declared[name] if i == 0 else _declared_members(cursor)[name]
                if part.endswith("[]"):
                    cursor = _declared_items(cursor)
            assert cursor is None or _declared_members(cursor) is None, (
                f"{package_dir}: {path} is reported free-form but the file "
                f"declares its members"
            )
