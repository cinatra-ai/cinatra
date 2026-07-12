import "server-only";

// EDGE-BOUND EXTENSION SERVING — the NON-AGENT consume-side binding
// (cinatra#1392 Gap 1 WIRING; follow-up slice of #1040 acceptance scenario 1,
// "A keeps consuming 0.1.4 via its resolved edge").
//
// The version-keyed serving REGISTRY (#1410) retains a NON-DEFAULT side-by-side
// version's register-channel registrations keyed by `(packageName, version)`.
// This module is the missing CONSUME side for the MCP-tool kind: it resolves,
// for the CURRENT dispatch, whether a TRUSTED dependent identity is edge-bound
// to a non-default version of the tool's owning package — and, when it is,
// serves THAT version's retained handler instead of the global (default) one,
// FAIL-CLOSED (a refusal never falls through to the default handler).
//
// TRUSTED DEPENDENT IDENTITY (never client input). Two verified sources, in
// order:
//   1. `ActorContext.dependentInstallId` — the run's signed lineage, stamped by
//      `buildActorContextFromRun` (cinatra#1392 Gap 2) and carried on the LLM
//      ActorContext ALS (worker / A2A / llm-bridge mint paths).
//   2. The live MCP transport frame's DELEGATED agent-run actor
//      (`mcpRequestContextStorage` → `delegatedActor.delegation === "agent_run"`)
//      — the run id from the SIGNED OBO token (#1195's "obo" channel). The
//      frame's bare `runId` field is NOT consulted: it can be served by the
//      legacy registry/header channels (forgeable; #1195 keeps them only for
//      the cutover) and the frame does not record per-field provenance.
// From a verified run id, the dependent install id is the run row's
// `dependent_install_id` — or, when the row predates the Gap-2 writer or the
// run is TOP-LEVEL (no A2A edge created it), a DERIVED identity (below).
//
// TOP-LEVEL DERIVATION (the scenario-1 bootstrap). `MultiAgentExecutor` stamps
// `dependent_install_id` only on runs CREATED through an edge-bound A2A
// dispatch, so a top-level run of agent A would otherwise carry no dependent
// identity and A's own tool calls could never be served its resolved edges.
// For a verified run whose row carries no id, `deriveDependentInstallIdForRun`
// derives the install the run executes AS, from trusted rows only:
//   - the run's template → `packageName`;
//   - the org-addressable LIVE (`active|locked`) canonical install rows for
//     that package (org-anchored rows preferred over workspace-level ones —
//     the same determinism rule as `pickActiveInstallId`);
//   - a REQUIRED-PIN run (`versionId` + `packageVersion` both set — the exact
//     fail-closed marker pair from cinatra#1040 S7) selects the row at that
//     exact version; an unpinned run selects the DEFAULT row (`isDefault !==
//     false` — an unpinned run executes the live/default template, so the
//     default install IS its identity, unambiguously).
// No match ⇒ undefined (compatibility-preserving: no edge-bound constraint —
// e.g. a bare template that was never installed as an extension).
//
// FAIL-CLOSED MATRIX (codex round-0). With a trusted dependent id present:
//   - dependent install row MISSING            → refuse (corrupt/torn-down lineage);
//   - resolved edge → row MISSING (dangling)   → refuse;
//   - resolved edge → row NOT LIVE             → refuse (archived mid-flight);
//   - resolved edge → NON-DEFAULT, NO version  → refuse (a non-default install
//     must be pinned; never silently serve the default);
//   - version-keyed lookup refuses (UNKNOWN_VERSION / NOT_SERVABLE /
//     NO_SUCH_HANDLER) → the dispatch THROWS with that evidence — never the
//     global handler.
// NOTE: this is deliberately STRICTER than the agent-path resolver
// (`extension-edge-bound-agent.ts` treats a dangling resolved id as "no edge",
// relying on the closure gates' name-fallback re-heal). Aligning the agent path
// to this matrix is a follow-up noted on cinatra#1392.
// Absent trusted identity / no resolved edge to the target package ⇒ `none`
// (compatibility-preserving: the global/default registration serves, exactly
// as before this slice).
//
// OUT OF SCOPE (cinatra#1392 stays open for these): capability-provider
// resolve substitution (`HostCapabilitiesPort.resolveProviders` is SYNC by
// ABI; needs loader-side pre-resolved edge maps), object-type / ui-surface
// serve surfaces, extension-ctx dependents (`ctx.mcp.callPrimitive` callers
// carry no install identity yet), and the tool DISCOVERY union (tools/list
// advertises the DEFAULT version's names; a name existing only in the pinned
// version is not dispatchable — input is validated against the default's
// registered schema).

