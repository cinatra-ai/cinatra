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
// TRUSTED DEPENDENT IDENTITY (never client input). Three verified sources, in
// order:
//   0. The EXTENSION-CTX identity frame (cinatra#1392 S8,
//      `extension-ctx-dependent-identity.ts`) — set by the host ctx factory
//      around `ctx.mcp.callPrimitive`, carrying the CALLING extension record's
//      host-injected (packageName, version, isDefault). The immediate caller
//      OUTRANKS the run lineage: an extension invoking a primitive is itself
//      the consumer, so ITS resolved edges (not the outer run's) decide the
//      served version. The identity maps to the canonical install row
//      fail-closed (exactly-one live match; a torn non-default or an ambiguous
//      match REFUSES; a default identity with no canonical row is `none` — a
//      bare/dev extension that was never installed).
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
//   - the LIVE (`active|locked`) canonical install rows for that package in
//     the RUN'S ORG (org-anchored or workspace-level; cross-org rows are never
//     candidates). Owner level is NOT an exclusion axis here — a team/user-
//     owned install in the run's org is a legitimate identity (codex round-1);
//   - a REQUIRED-PIN run (`versionId` + `packageVersion` both set — the exact
//     fail-closed marker pair from cinatra#1040 S7) selects the row at that
//     exact version; an unpinned run selects the DEFAULT rows (`isDefault !==
//     false` — an unpinned run executes the live/default template);
//   - EXACTLY ONE candidate → that identity. MULTIPLE candidates are
//     disambiguated by the template's LOCKED owner anchor
//     (`ownerLevel`/`ownerId` — the same anchor the OBO-ceiling derivation
//     trusts); anything still ambiguous REFUSES (fail-closed, codex round-1 —
//     never an arbitrary first-row pick that could bind the wrong edges).
// No candidate ⇒ `none` (compatibility-preserving: no edge-bound constraint —
// e.g. a bare template that was never installed as an extension).
//
// FAIL-CLOSED MATRIX (codex rounds 0–1). With a trusted dependent id present:
//   - dependent install row MISSING            → refuse (corrupt/torn-down lineage);
//   - derivation AMBIGUOUS (multiple candidates
//     the owner anchor cannot single out)      → refuse;
//   - resolved edge → row MISSING (dangling)   → refuse;
//   - resolved edge → row NOT LIVE             → refuse (archived mid-flight);
//   - resolved edge → NON-DEFAULT, NO version  → refuse (a non-default install
//     must be pinned; never silently serve the default);
//   - version-keyed lookup refuses (UNKNOWN_VERSION / NOT_SERVABLE /
//     NO_SUCH_HANDLER) → the dispatch THROWS with that evidence — never the
//     global handler.
// The agent-path resolver (`extension-edge-bound-agent.ts`) is ALIGNED to this
// matrix since cinatra#1392 S8 (a dangling / not-live resolved row refuses with
// evidence there too).
// Absent trusted identity / no resolved edge to the target package ⇒ `none`
// (compatibility-preserving: the global/default registration serves, exactly
// as before this slice).
//
// TOOL DISCOVERY UNION (cinatra#1392 S8). `planExtensionToolDiscovery` computes,
// for the CURRENT caller, the extension tool set a per-request MCP server build
// must register: a package whose resolved edge pins a NON-DEFAULT version
// advertises THAT version's retained tool names — with input validated against
// the RESOLVED version's registered schema, not the default's — including names
// that exist ONLY in the pinned version (registered with a strict dispatch that
// re-verifies the edge at call time), and NOT advertising default names the
// pinned version does not register (calling one would refuse NO_SUCH_HANDLER).
// Absent identity / no pins ⇒ the plan is exactly the default replay,
// byte-identical to the pre-S8 behavior.
//
// OUT OF SCOPE (cinatra#1392 stays open for these): the object-type /
// ui-surface serve surfaces (S9, after the #1443 lane merges).

