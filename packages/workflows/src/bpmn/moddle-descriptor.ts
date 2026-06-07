// Cinatra BPMN Profile 1.0 — `cinatra:` moddle descriptor.
//
// Every Cinatra-specific datum rides inside the standard `<bpmn:extensionElements>`
// channel (NOT as custom attributes on BPMN elements) — this is the moddle-blessed
// round-trip path. `xml.tagAlias: "lowerCase"` means XML tags are lowerCamelCase
// (`cinatra:agentRef`) while moddle type names + `$type` stay PascalCase
// (`cinatra:AgentRef`). The compiler matches on `$type`.
//
// The 12 Profile 1.0 extension elements (per REQ BPMN-02):
//   workflowMeta, placeholders, placeholderHint, agentRef, taskInput,
//   taskSchedule, taskPolicy, approvalConfig, taskKind, messageBody,
//   foreachSource, transitionOutcome.
// `workflowTarget` + `placeholder` are structural sub-elements of the above.
// There is intentionally NO `idempotencyKey` element — the live WorkflowSpec
// engine has no task-level idempotency field (idempotency is enforced at the
// primitive layer; see BCW-04).

export const CINATRA_BPMN_NAMESPACE_URI = "http://cinatra.ai/schema/bpmn/profile-1.0" as const;
export const CINATRA_BPMN_PREFIX = "cinatra" as const;