import { getActorContext } from "@cinatra-ai/llm/actor-context";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  resolveVersionKeyedMcpTool,
  type RetainedVersionKeyedMcpTool,
} from "@/lib/extension-version-keyed-serving";
import { isInstallRowAddressableByActor } from "@/lib/extension-install-resolution";

/** The LIVE canonical-row statuses (mirrors `pickActiveInstallId`'s filter). */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** The run-row projection the derivation consumes (a subset of the serde record). */
export type RunRowForEdgeBoundServing = {
  id: string;
  templateId: string;
  orgId: string | null;
  runBy?: string | null;
  packageVersion?: string | null;
  versionId?: string | null;
  dependentInstallId?: string | null;
};

/** An edge-bound serving decision for a NON-AGENT dispatch to `targetPackageName`. */
export type EdgeBoundExtensionVersionDecision =
  /** No trusted dependent identity, or no resolved edge to the target — the global/default registration serves. */
  | { kind: "none" }
  /** The dependent's edge resolves to the DEFAULT install — the global registration IS that version. */
  | { kind: "default" }
  /** The dependent's edge resolves to a NON-DEFAULT pinned version — serve it version-keyed. */
  | { kind: "versioned"; version: string; resolvedInstallId: string }
  /** Fail-closed refusal with evidence — the caller must HARD-STOP, never default-serve. */
  | { kind: "refuse"; code: EdgeBoundExtensionRefuseCode; message: string };

export type EdgeBoundExtensionRefuseCode =
  | "EDGE_BOUND_RUN_MISSING"
  | "EDGE_BOUND_DEPENDENT_MISSING"
  | "EDGE_BOUND_RESOLVED_MISSING"
  | "EDGE_BOUND_RESOLVED_NOT_LIVE"
  | "EDGE_BOUND_VERSION_UNPINNED";

/** Injectable seams — every default is the live trusted source / store read. */
export type ResolveEdgeBoundExtensionDeps = {
  /** Source 1: the run-lineage dependent install id (ActorContext ALS). */
  getDependentInstallId?: () => string | undefined;
  /** Source 2: the VERIFIED (signed-OBO) delegated agent-run id on the MCP frame. */
  getVerifiedRunId?: () => string | undefined;
  readAgentRunById?: (id: string) => Promise<RunRowForEdgeBoundServing | null>;
  readAgentTemplateById?: (id: string) => Promise<{ packageName?: string | null } | null>;
  readInstalledExtensionById?: (id: string) => Promise<InstalledExtension | null>;
  readInstalledExtensionsByPackageName?: (packageName: string) => Promise<InstalledExtension[]>;
};

