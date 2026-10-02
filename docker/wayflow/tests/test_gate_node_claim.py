"""cinatra#3745 — the runtime records which step of the flow paused a run.

When a run pauses for a review (an input-required task), the loader finds the
conversation that yielded (the conversation itself or one of its
sub-conversations whose id equals the status's `_conversation_id`), reads the id
of that conversation's current step, signs the claim
`g1\\n<contextId>\\n<taskId>\\n<nodeId>` with CINATRA_CONTEXT_ATTEST_KEY and puts
`{"node": <id>, "attestation": "g1:<hex>"}` on the metadata of the last new A2A
message under `cinatra_gate_node`. The application stores the claim as signed.

The helpers are driven alone over plain test objects, in the shape of
test_endnode_outputs_extraction.py.
"""
from __future__ import annotations

import hashlib
import hmac
from typing import Any, Dict, List, Optional

import agent_loader as loader

KEY = "attest-key-under-test"
CTX = "conv-ctx-id-123"
TASK = "task-id-456"
NODE = "review-step-node"


class _Step:
    def __init__(self, step_id: str) -> None:
        self.id = step_id


class _Flow:
    def __init__(self, steps: Dict[str, Any]) -> None:
        self.steps = steps


class _Conversation:
    def __init__(
        self,
        conv_id: str,
        current_step_name: str,
        steps: Dict[str, Any],
        subs: Optional[List[Any]] = None,
    ) -> None:
        self.id = conv_id
        self.current_step_name = current_step_name
        self.component = _Flow(steps)
        self._subs = subs or []

    def _get_all_sub_conversations(self) -> List[Any]:
        return list(self._subs)


class _Status:
    def __init__(self, conversation_id: Optional[str]) -> None:
        self._conversation_id = conversation_id


class _Unreadable:
    @property
    def id(self) -> str:
        raise RuntimeError("unreadable")

    def _get_all_sub_conversations(self) -> List[Any]:
        raise RuntimeError("unreadable")


def _expected_claim(ctx: str, task: str, node: str) -> Dict[str, str]:
    sig = hmac.new(
        KEY.encode("utf-8"), f"g1\n{ctx}\n{task}\n{node}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {"node": node, "attestation": f"g1:{sig}"}


# (g1)
def test_top_level_yielding_conversation_answers_its_current_step_id() -> None:
    conv = _Conversation("conv-top", "review", {"review": _Step(NODE), "other": _Step("n2")})
    assert loader._find_yielding_step_id(_Status("conv-top"), conv) == NODE


# (g2)
def test_nested_yielding_conversation_answers_its_own_current_step_id() -> None:
    inner = _Conversation("conv-inner", "gate", {"gate": _Step("inner-gate-node")})
    middle = _Conversation("conv-middle", "sub", {"sub": _Step("middle-node")}, [inner])
    top = _Conversation("conv-top", "flow", {"flow": _Step("top-node")}, [middle])
    assert loader._find_yielding_step_id(_Status("conv-inner"), top) == "inner-gate-node"


# (g3)
def test_finder_answers_none_when_nothing_can_be_read() -> None:
    conv = _Conversation("conv-top", "review", {"review": _Step(NODE)})
    # no conversation matches
    assert loader._find_yielding_step_id(_Status("conv-elsewhere"), conv) is None
    # no conversation id on the status
    assert loader._find_yielding_step_id(_Status(None), conv) is None
    assert loader._find_yielding_step_id(object(), conv) is None
    # the current step is not in the flow's steps
    missing = _Conversation("conv-top", "None", {"review": _Step(NODE)})
    assert loader._find_yielding_step_id(_Status("conv-top"), missing) is None
    # a step without an id
    no_id = _Conversation("conv-top", "review", {"review": object()})
    assert loader._find_yielding_step_id(_Status("conv-top"), no_id) is None
    # objects that raise on every read
    assert loader._find_yielding_step_id(_Status("conv-top"), _Unreadable()) is None
    assert loader._find_yielding_step_id(_Status("conv-top"), None) is None


# (g4)
def test_claim_is_signed_over_context_task_and_node() -> None:
    assert loader._sign_gate_node_claim(KEY, CTX, TASK, NODE) == _expected_claim(CTX, TASK, NODE)
    # a different task gives a different signature
    assert (
        loader._sign_gate_node_claim(KEY, CTX, "task-other", NODE)["attestation"]
        != _expected_claim(CTX, TASK, NODE)["attestation"]
    )


# (g5)
def test_claim_is_none_without_key_context_task_or_node() -> None:
    assert loader._sign_gate_node_claim(None, CTX, TASK, NODE) is None
    assert loader._sign_gate_node_claim("", CTX, TASK, NODE) is None
    assert loader._sign_gate_node_claim(KEY, "", TASK, NODE) is None
    assert loader._sign_gate_node_claim(KEY, None, TASK, NODE) is None
    assert loader._sign_gate_node_claim(KEY, CTX, "", NODE) is None
    assert loader._sign_gate_node_claim(KEY, CTX, None, NODE) is None
    assert loader._sign_gate_node_claim(KEY, CTX, TASK, "") is None
    assert loader._sign_gate_node_claim(KEY, CTX, TASK, None) is None


# (g6)
def test_attach_sets_the_claim_on_the_last_message_only() -> None:
    claim = _expected_claim(CTX, TASK, NODE)
    messages: List[Dict[str, Any]] = [
        {"kind": "message", "role": "agent", "parts": [], "metadata": {"a": 1}},
        {"kind": "message", "role": "agent", "parts": [], "metadata": {"keep": "yes"}},
    ]
    result = loader._attach_gate_node_claim(messages, claim)
    assert result is messages
    assert len(messages) == 2
    assert messages[0]["metadata"] == {"a": 1}
    assert messages[1]["metadata"] == {"keep": "yes", "cinatra_gate_node": claim}

    bare: List[Dict[str, Any]] = [{"kind": "message", "role": "agent", "parts": []}]
    loader._attach_gate_node_claim(bare, claim)
    assert bare[0]["metadata"] == {"cinatra_gate_node": claim}

    empty: List[Dict[str, Any]] = []
    assert loader._attach_gate_node_claim(empty, claim) == []
    assert empty == []

    untouched: List[Dict[str, Any]] = [{"kind": "message", "role": "agent", "parts": []}]
    loader._attach_gate_node_claim(untouched, None)
    assert "metadata" not in untouched[0]
