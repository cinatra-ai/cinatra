// Template row codec — the agent_templates row <-> record mapping, extracted
// from store.ts as its own vertical slice (cinatra#3208 file-size ratchet, the
// same seam convention ./run-status, ./run-transition and ./agent-run-serde
// already follow). Pure row mapping: no db handle, no query, no side effect.
// store.ts re-exports `deserializeTemplate` so every existing `./store`
// importer is unchanged.
import { EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY } from "@cinatra-ai/sdk-extensions";
import type { AgentIOSpec } from "@cinatra-ai/objects";
import type { agentTemplates } from "./schema";
import type { ExtensionOrigin, ConnectorDependencyMap, AgentDependencyMap } from "./schema";
import type { GatedStep } from "./trigger-infer-side-effects";
import { derivePackageName } from "./agent-template-identity";
import { parseAuthPolicySafe } from "./agent-run-serde";
// Type-only back-edge to the module this slice was cut from: erased at compile
// time, so there is no runtime import cycle with store.ts.
import type {
  AgentTemplateRecord,
  ApprovalPolicy,
  CompiledStep,
  CreateAgentTemplateInput,
} from "./store";

export function serializeTemplate(input: CreateAgentTemplateInput) {
  // derive packageName when callers omit it. The DB column
  // is NOT NULL, so a literal null would crash on
  // INSERT; auto-derive guarantees every row has a stable identity.
  const packageName = derivePackageName({
    packageName: input.packageName,
    userId: input.creatorId ?? null,
    name: input.name,
    id: input.id,
  });
  return {
    id: input.id,
    orgId: input.orgId ?? null,
    // owner tier. NULL when caller did not specify; the
    // backfill covers legacy rows.
    ownerLevel: input.ownerLevel ?? null,
    ownerId: input.ownerId ?? null,
    creatorId: input.creatorId ?? null,
    name: input.name,
    description: input.description ?? null,
    sourceNl: input.sourceNl,
    compiledPlan: JSON.stringify(input.compiledPlan),
    inputSchema: JSON.stringify(input.inputSchema),
    outputSchema: input.outputSchema ? JSON.stringify(input.outputSchema) : null,
    approvalPolicy: JSON.stringify(input.approvalPolicy),
    status: input.status ?? "draft",
    type: input.type ?? "leaf",
    taskSpec: input.taskSpec ?? null,
    packageName,
    packageVersion: input.packageVersion ?? null,
    hitlScreens: input.hitlScreens ? JSON.stringify(input.hitlScreens) : null,
    agentDependencies:
      input.agentDependencies && Object.keys(input.agentDependencies).length > 0
        ? JSON.stringify(input.agentDependencies)
        : null,
    connectorDependencies:
      input.connectorDependencies && Object.keys(input.connectorDependencies).length > 0
        ? JSON.stringify(input.connectorDependencies)
        : null,
    ioSpec: input.ioSpec ? JSON.stringify(input.ioSpec) : null,
    hitlRequired: input.hitlRequired ?? false,
    executionProvider: input.executionProvider ?? "wayflow",
    lgGraphCode: input.lgGraphCode ?? null,
    lgGraphId: input.lgGraphId ?? null,
    // null on initial create; populated by
    // agent_source_compile on the first recompile.
    triggerMode: input.triggerMode ?? null,
    gatedSteps: input.gatedSteps ? JSON.stringify(input.gatedSteps) : null,
    // The compiled manifest lifecycle declaration (already JSON-as-text from the
    // install seed / builder). null on create when the manifest declares none.
    lifecycleConfig: input.lifecycleConfig ?? null,
    // The locally-persisted binding-presence authority (cinatra#2498). null on
    // create when the caller does not derive it from a compile (e.g. a legacy
    // fixture) — treated as "unknown", the same fail-closed posture every row
    // had before this column existed.
    hasArtifactBindings: input.hasArtifactBindings ?? null,
    // The executed artifact-binding declaration (cinatra#3208), already
    // JSON-as-text from the install seed. null on create when the caller does
    // not derive it from a compile — "unknown", the pre-#3208 fallback.
    artifactBindings: input.artifactBindings ?? null,
    // template-level AgentAuthPolicy as JSON-as-text. null = use
    // DEFAULT_AGENT_AUTH_POLICY at read time.
    agentAuthPolicy: input.agentAuthPolicy ? JSON.stringify(input.agentAuthPolicy) : null,
  };
}

