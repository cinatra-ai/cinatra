"""cinatra#4264 slice B1b at the loader level (runs inside the runtime image).

T11: ``_start_segment_conversation`` refuses a mounted flow version that
differs from the request's ``flowSha256`` with REGENERATE_FLOW_CHANGED before
the segment is derived or loaded (the loader is never called). A good request
loads the derived segment once per (flowSha256, step, artifactNode,
noteInput) with the mount's placeholder substitution and starts it with the
segment inputs; the receipt is signed for the run id of the message.

T12: ``/.health`` of a real parent app lists ``regenerate_segment/1``.

``import agent_loader`` needs the image's packages; outside the image this
file skips, and test_regenerate_segment.py reads the same wiring from source.

Red at the B1a head: ``_start_segment_conversation`` and the capability do not
exist.
"""
from __future__ import annotations

import hashlib
import json

import pytest

pytest.importorskip("wayflowcore")

import agent_loader  # noqa: E402
import regenerate_segment as rs  # noqa: E402

from tests.test_regenerate_segment import _tiny  # noqa: E402

FLOW = "d" * 64


class _Flow:
    def __init__(self) -> None:
        self.started = []

    def start_conversation(self, inputs=None, **_kw):
        self.started.append(inputs)
        return {"conversation": inputs}


class _Loader:
    def __init__(self) -> None:
        self.loaded = []
        self.flow = _Flow()

    def load_json(self, text):
        self.loaded.append(json.loads(text))
        return self.flow


class _Assistant:
    def __init__(self, flow_sha, loader) -> None:
        self._cinatra_flow_sha256 = flow_sha
        self._cinatra_working_doc = _tiny()
        self._cinatra_spec_loader = loader


def _message(flow=FLOW):
    produce = json.dumps({"topic": "kept", "note": "old"})
    return {
        "role": "user",
        "parts": [{"kind": "text", "text": json.dumps({"userNote": "new", "cinatra_run_id": "run-seg-1"})}],
        "metadata": {
            rs.REGENERATE_SEGMENT_METADATA_KEY: {
                "step": "produce",
                "artifactNode": "file",
                "noteInput": "note",
                "flowSha256": flow,
                "snapshots": [
                    {"node": "produce", "inputs_json": produce, "sha256": hashlib.sha256(produce.encode()).hexdigest()},
                    {"node": "file", "inputs_json": "{}", "sha256": hashlib.sha256(b"{}").hexdigest()},
                ],
            }
        },
    }


def test_a_changed_flow_is_refused_before_the_segment_is_loaded():
    loader = _Loader()
    message = _message()
    request = rs.read_segment_request(message)
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        agent_loader._start_segment_conversation(_Assistant("e" * 64, loader), message, request)
    assert excinfo.value.code == rs.REGENERATE_FLOW_CHANGED
    assert loader.loaded == [] and loader.flow.started == []


def test_a_good_request_starts_the_segment_once_loaded():
    loader = _Loader()
    assistant = _Assistant(FLOW, loader)
    message = _message()
    request = rs.read_segment_request(message)
    _conv, run_id = agent_loader._start_segment_conversation(assistant, message, request)
    agent_loader._start_segment_conversation(assistant, message, request)
    assert run_id == "run-seg-1"
    assert len(loader.loaded) == 1  # cached per (flowSha256, step, artifactNode, noteInput)
    assert loader.loaded[0]["start_node"] == {"$component_ref": rs.SEGMENT_START_ID}
    assert loader.flow.started[0] == {rs.SEGMENT_NOTE_OUTPUT: "new", "cinatra_seg_0": "kept", "cinatra_run_id": "run-seg-1"}


@pytest.mark.asyncio
async def test_health_lists_regenerate_segment(agents_dir, http_client_factory):
    root = agents_dir(("cinatra", "email-drafting-agent"))
    app = agent_loader.build_parent_app(root)
    async with http_client_factory(app) as client:
        r = await client.get("/.health")
    assert r.status_code == 200
    assert "regenerate_segment/1" in r.json().get("capabilities", [])
