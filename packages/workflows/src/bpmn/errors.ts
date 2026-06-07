// Structured error catalog for the Cinatra BPMN Profile 1.0 substrate.
//
// The five headline errors (per DOC-02 catalog) are: `bpmn_unsupported_construct`,
// `bpmn_unsupported_workflowspec_field`, `bpmn_sidecar_missing`,
// `bpmn_sidecar_duplicate`, `bpmn_inline_definition_forbidden`. The remaining
// codes are granular parser/compiler robustness failures surfaced as structured
// errors (never raw throws) so install/CI callers can fail closed with a code +
// human-readable reason.

export const BPMN_ERROR_CODES = {
  /** A BPMN element / construct outside the Profile 1.0 supported set. */
  unsupportedConstruct: "bpmn_unsupported_construct",
  /** A live WorkflowSpec/TaskSpec field outside the Profile 1.0 emit subset. */
  unsupportedWorkflowSpecField: "bpmn_unsupported_workflowspec_field",
  /** No `cinatra/workflow.bpmn` at the canonical package-root path. */
  sidecarMissing: "bpmn_sidecar_missing",
  /** More than one `cinatra/workflow.bpmn` under the package root. */
  sidecarDuplicate: "bpmn_sidecar_duplicate",
  /** Legacy inline JSON definition at `package.json#cinatra.workflow`. */
  inlineDefinitionForbidden: "bpmn_inline_definition_forbidden",
  /** `package.json#cinatra.workflowVersion` missing or non-integer. */
  workflowVersionMissing: "manifest_workflow_version_missing",
  /** `bpmn-moddle` could not parse the XML (malformed / warnings). */
  parseError: "bpmn_parse_error",
  /** A `cinatra:taskInput` body was not valid JSON. */
  taskInputInvalidJson: "bpmn_taskinput_invalid_json",
  /** Two placeholders declared the same name. */
  placeholderDuplicate: "bpmn_placeholder_duplicate",
  /** Process-graph cardinality / shape violation (0/2+ process, 0/2+ start). */
  structureInvalid: "bpmn_structure_invalid",
} as const;

export type BpmnErrorCode = (typeof BPMN_ERROR_CODES)[keyof typeof BPMN_ERROR_CODES];

export type BpmnUnsupportedConstructError = {
  code: typeof BPMN_ERROR_CODES.unsupportedConstruct;
  elementId: string | null;
  elementType: string;
  reason: string;
};

export type BpmnUnsupportedWorkflowSpecFieldError = {
  code: typeof BPMN_ERROR_CODES.unsupportedWorkflowSpecField;
  field: string;
  taskKey: string | null;
  reason: string;
};

export type BpmnSidecarError = {
  code:
    | typeof BPMN_ERROR_CODES.sidecarMissing
    | typeof BPMN_ERROR_CODES.sidecarDuplicate
    | typeof BPMN_ERROR_CODES.inlineDefinitionForbidden
    | typeof BPMN_ERROR_CODES.workflowVersionMissing
    | typeof BPMN_ERROR_CODES.parseError
    | typeof BPMN_ERROR_CODES.unsupportedConstruct
    | typeof BPMN_ERROR_CODES.taskInputInvalidJson
    | typeof BPMN_ERROR_CODES.placeholderDuplicate
    | typeof BPMN_ERROR_CODES.structureInvalid;
  detail: string;
};

export type BpmnCompileError = {
  code:
    | typeof BPMN_ERROR_CODES.taskInputInvalidJson
    | typeof BPMN_ERROR_CODES.placeholderDuplicate
    | typeof BPMN_ERROR_CODES.structureInvalid;
  elementId: string | null;
  reason: string;
};

/** Thrown only by the compiler for a structured-but-fatal compile failure;
 *  callers in `sidecar.ts` / the gate catch it and map to a `BpmnSidecarError`. */
export class BpmnCompileException extends Error {
  readonly error: BpmnCompileError;
  constructor(error: BpmnCompileError) {
    super(`[${error.code}] ${error.reason}`);
    this.name = "BpmnCompileException";
    this.error = error;
  }
}