function liveDeps(deps: ResolveEdgeBoundExtensionDeps): Required<ResolveEdgeBoundExtensionDeps> {
  return {
    getDependentInstallId:
      deps.getDependentInstallId ?? (() => getActorContext()?.dependentInstallId),
    getVerifiedRunId:
      deps.getVerifiedRunId ??
      (() => {
        const delegated = mcpRequestContextStorage.getStore()?.delegatedActor;
        return delegated && delegated.delegation === "agent_run" ? delegated.runId : undefined;
      }),
    readAgentRunById:
      deps.readAgentRunById ??
      (async (id) => (await import("@cinatra-ai/agents")).readAgentRunById(id)),
    readAgentTemplateById:
      deps.readAgentTemplateById ??
      (async (id) => (await import("@cinatra-ai/agents")).readAgentTemplateById(id)),
    readInstalledExtensionById:
      deps.readInstalledExtensionById ??
      (async (id) =>
        (await import("@cinatra-ai/extensions/canonical-store")).readInstalledExtensionById(id)),
    readInstalledExtensionsByPackageName:
      deps.readInstalledExtensionsByPackageName ??
      (async (packageName) =>
        (await import("@cinatra-ai/extensions/canonical-store")).readInstalledExtensionsByPackageName(
          packageName,
        )),
  };
}

/**
 * Derive the install id a run executes AS, for a run row that carries no
 * `dependent_install_id` (a top-level run, or a pre-Gap-2 row). Trusted rows
 * only; `undefined` when no unambiguous org-addressable install exists
 * (compatibility-preserving — the dispatch serves the default).
 */
export async function deriveDependentInstallIdForRun(
  run: RunRowForEdgeBoundServing,
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<string | undefined> {
  const d = liveDeps(deps);
  const template = await d.readAgentTemplateById(run.templateId);
  const packageName = template?.packageName;
  if (!packageName) return undefined;

  const rows = await d.readInstalledExtensionsByPackageName(packageName);
  // The run's addressable scope: its org (org-anchored + workspace-level rows;
  // user/team-owned rows are keyed on the dispatching principal). Reuses the
  // SHARED scope predicate so cross-org rows can never leak in.
  const scope = {
    organizationId: run.orgId ?? null,
    ownerId: run.runBy ?? null,
    teamIds: [] as readonly string[],
  };
  const live = rows.filter(
    (row) => LIVE_STATUSES.has(row.status) && isInstallRowAddressableByActor(row, scope),
  );

  // REQUIRED pin (versionId + packageVersion — the S7 fail-closed marker pair):
  // the run executes AS the install at that exact version. Unpinned: the run
  // executes the live/default template — the DEFAULT install is its identity.
  const isRequiredPin = run.versionId != null && !!run.packageVersion;
  const candidates = isRequiredPin
    ? live.filter((row) => row.version === run.packageVersion)
    : live.filter((row) => row.isDefault !== false);

  if (candidates.length === 0) return undefined;
  // Determinism (mirrors pickActiveInstallId): prefer an org-anchored row over a
  // workspace-level (org-less) one; within the preferred set keep store order.
  const preferred = candidates.filter((row) => row.organizationId !== null);
  return (preferred[0] ?? candidates[0]).id;
}

/**
 * Resolve the edge-bound serving decision for a NON-AGENT dispatch to
 * `targetPackageName`. Pure over its injected deps (unit-testable without an
 * ALS frame or a DB); see the module header for the fail-closed matrix.
 */
export async function resolveEdgeBoundExtensionVersion(
  input: { targetPackageName: string },
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<EdgeBoundExtensionVersionDecision> {
  const d = liveDeps(deps);

  // TRUSTED dependent identity only — never client metadata.
  let dependentInstallId = d.getDependentInstallId();
  if (!dependentInstallId) {
    const runId = d.getVerifiedRunId();
    if (!runId) return { kind: "none" };
    const run = await d.readAgentRunById(runId);
    if (!run) {
      return {
        kind: "refuse",
        code: "EDGE_BOUND_RUN_MISSING",
        message:
          `edge-bound serving refused — verified run ${runId} has no run row; ` +
          `cannot establish the dependent identity for a dispatch to ${input.targetPackageName}`,
      };
    }
    dependentInstallId = run.dependentInstallId ?? (await deriveDependentInstallIdForRun(run, d));
    if (!dependentInstallId) return { kind: "none" };
  }

  const dependent = await d.readInstalledExtensionById(dependentInstallId);
  if (!dependent) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_DEPENDENT_MISSING",
      message:
        `edge-bound serving refused — trusted dependent install ${dependentInstallId} has no ` +
        `canonical row (torn down mid-flight?); refusing a dispatch to ${input.targetPackageName} ` +
        `rather than serving an identity-less default`,
    };
  }

  const edge = (dependent.dependencyEdges ?? []).find(
    (e) => e.packageName === input.targetPackageName && e.resolvedInstallId != null,
  );
  if (!edge || edge.resolvedInstallId == null) return { kind: "none" };

  const resolvedRow = await d.readInstalledExtensionById(edge.resolvedInstallId);
  if (!resolvedRow) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_RESOLVED_MISSING",
      message:
        `edge-bound serving refused — dependent install ${dependentInstallId} resolved its edge ` +
        `to ${input.targetPackageName} install ${edge.resolvedInstallId}, but that row is gone; ` +
        `refusing rather than silently serving the default`,
    };
  }
  if (!LIVE_STATUSES.has(resolvedRow.status)) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_RESOLVED_NOT_LIVE",
      message:
        `edge-bound serving refused — dependent install ${dependentInstallId} resolved its edge ` +
        `to ${input.targetPackageName} install ${resolvedRow.id}, which is "${resolvedRow.status}" ` +
        `(not live); refusing rather than silently serving the default`,
    };
  }

  if (resolvedRow.isDefault !== false) return { kind: "default" };

  const version = resolvedRow.version;
  if (typeof version !== "string" || version.length === 0) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_VERSION_UNPINNED",
      message:
        `edge-bound serving refused — dependent install ${dependentInstallId} resolved its edge ` +
        `to a NON-DEFAULT install of ${input.targetPackageName} (install ${resolvedRow.id}) that ` +
        `carries NO version pin; refusing rather than silently serving the default`,
    };
  }
  return { kind: "versioned", version, resolvedInstallId: resolvedRow.id };
}

