"""cinatra#4264 slice B1a, T7 at the loader level (review 1 MF3).

The loader's REAL capture patch on ``Step.invoke_async``, installed by
``agent_loader._patch_step_snapshot_capture``, records the listed top-level
nodes of a REAL two-leg Wayflow flow: leg 1 runs ``produce`` and pauses in a
subflow's input step; leg 2 (the resume) runs the root flow's ``file_image``.
The subflow also holds a step that carries the SAME id as the root
``file_image`` and runs first, in leg 1; it is never recorded.

This file needs the pinned wayflowcore, so it runs inside the runtime image
(``import agent_loader`` needs the image's packages). Outside the image it
skips; the pure halves of the same rules are in test_step_snapshot.py.

Red before the fold: ``_LIVE_CLASS_BINDINGS`` does not name
``Step.invoke_async`` and ``step_snapshot.snapshot_recorder_for_leg`` does not
exist.
"""
from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("wayflowcore")

import agent_loader  # noqa: E402
import step_snapshot as snap  # noqa: E402

KEY = "loader-test-key"
RUN = "run-loader-1"
FLOW = "a" * 64


def _flow():
    from wayflowcore.flow import Flow
    from wayflowcore.steps import FlowExecutionStep, InputMessageStep, OutputMessageStep

    produce = OutputMessageStep(message_template="produced", name="produce")
    file_image = OutputMessageStep(message_template="filed", name="file_image")
    nested = OutputMessageStep(message_template="nested", name="nested_file_image")
    # The break-shaped input: a nested step that carries the root node's id.
    nested.id = file_image.id
    gate = InputMessageStep(message_template="continue?", name="gate")
    subflow = Flow.from_steps([nested, gate])
    ctx = FlowExecutionStep(flow=subflow, name="ctx")
    root = Flow.from_steps([produce, ctx, file_image])
    return root, produce, file_image


def _leg(conversation, nodes):
    message = {
        "metadata": {
            snap.SNAPSHOT_NODES_METADATA_KEY: nodes,
            snap.SNAPSHOT_RUN_METADATA_KEY: RUN,
        }
    }
    recorder = snap.snapshot_recorder_for_leg(message, flow_sha256=FLOW, key=KEY, conversation=conversation)
    assert recorder is not None
    token = agent_loader._STEP_SNAPSHOT_RECORDER.set(recorder)
    try:
        status = asyncio.run(conversation.execute_async())
    finally:
        agent_loader._STEP_SNAPSHOT_RECORDER.reset(token)
    return status, recorder.snapshots()


def test_step_invoke_async_is_in_the_startup_guard():
    assert ("wayflowcore", "Step", "invoke_async") in agent_loader._LIVE_CLASS_BINDINGS
    agent_loader._validate_live_class_names()


def test_the_real_patch_records_the_filing_node_on_the_resumed_leg():
    from wayflowcore.executors.executionstatus import UserMessageRequestStatus

    agent_loader._patch_step_snapshot_capture()
    agent_loader._patch_step_snapshot_capture()  # idempotent

    root, produce, file_image = _flow()
    nodes = sorted([produce.id, file_image.id])
    conversation = root.start_conversation()

    status1, leg1 = _leg(conversation, nodes)
    assert isinstance(status1, UserMessageRequestStatus)
    # The nested step with file_image's id ran in leg 1 and is not recorded.
    assert [s["node"] for s in leg1] == [produce.id]

    conversation.append_user_message("yes")
    _status2, leg2 = _leg(conversation, nodes)
    (filed,) = leg2
    assert filed["node"] == file_image.id
    assert isinstance(json.loads(filed["inputs_json"]), dict)
    assert filed["attestation"] == snap.snapshot_attestation(KEY, RUN, file_image.id, filed["sha256"], FLOW)
