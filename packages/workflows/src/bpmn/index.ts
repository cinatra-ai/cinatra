// Public surface of the Cinatra BPMN Profile 1.0 substrate
// (`@cinatra-ai/workflows/bpmn`). No `server-only` import in this subtree — the
// CI gate (`scripts/audit/workflow-bpmn-gate.mjs`, run under `node --import tsx`)
// imports from here and must not trip the Next.js server-only guard.

export {
  BPMN_ERROR_CODES,
  BpmnCompileException,
  type BpmnErrorCode,
  type BpmnUnsupportedConstructError,
  type BpmnUnsupportedWorkflowSpecFieldError,
  type BpmnSidecarError,
  type BpmnCompileError,
} from "./errors";

export {
  cinatraModdleDescriptor,
  CINATRA_BPMN_NAMESPACE_URI,
  CINATRA_BPMN_PREFIX,
  type CinatraModdleElement,
  type CinatraWorkflowMeta,
  type CinatraWorkflowTarget,
  type CinatraPlaceholder,
  type CinatraPlaceholders,
  type CinatraPlaceholderHint,
  type CinatraAgentRef,
  type CinatraTaskInput,
  type CinatraTaskSchedule,
  type CinatraTaskPolicy,
  type CinatraApprovalConfig,
  type CinatraTaskKind,
  type CinatraMessageBody,
  type CinatraForeachSource,
  type CinatraTransitionOutcome,
} from "./moddle-descriptor";

export { createCinatraBpmnModdle, parseBpmnXml, serializeBpmnDefinitions, type BpmnXmlParseResult } from "./moddle";

export {
  validateBpmnAgainstProfile,
  validateWorkflowSpecAgainstBpmnProfile,
  type BpmnProfileValidationResult,
  type WorkflowSpecProfileResult,
} from "./profile";

export { compileBpmnToWorkflowSpec } from "./compile";

export { parseWorkflowBpmnSidecar, type SidecarParseResult } from "./sidecar";
