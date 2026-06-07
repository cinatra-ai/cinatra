import "server-only";

import { A2AError } from "@a2a-js/sdk/server";
import {
  readAgentTemplateByPackageName,
  readAgentTemplateVersionBySemver,
} from "@cinatra-ai/agents";

// ---------------------------------------------------------------------------
// resolveVersionBeforeRun
//
// Pure helper that resolves a concrete `packageVersion` string BEFORE a run is
// enqueued into BullMQ. This pins the run against the immutable
// `agent_template_versions` snapshot that existed at request time — a later
// publish cannot race and substitute a different compiled plan or taskSpec.
//
// Mapping:
//   - requestedVersion provided   → validate it exists in agent_template_versions;
//     return it, or throw invalidParams if missing.
//   - requestedVersion omitted    → read the template's current `packageVersion`
//     (set at publish time via Verdaccio flow) and return it; throw invalidParams
//     if the template has no published version yet.
//   - unknown packageName         → throw invalidParams so JSON-RPC surface
//     surfaces a clean -32602 error envelope instead of a 500.
// ---------------------------------------------------------------------------

export type ResolveVersionInput = {
  packageName: string;
  requestedVersion?: string;
};

export type ResolveVersionResult = {
  templateId: string;
  resolvedVersion: string;
  snapshotId?: string;
};

export async function resolveVersionBeforeRun(
  input: ResolveVersionInput,
): Promise<ResolveVersionResult> {
  const template = await readAgentTemplateByPackageName(input.packageName);
  if (!template) {
    throw A2AError.invalidParams(`Unknown agent package: ${input.packageName}`);
  }
  if (input.requestedVersion) {
    const match = await readAgentTemplateVersionBySemver(
      template.id,
      input.requestedVersion,
    );
    if (!match) {
      throw A2AError.invalidParams(
        `Version ${input.requestedVersion} not found for ${input.packageName}`,
      );
    }
    return {
      templateId: template.id,
      resolvedVersion: match.semver,
      snapshotId: match.id,
    };
  }
  if (!template.packageVersion) {
    throw A2AError.invalidParams(
      `No published version for ${input.packageName}`,
    );
  }
  return {
    templateId: template.id,
    resolvedVersion: template.packageVersion,
  };
}