import { getActorContext } from "@cinatra-ai/llm/actor-context";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  resolveVersionKeyedMcpTool,
  resolveVersionKeyedMcpTools,
  type RetainedVersionKeyedMcpTool,
  type VersionKeyedServeResult,
} from "@/lib/extension-version-keyed-serving";
import {
  getExtensionCtxIdentity,
  type ExtensionCtxIdentity,
} from "@/lib/extension-ctx-dependent-identity";

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
  | "EDGE_BOUND_DEPENDENT_AMBIGUOUS"
  | "EDGE_BOUND_RESOLVED_MISSING"
  | "EDGE_BOUND_RESOLVED_NOT_LIVE"
  | "EDGE_BOUND_VERSION_UNPINNED";

/** Injectable seams — every default is the live trusted source / store read. */
export type ResolveEdgeBoundExtensionDeps = {
  /** Source 0: the extension-ctx dependent identity (`ctx.mcp.callPrimitive` ALS frame). */
  getCtxIdentity?: () => ExtensionCtxIdentity | undefined;
  /** Source 1: the run-lineage dependent install id (ActorContext ALS). */
  getDependentInstallId?: () => string | undefined;
  /** Source 2: the VERIFIED (signed-OBO) delegated agent-run id on the MCP frame. */
  getVerifiedRunId?: () => string | undefined;
  readAgentRunById?: (id: string) => Promise<RunRowForEdgeBoundServing | null>;
  readAgentTemplateById?: (
    id: string,
  ) => Promise<{
    packageName?: string | null;
    ownerLevel?: string | null;
    ownerId?: string | null;
  } | null>;
  readInstalledExtensionById?: (id: string) => Promise<InstalledExtension | null>;
  readInstalledExtensionsByPackageName?: (packageName: string) => Promise<InstalledExtension[]>;
};