export function deserializeTemplate(row: typeof agentTemplates.$inferSelect): AgentTemplateRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    ownerLevel: row.ownerLevel ?? null,
    ownerId: row.ownerId ?? null,
    creatorId: row.creatorId,
    name: row.name,
    description: row.description,
    sourceNl: row.sourceNl,
    compiledPlan: JSON.parse(row.compiledPlan) as CompiledStep[],
    inputSchema: JSON.parse(row.inputSchema) as Record<string, unknown>,
    outputSchema: row.outputSchema ? (JSON.parse(row.outputSchema) as Record<string, unknown>) : null,
    approvalPolicy: JSON.parse(row.approvalPolicy) as ApprovalPolicy,
    status: row.status,
    // Normalize null / legacy / unknown values to "leaf"; OAS-aligned "flow"|"node" preserved.
    type: (row.type === "proxy" ? "proxy"
         : row.type === "orchestrator" ? "orchestrator"
         : row.type === "parallel" ? "parallel"
         : row.type === "supervisor" ? "supervisor"
         : row.type === "iterative" ? "iterative"
         : row.type === "node" ? "node"
         : row.type === "flow" ? "flow"
         : "leaf") as AgentTemplateRecord["type"],
    agentKind: row.agentKind === "assistant" ? "assistant" : "executor", // #1037: only an explicit "assistant" opts in; else the column DEFAULT ("executor")
    taskSpec: row.taskSpec,
    packageName: row.packageName ?? null,
    packageVersion: row.packageVersion ?? null,
    currentVersionId: row.currentVersionId ?? null,
    hitlScreens: row.hitlScreens ? (JSON.parse(row.hitlScreens) as string[]) : null,
    agentDependencies: row.agentDependencies
      ? (JSON.parse(row.agentDependencies) as AgentDependencyMap)
      : {},
    connectorDependencies: row.connectorDependencies
      ? (JSON.parse(row.connectorDependencies) as ConnectorDependencyMap)
      : {},
    ioSpec: row.ioSpec ? (JSON.parse(row.ioSpec) as AgentIOSpec) : null,
    hitlRequired: row.hitlRequired ?? false, // null from pre-migration rows → false
    executionProvider: (row.executionProvider === "openai" ? "openai"
      : row.executionProvider === "anthropic" ? "anthropic"
      : row.executionProvider === "gemini" ? "gemini"
      : row.executionProvider === "langgraph" ? "langgraph"
      : row.executionProvider === "wayflow" ? "wayflow"
      : "default") as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default",
    lgGraphCode: row.lgGraphCode ?? null,
    lgGraphId: row.lgGraphId ?? null,
    // external A2A template columns.
    // Unknown values (e.g. stray strings from direct SQL writes) fall back
    // to "internal" so downstream type-narrow branches stay sound.
    sourceType: (row.sourceType === "external" ? "external" : "internal") as
      | "internal"
      | "external",
    agentUrl: row.agentUrl ?? null,
    connectorSlug: row.connectorSlug ?? null,
    remoteAgentId: row.remoteAgentId ?? null,
    // trigger gate metadata. Stored as text columns;
    // deserialized to typed values here. Unknown trigger_mode strings (e.g.
    // direct SQL writes) coerce to null so callers can default to "full"
    // conservatively at the gate.
    triggerMode: (row.triggerMode === "full" ? "full"
                : row.triggerMode === "start-only" ? "start-only"
                : null) as "full" | "start-only" | null,
    gatedSteps: row.gatedSteps ? (JSON.parse(row.gatedSteps) as GatedStep[]) : null,
    // Compiled manifest lifecycle stays JSON-as-text on the record; the lifecycle
    // readers parse it fail-soft at their own call sites.
    lifecycleConfig: row.lifecycleConfig ?? null,
    // The locally-persisted binding-presence authority (cinatra#2498). Native
    // boolean column; null (unknown) passes through unchanged.
    hasArtifactBindings: row.hasArtifactBindings ?? null,
    // The executed artifact-binding declaration (cinatra#3208) stays
    // JSON-as-text on the record; the materializer parses it fail-closed
    // through the single grammar (parseArtifactBindingDeclaration).
    artifactBindings: row.artifactBindings ?? null,
    // JSON-as-text deserialization. Returns null when column is null.
    // fix: defensive parse — see parseAuthPolicySafe definition above.
    agentAuthPolicy: parseAuthPolicySafe(row.agentAuthPolicy ?? null),
    // the per-kind column was dropped; status is canonical
    // (installed_extension). deserializeTemplate is a synchronous row mapper
    // and cannot query the manifest, so it defaults to "active". The marketplace
    // readers (readActiveExtensionTemplates / readArchivedExtensionTemplates)
    // OVERRIDE this from readEffectiveStatusByPackageNames; callers that need
    // the authoritative status must use those readers (or the canonical store).
    extensionLifecycleStatus: "active" as "active" | "archived",
    // origin JSONB deserialized as-is; null for legacy rows.
    // Callers that need visibility should read origin?.visibility ?? 'public' (grandfather clause).
    origin: (row.origin as ExtensionOrigin | null | undefined) ?? null,
    // Per-agent execution config (cinatra#1708 slice B). The declared
    // environment stays RAW on the record — every consumer runs it through the
    // fail-closed `parseExecutionEnvironment` (a JSON.parse here would have to
    // choose a failure mode for malformed stored text, and "silently no
    // environment" is exactly the outcome the fail-closed doctrine forbids).
    // Unparseable text therefore surfaces as an INVALID declaration downstream,
    // never as "no environment".
    executionEnvironment: parseStoredExecutionEnvironment(row.executionEnvironment),
    executionEnabled: row.executionEnabled ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * JSON-as-text → the RAW declared value handed to `parseExecutionEnvironment`.
 * `null`/empty column ⇒ `null` ("no declared environment"). Text that is not
 * JSON at all cannot be "no environment" (that would silently drop a
 * declaration the author made), so it resolves to the sdk leaf's
 * present-but-malformed POISON marker, which the parser rejects with a precise
 * error at consumption — the same doctrine the manifest claim resolver uses.
 */
function parseStoredExecutionEnvironment(stored: string | null | undefined): unknown {
  if (stored == null || stored.trim() === "") return null;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return { [EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY]: true };
  }
}

