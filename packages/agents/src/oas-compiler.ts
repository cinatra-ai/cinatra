import "server-only";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { resolveAgentInstallDir } from "./agent-install-path";
// Operator-aware vendor dir for compile-time probes.
// Reads the instance-identity store dynamically to avoid a hard import that
// the unit-test transitive shim cannot stub. Missing store returns null and
// the compiler falls back to the shipped "cinatra-ai" vendor.
function readOperatorInstanceNamespace(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/lib/instance-identity-store") as {
      readInstanceIdentity?: () => { instanceNamespace?: string } | null;
    };
    const id = mod.readInstanceIdentity?.();
    const ns = id?.instanceNamespace;
    if (typeof ns === "string" && ns.length > 0) return ns;
    return null;
  } catch {
    return null;
  }
}
function compilerVendorDirCandidates(): string[] {
  const operator = readOperatorInstanceNamespace();
  if (operator === null || operator === "cinatra-ai") return ["cinatra-ai"];
  return [operator, "cinatra-ai"];
}
// Use the sub-path import (NOT the full @cinatra-ai/objects barrel) to keep
// oas-compiler test transitive imports clean. The full barrel pulls
// objects/mcp/handlers → mcp-server → @/lib/mcp-logging which is not stubbed
// for agent-builder vitest. namespace.ts has zero side-effect imports.
import { OBJECT_TYPE_NAMESPACE_RE } from "@cinatra-ai/objects/namespace";
// Compile-time side-effects inference + triggerMode derivation.
// Output is persisted on the compiled OAS root (CompiledAgentOas.triggerMode +
// .gatedSteps) and from there into agent_templates.trigger_mode + .gated_steps
// by mcp/handlers.ts. Read at runtime by the trigger gate and at
// display time by the Trigger tab UI.
import {
  collectGatedSteps,
  deriveTriggerMode,
  type GatedStep,
  type TriggerMode,
  type InferenceCompiledOas,
} from "./trigger-infer-side-effects";
// Type-only import reuses the LLM policy shape without
// pulling the Zod schema (oas-compiler is host-only too; the type-only import
// keeps the symbol surface minimal per CONVENTIONS.md).
import type { OasCinatraLlm } from "./llm-provider-policy";
import {
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  TRIGGER_WAIT_STATUS_RENDERER_ID,
} from "./agent-builder-ids";

// ---------------------------------------------------------------------------
// OAS Flow compiler
//
// Translates compact OAS v26.1.0 Flow files (authored under agents/*/cinatra/
// agent.json) into the legacy graphInput shapes consumed by the Python runtime
// (orchestrator_v1.py, setup_collector.py, leaf_v1.py). The Python contract is
// UNCHANGED — this module is the single source of truth for deriving
// approvalPolicy, inputSchema, outputSchema, prompt, packageName, etc., from
// the new authored format.
//
// Public surface (only these four names are exported):
//   - compileOasAgentJson
//   - validateOasFlowStructural
//   - types: CompiledAgentOas, CompiledAgentOasStep, CompileOasResult
//
// All other helpers are file-private (no `export` keyword). Tests exercise
// them indirectly via compileOasAgentJson.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Zod schemas — structural validation of the compact OAS shape
// ---------------------------------------------------------------------------

const componentRefSchema = z.object({ "$component_ref": z.string() });

const outputCinatraAnnotationSchema = z
  .object({
    object_type: z.string(),
    display_name: z.string().optional(),
    category: z.enum(["profile", "content", "project", "idea", "report"]).optional(),
    canonical_keys: z.array(z.string()).optional(),
    identity_key: z.string().optional(),
  })
  .optional();

const propertySchema = z
  .object({
    title: z.string(),
    type: z.string(),
    format: z.string().optional(),
    description: z.string().optional(),
    items: z.unknown().optional(),
    // Inline Cinatra object-type annotation (custom JSON Schema keyword).
    // Placed on the output port that carries the object's id, not in metadata.
    cinatra: outputCinatraAnnotationSchema,
  })
  .passthrough();

const startNodeSchema = z.object({
  component_type: z.literal("StartNode"),
  id: z.string(),
  name: z.string(),
  metadata: z
    .object({
      cinatra: z
        .object({
          required: z.array(z.string()).optional(),
          hidden: z.array(z.string()).optional(),
          inputRenderers: z.record(z.string(), z.string()).optional(),
          inputTitles: z.record(z.string(), z.string()).optional(),
        })
        .passthrough(),
    })
    .optional(),
  inputs: z.array(propertySchema),
  outputs: z.array(propertySchema).optional(), // inferred from inputs when absent (§9.3)
  branches: z.array(z.string()).optional(),     // defaults to ["next"] (§9.4)
});

const agentNodeSchema = z.object({
  component_type: z.literal("AgentNode"),
  id: z.string(),
  name: z.string(),
  metadata: z
    .object({
      cinatra: z
        .object({
          riskClass: z.string().optional(),
          requiresApproval: z.boolean().optional(),
          renderer: z.string().optional(),
          a2uiSurfaceId: z.string().optional(),
          a2uiSurfaceIdOverride: z.string().optional(),
          hitlOwnedBy: z.enum(["childAgent", "self"]).optional(),
          description: z.string().optional(),
        })
        .passthrough(),
    })
    .optional(),
  inputs: z.array(propertySchema).optional(),
  outputs: z.array(propertySchema).optional(),
  agent: componentRefSchema,
  branches: z.array(z.string()).optional(),
});

const endNodeSchema = z.object({
  component_type: z.literal("EndNode"),
  id: z.string(),
  name: z.string(),
  outputs: z.array(propertySchema),
});