function liveDeps(deps: ResolveEdgeBoundExtensionDeps): Required<ResolveEdgeBoundExtensionDeps> {
  return {
    getCtxIdentity: deps.getCtxIdentity ?? (() => getExtensionCtxIdentity()),
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

/** The derivation outcome — `ambiguous` maps to a fail-closed refusal. */
export type DerivedDependentInstallId =
  | { kind: "none" }
  | { kind: "derived"; id: string }
  | { kind: "ambiguous"; message: string };

/**
 * Derive the install id a run executes AS, for a run row that carries no
 * `dependent_install_id` (a top-level run, or a pre-Gap-2 row). Trusted rows
 * only. `none` when no candidate exists (compatibility-preserving — the
 * dispatch serves the default); `ambiguous` when multiple candidates survive
 * the template's LOCKED owner-anchor disambiguation (fail-closed — an
 * arbitrary pick could bind the WRONG install's dependency edges).
 */
export async function deriveDependentInstallIdForRun(
  run: RunRowForEdgeBoundServing,
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<DerivedDependentInstallId> {
  const d = liveDeps(deps);
  const template = await d.readAgentTemplateById(run.templateId);
  const packageName = template?.packageName;
  if (!packageName) return { kind: "none" };

  const rows = await d.readInstalledExtensionsByPackageName(packageName);
  // The run's org scope: org-anchored + workspace-level rows. Owner level is
  // NOT an exclusion axis (a team/user-owned install in the run's org is a
  // legitimate run identity — codex round-1); cross-org rows never qualify.
  const scoped = rows.filter(
    (row) =>
      LIVE_STATUSES.has(row.status) &&
      (row.organizationId === null || row.organizationId === (run.orgId ?? null)),
  );

  // REQUIRED pin (versionId + packageVersion — the S7 fail-closed marker pair):
  // the run executes AS the install at that exact version. Unpinned: the run
  // executes the live/default template — a DEFAULT install is its identity.
  const isRequiredPin = run.versionId != null && !!run.packageVersion;
  const candidates = isRequiredPin
    ? scoped.filter((row) => row.version === run.packageVersion)
    : scoped.filter((row) => row.isDefault !== false);

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "derived", id: candidates[0].id };

  // Multiple candidates: disambiguate by the template's LOCKED owner anchor
  // (`ownerLevel`/`ownerId` — the same anchor the OBO-ceiling derivation
  // trusts). Exactly one anchor match wins; anything else is ambiguous.
  const anchorLevel = template?.ownerLevel ?? null;
  const anchorId = template?.ownerId ?? null;
  const anchored =
    anchorLevel !== null
      ? candidates.filter(
          (row) => row.ownerLevel === anchorLevel && (row.ownerId ?? null) === anchorId,
        )
      : [];
  if (anchored.length === 1) return { kind: "derived", id: anchored[0].id };

  return {
    kind: "ambiguous",
    message:
      `run ${run.id} (template ${run.templateId}, package ${packageName}) matches ` +
      `${candidates.length} live install rows in its org and the template's owner anchor ` +
      `(${anchorLevel ?? "none"}/${anchorId ?? "none"}) does not single one out`,
  };
}

/** The trusted-dependent resolution shared by dispatch AND discovery (S8). */
export type EdgeBoundDependentResolution =
  /** No trusted identity — the caller has no edge-bound constraint. */
  | { kind: "none" }
  /** The dependent's canonical row (its edges drive every per-package decision). */
  | { kind: "dependent"; row: InstalledExtension }
  /** Fail-closed refusal with evidence (torn/ambiguous identity). */
  | { kind: "refuse"; code: EdgeBoundExtensionRefuseCode; message: string };

/**
 * Map the extension-ctx identity (source 0) to its canonical install row,
 * fail-closed. The identity is host-injected activation identity: a DEFAULT
 * identity selects the package's live default row(s); a NON-DEFAULT identity
 * selects the live non-default row at ITS exact version. Exactly one match
 * binds; zero matches are `none` for a default (a bare/dev extension never
 * installed as a canonical row — compatibility-preserving) but REFUSE for a
 * non-default (a versioned sibling only activates FROM a canonical row, so a
 * missing row is torn state); multiple matches REFUSE (an arbitrary pick could
 * bind the wrong install's edges — same rule as the run derivation).
 */
async function resolveCtxIdentityRow(
  identity: ExtensionCtxIdentity,
  d: Required<ResolveEdgeBoundExtensionDeps>,
): Promise<EdgeBoundDependentResolution> {
  const rows = await d.readInstalledExtensionsByPackageName(identity.packageName);
  const live = rows.filter((row) => LIVE_STATUSES.has(row.status));
  const candidates = identity.isDefault
    ? live.filter((row) => row.isDefault !== false)
    : live.filter((row) => row.isDefault === false && (row.version ?? null) === identity.version);
  if (candidates.length === 1) return { kind: "dependent", row: candidates[0] };
  if (candidates.length === 0) {
    if (identity.isDefault) return { kind: "none" };
    return {
      kind: "refuse",
      code: "EDGE_BOUND_DEPENDENT_MISSING",
      message:
        `edge-bound serving refused — extension-ctx caller ${identity.packageName}@` +
        `${identity.version ?? "(unversioned)"} (non-default) has no live canonical row ` +
        `(torn down mid-flight?); refusing rather than serving an identity-less default`,
    };
  }
  return {
    kind: "refuse",
    code: "EDGE_BOUND_DEPENDENT_AMBIGUOUS",
    message:
      `edge-bound serving refused — extension-ctx caller ${identity.packageName}` +
      `${identity.isDefault ? " (default)" : `@${identity.version ?? "(unversioned)"}`} matches ` +
      `${candidates.length} live install rows; refusing rather than binding an arbitrary ` +
      `install's dependency edges`,
  };
}

/**
 * Resolve the TRUSTED dependent for the current caller — the shared first half
 * of the fail-closed matrix (identity sources 0/1/2 + the top-level
 * derivation). Returns the dependent's ROW so discovery can decide many
 * packages from one resolution. `targetLabel` only shapes refusal messages.
 */
export async function resolveEdgeBoundDependent(
  deps: ResolveEdgeBoundExtensionDeps = {},
  targetLabel = "(discovery)",
): Promise<EdgeBoundDependentResolution> {
  const d = liveDeps(deps);

  // Source 0 — the extension-ctx identity frame (the immediate caller).
  const ctxIdentity = d.getCtxIdentity();
  if (ctxIdentity) {
    const viaCtx = await resolveCtxIdentityRow(ctxIdentity, d);
    // A default identity with no canonical row falls THROUGH to the run
    // lineage: the ctx frame proves an extension is calling, but a bare/dev
    // extension without an install row has no edges of its own — the outer
    // run's edges (if any) are then the only applicable constraint.
    if (viaCtx.kind !== "none") return viaCtx;
  }

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
          `cannot establish the dependent identity for a dispatch to ${targetLabel}`,
      };
    }
    if (run.dependentInstallId) {
      dependentInstallId = run.dependentInstallId;
    } else {
      const derived = await deriveDependentInstallIdForRun(run, d);
      if (derived.kind === "none") return { kind: "none" };
      if (derived.kind === "ambiguous") {
        return {
          kind: "refuse",
          code: "EDGE_BOUND_DEPENDENT_AMBIGUOUS",
          message:
            `edge-bound serving refused — cannot derive an unambiguous dependent identity for a ` +
            `dispatch to ${targetLabel}: ${derived.message}; refusing rather than ` +
            `binding an arbitrary install's dependency edges`,
        };
      }
      dependentInstallId = derived.id;
    }
  }

  const dependent = await d.readInstalledExtensionById(dependentInstallId);
  if (!dependent) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_DEPENDENT_MISSING",
      message:
        `edge-bound serving refused — trusted dependent install ${dependentInstallId} has no ` +
        `canonical row (torn down mid-flight?); refusing a dispatch to ${targetLabel} ` +
        `rather than serving an identity-less default`,
    };
  }
  return { kind: "dependent", row: dependent };
}

