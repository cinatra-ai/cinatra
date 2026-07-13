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
      /**
       * The EXACT `installed_extension` row id the dependent's edge resolved to
       * (cinatra#1392 Gap 2). ALWAYS present on a resolved result — the dispatch
       * seam stamps it onto the target run's `dependent_install_id` so an
       * edge-bound chain self-propagates. A resolved result that somehow lacks it
       * is treated as a refusal by the dispatch binding (never a silent default).
       */
      resolvedInstallId: string;
      /** The immutable `agent_template_versions` snapshot id when a non-default pin is servable. */
      snapshotId?: string;
    };

/** The agent-path fail-closed refusal classes (cinatra#1392 S8 alignment). */
export type EdgeBoundAgentRefuseCode =
  /** A NON-DEFAULT pin with no `agent_template_versions` snapshot to serve. */
  | "EDGE_BOUND_AGENT_UNREACHABLE"
  /** The resolved edge's target row is GONE (dangling resolved id). */
  | "EDGE_BOUND_AGENT_RESOLVED_MISSING"
  /** The resolved edge's target row exists but is not live (archived mid-flight). */
  | "EDGE_BOUND_AGENT_RESOLVED_NOT_LIVE";

/**
 * Thrown when a dependent's resolved edge cannot be served fail-closed: a
 * NON-DEFAULT pin that is UNREACHABLE (no `agent_template_versions` snapshot to
 * pin the run to), or — since the cinatra#1392 S8 alignment to the stricter
 * non-agent matrix — a resolved edge whose target row is MISSING (dangling) or
 * NOT LIVE. Carries the full evidence set so the JSON-RPC / dispatch surface
 * can surface a clean, actionable refusal instead of silently serving the
 * default.
 */
export class EdgeBoundAgentServingError extends Error {
  readonly code: EdgeBoundAgentRefuseCode;
  readonly dependentInstallId: string;
  readonly targetPackageName: string;
  readonly resolvedInstallId: string;
  readonly resolvedVersion: string | null;
  constructor(input: {
    dependentInstallId: string;
    targetPackageName: string;
    resolvedInstallId: string;
    resolvedVersion: string | null;
    code?: EdgeBoundAgentRefuseCode;
    /** Overrides the default (snapshot-unreachable) message when set. */
    message?: string;
  }) {
    super(
      input.message ??
        `edge-bound serving refused — dependent install ${input.dependentInstallId} resolved its ` +
          `edge to ${input.targetPackageName}@${input.resolvedVersion ?? "(unversioned)"} ` +
          `(install ${input.resolvedInstallId}), a NON-DEFAULT side-by-side version with no ` +
          `agent_template_versions snapshot to pin the run to — refusing rather than silently ` +
          `serving the default. Publish a template snapshot for that version, or re-resolve the ` +
          `edge to the default.`,
    );
    this.name = "EdgeBoundAgentServingError";
    this.code = input.code ?? "EDGE_BOUND_AGENT_UNREACHABLE";
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
 * fail-closed (cinatra#1392 S8: aligned to the stricter non-agent matrix).
 *
 *   - no dependent row / no resolved edge to the target  → { resolved: false }
 *     (the caller uses ordinary default resolution — no non-default requirement).
 *   - resolved edge → target row MISSING (dangling)       → throws (refuse-with-
 *     evidence; never a silent downgrade to the default).
 *   - resolved edge → target row NOT LIVE                 → throws (as above).
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
  // cinatra#1392 S8 — ALIGNED to the stricter non-agent fail-closed matrix
  // (`extension-edge-bound-serving.ts`): a DANGLING resolved id (target row
  // deleted after the edge was written) REFUSES with evidence. The previous
  // "treat as no edge" lenience silently downgraded the dependent to the
  // default template — exactly the outcome the edge pin exists to prevent; the
  // closure gates' name-fallback re-heal repairs the EDGE ROW, not a live
  // dispatch already bound to it.
  if (!resolvedRow) {
    throw new EdgeBoundAgentServingError({
      dependentInstallId: input.dependentInstallId,
      targetPackageName: input.targetPackageName,
      resolvedInstallId: edge.resolvedInstallId,
      resolvedVersion: null,
      code: "EDGE_BOUND_AGENT_RESOLVED_MISSING",
      message:
        `edge-bound serving refused — dependent install ${input.dependentInstallId} resolved its ` +
        `edge to ${input.targetPackageName} install ${edge.resolvedInstallId}, but that row is ` +
        `gone; refusing rather than silently serving the default`,
    });
  }
  // Same alignment: a resolved row that is no longer LIVE (archived/uninstalled
  // mid-flight) refuses rather than serving anything on a retired pin.
  if (resolvedRow.status !== "active" && resolvedRow.status !== "locked") {
    throw new EdgeBoundAgentServingError({
      dependentInstallId: input.dependentInstallId,
      targetPackageName: input.targetPackageName,
      resolvedInstallId: resolvedRow.id,
      resolvedVersion: resolvedRow.version ?? null,
      code: "EDGE_BOUND_AGENT_RESOLVED_NOT_LIVE",
      message:
        `edge-bound serving refused — dependent install ${input.dependentInstallId} resolved its ` +
        `edge to ${input.targetPackageName} install ${resolvedRow.id}, which is ` +
        `"${resolvedRow.status}" (not live); refusing rather than silently serving the default`,
    });
  }

  const isDefault = resolvedRow.isDefault !== false;
  const version = resolvedRow.version ?? null;
  if (isDefault)
    return { resolved: true, version, isDefault: true, resolvedInstallId: resolvedRow.id };

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
  return {
    resolved: true,
    version,
    isDefault: false,
    resolvedInstallId: resolvedRow.id,
    snapshotId: snapshot.id,
  };
}
