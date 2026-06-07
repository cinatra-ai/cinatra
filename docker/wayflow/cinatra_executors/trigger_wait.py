"""
CinatraTriggerWaitNodeExecutor.

WayFlow custom Step for the Cinatra-extension `TriggerWaitNode`. Pauses an
in-flight WayFlow run until an external scheduler (trigger-release-job) fires.

Background
----------
OAS 26.1.0 has no native Wait/Schedule primitive. The standard Flow node list
is exhaustive: LlmNode, ApiNode, AgentNode, FlowNode, MapNode, StartNode,
EndNode, BranchingNode, ToolNode, InputMessageNode, OutputMessageNode,
ParallelMapNode, ParallelFlowNode. None of these expresses "wait for external
event."

ADR 0043 documents the Cinatra extension: TriggerWaitNode is recognized by
the OAS compiler (packages/agents/src/oas-compiler.ts COMPONENT_TYPES_HANDLED)
and emits a yield with task_state="input-required" plus a
metadata.cinatra.resumeSource="trigger-release" marker. InputMessageNode is
the OAS-native pause primitive, so the marker keeps the pause spec-safe while
letting the dispatcher distinguish trigger waits from user-input waits.

The TS worker (packages/agents/src/execution.ts) detects the resumeSource
marker on the A2A task update, persists a row in agent_run_trigger_waits with
the held a2aContextId, transitions the run from `running` → `waiting_trigger`,
and exits cleanly. The WayFlow conversation context stays open server-side.

Resume
------
trigger-release-job (packages/agents/src/trigger-release-job.ts) detects when
a scheduled trigger fires AND there is an entry in agent_run_trigger_waits
for the run. Instead of re-dispatching execution from start (the existing
`armed` path), it sends an A2A message into the existing a2a_context_id with
a `triggerRelease` payload. WayFlow resumes the conversation from the
TriggerWaitNode and the next node executes.

Recurring triggers depart from the existing `armed` lifecycle (which clones
the run on each cron tick): `waiting_trigger` runs resume the SAME
a2aContext on each tick. The flow author is responsible for the loop
structure (BranchingNode → re-enter TriggerWaitNode).

Status
------
This file lays the contract. The full Python wiring (yielding the right
A2A status and attaching the resumeSource marker via WayFlow's message
metadata APIs) requires live Docker WayFlow integration testing. The class
is registered in agent_loader.py so OAS files declaring
component_type="TriggerWaitNode" load without error; the runtime yield
contract is finalized when the email-delivery flow is wired.
"""

from typing import Any, Dict

try:
    from wayflowcore import Step  # type: ignore[import-not-found]
    from wayflowcore.steps.step import StepResult  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    class Step:  # type: ignore[no-redef]
        async def _invoke_step_async(self, inputs: Dict[str, Any], conversation: Any) -> Any:
            raise NotImplementedError("WayFlow runtime not available")

    class StepResult:  # type: ignore[no-redef]
        def __init__(self, outputs: Dict[str, Any]) -> None:
            self.outputs = outputs


# Marker key the TS worker scans for on the A2A task update payload to
# distinguish a TriggerWait pause from a regular InputMessageNode pause.
# See packages/agents/src/execution.ts and ADR 0043.
TRIGGER_WAIT_RESUME_SOURCE = "trigger-release"


class CinatraTriggerWaitNodeExecutor(Step):
    """
    Yields the WayFlow run with the trigger-release marker so the Cinatra
    dispatcher transitions the run to `waiting_trigger` and persists the
    held a2aContextId. trigger-release-job resumes by sending an A2A
    message into the same context when the scheduled trigger fires.

    Inputs (from prior nodes via DataFlowEdges):
        triggerConfig: dict — the trigger configuration produced by the
            preceding trigger-agent subflow (immediate, scheduled, recurring).

    Outputs (after resume):
        triggerRelease: dict — the release payload posted by
            trigger-release-job. Downstream nodes (e.g. the send ApiNode)
            consume this to know the wait completed.

    Note on the spec-safe fallback: this executor returns task_state=
    "input-required" plus metadata.cinatra.resumeSource = TRIGGER_WAIT_RESUME_SOURCE.
    OAS 26.1.0 only blesses user-input pause; introducing a new task_state would
    require WayFlow runtime cooperation. The marker pattern lets the TS
    dispatcher distinguish the two without violating spec.
    """

    async def _invoke_step_async(
        self, inputs: Dict[str, Any], conversation: Any
    ) -> "StepResult":
        # Production wiring: the executor must yield a WayFlow status whose
        # A2A representation carries the resumeSource marker. The exact
        # WayFlow API for attaching message metadata at yield time depends on
        # the wayflowcore version pinned in docker/wayflow/Dockerfile and is
        # validated during live integration. Until then this stub is a no-op
        # pass-through so OAS load + compile work end-to-end.
        return StepResult(outputs={"triggerRelease": {}})