/**
 * Decide the served version of `targetPackageName` for a KNOWN dependent row —
 * the shared second half of the fail-closed matrix (edge → resolved row →
 * live → default/versioned).
 */
export async function decideEdgeBoundVersionForDependent(
  dependent: InstalledExtension,
  targetPackageName: string,
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<EdgeBoundExtensionVersionDecision> {
  const d = liveDeps(deps);
  const dependentInstallId = dependent.id;

  const edge = (dependent.dependencyEdges ?? []).find(
    (e) => e.packageName === targetPackageName && e.resolvedInstallId != null,
  );
  if (!edge || edge.resolvedInstallId == null) return { kind: "none" };

  const resolvedRow = await d.readInstalledExtensionById(edge.resolvedInstallId);
  if (!resolvedRow) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_RESOLVED_MISSING",
      message:
        `edge-bound serving refused — dependent install ${dependentInstallId} resolved its edge ` +
        `to ${targetPackageName} install ${edge.resolvedInstallId}, but that row is gone; ` +
        `refusing rather than silently serving the default`,
    };
  }
  if (!LIVE_STATUSES.has(resolvedRow.status)) {
    return {
      kind: "refuse",
      code: "EDGE_BOUND_RESOLVED_NOT_LIVE",
      message:
        `edge-bound serving refused — dependent install ${dependentInstallId} resolved its edge ` +
        `to ${targetPackageName} install ${resolvedRow.id}, which is "${resolvedRow.status}" ` +
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
        `to a NON-DEFAULT install of ${targetPackageName} (install ${resolvedRow.id}) that ` +
        `carries NO version pin; refusing rather than silently serving the default`,
    };
  }
  return { kind: "versioned", version, resolvedInstallId: resolvedRow.id };
}

/**
 * Resolve the edge-bound serving decision for a NON-AGENT dispatch to
 * `targetPackageName`. Pure over its injected deps (unit-testable without an
 * ALS frame or a DB); see the module header for the fail-closed matrix.
 * Composition of `resolveEdgeBoundDependent` + `decideEdgeBoundVersionForDependent`
 * (behavior-identical to the pre-S8 single function for identity sources 1/2).
 */
