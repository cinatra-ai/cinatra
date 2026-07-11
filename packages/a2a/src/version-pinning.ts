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
    // REFUSE-WITH-EVIDENCE (cinatra#1040 S5) — at the REQUEST-TIME pinning seam:
    // a pinned version with no immutable `agent_template_versions` snapshot is
    // UNREACHABLE (a side-by-side NON-DEFAULT install whose template snapshot was
    // never published), so the run is never even enqueued — fail closed naming
    // the (package, version) rather than resolving to the template's current
    // default `packageVersion`.
    //   SCOPE NOTE: this closes the REQUEST-TIME hole only. The execution worker
    //   still best-effort falls back to the LIVE template if a REQUESTED-and-
    //   present snapshot is PURGED mid-flight (agents `execution.ts`), because the
    //   run row records only the resolved semver, not whether the pin was a
    //   REQUIRED explicit pin vs. a default resolution. Closing that end-to-end
    //   (a persisted required-pin marker + a fail-closed worker) is folded into
    //   the positive edge-bound-serving slice (cinatra#1040 S7) — a snapshot
    //   purge of an in-flight run is the only residual window.
    if (!match) {
      throw A2AError.invalidParams(
        `Version ${input.requestedVersion} not found for ${input.packageName} — no published ` +
          `agent_template_versions snapshot to pin the run to (an unreachable non-default version); ` +
          `refusing rather than serving the default.`,
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
