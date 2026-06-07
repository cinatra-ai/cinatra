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
    },
  };
}
