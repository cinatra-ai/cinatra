// CLI-safe installAgentFromPackage.
// Does NOT import "server-only" — safe for plain Node.js CLI processes.
// Uses CLI-safe implementations of extractAgentPackage and createLocalAgentTemplateVersion
// instead of going through the server-only-guarded barrel (index.ts).

import {
  CINATRA_AGENT_PACKAGE_TYPE,
  CINATRA_AGENT_MANIFEST_VERSION,
} from "../verdaccio/package-contract";
import {
  extractAgentPackageCli,
  cleanupExtractedAgentPackageCli,
} from "./extract-agent-package-cli";
import { createLocalAgentTemplateVersionCli } from "./create-agent-template-cli";

export type InstallAgentFromPackageInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
  creatorId?: string;
  status?: "draft" | "published";
};

export type InstallAgentFromPackageResult = {
  templateId: string;
  versionId: string;
  packageName: string;
  packageVersion: string;
  agentDependencies: Record<string, string>;
};

/**
 * Validate and filter agentDependencies from an untrusted manifest.
 * Only string-keyed / string-valued entries are kept; non-string values
 * (objects, arrays, numbers) from a malformed or malicious package are
 * dropped rather than propagated into the DB or semver resolution.
 */
function sanitizeAgentDependencies(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string") {
      result[k] = v;
    }
  }
  return result;
}

/**
 * CLI-safe installAgentFromPackage — extracts a Verdaccio tarball, validates
 * the manifest, and persists the agent template to the DB.
 * Requires SUPABASE_DB_URL and Verdaccio config env vars to be set.
 */
export async function installAgentFromPackage(
  input: InstallAgentFromPackageInput,
): Promise<InstallAgentFromPackageResult> {
  const extracted = await extractAgentPackageCli({
    packageName: input.packageName,
    packageVersion: input.packageVersion,
  });
  try {
    if (extracted.manifest.cinatra.packageType !== CINATRA_AGENT_PACKAGE_TYPE) {
      throw new Error(
        `Unsupported package type: ${extracted.manifest.cinatra.packageType}`,
      );
    }
    if (
      extracted.manifest.cinatra.manifestVersion !==
      CINATRA_AGENT_MANIFEST_VERSION
    ) {
      throw new Error(
        `Unsupported manifest version: ${extracted.manifest.cinatra.manifestVersion}`,
      );
    }

    const rawDeps = (extracted.manifest.cinatra as Record<string, unknown>).agentDependencies;
    const agentDependencies = sanitizeAgentDependencies(rawDeps);

    const rawType = (extracted.manifest.cinatra as { type?: unknown }).type;
    const type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" =
      rawType === "proxy"
        ? "proxy"
        : rawType === "orchestrator"
          ? "orchestrator"
          : rawType === "parallel"
            ? "parallel"
            : rawType === "supervisor"
              ? "supervisor"
              : rawType === "iterative"
                ? "iterative"
                : "leaf";

    const lgGraphCode: string | null =
      extracted.payload.template.lgGraphCode ?? null;
    const lgGraphId: string | null =
      extracted.payload.template.lgGraphId ?? null;

    const { templateId, versionId } =
      await createLocalAgentTemplateVersionCli({
        seed: {
          name:
            extracted.payload.title?.trim() ||
            extracted.payload.template.name,
          description:
            extracted.payload.description ??
            extracted.payload.template.description,
          sourceNl: extracted.payload.template.sourceNl,
          compiledPlan: extracted.payload.template.compiledPlan,
          inputSchema: extracted.payload.template.inputSchema,
          outputSchema: extracted.payload.template.outputSchema,
          approvalPolicy: extracted.payload.template.approvalPolicy,
          type,
          taskSpec: extracted.payload.template.taskSpec,
          snapshot: extracted.payload.version.snapshot,
          creatorId: input.creatorId,
          orgId: input.orgId,
          packageName: extracted.packageName,
          packageVersion: extracted.packageVersion,
          agentDependencies:
            Object.keys(agentDependencies).length > 0
              ? agentDependencies
              : undefined,
          lgGraphCode,
          lgGraphId,
          status: input.status ?? "draft",
        },
      });

    return {
      templateId,
      versionId,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      agentDependencies,
    };
  } finally {
    await cleanupExtractedAgentPackageCli(extracted.tempDir);
  }
}
