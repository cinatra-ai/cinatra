import "server-only";

// EDGE-BOUND AGENT SERVING (cinatra#1040 S5, fallback-only per codex round-1 D5).
//
// A package may be installed at several versions side by side; the DEFAULT
// version alone owns the package's unversioned global names (S4). A dependent
// that resolved its dependency edge to a NON-DEFAULT agent version must, when
// it dispatches to that package, be served THAT version's immutable
// `agent_template_versions` snapshot — never the default's current plan.
//
// SCOPE (deliberately narrow): this helper is the RESOLVER + the fail-closed
// GUARD. It maps a KNOWN dependent install id + a target agent package to the
// resolved-edge version, and REFUSES-WITH-EVIDENCE when that edge points at a
// non-default version that has NO published snapshot (an unreachable install —
// #1040 outcome #4's "refuse rather than ship an unreachable install"). It
// never silently downgrades to the default.
//
// What it is NOT (deferred): AUTOMATIC threading of the dependent identity into
// the live A2A dispatch seam. The multi-agent executor's `extractRouting`/
// `ActorContext` carries only the caller-supplied TARGET (skillId + optional
// requestedVersion), not a trusted dependent install id, and
// `dependentPackageName + orgId` is ambiguous once dependents themselves have
// side-by-side versions (codex round-1 D5). Auto-threading waits for signed run
// lineage to carry the exact `dependentInstallId`; until then this helper is the
// substrate + the guard any host caller that DOES hold a trusted dependent id
// (e.g. an in-process dependency dispatch) uses before serving.

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

/** A resolved-edge agent version the dependent may be served. */
export type EdgeBoundAgentResolution =
  | {
      /** No resolved edge from this dependent to the target — caller uses normal default resolution. */
      resolved: false;
    }
  | {
      resolved: true;
      /** The resolved install row's version (may be the default). */
      version: string | null;
      isDefault: boolean;
      /** The immutable `agent_template_versions` snapshot id when a non-default pin is servable. */
      snapshotId?: string;
    };

/**
 * Thrown when a dependent's resolved edge points at a NON-DEFAULT agent version
 * that is UNREACHABLE (no `agent_template_versions` snapshot to pin the run to).
 * Carries the full evidence set so the JSON-RPC / dispatch surface can surface a
 * clean, actionable refusal instead of silently serving the default.
 */
export class EdgeBoundAgentServingError extends Error {
  readonly code = "EDGE_BOUND_AGENT_UNREACHABLE";
  readonly dependentInstallId: string;
  readonly targetPackageName: string;
  readonly resolvedInstallId: string;
  readonly resolvedVersion: string | null;
  constructor(input: {
    dependentInstallId: string;
    targetPackageName: string;
    resolvedInstallId: string;
    resolvedVersion: string | null;
  }) {
    super(
      `edge-bound serving refused — dependent install ${input.dependentInstallId} resolved its ` +
        `edge to ${input.targetPackageName}@${input.resolvedVersion ?? "(unversioned)"} ` +
        `(install ${input.resolvedInstallId}), a NON-DEFAULT side-by-side version with no ` +
        `agent_template_versions snapshot to pin the run to — refusing rather than silently ` +
        `serving the default. Publish a template snapshot for that version, or re-resolve the ` +
        `edge to the default.`,
    );
    this.name = "EdgeBoundAgentServingError";
    this.dependentInstallId = input.dependentInstallId;
    this.targetPackageName = input.targetPackageName;
    this.resolvedInstallId = input.resolvedInstallId;
    this.resolvedVersion = input.resolvedVersion;
  }
}

export type ResolveEdgeBoundAgentDeps = {
  readInstalledExtensionById?: (id: string) => Promise<InstalledExtension | null>;
  readAgentTemplateByPackageName?: (
    packageName: string,
  ) => Promise<{ id: string } | null>;
  readAgentTemplateVersionBySemver?: (
    templateId: string,
    semver: string,
  ) => Promise<{ id: string } | null>;
};

/**
 * Resolve the version a KNOWN dependent must be served for `targetPackageName`,
 * fail-closed on an unreachable non-default pin.
 *
 *   - no dependent row / no resolved edge to the target  → { resolved: false }
 *     (the caller uses ordinary default resolution — no non-default requirement).
 *   - resolved edge → the DEFAULT version                 → { resolved: true, isDefault: true }
 *     (serving the default is always fine).
 *   - resolved edge → a NON-DEFAULT version WITH a snapshot → { resolved: true, isDefault: false, snapshotId }.
 *   - resolved edge → a NON-DEFAULT version WITHOUT a snapshot → throws
 *     EdgeBoundAgentServingError (never serve the default silently).
 */
export async function resolveEdgeBoundAgentVersion(
  input: { dependentInstallId: string; targetPackageName: string },
  deps: ResolveEdgeBoundAgentDeps = {},
): Promise<EdgeBoundAgentResolution> {
  const readById =
    deps.readInstalledExtensionById ??
    (async (id: string) =>
      (await import("@cinatra-ai/extensions/canonical-store")).readInstalledExtensionById(id));

  const dependent = await readById(input.dependentInstallId);
  if (!dependent) return { resolved: false };

  const edge = (dependent.dependencyEdges ?? []).find(
    (e) => e.packageName === input.targetPackageName && e.resolvedInstallId != null,
  );
  if (!edge || edge.resolvedInstallId == null) return { resolved: false };

  const resolvedRow = await readById(edge.resolvedInstallId);
  // A dangling resolved id (target row deleted after the edge was written) is
  // treated as "no resolved edge" — the closure gates' name-fallback re-heals.
  if (!resolvedRow) return { resolved: false };

  const isDefault = resolvedRow.isDefault !== false;
  const version = resolvedRow.version ?? null;
  if (isDefault) return { resolved: true, version, isDefault: true };

  // NON-DEFAULT resolved edge → require a published snapshot, else refuse.
  const readTemplate =
    deps.readAgentTemplateByPackageName ??
    (async (packageName: string) =>
      (await import("@cinatra-ai/agents")).readAgentTemplateByPackageName(packageName));
  const readSnapshot =
    deps.readAgentTemplateVersionBySemver ??
    (async (templateId: string, semver: string) =>
      (await import("@cinatra-ai/agents")).readAgentTemplateVersionBySemver(templateId, semver));

  const template = version ? await readTemplate(input.targetPackageName) : null;
  const snapshot = template && version ? await readSnapshot(template.id, version) : null;
  if (!snapshot) {
    throw new EdgeBoundAgentServingError({
      dependentInstallId: input.dependentInstallId,
      targetPackageName: input.targetPackageName,
      resolvedInstallId: edge.resolvedInstallId,
      resolvedVersion: version,
    });
  }
  return { resolved: true, version, isDefault: false, snapshotId: snapshot.id };
}