/** Thrown by the dispatch wrapper on a fail-closed edge-bound refusal. */
export class EdgeBoundMcpServeRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeBoundMcpServeRefusal";
    this.code = code;
  }
}

/**
 * Dispatch an EXTENSION-registered MCP tool under edge-bound serving. The single
 * chokepoint both `mcp-server.ts` serve surfaces (the live-transport replay and
 * the self-primitive capture) call instead of `tool.handler(input)` directly:
 *
 *   - `none` / `default`   → the GLOBAL (default-version) handler;
 *   - `versioned`          → the version-keyed retained handler for the pinned
 *                            version, fail-closed via `resolveVersionKeyedMcpTool`
 *                            (UNKNOWN_VERSION / NOT_SERVABLE / NO_SUCH_HANDLER
 *                            THROW — never the global handler);
 *   - `refuse`             → THROWS the evidence-carrying refusal.
 */
export async function dispatchExtensionMcpToolEdgeBound(
  tool: {
    packageName: string;
    name: string;
    handler: (input: unknown) => unknown | Promise<unknown>;
  },
  input: unknown,
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<unknown> {
  const decision = await resolveEdgeBoundExtensionVersion(
    { targetPackageName: tool.packageName },
    deps,
  );
  if (decision.kind === "refuse") {
    throw new EdgeBoundMcpServeRefusal(decision.code, decision.message);
  }
  if (decision.kind === "versioned") {
    const served: ReturnType<typeof resolveVersionKeyedMcpTool> = resolveVersionKeyedMcpTool(
      tool.packageName,
      decision.version,
      tool.name,
    );
    if (served.kind === "refuse") {
      throw new EdgeBoundMcpServeRefusal(
        served.code,
        `edge-bound serving refused for MCP tool "${tool.name}" — ${served.message}`,
      );
    }
    const retained: RetainedVersionKeyedMcpTool = served.value;
    return retained.handler(input);
  }
  return tool.handler(input);
}