export async function resolveEdgeBoundExtensionVersion(
  input: { targetPackageName: string },
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<EdgeBoundExtensionVersionDecision> {
  const dependent = await resolveEdgeBoundDependent(deps, input.targetPackageName);
  if (dependent.kind === "none") return { kind: "none" };
  if (dependent.kind === "refuse") return dependent;
  return decideEdgeBoundVersionForDependent(dependent.row, input.targetPackageName, deps);
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
  // Capture the global handler DETACHED before any await — the pre-slice
  // chokepoints invoked `const handler = tool.handler; handler(input)` unbound,
  // and the absent-identity path must stay byte-identical (codex round-1: the
  // public handler type does not declare `this: void`, so a bound `tool.handler(
  // input)` call would change `this` semantics).
  const globalHandler = tool.handler;
  const decision = await resolveEdgeBoundExtensionVersion(
    { targetPackageName: tool.packageName },
    deps,
  );
  if (decision.kind === "refuse") {
    throw new EdgeBoundMcpServeRefusal(decision.code, decision.message);
  }
  if (decision.kind === "versioned") {
    const served = resolveVersionKeyedMcpTool(tool.packageName, decision.version, tool.name);
    if (served.kind === "refuse") {
      throw new EdgeBoundMcpServeRefusal(
        served.code,
        `edge-bound serving refused for MCP tool "${tool.name}" — ${served.message}`,
      );
    }
    // Same detached-invocation semantics for the retained handler.
    const versionedHandler = served.value.handler;
    return versionedHandler(input);
  }
  return globalHandler(input);
}

/**
 * Dispatch a VERSIONED-ONLY extension MCP tool — a name that exists in a
 * retained NON-DEFAULT version but NOT in the default's global registration
 * (cinatra#1392 S8 discovery union). There is no global handler to fall back
 * to, so the matrix is STRICT:
 *
 *   - `versioned` → the version-keyed retained handler, fail-closed via
 *     `resolveVersionKeyedMcpTool` (incl. NO_SUCH_HANDLER when the CALLER's
 *     pinned version — possibly a different one than the version that
 *     advertised the name — did not register it);
 *   - `none` / `default` → THROW (the caller's edges do not pin a version
 *     serving this name; for this caller the tool does not exist);
 *   - `refuse` → THROW the evidence-carrying refusal.
 */
export async function dispatchVersionedOnlyExtensionMcpTool(
  target: { packageName: string; name: string },
  input: unknown,
  deps: ResolveEdgeBoundExtensionDeps = {},
): Promise<unknown> {
  const decision = await resolveEdgeBoundExtensionVersion(
    { targetPackageName: target.packageName },
    deps,
  );
  if (decision.kind === "refuse") {
    throw new EdgeBoundMcpServeRefusal(decision.code, decision.message);
  }
  if (decision.kind !== "versioned") {
    throw new EdgeBoundMcpServeRefusal(
      "EDGE_BOUND_VERSIONED_ONLY_UNBOUND",
      `edge-bound serving refused — MCP tool "${target.name}" exists only in a retained ` +
        `non-default version of ${target.packageName}, and the caller's resolved edges do not ` +
        `pin a non-default version of that package (the tool is not served to this caller)`,
    );
  }
  const served = resolveVersionKeyedMcpTool(target.packageName, decision.version, target.name);
  if (served.kind === "refuse") {
    throw new EdgeBoundMcpServeRefusal(
      served.code,
      `edge-bound serving refused for MCP tool "${target.name}" — ${served.message}`,
    );
  }
  const versionedHandler = served.value.handler;
  return versionedHandler(input);
}

// ---------------------------------------------------------------------------
// TOOL DISCOVERY UNION (cinatra#1392 S8)
// ---------------------------------------------------------------------------

/** The default-registry tool shape the planner consumes (registry entry). */
export type DiscoveryDefaultTool = {
  name: string;
  packageName: string;
  description?: string;
  inputSchema?: unknown;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

/** One tool a per-request MCP server build must register for the CURRENT caller. */
export type ExtensionToolDiscoveryEntry =
  /** The default replay entry — dispatch via `dispatchExtensionMcpToolEdgeBound`. */
  | { mode: "default"; tool: DiscoveryDefaultTool }
  /**
   * An edge-resolved NON-DEFAULT version's retained tool: advertise ITS
   * name/description and validate input against ITS registered schema. When the
   * default set has the same name, `defaultTool` carries it so the dispatch
   * chokepoint keeps the exact S7 call-time semantics (a mid-flight decision
   * flip to default serves the global handler); absent, the strict
   * versioned-only dispatch applies.
   */
  | {
      mode: "versioned";
      packageName: string;
      version: string;
      tool: RetainedVersionKeyedMcpTool;
      defaultTool?: DiscoveryDefaultTool;
    };

export type ExtensionToolDiscoveryPlan = {
  entries: ExtensionToolDiscoveryEntry[];
  /**
   * Diagnostics for the server build's log line: identity-level refusals and
   * per-package torn-retention downgrades (where default names stay advertised
   * so the call-time chokepoint surfaces the evidence-carrying refusal).
   */
  notes: string[];
};

/** Planner seams beyond the resolver deps (the bulk retained-tool lookup). */
export type PlanExtensionToolDiscoveryDeps = ResolveEdgeBoundExtensionDeps & {
  resolveVersionKeyedMcpToolSet?: (
    packageName: string,
    version: string,
  ) => VersionKeyedServeResult<readonly RetainedVersionKeyedMcpTool[]>;
};

/**
 * Plan the extension-tool registration set for the CURRENT caller (per-request
 * server build). Order is deliberate and deterministic:
 *   - the default registry order is preserved (a no-identity / no-pins plan is
 *     the EXACT default replay — byte-identical pre-S8 behavior);
 *   - a pinned package's both-present names occupy their default positions;
 *   - names existing ONLY in the pinned version are appended after the default
 *     block, grouped per package (first-seen package order, then lexicographic
 *     for edge-target packages that register no default tools).
 * Fail-closed downgrades (identity refuse / torn retained lookup) keep the
 * DEFAULT names advertised: every call then flows through the dispatch
 * chokepoint, which re-resolves and throws the evidence-carrying refusal (a
 * hidden tool would swallow the evidence).
 */
export async function planExtensionToolDiscovery(
  defaultTools: readonly DiscoveryDefaultTool[],
  deps: PlanExtensionToolDiscoveryDeps = {},
): Promise<ExtensionToolDiscoveryPlan> {
  const notes: string[] = [];
  const defaultPlan = (): ExtensionToolDiscoveryPlan => ({
    entries: defaultTools.map((tool) => ({ mode: "default" as const, tool })),
    notes,
  });

  const dependent = await resolveEdgeBoundDependent(deps);
  if (dependent.kind === "none") return defaultPlan();
  if (dependent.kind === "refuse") {
    notes.push(`identity refuse (${dependent.code}) — default names advertised; calls will refuse`);
    return defaultPlan();
  }

  const resolveToolSet =
    deps.resolveVersionKeyedMcpToolSet ??
    ((packageName: string, version: string) => resolveVersionKeyedMcpTools(packageName, version));

  // One decision per package (memoised) across the default set + the
  // dependent's resolved-edge targets.
  const decisionByPkg = new Map<string, Promise<EdgeBoundExtensionVersionDecision>>();
  const decide = (pkg: string): Promise<EdgeBoundExtensionVersionDecision> => {
    let p = decisionByPkg.get(pkg);
    if (!p) {
      p = decideEdgeBoundVersionForDependent(dependent.row, pkg, deps);
      decisionByPkg.set(pkg, p);
    }
    return p;
  };

  // The servable retained tool set per VERSIONED-pinned package; `null` marks a
  // torn lookup (downgrade to default names, call-time refusal).
  const servedSetByPkg = new Map<string, readonly RetainedVersionKeyedMcpTool[] | null>();
  const versionByPkg = new Map<string, string>();

  const entries: ExtensionToolDiscoveryEntry[] = [];
  const pkgOrder: string[] = [];
  const seenPkg = new Set<string>();
  const defaultNamesByPkg = new Map<string, Set<string>>();
  for (const tool of defaultTools) {
    let names = defaultNamesByPkg.get(tool.packageName);
    if (!names) defaultNamesByPkg.set(tool.packageName, (names = new Set()));
    names.add(tool.name);
  }

  // Pass 1 — the default registry order, versioned substitution in place.
  for (const tool of defaultTools) {
    const pkg = tool.packageName;
    if (!seenPkg.has(pkg)) {
      seenPkg.add(pkg);
      pkgOrder.push(pkg);
    }
    const decision = await decide(pkg);
    if (decision.kind === "none" || decision.kind === "default") {
      entries.push({ mode: "default", tool });
      continue;
    }
    if (decision.kind === "refuse") {
      if (!servedSetByPkg.has(pkg)) {
        servedSetByPkg.set(pkg, null);
        notes.push(`${pkg}: decision refuse (${decision.code}) — default names advertised; calls will refuse`);
      }
      entries.push({ mode: "default", tool });
      continue;
    }
    // versioned — resolve the retained set once per package.
    if (!servedSetByPkg.has(pkg)) {
      const served = resolveToolSet(pkg, decision.version);
      if (served.kind === "refuse") {
        servedSetByPkg.set(pkg, null);
        notes.push(
          `${pkg}@${decision.version}: retained lookup refuse (${served.code}) — default names ` +
            `advertised; calls will refuse`,
        );
      } else {
        servedSetByPkg.set(pkg, served.value);
        versionByPkg.set(pkg, decision.version);
      }
    }
    const servedSet = servedSetByPkg.get(pkg);
    if (servedSet === null || servedSet === undefined) {
      entries.push({ mode: "default", tool });
      continue;
    }
    const retained = servedSet.find((t) => t.name === tool.name);
    if (retained) {
      entries.push({
        mode: "versioned",
        packageName: pkg,
        version: decision.version,
        tool: retained,
        defaultTool: tool,
      });
    }
    // else: the pinned version does not register this default name — for this
    // caller the tool does not exist (calling it would refuse NO_SUCH_HANDLER),
    // so it is NOT advertised.
  }

  // Edge-target packages that register no default tools still contribute their
  // pinned version's names (lexicographic for determinism).
  const edgeTargets = (dependent.row.dependencyEdges ?? [])
    .filter((e) => e.resolvedInstallId != null)
    .map((e) => e.packageName)
    .filter((pkg) => !seenPkg.has(pkg))
    .sort();
  for (const pkg of edgeTargets) {
    if (seenPkg.has(pkg)) continue;
    seenPkg.add(pkg);
    pkgOrder.push(pkg);
    const decision = await decide(pkg);
    if (decision.kind !== "versioned") continue; // no default names to advertise either
    const served = resolveToolSet(pkg, decision.version);
    if (served.kind === "refuse") {
      servedSetByPkg.set(pkg, null);
      notes.push(
        `${pkg}@${decision.version}: retained lookup refuse (${served.code}) — no names advertised ` +
          `(the package registers no default tools)`,
      );
      continue;
    }
    servedSetByPkg.set(pkg, served.value);
    versionByPkg.set(pkg, decision.version);
  }

  // Pass 2 — append the VERSIONED-ONLY names (retained names the default set
  // does not register), grouped per package in first-seen order.
  for (const pkg of pkgOrder) {
    const servedSet = servedSetByPkg.get(pkg);
    if (!servedSet) continue;
    const version = versionByPkg.get(pkg);
    if (!version) continue;
    const defaultNames = defaultNamesByPkg.get(pkg) ?? new Set<string>();
    for (const retained of servedSet) {
      if (defaultNames.has(retained.name)) continue; // placed in pass 1
      entries.push({ mode: "versioned", packageName: pkg, version, tool: retained });
    }
  }

  return { entries, notes };
}
