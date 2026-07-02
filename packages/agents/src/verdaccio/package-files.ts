import type { AgentTemplateRecord, AgentVersionRecord } from "../store";
import type { VerdaccioConfig } from "./config";
import {
  AGENT_PACKAGE_FORMAT_VERSION,
  CINATRA_AGENT_MANIFEST_VERSION,
  CINATRA_AGENT_PACKAGE_TYPE,
  type AgentPackageManifest,
  type AgentPackagePayload,
  type CinatraAgentPackageMetadata,
  agentPackageRiskLevelSchema,
  parseAgentPackageManifest,
  parseAgentPackagePayload,
} from "./package-contract";

export type BuildAgentPackageInput = {
  template: AgentTemplateRecord;
  version: AgentVersionRecord;
  semver: string;
  title: string;
  description?: string | null;
  changelog?: string | null;
  riskLevel: "low" | "medium" | "high" | "critical";
  toolAccess: string[];
  hasApprovalGates: boolean;
  agentDependencies?: Record<string, string>;
  publishedAt?: Date;
  /**
   * Canonical package name read from the agent's `package.json#name`
   * or composed by the caller. When omitted, falls back to the legacy
   * scope-templating behavior using `config.packageScope` and a slugified
   * template name. New callers MUST supply this; the fallback is retained
   * only for backward compatibility with legacy publish paths.
   */
  packageName?: string;
};

export type AgentPackageFiles = {
  packageName: string;
  packageVersion: string;
  manifest: AgentPackageManifest;
  payload: AgentPackagePayload;
  files: {
    "package.json": string;
    "agent.json": string;
    "README.md": string;
    // Synthesized OAS Flow document. Post-engineering#378 the installer
    // (buildAgentTemplateInstallSeed) seeds the agent_templates row strictly
    // from this file and THROWS when it is absent. publishAgentPackage works
    // purely from the DB template (no authored OAS on disk), so we synthesize a
    // structurally-valid OAS that round-trips through compileOasAgentJson.
    "cinatra/oas.json": string;
  };
};

function slugifyPackageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeToolAccess(toolAccess: string[]): string[] {
  return [...new Set(toolAccess.map((value) => value.trim()).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// Synthesized cinatra/oas.json (engineering#420)
// ---------------------------------------------------------------------------
//
// Synthesize a structurally-valid OAS Flow document from the DB
// AgentTemplateRecord so publishAgentPackage (the chat "save & publish" path,
// which works purely from the DB template — there is NO authored OAS on disk
// for a freshly-saved-but-not-installed agent) emits a package the post-
// engineering#378 installer can seed. The installer
// (buildAgentTemplateInstallSeed) now seeds the agent_templates row STRICTLY
// from cinatra/oas.json + package.json#cinatra and THROWS when the OAS is
// absent, so an OAS-less package is non-installable.
//
// Kept inline in this module (not a separate file) deliberately: a new module
// would add one node to the first-party import graph reachable from /api/a2a,
// /api/llm-bridge, /api/mcp and /chat, tripping the route-graph-ratchet dev-
// perf budget. Inlining adds zero modules.
//
// Fidelity contract (what the installer reads back, see oas-compiler.ts):
//   - root `sourceNl`          → seed.sourceNl
//   - Agent.system_prompt      → compiled.prompt → seed.taskSpec
//   - StartNode.inputs (+ metadata.cinatra.required/hidden/inputRenderers)
//                              → compiled.inputSchema → seed.inputSchema
//   - EndNode.outputs          → compiled.outputSchema → seed.outputSchema
//   - metadata.cinatra.type    → compiled.type → seed.type

const OAS_AGENTSPEC_VERSION = "26.1.0";

/**
 * Map the 8-value template `type` enum onto the 4 values the OAS Flow schema
 * (oas-compiler.ts `flowSchema.metadata.cinatra.type`) accepts. The OAS Flow
 * document is a WayFlow artifact and only models leaf / orchestrator / node /
 * flow topologies; proxy / parallel / supervisor / iterative agents collapse
 * onto their closest WayFlow-runnable equivalent so the synthesized doc stays
 * structurally valid. leaf/node/flow/orchestrator pass through unchanged.
 *
 * NOTE: `compileOasAgentJson` reads this back as `compiled.type`, which
 * `buildAgentTemplateInstallSeed.canonicalizeType` prefers over the manifest
 * `cinatra.type`. The manifest still carries the ORIGINAL template type
 * (buildAgentMetadata emits `template.type ?? "leaf"`), so the package metadata
 * preserves the authored subtype even though the seeded row canonicalizes.
 */
function toOasFlowType(
  type: AgentTemplateRecord["type"],
): "leaf" | "orchestrator" | "node" | "flow" {
  switch (type) {
    case "orchestrator":
    case "node":
    case "flow":
    case "leaf":
      return type;
    case "parallel":
    case "supervisor":
    case "iterative":
      // Multi-child coordination shapes → orchestrator (the OAS topology that
      // models fan-out/delegation). The manifest retains the precise subtype.
      return "orchestrator";
    case "proxy":
    default:
      // proxy + any unknown future enum value → leaf (single-agent execution).
      return "leaf";
  }
}

type OasProperty = {
  title: string;
  type: string;
  format?: string;
  description?: string;
  items?: unknown;
};

/**
 * Reverse a JSON-Schema-shaped object (the template's `inputSchema` /
 * `outputSchema`: `{ type:"object", required?:[], properties:{ field:{...} } }`)
 * into the OAS port array shape (`Array<{ title, type, ... }>`) the compiler's
 * StartNode/EndNode readers consume.
 *
 * Per-field `x-renderer` / `x-hidden` are lifted back into the StartNode
 * `metadata.cinatra.inputRenderers` / `hidden` maps so the compiled
 * inputSchema reproduces them (the compiler re-emits `x-renderer`/`x-hidden`
 * from those metadata maps, not from the raw port).
 */
function reverseSchemaToPorts(schema: Record<string, unknown> | null | undefined): {
  ports: OasProperty[];
  required: string[];
  hidden: string[];
  inputRenderers: Record<string, string>;
} {
  const ports: OasProperty[] = [];
  const hidden: string[] = [];
  const inputRenderers: Record<string, string> = {};
  if (!schema || typeof schema !== "object") {
    return { ports, required: [], hidden, inputRenderers };
  }
  const rawRequired = (schema as { required?: unknown }).required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((r): r is string => typeof r === "string")
    : [];
  const properties = (schema as { properties?: unknown }).properties;
  if (properties && typeof properties === "object") {
    for (const [field, rawDef] of Object.entries(properties as Record<string, unknown>)) {
      const def = (rawDef && typeof rawDef === "object" ? rawDef : {}) as Record<string, unknown>;
      const port: OasProperty = {
        // `title` is the field IDENTIFIER in the OAS contract (the compiler keys
        // inputSchema.properties by `prop.title`). Always use the property key
        // so the round-tripped field name matches the original.
        title: field,
        type: typeof def.type === "string" ? def.type : "string",
      };
      if (typeof def.format === "string") port.format = def.format;
      if (typeof def.description === "string") port.description = def.description;
      if (def.items !== undefined) port.items = def.items;
      if (typeof def["x-renderer"] === "string") inputRenderers[field] = def["x-renderer"] as string;
      if (def["x-hidden"] === true) hidden.push(field);
      ports.push(port);
    }
  }
  return { ports, required, hidden, inputRenderers };
}

/**
 * Build the synthesized OAS Flow document for `template`. The returned object
 * is JSON-serialized verbatim into the package's `cinatra/oas.json`.
 *
 * Guaranteed to satisfy `validateOasFlowStructural` and compile via
 * `compileOasAgentJson` for any well-formed template (leaf/orchestrator/node/
 * flow + the collapsed subtypes). Determinism: no wall-clock; output depends
 * only on the template fields.
 */
export function buildAgentOasFromTemplate(
  template: AgentTemplateRecord,
): Record<string, unknown> {
  const flowType = toOasFlowType(template.type);
  const { ports: inputPorts, required, hidden, inputRenderers } = reverseSchemaToPorts(
    template.inputSchema,
  );
  const { ports: outputPorts } = reverseSchemaToPorts(template.outputSchema);

  // system_prompt → compiled.prompt → seed.taskSpec. We must NOT invent a
  // taskSpec the template never had: the compiler returns `prompt: null` only
  // when no Agent declares a string `system_prompt`. So when the template's
  // taskSpec is null/empty we OMIT system_prompt entirely, which round-trips to
  // seed.taskSpec === null — preserving the template's original (a
  // `taskSpec ?? sourceNl ?? ""` fallback silently corrupted a null taskSpec
  // into sourceNl/"" on install). sourceNl is carried independently via the
  // OAS-root `sourceNl` field, so dropping the fallback here loses nothing.
  const systemPrompt =
    typeof template.taskSpec === "string" && template.taskSpec.length > 0
      ? template.taskSpec
      : null;

  const startCinatra: Record<string, unknown> = {};
  if (required.length > 0) startCinatra.required = required;
  if (hidden.length > 0) startCinatra.hidden = hidden;
  if (Object.keys(inputRenderers).length > 0) startCinatra.inputRenderers = inputRenderers;

  const startNode: Record<string, unknown> = {
    component_type: "StartNode",
    id: "start",
    name: "Start",
    inputs: inputPorts,
  };
  if (Object.keys(startCinatra).length > 0) {
    startNode.metadata = { cinatra: startCinatra };
  }

  const agentNode: Record<string, unknown> = {
    component_type: "AgentNode",
    id: "agent",
    name: template.name || "Agent",
    agent: { $component_ref: "agentImpl" },
  };

  const agentImpl: Record<string, unknown> = {
    component_type: "Agent",
    id: "agentImpl",
    name: template.name || "Agent",
  };
  // Only emit system_prompt when the template actually has a taskSpec; omitting
  // it makes the compiler return prompt:null → seed.taskSpec:null (see above).
  if (systemPrompt !== null) {
    agentImpl.system_prompt = systemPrompt;
  }

  const endNode: Record<string, unknown> = {
    component_type: "EndNode",
    id: "end",
    name: "End",
    outputs: outputPorts,
  };

  return {
    agentspec_version: OAS_AGENTSPEC_VERSION,
    component_type: "Flow",
    id: template.id,
    name: template.name,
    // Root sourceNl is read back by buildAgentTemplateInstallSeed.
    sourceNl: template.sourceNl ?? "",
    ...(template.description ? { description: template.description } : {}),
    metadata: {
      cinatra: {
        type: flowType,
        ...(template.hitlScreens && template.hitlScreens.length > 0
          ? { hitlScreens: template.hitlScreens }
          : {}),
      },
    },
    inputs: inputPorts,
    outputs: outputPorts,
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "agent" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-agent",
        from_node: { $component_ref: "start" },
        to_node: { $component_ref: "agent" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "agent-to-end",
        from_node: { $component_ref: "agent" },
        to_node: { $component_ref: "end" },
      },
    ],
    $referenced_components: {
      start: startNode,
      agent: agentNode,
      agentImpl,
      end: endNode,
    },
  };
}

function buildAgentMetadata(
  template: AgentTemplateRecord,
  version: AgentVersionRecord,
  input: BuildAgentPackageInput,
): CinatraAgentPackageMetadata {
  const metadata: CinatraAgentPackageMetadata = {
    packageType: CINATRA_AGENT_PACKAGE_TYPE,
    manifestVersion: CINATRA_AGENT_MANIFEST_VERSION,
    sourceTemplateId: template.id,
    sourceVersionId: version.id,
    sourceVersionNumber: version.versionNumber,
    // Default to "leaf" defensively for legacy rows where `type` was not yet
    // persisted. Zod's schema default also normalizes this downstream, but
    // emitting the field explicitly avoids relying on parser defaults in
    // consumers that read the manifest directly.
    type: template.type ?? "leaf",
    riskLevel: agentPackageRiskLevelSchema.parse(input.riskLevel),
    hasApprovalGates: input.hasApprovalGates,
    toolAccess: normalizeToolAccess(input.toolAccess),
    ownerOrgId: template.orgId ?? null,
    // Unconditionally emit marketplace discriminators on every agent-builder
    // publish. Without these, the marketplace `?tab=agent` filter excludes the
    // card because kind derivation in packages/registries/src/verdaccio/client.ts
    // returns null when cinatra.kind is missing. This handler is agent-only
    // (DB-template publish path via agent_registry_publish + UI publish +
    // promotion), mirroring the same constants `publishAgentPackageFromGitDir`
    // emits.
    kind: "agent",
    apiVersion: "cinatra.ai/v1",
  };
  if (input.agentDependencies && Object.keys(input.agentDependencies).length > 0) {
    metadata.agentDependencies = { ...input.agentDependencies };
  }
  // Emit executionProvider when the template declares a non-default provider.
  // Schema (package-contract.ts) marks this field optional; install path
  // (agents-install.mjs line 355) falls back to "default" when absent, so
  // omitting "default" keeps the manifest minimal.
  if (template.executionProvider && template.executionProvider !== "default") {
    metadata.executionProvider = template.executionProvider;
  }
  return metadata;
}

function buildReadme(
  input: BuildAgentPackageInput,
  packageName: string,
  metadata: CinatraAgentPackageMetadata,
): string {
  const title = input.title.trim() || input.template.name;
  const description = input.description?.trim() || input.template.description || "Cinatra agent package";
  const toolAccess = metadata.toolAccess.length > 0 ? metadata.toolAccess.join(", ") : "None";
  const approvalText = metadata.hasApprovalGates ? "Yes" : "No";
  const changelog = input.changelog?.trim();

  return [
    `# ${title}`,
    "",
    description,
    "",
    `Published package: \`${packageName}@${input.semver}\``,
    "",
    "## Package Metadata",
    "",
    `- Risk level: ${metadata.riskLevel}`,
    `- Approval gates: ${approvalText}`,
    `- Tool access: ${toolAccess}`,
    `- Source template: ${metadata.sourceTemplateId}`,
    `- Source version: ${metadata.sourceVersionId} (v${metadata.sourceVersionNumber})`,
    "",
    changelog ? "## Changelog" : "",
    changelog ? "" : "",
    changelog ?? "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === "" && lines[index + 1] === ""))
    .join("\n")
    .trimEnd()
    .concat("\n");
}

export function buildAgentPackageFiles(
  input: BuildAgentPackageInput,
  config: VerdaccioConfig,
): AgentPackageFiles {
  const title = input.title.trim() || input.template.name;
  const description = input.description?.trim() || input.template.description || null;
  // Prefer caller-supplied packageName read verbatim from each agent's
  // package.json#name. Fall back to scope+slug composition only for legacy
  // template-based publish paths that have not yet been migrated.
  const fallbackSlug =
    slugifyPackageName(input.template.name) || `agent-${input.template.id.slice(0, 8)}`;
  const packageName = input.packageName ?? [config.packageScope, fallbackSlug].join("/");
  const publishedAt = (input.publishedAt ?? new Date()).toISOString();
  const metadata = buildAgentMetadata(input.template, input.version, input);

  const manifest = parseAgentPackageManifest({
    name: packageName,
    version: input.semver,
    description,
    keywords: ["cinatra", "cinatra-agent"],
    publishConfig: {
      registry: config.registryUrl,
    },
    cinatra: metadata,
  });

  const publish: {
    riskLevel: CinatraAgentPackageMetadata["riskLevel"];
    toolAccess: string[];
    hasApprovalGates: boolean;
    agentDependencies?: Record<string, string>;
  } = {
    riskLevel: metadata.riskLevel,
    toolAccess: metadata.toolAccess,
    hasApprovalGates: metadata.hasApprovalGates,
  };
  if (input.agentDependencies && Object.keys(input.agentDependencies).length > 0) {
    publish.agentDependencies = { ...input.agentDependencies };
  }

  const payload = parseAgentPackagePayload({
    formatVersion: AGENT_PACKAGE_FORMAT_VERSION,
    packageName,
    packageVersion: input.semver,
    publishedAt,
    title,
    description,
    changelog: input.changelog?.trim() || null,
    template: {
      sourceTemplateId: input.template.id,
      ownerOrgId: input.template.orgId ?? null,
      name: input.template.name,
      description: input.template.description ?? null,
      sourceNl: input.template.sourceNl,
      compiledPlan: input.template.compiledPlan,
      inputSchema: input.template.inputSchema,
      outputSchema: input.template.outputSchema ?? null,
      approvalPolicy: input.template.approvalPolicy,
      taskSpec: input.template.taskSpec ?? null,
      status: input.template.status,
      // Mirror metadata.executionProvider into agent.json payload so the
      // install-side reader (agents-install.mjs line 355) can prefer
      // `template.executionProvider` over `cinatra.executionProvider` without a
      // fallback-to-"default" branch.
      ...(input.template.executionProvider && input.template.executionProvider !== "default"
        ? { executionProvider: input.template.executionProvider }
        : {}),
    },
    version: {
      sourceVersionId: input.version.id,
      sourceVersionNumber: input.version.versionNumber,
      contentHash: input.version.contentHash,
      snapshot: input.version.snapshot,
    },
    publish,
  });

  return {
    packageName,
    packageVersion: input.semver,
    manifest,
    payload,
    files: {
      "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "agent.json": `${JSON.stringify(payload, null, 2)}\n`,
      "README.md": buildReadme(input, packageName, metadata),
      // Synthesize the OAS Flow document from the DB template so the published
      // package carries cinatra/oas.json. Without it the post-engineering#378 installer
      // throws (legacy agent.json-only packages are no longer installable).
      "cinatra/oas.json": `${JSON.stringify(buildAgentOasFromTemplate(input.template), null, 2)}\n`,
    },
  };
}