// InputMessageNode: HITL field-collection step. Compiles to a
// runtime-neutral `nodeType: "input_message"` projection consumed by both the
// LangGraph runtime (CinatraSetupCollectorHook) and the WayFlow runtime
// (CinatraInputMessageNodeExecutor).
const inputMessageNodeStepSchema = z.object({
  id: z.string(),
  component_type: z.literal("InputMessageNode"),
  name: z.string().optional(),
  outputs: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
      }).passthrough(),
    )
    .min(1),
  inputs: z
    .array(
      z.object({
        id: z.string().optional(),
        schema: z.record(z.string(), z.unknown()).optional(),
      }).passthrough(),
    )
    .optional(),
  metadata: z
    .object({
      cinatra: z
        .object({
          inputRenderers: z.record(z.string(), z.string()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .optional(),
}).passthrough();

// Exported (private) to silence "unused" if we end up not referencing them directly.
// These are currently used via the flowSchema composition inline; kept as individual
// declarations for readability and future per-node validation expansion.
void startNodeSchema;
void agentNodeSchema;
void endNodeSchema;
void inputMessageNodeStepSchema;

// ---------------------------------------------------------------------------
// Per-agent llm_config / toolboxes / A2A connection_config schemas
// ---------------------------------------------------------------------------

const llmConfigSchema = z.object({
  component_type: z.literal("OpenAiConfig"),
  id: z.string(),
  name: z.string().optional(),
  model_id: z.string(),
  api_type: z.enum(["chat_completions", "responses"]).optional(),
}).passthrough();

const streamableHttpTransportSchema = z.object({
  component_type: z.literal("StreamableHTTPTransport"),
  id: z.string(),
  name: z.string().optional(),
  url: z.string(),
}).passthrough();

const mcpToolBoxSchema = z.object({
  component_type: z.literal("MCPToolBox"),
  id: z.string(),
  name: z.string().optional(),
  client_transport: streamableHttpTransportSchema,
}).passthrough();

const a2aConnectionConfigSchema = z.object({
  component_type: z.literal("A2AConnectionConfig"),
  id: z.string(),
  name: z.string().optional(),
  timeout: z.number().int().positive(),
  verify: z.boolean(),
}).passthrough();

// Suppress unused-import lint on these new schemas; they are applied at
// extraction time (not via flowSchema composition) so Zod doesn't validate
// new-shape unknowns against the root schema — same pattern as
// `void startNodeSchema;` above.
void llmConfigSchema;
void streamableHttpTransportSchema;
void mcpToolBoxSchema;
void a2aConnectionConfigSchema;

const controlFlowEdgeSchema = z.object({
  component_type: z.literal("ControlFlowEdge"),
  name: z.string(),
  id: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  from_node: componentRefSchema,
  to_node: componentRefSchema,
  from_branch: z.string().nullable().optional(), // missing/null are both valid default
});

const dataFlowEdgeSchema = z.object({
  component_type: z.literal("DataFlowEdge"),
  name: z.string(),
  id: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source_node: componentRefSchema,
  source_output: z.string(),
  destination_node: componentRefSchema,
  destination_input: z.string(),
});

// ParallelFlowNode.
// Container node that executes its `subflows[]` concurrently and joins
// their outputs. From the OAS 26.1.0 spec; see
// https://oracle.github.io/agent-spec/development/agentspec/language_spec_26_1_0.html
// — `subflows` is `List[Flow]` where `Flow = BaseFlow | ComponentReference`.
// The node itself is structural — it does NOT contribute an approvalPolicy
// step. Each subflow's child AgentNode / InputMessageNode / FlowNode
// contributes normally via recursive expansion (deferred to a follow-up;
// the spike's synthetic OAS contains only ApiNodes inside subflows, which
// are non-steppable). The runtime executes ParallelFlowNode natively via
// wayflowcore's ParallelFlowStep in `docker/wayflow/agent_loader.py`'s
// AgentSpecLoader path — no Cinatra-side execution translation needed.
//
// Defensive guard: ParallelFlowNode is NOT added to COMPONENT_TYPES_HANDLED
// because it never appears as a steppable approval entry. If a future
// change includes it in `steppableNodeIds`, the assertion in the map body
// will catch it with a clear error message.
//
// Spec-aligned `subflows` shape: accept either component refs (the common
// authoring pattern in Cinatra — keeps inner Flow definitions in
// `$referenced_components`) or inline `BaseFlow` objects (for completeness
// per the spec). The inline option uses `z.unknown()` because Zod can't
// trivially express the recursive Flow shape without a lazy ref to
// `flowSchema` (and Flow has required top-level fields like
// `agentspec_version` that an inline subflow may legitimately omit).
const parallelFlowNodeSchema = z.object({
  component_type: z.literal("ParallelFlowNode"),
  id: z.string().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  inputs: z.array(propertySchema).nullable().optional(),
  outputs: z.array(propertySchema).nullable().optional(),
  subflows: z.array(z.union([componentRefSchema, z.record(z.string(), z.unknown())])).min(1),
}).passthrough();

/**
 * Post-pass validation for `$referenced_components`: walks the components
 * map and validates each entry against its discriminating `component_type`
 * where Cinatra has a strict schema. Today the only added strict component
 * is `ParallelFlowNode` — other component types remain loosely typed via
 * the parent `flowSchema.$referenced_components: z.record(string, unknown)`
 * and are validated at usage sites. This function gives Cinatra a hook
 * to tighten validation gradually without rewriting `flowSchema`.
 */
function validateReferencedComponents(
  parsed: Record<string, unknown>,
): string[] {
  const refs = parsed.$referenced_components;
  if (refs === null || refs === undefined || typeof refs !== "object") return [];
  const errors: string[] = [];
  for (const [id, comp] of Object.entries(refs as Record<string, unknown>)) {
    if (comp === null || typeof comp !== "object") continue;
    const ct = (comp as { component_type?: unknown }).component_type;
    if (ct === "ParallelFlowNode") {
      const r = parallelFlowNodeSchema.safeParse(comp);
      if (!r.success) {
        for (const issue of r.error.issues) {
          errors.push(
            `$referenced_components.${id}.${issue.path.join(".")}: ${issue.message}`,
          );
        }
      }
    }
  }
  return errors;
}

const flowSchema = z.object({
  agentspec_version: z.literal("26.1.0"),
  component_type: z.literal("Flow"),
  id: z.string(),
  name: z.string(),
  metadata: z.object({
    cinatra: z
      .object({
        // Accept both legacy ("leaf"/"orchestrator") and
        // OAS-aligned ("node"/"flow") type values. The TS dispatch layer maps
        // both to the same Python graphs via TYPE_TO_GRAPH.
        type: z.enum(["orchestrator", "leaf", "node", "flow"]),
        hitlScreens: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
  inputs: z.array(propertySchema),
  outputs: z.array(propertySchema),
  start_node: componentRefSchema,
  nodes: z.array(componentRefSchema),
  control_flow_connections: z.array(controlFlowEdgeSchema),
  data_flow_connections: z.array(dataFlowEdgeSchema).optional(),
  $referenced_components: z.record(z.string(), z.unknown()),
});

export function validateOasFlowStructural(parsed: Record<string, unknown>): string[] {
  const result = flowSchema.safeParse(parsed);
  const topLevel = result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  // After top-level structural check, validate strictly-typed components
  // inside `$referenced_components` (currently only `ParallelFlowNode`).
  // Always run this pass — even when the top-level check fails — so authors
  // see all structural errors at once rather than playing whack-a-mole.
  const referenced = validateReferencedComponents(parsed);
  return [...topLevel, ...referenced];
}

// ---------------------------------------------------------------------------
// Global registry loader (module-level cache; strict / non-strict modes)
// ---------------------------------------------------------------------------

// Module-level cache keyed by absolute registry path.
// Tests pass their own tmp registryPath per test, so entries never collide.
//
// Production cache-invalidation caveat: entries are never invalidated for the
// lifetime of the Node.js process. The shared registry at
// agents/_shared/cinatra/components.json is expected to change rarely (new
// global component ids are a shared-infrastructure concern). If an operator
// edits the shared registry on a running server, they must restart the dev
// server (or redeploy) to pick up the new components — subsequent compiles
// will otherwise use the stale in-memory snapshot. We deliberately do not
// stat() the file on every load because the hot path compiles many agents and
// an fs.stat per compile adds measurable latency for a rare scenario. If the
// trade-off changes, switch the cache key to `${path}:${stat.mtimeMs}`.
let _registryCache: Map<string, Record<string, unknown>> | null = null;

async function loadGlobalRegistry(
  registryPath?: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<Record<string, unknown>> {
  const path =
    registryPath ?? join(resolveAgentInstallDir(), "_shared", "cinatra", "components.json");
  if (_registryCache === null) _registryCache = new Map();
  const cached = _registryCache.get(path);
  if (cached !== undefined) return cached;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (strict) throw new Error(`global registry not found at ${path}: ${(err as Error).message}`);
    console.warn(
      `[oas-compiler] global registry not found at ${path} — proceeding with empty registry`,
    );
    _registryCache.set(path, {});
    return {};
  }

  let parsed: { components?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { components?: Record<string, unknown> };
  } catch (err) {
    if (strict)
      throw new Error(
        `global registry at ${path} is malformed JSON: ${(err as Error).message}`,
      );
    console.warn(
      `[oas-compiler] global registry at ${path} is malformed JSON — proceeding with empty registry`,
    );
    _registryCache.set(path, {});
    return {};
  }

  const components = parsed.components ?? {};
  _registryCache.set(path, components);
  return components;
}

// @visibleForTesting — not documented in the public API. Tests call this in
// beforeEach so each test's tmp registry is loaded fresh from disk.
export function __resetRegistryCacheForTests(): void {
  _registryCache = null;
}

// ---------------------------------------------------------------------------
// Component reference resolution (local → global → throw; cycle detection)
// ---------------------------------------------------------------------------

function resolveComponentRef(
  id: string,
  localRefs: Record<string, unknown>,
  globalRegistry: Record<string, unknown>,
  visited: Set<string>,
): Record<string, unknown> {
  if (visited.has(id)) throw new Error(`cycle detected at component id ${id}`);
  visited.add(id);
  const local = localRefs[id];
  if (local && typeof local === "object") return local as Record<string, unknown>;
  const global = globalRegistry[id];
  if (global && typeof global === "object") return global as Record<string, unknown>;
  throw new Error(
    `unresolved component ref: ${id} (looked in local $referenced_components and global registry)`,
  );
}

// ---------------------------------------------------------------------------
// inputMapping template variable derivation
// ---------------------------------------------------------------------------

function deriveInputMappingTemplateVar(args: {
  sourceNodeId: string;
  sourceOutput: string;
  sourceNodeType: "StartNode" | "AgentNode" | "EndNode";
  sourceNodeIndex: number; // index in the BFS-ordered node list; -1 for StartNode
  destinationNodeIndex: number;
}): string {
  const {
    sourceNodeId,
    sourceOutput,
    sourceNodeType,
    sourceNodeIndex,
    destinationNodeIndex,
  } = args;

  if (sourceNodeType === "StartNode") {
    return `{{input_params.${sourceOutput}}}`;
  }
  if (sourceNodeIndex === destinationNodeIndex - 1) {
    return `{{child_output.${sourceOutput}}}`;
  }
  return `{{${sourceNodeId}_output.${sourceOutput}}}`;
}

// ---------------------------------------------------------------------------
// Parent/leaf metadata.cinatra merge
// Explicit 5-key projection — do NOT spread.
// a2uiSurfaceIdOverride is CONSUMED here, never re-emitted downstream.
// ---------------------------------------------------------------------------

function mergeParentLeafCinatra(
  parentCinatra: Record<string, unknown> | undefined,
  leafCinatra: Record<string, unknown> | undefined,
) {
  const p = (parentCinatra ?? {}) as Record<string, unknown>;
  const l = (leafCinatra ?? {}) as Record<string, unknown>;
  return {
    a2uiSurfaceId: (p.a2uiSurfaceIdOverride as string | undefined) ?? (l.a2uiSurfaceId as string | undefined) ?? (p.a2uiSurfaceId as string | undefined),
    renderer: (p.renderer as string | undefined) ?? (l.renderer as string | undefined),
    requiresApproval: (p.requiresApproval as boolean | undefined) ?? (l.requiresApproval as boolean | undefined),
    riskClass: (p.riskClass as string | undefined) ?? (l.riskClass as string | undefined),
    hitlOwnedBy: (p.hitlOwnedBy as "childAgent" | "self" | undefined) ?? (l.hitlOwnedBy as "childAgent" | "self" | undefined),
  };
  // NOTE: a2uiSurfaceIdOverride is intentionally never present in the output.
}

// ---------------------------------------------------------------------------
// Path resolution for the agent.json (traversal guard)
// ---------------------------------------------------------------------------

// Legacy slug map for the two slugs whose older directory names differ from the slug.
const OAS_COMPILER_LEGACY_SLUG_MAP: Record<string, string> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

// Derive renderer and riskClass from a child agent's own OAS so parent FlowNodes
// don't need to redeclare metadata that belongs to the child.
// Scans the child's $referenced_components for the first InputMessageNode that
// has metadata.cinatra.requiresApproval === true and returns its renderer + riskClass.
function readChildOasRendererInfo(
  packageName: string,
): { renderer?: string; riskClass?: string } | null {
  const candidates = resolveAgentJsonPath(packageName);
  if (!candidates) return null;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const refs = (parsed["$referenced_components"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const comp of Object.values(refs)) {
        if (comp.component_type !== "InputMessageNode") continue;
        const cinatra = ((comp.metadata as Record<string, unknown> | undefined)?.cinatra ?? {}) as Record<string, unknown>;
        if (cinatra.requiresApproval !== true) continue;
        const renderer = cinatra.renderer as string | undefined;
        const riskClass = cinatra.riskClass as string | undefined;
        if (renderer) return { renderer, riskClass };
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

function resolveAgentJsonPath(packageName: string): string[] | null {
  // Reject anything that contains traversal or NUL at any position in the name.
  if (packageName.includes("..") || packageName.includes("\0")) return null;
  const slug = packageName.split("/").pop();
  if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\0")) return null;
  // Reject any packageName with more than one "/" separator. The scope-aware
  // convention is `@scope/slug`, but unscoped `slug` is also accepted via the
  // split-pop pattern above. We do not enforce a leading "@" on the scope part —
  // both `@scope/slug` and `foo/bar` map to slug = last segment.
  const parts = packageName.split("/");
  if (parts.length > 2) return null;
  // N-rung probe. The canonical layout nests agents under a
  // vendor-namespace dir AND renames agent.json -> oas.json.
  // Vendor-dir probe walks the operator's instance
  // namespace first, then the shipped "cinatra" dir. Non-cinatra operators
  // could not publish chat-authored agents before this restore.
  const root = resolveAgentInstallDir();
  const legacySlug = OAS_COMPILER_LEGACY_SLUG_MAP[slug] ?? slug;
  const candidates: string[] = [];
  for (const vendor of compilerVendorDirCandidates()) {
    candidates.push(join(root, vendor, slug, "cinatra", "oas.json"));    // canonical
    candidates.push(join(root, vendor, slug, "cinatra", "agent.json"));  // transitional
  }
  candidates.push(join(root, legacySlug, "cinatra", "agent.json"));      // older cinatra layout
  candidates.push(join(root, legacySlug, "agent.json"));                 // older flat layout
  return candidates;
}

// ---------------------------------------------------------------------------
// Sibling package.json loader
// ---------------------------------------------------------------------------

// Read sibling `<agent>/cinatra.json` (next to package.json,
// NOT inside the cinatra/ subdirectory which holds OAS files).
// Exported for unit testing — production callers should rely on the compiler
// surfacing this via CompiledAgentOas.cinatraConfig.
export async function readSiblingCinatraJson(
  agentJsonPath: string,
): Promise<CinatraAgentConfig | null> {
  const candidates = [
    join(dirname(agentJsonPath), "..", "cinatra.json"), // cinatra/ layout (most common)
    join(dirname(agentJsonPath), "cinatra.json"),       // flat layout
  ];
  for (const cfgPath of candidates) {
    try {
      const raw = await readFile(cfgPath, "utf8");
      const parsed = JSON.parse(raw) as CinatraAgentConfig;
      // Defensive shape check — drop unknown roots, validate scalar types.
      const out: CinatraAgentConfig = {};
      if (parsed.limits && typeof parsed.limits === "object") {
        const maxRecipients = parsed.limits.maxRecipients;
        if (typeof maxRecipients === "number" && maxRecipients > 0) {
          out.limits = { maxRecipients };
        }
      }
      if (Array.isArray(parsed.requiredConnections)) {
        const conns = parsed.requiredConnections.filter(
          (c): c is { type: string; preferred?: string } =>
            !!c && typeof c === "object" && typeof c.type === "string",
        );
        if (conns.length > 0) out.requiredConnections = conns;
      }
      if (parsed.defaults && typeof parsed.defaults === "object") {
        const senderName = parsed.defaults.senderName;
        if (typeof senderName === "string" || senderName === null) {
          out.defaults = { senderName };
        }
      }
      return out;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readSiblingPackageJson(
  agentJsonPath: string,
): Promise<{
  packageName: string | null;
  packageVersion: string | null;
  agentDependencies: Record<string, string>;
} | null> {
  // agent.json lives at either:
  //   agents/<slug>/cinatra/agent.json  → package.json is ../../package.json (one up from cinatra/)
  //   agents/<slug>/agent.json          → package.json is ../package.json
  // dirname(agentJsonPath) joined with ".." / "package.json" handles the cinatra/ case.
  // For the flat case, the same path accidentally works because dirname is agents/<slug>/
  // and "..", "package.json" jumps up to agents/package.json (which doesn't exist) — so try
  // both candidates for robustness.
  const candidates = [
    join(dirname(agentJsonPath), "..", "package.json"), // cinatra/ layout
    join(dirname(agentJsonPath), "package.json"),       // flat layout
  ];
  for (const pkgPath of candidates) {
    try {
      const raw = await readFile(pkgPath, "utf8");
      const parsed = JSON.parse(raw) as {
        name?: unknown;
        version?: unknown;
        cinatra?: { agentDependencies?: Record<string, string> };
      };
      return {
        packageName: typeof parsed.name === "string" ? parsed.name : null,
        packageVersion: typeof parsed.version === "string" ? parsed.version : null,
        agentDependencies: parsed.cinatra?.agentDependencies ?? {},
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// `/api/llm-bridge` ApiNode injection
//
// The OAS bridge route reads `cinatra_llm` from each ApiNode's body
// to decide which provider/model/capability to honour at runtime. Authored
// OAS files never write that block by hand — they declare a single
// `metadata.cinatra.llm` at the root and rely on this compiler pass to fan
// it out to every bridge-targeting ApiNode (top-level AND any FlowNode-
// embedded subflow). When `metadata.cinatra.llm` is absent we intentionally
// inject nothing, preserving byte-for-byte back-compat for authored outputs
// without LLM metadata.
//
// The walker MUST recurse into Flow subflows reachable via
// FlowNode `subflow.$component_ref`. In the email-outreach-agent OAS, five
// Flow components live at `$referenced_components` next to the FlowNodes that
// reference them; each Flow has its OWN `$referenced_components` containing
// nested ApiNodes targeting `/api/llm-bridge`. Skipping the recursion silently
// strips the OAS's LLM preference for any branch routed through a subflow.
// ---------------------------------------------------------------------------

const LLM_BRIDGE_PATH = "/api/llm-bridge";
const INJECT_MAX_DEPTH = 16;

/**
 * Accepts:
 *   - "/api/llm-bridge"                       (exact relative form)
 *   - "{{CINATRA_BASE_URL}}/api/llm-bridge"   (template literal — current
 *                                              authored shape across all OAS
 *                                              files; verified against
 *                                              extensions/cinatra-ai/email-drafting-
 *                                              agent and email-outreach-agent)
 *   - any absolute URL ending in "/api/llm-bridge"
 *
 * The `-stream` variant is not supported because that route does not exist.
 */
function targetsLlmBridge(url: unknown): boolean {
  if (typeof url !== "string") return false;
  if (url === LLM_BRIDGE_PATH) return true;
  if (url.endsWith(`{{CINATRA_BASE_URL}}${LLM_BRIDGE_PATH}`)) return true;
  return url.endsWith(LLM_BRIDGE_PATH);
}

/**
 * Recursively walk an OAS Flow document and inject `cinatra_llm` into every
 * ApiNode whose `url` targets `/api/llm-bridge`. Mutates in place.
 *
 * Traversal contract:
 *   1. Visit every entry in `oas.$referenced_components`. For each entry
 *      where `component_type === "ApiNode"` and `targetsLlmBridge(entry.url)`,
 *      set `entry.data.cinatra_llm = { ...llmMetadata }` (fresh shallow clone
 *      per node so a runtime mutation in one ApiNode doesn't ripple).
 *   2. For every entry where `component_type === "Flow"` recurse into its own
 *      `$referenced_components` and apply the same rule. (Subflow components
 *      live at the same root level as the FlowNodes that reference them via
 *      `subflow.$component_ref`; their own `$referenced_components` carry the
 *      nested ApiNodes.)
 *   3. If a node already declares `data.cinatra_llm` (synthetic / hand-
 *      authored override) it is preserved — the injector is non-destructive.
 *
 * No-ops when `llmMetadata` is undefined to preserve existing compiled output.
 *
 * Throws an Error referencing the OAS-COMPILE family of failures when the
 * traversal exceeds INJECT_MAX_DEPTH levels. The current compile pipeline
 * uses string-based `{ ok: false, error }` returns rather than custom error
 * classes; the throw flows through `compileOasAgentJson`'s outer surface.
 */
export function injectCinatraLlmIntoApiNodes(
  compiledFlow: Record<string, unknown>,
  llmMetadata: OasCinatraLlm | undefined,
): void {
  if (llmMetadata === undefined) return;

  function visitContainer(
    container: Record<string, unknown> | undefined,
    depth: number,
  ): void {
    if (!container) return;
    if (depth > INJECT_MAX_DEPTH) {
      throw new Error(
        `injectCinatraLlmIntoApiNodes: traversal exceeded MAX_DEPTH=${INJECT_MAX_DEPTH}; possible pathological OAS input`,
      );
    }
    for (const [, entry] of Object.entries(container)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      const compType = node.component_type;

      if (compType === "ApiNode" && targetsLlmBridge(node.url)) {
        // Ensure `data` exists as an object before assignment — authored
        // ApiNodes always carry one, but a synthetic fixture without
        // `data` must not crash the walker.
        const data =
          (node.data && typeof node.data === "object"
            ? (node.data as Record<string, unknown>)
            : ((node.data = {}), node.data as Record<string, unknown>));
        if (data.cinatra_llm === undefined) {
          // Shallow clone of the metadata object so per-node mutation
          // does not ripple. The OasCinatraLlm shape is flat — three
          // optional string fields — so spread suffices.
          data.cinatra_llm = { ...llmMetadata };
        }
        continue;
      }

      if (compType === "Flow") {
        const nestedRefs = node.$referenced_components;
        if (nestedRefs && typeof nestedRefs === "object") {
          visitContainer(nestedRefs as Record<string, unknown>, depth + 1);
        }
      }
    }
  }

  const rootRefs = compiledFlow.$referenced_components;
  if (rootRefs && typeof rootRefs === "object") {
    visitContainer(rootRefs as Record<string, unknown>, 0);
  }
}

/**
 * Recursively walk an OAS Flow document
 * and propagate `metadata.cinatra.toolboxes` onto every bridge-targeting
 * ApiNode's `data.toolbox_ids`. Mirrors the traversal contract of
 * injectCinatraLlmIntoApiNodes (top-level + nested Flow components).
 *
 * Non-destructive: an existing `data.toolbox_ids` declaration wins (operator
 * override). Built-in tool names (`"web_search"`) and MCP IDs (`"cinatra-mcp"`,
 * external MCP server ids) coexist in the same list; the bridge route handler
 * partitions them at runtime.
 */
export function propagateToolboxesIntoApiNodes(
  compiledFlow: Record<string, unknown>,
  toolboxes: readonly string[],
): void {
  if (toolboxes.length === 0) return;

  function visitContainer(
    container: Record<string, unknown> | undefined,
    depth: number,
  ): void {
    if (!container) return;
    if (depth > INJECT_MAX_DEPTH) {
      throw new Error(
        `propagateToolboxesIntoApiNodes: traversal exceeded MAX_DEPTH=${INJECT_MAX_DEPTH}`,
      );
    }
    for (const [, entry] of Object.entries(container)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      const compType = node.component_type;

      if (compType === "ApiNode" && targetsLlmBridge(node.url)) {
        const data =
          (node.data && typeof node.data === "object"
            ? (node.data as Record<string, unknown>)
            : ((node.data = {}), node.data as Record<string, unknown>));
        if (data.toolbox_ids === undefined) {
          data.toolbox_ids = [...toolboxes];
        }
        continue;
      }

      if (compType === "Flow") {
        const nestedRefs = node.$referenced_components;
        if (nestedRefs && typeof nestedRefs === "object") {
          visitContainer(nestedRefs as Record<string, unknown>, depth + 1);
        }
      }
    }
  }

  const rootRefs = compiledFlow.$referenced_components;
  if (rootRefs && typeof rootRefs === "object") {
    visitContainer(rootRefs as Record<string, unknown>, 0);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CompiledAgentOasLlmConfig = {
  modelId: string;
  apiType?: "chat_completions" | "responses";
};

export type CompiledAgentOasToolbox = {
  id: string;
  url: string;
};

export type CompiledAgentOasConnectionConfig = {
  timeout: number;
  verify: boolean;
};

export type CompiledAgentOasStep = {
  // Runtime-neutral node-type discriminator. Defaults to
  // "agent" for AgentNode-derived steps and the StartNode setup step (which
  // is implicit and shares the agent execution path). InputMessageNode steps
  // compile to "input_message" with `inputMessageField`/`inputMessageSchema`
  // populated and `requiresApproval = true`.
  nodeType?: "agent" | "input_message";
  stepNumber: number;
  riskClass?: string;
  requiresApproval: boolean;
  // Author override for side-effects gating. When set, wins
  // over riskClass-based inference in collectGatedSteps. Optional; default is
  // to infer from riskClass via SIDE_EFFECT_PATTERNS.
  //   true  → step is gated regardless of riskClass match
  //   false → step is NOT gated even if riskClass matches a pattern (dry-run preview)
  //   undef → fall through to pattern matching
  sideEffects?: boolean;
  xRenderer?: string;
  description?: string;
  name?: string;
  a2uiSurfaceId?: string;
  hitlOwnedBy?: "childAgent" | "self";
  gateCount?: number;
  skipLlm?: boolean;
  childAgent?: {
    packageName: string;
    inputMapping: Record<string, string>;
  };
  connectionConfig?: CompiledAgentOasConnectionConfig;
  // InputMessageNode projection fields.
  inputMessageField?: string;
  inputMessageSchema?: Record<string, unknown>;
};

export type CompiledAgentOas = {
  approvalPolicy: { steps: CompiledAgentOasStep[] };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  prompt: string | null;
  packageName: string | null;
  packageVersion: string | null;
  agentDependencies: Record<string, string>;
  // Both legacy and OAS-aligned values pass through.
  type: "leaf" | "orchestrator" | "node" | "flow";
  compiledPlan: [];
  hitlScreens: string[];
  llmConfig: CompiledAgentOasLlmConfig | null;
  toolboxes: CompiledAgentOasToolbox[];
  // Open Agent Specification (OAS) format version this agent.json
  // declares (e.g. "26.1.0"). Surfaced from the top-level `agentspec_version`
  // field so downstream layers can stamp run-context provenance into objects.
  agentSpecVersion: string | null;
  // Object types declared inline on output ports via `outputs[*].cinatra`.
  // Undefined (NOT empty array) when no outputs carry a `cinatra` annotation —
  // use `?.length` guards. Consumers register each dynamic object type.
  producesObjectTypes?: Array<{
    typeId: string;
    displayName: string;
    category: "profile" | "content" | "project" | "idea" | "report";
    canonicalKeys?: string[];
    identityKey?: string;
  }>;
  // Trigger gate metadata. Persisted to
  // agent_templates.trigger_mode + agent_templates.gated_steps; read by
  // the runtime gate and UI. triggerMode is derived from
  // runtime classification: wayflow + cinatra-linear → "full" (statically
  // analyzable per-step), all others → "start-only" (conservative). For
  // "start-only", gatedSteps is always [] — the runtime cannot use them.
  triggerMode: TriggerMode;
  gatedSteps: GatedStep[];
  // Sibling cinatra.json metadata: per-agent limits,
  // required connection types, and authoring-time defaults. Operator-tunable
  // overrides will land on agent_install_settings DB table in a follow-up.
  // Null when no cinatra.json sits next to package.json.
  cinatraConfig: CinatraAgentConfig | null;
};

// Sibling `<agent>/cinatra.json` schema (lives next to
// package.json, NOT inside `<agent>/cinatra/` which holds OAS files).
export type CinatraAgentConfig = {
  limits?: { maxRecipients?: number };
  requiredConnections?: Array<{ type: string; preferred?: string }>;
  defaults?: { senderName?: string | null };
};

// Discriminated union eliminates mixed null/throw.
export type CompileOasResult =
  | { ok: true; value: CompiledAgentOas }
  | { ok: false; error: string };

// Exhaustive component_type list for steppable nodes. Adding a new
// component_type to the steppableNodeIds filter without a matching branch in
// the map body produces a compile-time `never` error.
const COMPONENT_TYPES_HANDLED = ["AgentNode", "InputMessageNode", "FlowNode", "TriggerWaitNode"] as const;
type HandledComponentType = (typeof COMPONENT_TYPES_HANDLED)[number];

function assertHandledComponentType(
  t: string,
  location: string,
): asserts t is HandledComponentType {
  if (!(COMPONENT_TYPES_HANDLED as readonly string[]).includes(t)) {
    throw new Error(
      `OAS compile error at ${location}: unhandled component_type "${t}". ` +
        `Update COMPONENT_TYPES_HANDLED + add a matching branch in the steppableNodeIds.map body.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main compile entry point
// ---------------------------------------------------------------------------

export async function compileOasAgentJson(opts: {
  packageName: string | null | undefined;
  registryPath?: string;
  agentJsonPath?: string;
  // Runtime classification override used by deriveTriggerMode
  // when the OAS itself does not declare `metadata.cinatra.runtime`. Falls back
  // to undefined → "full" (DESIGN.md default). Callers in mcp/handlers.ts may
  // pass the template's executionProvider so legacy/unannotated agents still
  // get the right triggerMode classification.
  executionProvider?: string;
}): Promise<CompileOasResult> {
  if (!opts.packageName) {
    return { ok: false, error: "packageName is required" };
  }

  // 1. Resolve agent.json path (with traversal guard)
  let agentJsonPath = opts.agentJsonPath ?? null;
  if (!agentJsonPath) {
    const candidates = resolveAgentJsonPath(opts.packageName);
    if (!candidates) {
      return {
        ok: false,
        error: `packageName ${opts.packageName} failed path-traversal guard`,
      };
    }
    for (const candidate of candidates) {
      try {
        await readFile(candidate, "utf8");
        agentJsonPath = candidate;
        break;
      } catch {
        // try next
      }
    }
    if (!agentJsonPath) {
      return {
        ok: false,
        error: `agent.json not found for ${opts.packageName} (tried ${candidates.join(", ")})`,
      };
    }
  }

  // 2. Load agent.json
  let raw: string;
  try {
    raw = await readFile(agentJsonPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `agent.json at ${agentJsonPath} could not be read: ${(err as Error).message}`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: `agent.json at ${agentJsonPath} is malformed JSON: ${(err as Error).message}`,
    };
  }

  // 3. Structural validation
  const structuralErrors = validateOasFlowStructural(parsed);
  if (structuralErrors.length > 0) {
    return {
      ok: false,
      error: `OAS agent.json structural validation failed for ${opts.packageName}:\n${structuralErrors.join("\n")}`,
    };
  }

  // Fan out `metadata.cinatra.llm` to every
  // `/api/llm-bridge`-targeting ApiNode at all nesting depths (top-level and
  // FlowNode-embedded subflows). No-op when `metadata.cinatra.llm` is absent
  // The mutation is on `parsed`; the on-disk persistence
  // is handled by the caller (mcp/handlers.ts:agent_source_compile) which
  // re-applies the same helper to its own parse before writing.
  {
    const llmMetadata = (parsed.metadata as
      | { cinatra?: { llm?: OasCinatraLlm } }
      | undefined)?.cinatra?.llm;
    injectCinatraLlmIntoApiNodes(parsed, llmMetadata);
  }

  // Fan out `metadata.cinatra.toolboxes`
  // onto every bridge-targeting ApiNode's `data.toolbox_ids`. Before this
  // pass, the declaration was dead metadata — the bridge defaulted
  // `body.toolbox_ids ?? ["cinatra-mcp"]` and an agent declaring
  // `toolboxes: ["web_search"]` got the full ~130-primitive Cinatra MCP
  // suite. Non-destructive: existing `data.toolbox_ids` overrides win.
  {
    const toolboxes = (parsed.metadata as
      | { cinatra?: { toolboxes?: unknown } }
      | undefined)?.cinatra?.toolboxes;
    if (Array.isArray(toolboxes) && toolboxes.every((t) => typeof t === "string")) {
      propagateToolboxesIntoApiNodes(parsed, toolboxes as string[]);
    }
  }

  // 4. Load registries
  const globalRegistry = await loadGlobalRegistry(opts.registryPath);
  const localRefs = (parsed.$referenced_components as Record<string, unknown>) ?? {};

  // 5. Topology: derive step order via BFS from StartNode following control_flow_connections
  //    (do NOT rely on parsed.nodes array index).
  const nodes = parsed.nodes as Array<{ "$component_ref": string }>;
  const arrayNodeIds = nodes.map((n) => n.$component_ref);
  const controlEdges = (parsed.control_flow_connections as Array<Record<string, unknown>>) ?? [];

  const adjacency = new Map<string, string[]>();
  for (const edge of controlEdges) {
    const e = edge as { from_node?: { $component_ref?: string }; to_node?: { $component_ref?: string } };
    const fromId = e.from_node?.$component_ref;
    const toId = e.to_node?.$component_ref;
    if (!fromId || !toId) continue;
    if (!adjacency.has(fromId)) adjacency.set(fromId, []);
    const neighbors = adjacency.get(fromId)!;
    // Deduplicate: if the same (from, to) edge appears twice, do not push the
    // target id twice — that wastes queue operations and can muddle step order
    // under edge-duplication (the visited-set still catches it, but only after
    // the duplicate has been drained).
    if (!neighbors.includes(toId)) neighbors.push(toId);
  }

  const startEntryId = (parsed.start_node as { $component_ref: string }).$component_ref;
  const nodeIds: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [startEntryId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    nodeIds.push(id);
    const next = adjacency.get(id) ?? [];
    for (const n of next) if (!visited.has(n)) queue.push(n);
  }
  // Safety: append any disconnected nodes in array order (structural validator should reject).
  for (const id of arrayNodeIds) if (!visited.has(id)) nodeIds.push(id);

  const nodeOrder = new Map<string, number>();
  nodeIds.forEach((id, idx) => nodeOrder.set(id, idx));

  // AgentNodes (excluding StartNode/EndNode) — 1-indexed stepNumber assignment.
  const agentNodeIds = nodeIds.filter((id) => {
    const comp = localRefs[id] as Record<string, unknown> | undefined;
    return comp?.component_type === "AgentNode";
  });

  // InputMessageNodes are also numbered HITL steps.
  const inputMessageNodeIds = nodeIds.filter((id) => {
    const comp = localRefs[id] as Record<string, unknown> | undefined;
    return comp?.component_type === "InputMessageNode";
  });

  // Derive EndNode by graph structure — do NOT use array.last.
  const endNodeId = nodeIds.find((id) => {
    const comp = localRefs[id] as Record<string, unknown> | undefined;
    return comp?.component_type === "EndNode";
  });
  if (!endNodeId) {
    return {
      ok: false,
      error: `flow has no EndNode (expected exactly one node with component_type: "EndNode")`,
    };
  }

  // 6. Build approvalPolicy.steps — StartNode step 0 (inferred) + one per AgentNode.
  const dataFlowEdges = (parsed.data_flow_connections as Array<Record<string, unknown>>) ?? [];

  // Step 0: StartNode is an implied HITL checkpoint when it has visible required inputs.
  // Inferred from the node's own inputs + metadata.cinatra.required/hidden — no new fields.
  const _sn = localRefs[startEntryId] as
    | { name?: string; metadata?: { cinatra?: { required?: string[]; hidden?: string[] } } }
    | undefined;
  const _snReq = (_sn?.metadata?.cinatra?.required ?? []) as string[];
  const _snHid = (_sn?.metadata?.cinatra?.hidden ?? []) as string[];
  const startNodeStep: CompiledAgentOasStep | null = _snReq.some((f) => !_snHid.includes(f))
    ? {
        stepNumber: 0,
        name: _sn?.name ?? "Setup",
        description: _sn?.name ?? "Setup",
        requiresApproval: true,
        riskClass: "read_only",
        hitlOwnedBy: "self",
        skipLlm: true,
      }
    : null;

  // Build the steppable-node sequence in BFS order, mixing
  // AgentNodes and InputMessageNodes. Both contribute to stepNumber so their
  // ordering reflects the graph topology. InputMessageNodes are validated
  // (must have at least one output) before reaching this block.
  // ApiNode is intentionally excluded here: WayFlow calls it directly at runtime
  // without Cinatra approval-policy involvement. Only AgentNode (A2A child agents)
  // and InputMessageNode (HITL gates) produce Cinatra approval steps.
  const steppableNodeIds: string[] = nodeIds.filter((id) => {
    const comp = localRefs[id] as Record<string, unknown> | undefined;
    return (
      comp?.component_type === "AgentNode" ||
      comp?.component_type === "InputMessageNode" ||
      comp?.component_type === "FlowNode"
    );
  });
  // Validate InputMessageNodes: must have outputs[0]; throw OasCompileError-style
  // surface; errors flow through the discriminated result.
  for (const id of inputMessageNodeIds) {
    const comp = localRefs[id] as { outputs?: unknown } | undefined;
    if (!Array.isArray(comp?.outputs) || (comp!.outputs as unknown[]).length === 0) {
      return {
        ok: false,
        error: `MISSING_INPUT_MESSAGE_OUTPUT: InputMessageNode "${id}" must declare at least one output`,
      };
    }
  }

  // Pre-expand steppableNodeIds so FlowNodes that declare gateSteps produce one
  // logical entry per gate rather than one per node. The inner map below stays
  // a plain .map() — expansion happens here so step numbering is simply idx+1.
  type GateStepMeta = { name?: string; description?: string; renderer?: string; hitlOwnedBy?: string; gateCount?: number; requiresApproval?: boolean; riskClass?: string };
  const expandedEntries: Array<{ id: string; gateStep?: GateStepMeta }> = steppableNodeIds.flatMap((id) => {
    const comp = localRefs[id] as { component_type?: string; metadata?: { cinatra?: { gateSteps?: unknown[] } } } | undefined;
    if (comp?.component_type === "FlowNode") {
      const raw = comp?.metadata?.cinatra?.gateSteps;
      if (Array.isArray(raw) && raw.length > 0) {
        return (raw as GateStepMeta[]).map((gs) => ({ id, gateStep: gs }));
      }
    }
    return [{ id }];
  });

  const agentSteps: CompiledAgentOasStep[] = expandedEntries.map(({ id, gateStep }, idx) => {
    const stepNumber = idx + 1;
    const compType = (localRefs[id] as { component_type?: string } | undefined)
      ?.component_type;
    // Assign to a new const before asserting so TypeScript can narrow
    // the const (the original `compType` is `string | undefined` and cannot be
    // narrowed by an assertion on the expression `compType ?? "<missing>"`).
    const handledCompType = compType ?? "<missing>";
    assertHandledComponentType(handledCompType, `node "${id}"`);

    // ----- InputMessageNode branch -----
    if (handledCompType === "InputMessageNode") {
      const ime = localRefs[id] as {
        name?: string;
        outputs?: Array<{ id?: string; title?: string }>;
        inputs?: Array<{ id?: string; schema?: Record<string, unknown> }>;
        metadata?: { cinatra?: { description?: string; inputRenderers?: Record<string, string>; renderer?: string; inputMessageSchema?: Record<string, unknown> } };
      };
      const out0 = ime.outputs?.[0] ?? {};
      const field = out0.title ?? out0.id ?? id;
      const declaredSchema = ime.metadata?.cinatra?.inputMessageSchema ?? ime.inputs?.[0]?.schema;
      const inputSchema: Record<string, unknown> =
        declaredSchema && Object.keys(declaredSchema).length > 0
          ? declaredSchema
          : { type: "object" };
      const renderer =
        ime.metadata?.cinatra?.inputRenderers?.[field] ??
        ime.metadata?.cinatra?.renderer ??
        SCHEMA_FIELD_FALLBACK_RENDERER_ID;
      return {
        nodeType: "input_message",
        stepNumber,
        requiresApproval: true,
        riskClass: "read_only",
        hitlOwnedBy: "self",
        skipLlm: true,
        name: ime.name ?? field,
        description: ime.metadata?.cinatra?.description ?? ime.name ?? field,
        xRenderer: renderer,
        inputMessageField: field,
        inputMessageSchema: inputSchema,
      };
    }

    // ----- AgentNode branch -----
    // Wrapping the
    // AgentNode body in an explicit `if (handledCompType === "AgentNode")`
    // block lets the never-guard below narrow `handledCompType` to `never`,
    // which fails compilation if a future entry is added to
    // COMPONENT_TYPES_HANDLED without a matching branch here.
    if (handledCompType === "AgentNode") {
      const node = localRefs[id] as {
        name?: string;
        metadata?: { cinatra?: Record<string, unknown> };
        agent?: { $component_ref?: string };
      };
      const parentCinatra = node.metadata?.cinatra; // AgentNode's own metadata
      const agentRef = node.agent?.$component_ref;

      // Resolve the referenced Agent/A2AAgent. Leaf agent.json files back their
      // AgentNode with an Agent (no UI metadata); orchestrator agent.json files
      // back each AgentNode with an A2AAgent whose metadata.cinatra carries the
      // leaf-default renderer/requiresApproval/riskClass/a2uiSurfaceId/packageName.
      let resolvedAgent: Record<string, unknown> | null = null;
      if (agentRef) {
        try {
          resolvedAgent = resolveComponentRef(agentRef, localRefs, globalRegistry, new Set());
        } catch {
          // unresolved — leave null; merge falls through to parentCinatra
        }
      }
      const leafCinatra = (resolvedAgent as { metadata?: { cinatra?: Record<string, unknown> } } | null)
        ?.metadata?.cinatra;

      const effective = mergeParentLeafCinatra(parentCinatra, leafCinatra);

      // Build childAgent field when the resolved backing is an A2AAgent.
      let childAgent: { packageName: string; inputMapping: Record<string, string> } | undefined;
      if (
        resolvedAgent &&
        (resolvedAgent as { component_type?: string }).component_type === "A2AAgent"
      ) {
        const childPackageName =
          ((resolvedAgent as { metadata?: { cinatra?: { packageName?: string } } })
            .metadata?.cinatra?.packageName as string | undefined) ?? "";
        const inputMapping: Record<string, string> = {};
        for (const edge of dataFlowEdges) {
          const e = edge as {
            source_node: { $component_ref: string };
            source_output: string;
            destination_node: { $component_ref: string };
            destination_input: string;
          };
          if (e.destination_node?.$component_ref !== id) continue;
          const srcId = e.source_node.$component_ref;
          const srcComp = localRefs[srcId] as { component_type?: "StartNode" | "AgentNode" | "EndNode" } | undefined;
          const srcType = (srcComp?.component_type ?? "AgentNode") as "StartNode" | "AgentNode" | "EndNode";
          const srcIdx = srcType === "StartNode" ? -1 : (nodeOrder.get(srcId) ?? -1);
          const destIdx = nodeOrder.get(id) ?? -1;
          inputMapping[e.destination_input] = deriveInputMappingTemplateVar({
            sourceNodeId: srcId,
            sourceOutput: e.source_output,
            sourceNodeType: srcType,
            sourceNodeIndex: srcIdx,
            destinationNodeIndex: destIdx,
          });
        }
        childAgent = { packageName: childPackageName, inputMapping };
      }

      const step: CompiledAgentOasStep = {
        nodeType: "agent",
        stepNumber,
        requiresApproval: (effective.requiresApproval as boolean | undefined) ?? false,
        description:
          (parentCinatra?.description as string | undefined) ?? node.name,
        name: node.name,
      };
      if (effective.riskClass !== undefined) step.riskClass = effective.riskClass;
      if (effective.renderer !== undefined) step.xRenderer = effective.renderer;
      if (effective.a2uiSurfaceId !== undefined) step.a2uiSurfaceId = effective.a2uiSurfaceId;
      if (effective.hitlOwnedBy !== undefined) step.hitlOwnedBy = effective.hitlOwnedBy;
      if (childAgent) step.childAgent = childAgent;
      return step;
    }

    // ----- FlowNode branch: local subflow composition -----
    // FlowNode is the agent-spec primitive that embeds a Flow as a step. The
    // runtime class is FlowExecutionStep (wayflowcore.steps). Unlike AgentNode,
    // there is no leaf A2AAgent to merge — metadata.cinatra is authoritative
    // and the packageName is read directly from parentCinatra.
    if (handledCompType === "FlowNode") {
      const node = localRefs[id] as {
        name?: string;
        metadata?: { cinatra?: Record<string, unknown> };
        subflow?: { $component_ref?: string };
      };
      const parentCinatra = node.metadata?.cinatra;
      // No leaf to merge — pass undefined and let the merge function project
      // parentCinatra fields through the same 5-key surface as AgentNode.
      const effective = mergeParentLeafCinatra(parentCinatra, undefined);

      // Build inputMapping from data_flow_connections targeting this FlowNode.
      // Same logic as the AgentNode arm.
      const inputMapping: Record<string, string> = {};
      for (const edge of dataFlowEdges) {
        const e = edge as {
          source_node: { $component_ref: string };
          source_output: string;
          destination_node: { $component_ref: string };
          destination_input: string;
        };
        if (e.destination_node?.$component_ref !== id) continue;
        const srcId = e.source_node.$component_ref;
        const srcComp = localRefs[srcId] as {
          component_type?: "StartNode" | "AgentNode" | "EndNode" | "FlowNode";
        } | undefined;
        const srcType = (srcComp?.component_type === "StartNode"
          ? "StartNode"
          : "AgentNode") as "StartNode" | "AgentNode" | "EndNode";
        const srcIdx = srcType === "StartNode" ? -1 : (nodeOrder.get(srcId) ?? -1);
        const destIdx = nodeOrder.get(id) ?? -1;
        inputMapping[e.destination_input] = deriveInputMappingTemplateVar({
          sourceNodeId: srcId,
          sourceOutput: e.source_output,
          sourceNodeType: srcType,
          sourceNodeIndex: srcIdx,
          destinationNodeIndex: destIdx,
        });
      }

      const childPackageName =
        (parentCinatra?.packageName as string | undefined) ?? "";
      const childAgent = { packageName: childPackageName, inputMapping };

      const step: CompiledAgentOasStep = {
        nodeType: "agent",
        stepNumber,
        requiresApproval: (effective.requiresApproval as boolean | undefined) ?? false,
        description: (parentCinatra?.description as string | undefined) ?? node.name,
        name: node.name,
        childAgent,
      };
      // When a gateStep override is provided (from pre-expanded gateSteps), use
      // its properties instead of the FlowNode's own metadata.cinatra fields.
      if (gateStep) {
        if (gateStep.name) { step.name = gateStep.name; step.description = gateStep.description ?? gateStep.name; }
        if (gateStep.riskClass !== undefined) step.riskClass = gateStep.riskClass;
        if (gateStep.renderer !== undefined) step.xRenderer = gateStep.renderer;
        if (gateStep.hitlOwnedBy !== undefined) step.hitlOwnedBy = gateStep.hitlOwnedBy as "childAgent" | "self";
        if (gateStep.gateCount !== undefined) step.gateCount = gateStep.gateCount;
        if (gateStep.requiresApproval !== undefined) step.requiresApproval = gateStep.requiresApproval;
        if (effective.a2uiSurfaceId !== undefined) step.a2uiSurfaceId = effective.a2uiSurfaceId;
        return step;
      }

      if (effective.riskClass !== undefined) step.riskClass = effective.riskClass;
      if (effective.renderer !== undefined) step.xRenderer = effective.renderer;
      if (effective.a2uiSurfaceId !== undefined) step.a2uiSurfaceId = effective.a2uiSurfaceId;
      if (effective.hitlOwnedBy !== undefined) step.hitlOwnedBy = effective.hitlOwnedBy;
      else step.hitlOwnedBy = "childAgent";

      // Derive renderer + riskClass from the child's own OAS when the parent
      // FlowNode doesn't redeclare them. Child self-contained: parent only
      // needs packageName.
      if (!step.xRenderer && childPackageName) {
        const derived = readChildOasRendererInfo(childPackageName);
        if (derived?.renderer) step.xRenderer = derived.renderer;
        if (derived?.riskClass && step.riskClass === undefined) step.riskClass = derived.riskClass;
      }

      return step;
    }

    // ----- TriggerWaitNode branch -----
    // OAS-native primitive for in-flight trigger pause. There is no native
    // OAS Wait/Schedule primitive in 26.1.0 — this is a
    // Cinatra extension recognized by the compiler + WayFlow Python executor
    // (docker/wayflow/cinatra_executors/trigger_wait.py).
    //
    // Runtime contract: when WayFlow encounters a TriggerWaitNode it yields
    // with task_state="input-required" + metadata.cinatra.resumeSource=
    // "trigger-release". The TS worker detects
    // the marker, persists a row in agent_run_trigger_waits, and transitions
    // the run from `running` → `waiting_trigger`. trigger-release-job later
    // resumes by sending an A2A message into the held a2aContextId.
    if (handledCompType === "TriggerWaitNode") {
      const node = localRefs[id] as {
        name?: string;
        outputs?: Array<{ id?: string; title?: string }>;
        metadata?: { cinatra?: Record<string, unknown> };
      };
      const meta = node.metadata?.cinatra ?? {};
      return {
        nodeType: "input_message", // closest existing nodeType — TriggerWaitNode is also a pause primitive
        stepNumber,
        requiresApproval: false, // trigger-released, not human-approved
        riskClass: "read_only",
        hitlOwnedBy: "self",
        skipLlm: true,
        name: node.name ?? "Wait for trigger",
        description:
          (meta.description as string | undefined) ??
          node.name ??
          "Wait for scheduled trigger to fire",
        xRenderer:
          (meta.renderer as string | undefined) ??
          TRIGGER_WAIT_STATUS_RENDERER_ID,
      };
    }

    // Exhaustiveness check. assertHandledComponentType narrowed
    // handledCompType to "AgentNode" | "InputMessageNode" | "FlowNode" |
    // "TriggerWaitNode"; all arms above return, so this assignment is
    // unreachable. If a future entry is added to COMPONENT_TYPES_HANDLED
    // without a matching `if` branch, TypeScript will flag the assignment
    // to `never`. NOTE: use handledCompType (string narrowed to
    // HandledComponentType), NOT compType (still string | undefined —
    // assigning it to `never` would always error). Do NOT replace this
    // with `as never` — that would silence the exhaustiveness check.
    const _exhaustive: never = handledCompType;
    throw new Error(`unreachable: unhandled component_type "${String(_exhaustive)}"`);
  });

  const steps: CompiledAgentOasStep[] = startNodeStep
    ? [startNodeStep, ...agentSteps]
    : agentSteps;

  // 7. Reconstruct inputSchema
  const startRef = (parsed.start_node as { $component_ref: string }).$component_ref;
  const startNode = localRefs[startRef] as
    | {
        inputs?: Array<{ title: string; type: string; format?: string; description?: string; items?: unknown; json_schema?: { items?: unknown } }>;
        metadata?: {
          cinatra?: {
            required?: string[];
            hidden?: string[];
            inputRenderers?: Record<string, string>;
            inputTitles?: Record<string, string>;
            inputDataSources?: Record<string, string>;  // parallel to inputRenderers
          };
        };
      }
    | undefined;
  const startInputs = startNode?.inputs ?? [];
  const startRequired = startNode?.metadata?.cinatra?.required ?? [];
  const startHidden = startNode?.metadata?.cinatra?.hidden ?? [];
  const startRenderers = startNode?.metadata?.cinatra?.inputRenderers ?? {};
  const startDataSources = startNode?.metadata?.cinatra?.inputDataSources ?? {};
  const startInputTitles = startNode?.metadata?.cinatra?.inputTitles ?? {};
  const inputSchemaProperties: Record<string, unknown> = {};
  for (const prop of startInputs) {
    const { title, type, format, description } = prop;
    // `items` may live at the top level of the input definition OR nested
    // under `json_schema.items` (the agentspec 26.1.0 convention — see
    // contact-discovery-agent + apollo-prospecting-agent OAS files). Without
    // this fallback the compiled `inputSchema` declares arrays without
    // `items`, which OpenAI structured-output then rejects with
    // `400 array schema missing items` (observed live in the autonomous
    // chat campaign — Apollo prospecting silently dispatched with empty
    // inputParams and stuck in pending_approval).
    const items = prop.items ?? prop.json_schema?.items;
    // title is the field identifier (camelCase); inputTitles maps it to a human-readable label.
    const displayTitle = startInputTitles[title] ?? title;
    const propShape: Record<string, unknown> = { type, title: displayTitle };
    if (format) propShape.format = format;
    if (description) propShape.description = description;
    if (items) propShape.items = items;
    if (startRenderers[title]) propShape["x-renderer"] = startRenderers[title];
    if (startDataSources[title]) propShape["x-data-source"] = startDataSources[title];
    if (startHidden.includes(title)) propShape["x-hidden"] = true;
    inputSchemaProperties[title] = propShape;
  }
  const inputSchema: Record<string, unknown> = {
    type: "object",
    required: startRequired,
    properties: inputSchemaProperties,
  };

  // 8. Derive outputSchema — use graph-derived EndNode id.
  const endNode = localRefs[endNodeId] as
    | { outputs?: Array<{ title: string; type: string; format?: string; description?: string; items?: unknown; json_schema?: { items?: unknown } }> }
    | undefined;
  const endOutputs = endNode?.outputs ?? [];
  let outputSchema: Record<string, unknown> | null = null;
  if (endOutputs.length > 0) {
    const endProps: Record<string, unknown> = {};
    for (const prop of endOutputs) {
      const { title, type, format, description } = prop;
      // Same fallback as startInputs above — outputs follow the same
      // agentspec convention (`json_schema.items` or top-level `items`).
      const items = prop.items ?? prop.json_schema?.items;
      const shape: Record<string, unknown> = { type, title };
      if (format) shape.format = format;
      if (description) shape.description = description;
      if (items) shape.items = items;
      endProps[title] = shape;
    }
    outputSchema = { type: "object", properties: endProps };
  }

  // 9. Resolve Agent.system_prompt
  let prompt: string | null = null;
  for (const id of agentNodeIds) {
    const node = localRefs[id] as { agent?: { $component_ref?: string } };
    const agentRef = node?.agent?.$component_ref;
    if (!agentRef) continue;
    const agent = localRefs[agentRef] as
      | { component_type?: string; system_prompt?: string }
      | undefined;
    if (!agent) continue;
    if (agent.component_type === "Agent" && typeof agent.system_prompt === "string") {
      prompt = agent.system_prompt;
      break;
    }
  }

  // 12. Resolve Agent.llm_config — "first Agent wins" mirrors block 9 (prompt).
  //     Accepts either inline OpenAiConfig or $component_ref to local/global.
  let llmConfig: CompiledAgentOasLlmConfig | null = null;
  for (const id of agentNodeIds) {
    const node = localRefs[id] as { agent?: { $component_ref?: string } };
    const agentRef = node?.agent?.$component_ref;
    if (!agentRef) continue;
    let agent: Record<string, unknown> | null = null;
    try {
      agent = resolveComponentRef(agentRef, localRefs, globalRegistry, new Set());
    } catch {
      continue;
    }
    if ((agent as { component_type?: string }).component_type !== "Agent") continue;
    const rawCfg = (agent as { llm_config?: unknown }).llm_config;
    if (!rawCfg || typeof rawCfg !== "object") continue;
    let cfg: Record<string, unknown> | null = null;
    if ("$component_ref" in rawCfg) {
      try {
        cfg = resolveComponentRef(
          (rawCfg as { $component_ref: string }).$component_ref,
          localRefs,
          globalRegistry,
          new Set(),
        );
      } catch {
        cfg = null;
      }
    } else {
      cfg = rawCfg as Record<string, unknown>;
    }
    if (!cfg) continue;
    const modelId = (cfg as { model_id?: unknown }).model_id;
    if (typeof modelId !== "string") continue;
    const apiType = (cfg as { api_type?: unknown }).api_type;
    llmConfig = {
      modelId,
      apiType:
        apiType === "chat_completions" || apiType === "responses"
          ? apiType
          : undefined,
    };
    break;
  }

  // 13. Resolve Agent.toolboxes — "first Agent wins" mirrors block 12.
  //     Each toolbox entry may be inline MCPToolBox or $component_ref.
  let toolboxes: CompiledAgentOasToolbox[] = [];
  for (const id of agentNodeIds) {
    const node = localRefs[id] as { agent?: { $component_ref?: string } };
    const agentRef = node?.agent?.$component_ref;
    if (!agentRef) continue;
    let agent: Record<string, unknown> | null = null;
    try {
      agent = resolveComponentRef(agentRef, localRefs, globalRegistry, new Set());
    } catch {
      continue;
    }
    if ((agent as { component_type?: string }).component_type !== "Agent") continue;
    const rawList = (agent as { toolboxes?: unknown }).toolboxes;
    if (!Array.isArray(rawList) || rawList.length === 0) continue;
    const resolvedToolboxes: CompiledAgentOasToolbox[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== "object") continue;
      let tb: Record<string, unknown> | null = null;
      if ("$component_ref" in entry) {
        try {
          tb = resolveComponentRef(
            (entry as { $component_ref: string }).$component_ref,
            localRefs,
            globalRegistry,
            new Set(),
          );
        } catch {
          tb = null;
        }
      } else {
        tb = entry as Record<string, unknown>;
      }
      if (!tb) continue;
      if ((tb as { component_type?: string }).component_type !== "MCPToolBox") continue;
      const tbId = (tb as { id?: unknown }).id;
      const transport = (tb as { client_transport?: Record<string, unknown> }).client_transport;
      const tbUrl = transport?.url;
      if (typeof tbId !== "string" || typeof tbUrl !== "string") continue;
      resolvedToolboxes.push({ id: tbId, url: tbUrl });
    }
    if (resolvedToolboxes.length > 0) {
      toolboxes = resolvedToolboxes;
      break;
    }
  }

  // 14. Resolve per-step connectionConfig for A2AAgent-backed AgentNodes.
  //     Mutates the existing `steps` array in place (built at block 6).
  //     Self-hosted AgentNodes (Agent backing) leave step.connectionConfig undefined.
  // `steps` mixes AgentNode and InputMessageNode entries,
  // so we walk `expandedEntries` (which mirrors `agentSteps` 1-to-1) instead of
  // indexing `agentNodeIds` directly. The StartNode setup step (when present)
  // is prepended LATER, so expandedEntries[i] still aligns with agentSteps[i].
  for (let i = 0; i < agentSteps.length; i++) {
    const agentNodeId = expandedEntries[i]?.id ?? steppableNodeIds[i];
    const node = localRefs[agentNodeId] as
      | { agent?: { $component_ref?: string }; component_type?: string }
      | undefined;
    if (node?.component_type !== "AgentNode") continue;
    const agentRef = node?.agent?.$component_ref;
    if (!agentRef) continue;
    let resolvedAgent: Record<string, unknown> | null = null;
    try {
      resolvedAgent = resolveComponentRef(agentRef, localRefs, globalRegistry, new Set());
    } catch {
      continue;
    }
    if ((resolvedAgent as { component_type?: string }).component_type !== "A2AAgent") continue;
    const rawCc = (resolvedAgent as { connection_config?: unknown }).connection_config;
    if (!rawCc || typeof rawCc !== "object") continue;
    let cc: Record<string, unknown> | null = null;
    if ("$component_ref" in rawCc) {
      try {
        cc = resolveComponentRef(
          (rawCc as { $component_ref: string }).$component_ref,
          localRefs,
          globalRegistry,
          new Set(),
        );
      } catch {
        cc = null;
      }
    } else {
      cc = rawCc as Record<string, unknown>;
    }
    if (!cc) continue;
    const timeout = (cc as { timeout?: unknown }).timeout;
    const verify = (cc as { verify?: unknown }).verify;
    if (typeof timeout !== "number" || typeof verify !== "boolean") continue;
    agentSteps[i].connectionConfig = { timeout, verify };
  }

  // 10. Load sibling package.json
  const sibling = await readSiblingPackageJson(agentJsonPath);
  const cinatraConfig = await readSiblingCinatraJson(agentJsonPath);

  // 11. Flow-level metadata
  const flowCinatra = (parsed.metadata as { cinatra: { type: "leaf" | "orchestrator" | "flow" | "node"; hitlScreens?: string[] } })
    .cinatra;

  // Surface the OAS format version so downstream layers can stamp
  // it onto objects saved during agent runs.
  const agentSpecVersion =
    typeof parsed.agentspec_version === "string" ? parsed.agentspec_version : null;

  // Extract inline cinatra annotations from output ports.
  // Namespace check is a domain rule applied here; Zod enforces field shape upstream.
  // When no outputs carry a `cinatra` annotation, `producesObjectTypes` remains `undefined`
  // (NOT empty array) — backward-compat invariant: callers use `?.length` guards.
  type RawOutputPort = {
    title: string;
    cinatra?: {
      object_type: string;
      display_name?: string;
      category?: "profile" | "content" | "project" | "idea" | "report";
      canonical_keys?: string[];
      identity_key?: string;
    };
  };
  const annotatedOutputs = ((parsed.outputs ?? []) as RawOutputPort[]).filter(
    (o) => o.cinatra?.object_type,
  );

  let producesObjectTypes: CompiledAgentOas["producesObjectTypes"];
  if (annotatedOutputs.length > 0) {
    for (const output of annotatedOutputs) {
      const typeId = output.cinatra!.object_type;
      if (!OBJECT_TYPE_NAMESPACE_RE.test(typeId)) {
        return {
          ok: false,
          error: `outputs[${output.title}].cinatra.object_type "${typeId}" must match @scope/package:local-id`,
        };
      }
    }
    producesObjectTypes = annotatedOutputs.map((o) => ({
      typeId: o.cinatra!.object_type,
      displayName: o.cinatra!.display_name ?? o.title,
      category: o.cinatra!.category ?? "report",
      canonicalKeys: o.cinatra!.canonical_keys,
      identityKey: o.cinatra!.identity_key,
    }));
  }

  // Derive triggerMode from runtime + collect gated steps
  // from approvalPolicy.steps[]. Output is persisted on the compiled root and
  // consumed by the trigger gate and UI.
  //
  // Runtime resolution order:
  //   1. parsed.metadata?.cinatra?.runtime  (explicit OAS metadata)
  //   2. opts.executionProvider              (caller-supplied fallback)
  //   3. undefined                            (deriveTriggerMode → "full")
  //
  // For triggerMode === "start-only", gatedSteps is forced to [] — even if
  // internal steps have side-effect riskClass values, the runtime cannot use
  // them.
  const runtimeForGate: string | undefined =
    (parsed.metadata as { cinatra?: { runtime?: string } } | undefined)?.cinatra?.runtime
    ?? opts.executionProvider
    ?? undefined;
  const triggerMode: TriggerMode = deriveTriggerMode(runtimeForGate);
  const gatedSteps: GatedStep[] = triggerMode === "full"
    ? collectGatedSteps({
        packageName: sibling?.packageName ?? null,
        approvalPolicy: { steps },
      } as InferenceCompiledOas)
    : [];

  return {
    ok: true,
    value: {
      approvalPolicy: { steps },
      inputSchema,
      outputSchema,
      prompt,
      packageName: sibling?.packageName ?? null,
      packageVersion: sibling?.packageVersion ?? null,
      agentDependencies: sibling?.agentDependencies ?? {},
      type: flowCinatra.type,
      compiledPlan: [],
      hitlScreens: flowCinatra.hitlScreens ?? [],
      llmConfig,
      toolboxes,
      agentSpecVersion,
      producesObjectTypes,
      triggerMode,
      gatedSteps,
      // sibling cinatra.json
      cinatraConfig,
    },
  };
}