/** The moddle package descriptor passed to `new BpmnModdle({ cinatra: cinatraModdleDescriptor })`. */
export const cinatraModdleDescriptor = {
  name: "Cinatra",
  prefix: CINATRA_BPMN_PREFIX,
  uri: CINATRA_BPMN_NAMESPACE_URI,
  xml: { tagAlias: "lowerCase" },
  associations: [],
  types: [
    {
      name: "WorkflowMeta",
      superClass: ["Element"],
      properties: [
        { name: "name", type: "String", isAttr: true },
        { name: "product", type: "String", isAttr: true },
        { name: "target", type: "WorkflowTarget" },
      ],
    },
    {
      name: "WorkflowTarget",
      superClass: ["Element"],
      properties: [
        { name: "at", type: "String", isAttr: true },
        { name: "tz", type: "String", isAttr: true },
      ],
    },
    {
      name: "Placeholders",
      superClass: ["Element"],
      properties: [{ name: "placeholders", type: "Placeholder", isMany: true }],
    },
    {
      name: "Placeholder",
      superClass: ["Element"],
      properties: [
        { name: "name", type: "String", isAttr: true },
        { name: "type", type: "String", isAttr: true },
        { name: "required", type: "Boolean", isAttr: true },
        { name: "description", type: "String", isAttr: true },
        // Coerced to the declared `type` by the compiler; XML carries a string.
        { name: "default", type: "String", isAttr: true },
        { name: "hint", type: "PlaceholderHint" },
      ],
    },
    {
      name: "PlaceholderHint",
      superClass: ["Element"],
      properties: [{ name: "kind", type: "String", isAttr: true }],
    },
    {
      name: "AgentRef",
      superClass: ["Element"],
      properties: [
        { name: "package", type: "String", isAttr: true },
        { name: "name", type: "String", isAttr: true },
        { name: "version", type: "String", isAttr: true },
        { name: "templateId", type: "String", isAttr: true },
      ],
    },
    {
      name: "TaskInput",
      superClass: ["Element"],
      // JSON body, parsed to an object by the compiler.
      properties: [{ name: "value", type: "String", isBody: true }],
    },
    {
      name: "TaskSchedule",
      superClass: ["Element"],
      properties: [
        { name: "mode", type: "String", isAttr: true },
        { name: "anchor", type: "String", isAttr: true },
        { name: "at", type: "String", isAttr: true },
        { name: "offsetIso8601", type: "String", isAttr: true },
        { name: "direction", type: "String", isAttr: true },
        { name: "localTime", type: "String", isAttr: true },
        { name: "tz", type: "String", isAttr: true },
        { name: "anchorPoint", type: "String", isAttr: true },
        { name: "durationIso8601", type: "String", isAttr: true },
      ],
    },
    {
      name: "TaskPolicy",
      superClass: ["Element"],
      properties: [
        { name: "failurePolicy", type: "String", isAttr: true },
        { name: "maxAttempts", type: "Integer", isAttr: true },
      ],
    },
    {
      name: "ApprovalConfig",
      superClass: ["Element"],
      properties: [
        { name: "level", type: "String", isAttr: true },
        { name: "id", type: "String", isAttr: true },
        { name: "rejectionPolicy", type: "String", isAttr: true },
      ],
    },
    {
      name: "TaskKind",
      superClass: ["Element"],
      properties: [{ name: "value", type: "String", isAttr: true }],
    },
    {
      name: "MessageBody",
      superClass: ["Element"],
      properties: [{ name: "value", type: "String", isBody: true }],
    },
    {
      name: "ForeachSource",
      superClass: ["Element"],
      properties: [
        { name: "source", type: "String", isAttr: true },
        { name: "as", type: "String", isAttr: true },
        { name: "itemKey", type: "String", isAttr: true },
        { name: "rollupPolicy", type: "String", isAttr: true },
        { name: "maxFanout", type: "Integer", isAttr: true },
      ],
    },
    {
      name: "TransitionOutcome",
      superClass: ["Element"],
      properties: [{ name: "outcome", type: "String", isAttr: true }],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// TypeScript shapes for the parsed moddle extension elements (the runtime
// objects carry a `$type` discriminator like `cinatra:AgentRef`).
// ---------------------------------------------------------------------------

export type CinatraModdleElement = { $type: string; [key: string]: unknown };

export type CinatraWorkflowTarget = { $type: "cinatra:WorkflowTarget"; at?: string; tz?: string };
export type CinatraWorkflowMeta = {
  $type: "cinatra:WorkflowMeta";
  name?: string;
  product?: string;
  target?: CinatraWorkflowTarget;
};
export type CinatraPlaceholderHint = { $type: "cinatra:PlaceholderHint"; kind?: string };
export type CinatraPlaceholder = {
  $type: "cinatra:Placeholder";
  name?: string;
  type?: string;
  required?: boolean;
  description?: string;
  default?: string;
  hint?: CinatraPlaceholderHint;
};
export type CinatraPlaceholders = { $type: "cinatra:Placeholders"; placeholders?: CinatraPlaceholder[] };
export type CinatraAgentRef = {
  $type: "cinatra:AgentRef";
  package?: string;
  name?: string;
  version?: string;
  templateId?: string;
};
export type CinatraTaskInput = { $type: "cinatra:TaskInput"; value?: string };
export type CinatraTaskSchedule = {
  $type: "cinatra:TaskSchedule";
  mode?: string;
  anchor?: string;
  at?: string;
  offsetIso8601?: string;
  direction?: string;
  localTime?: string;
  tz?: string;
  anchorPoint?: string;
  durationIso8601?: string;
};
export type CinatraTaskPolicy = { $type: "cinatra:TaskPolicy"; failurePolicy?: string; maxAttempts?: number };
export type CinatraApprovalConfig = {
  $type: "cinatra:ApprovalConfig";
  level?: string;
  id?: string;
  rejectionPolicy?: string;
};
export type CinatraTaskKind = { $type: "cinatra:TaskKind"; value?: string };
export type CinatraMessageBody = { $type: "cinatra:MessageBody"; value?: string };
export type CinatraForeachSource = {
  $type: "cinatra:ForeachSource";
  source?: string;
  as?: string;
  itemKey?: string;
  rollupPolicy?: string;
  maxFanout?: number;
};
export type CinatraTransitionOutcome = { $type: "cinatra:TransitionOutcome"; outcome?: string };
