import "server-only";

// CG-5 runtime-cube serve-gate (cinatra#660 / PR-7).
//
// The cube install-active + trust check that BOTH transports (HTTP cubejs route
// + MCP cube tools) apply BEFORE serving a query. It is ADDITIVE over the
// drizzle-cube `getSecurityContext` tenant predicate — it NEVER replaces it. The
// tenant predicate (`org_id IN accessibleOrgIds OR run_by = userId`, etc.) stays
// on BOTH transports for BOTH runtime AND bundled cubes; this gate adds, for
// RUNTIME cubes only, the assertion that the contributing extension is
// install-active for the actor and in a trusted state.
//
// "Bundled bypass": a bundled (host-owned) cube has NO install row by design, so
// it skips ONLY the install-row assertion — it does NOT bypass tenant isolation.
//
// Pure decision function: the host resolvers (is-this-cube-runtime, and the
// per-package install-active+trust read) are INJECTED, so this module imports no
// store and is unit-testable without a DB.

export type RuntimeCubeServeVerdict =
  | { ok: true }
  | { ok: false; code: "cube_not_active" | "cube_untrusted"; reason: string };

/**
 * The install-active + trust facts the gate needs about a runtime cube's source
 * package, for a specific actor. Derived from the installed-extension read-model
 * (`buildInstalledExtensionReadModel`): `actorVisible` + a live (`active`|
 * `locked`) status proves install-active for the actor; the trust verdict
 * proves trust state.
 */
export type RuntimeCubeInstallFacts = {
  /** Whether ANY install row for the source package is addressable to the actor. */
  readonly actorVisible: boolean;
  /** The actor-scoped lifecycle status: active | locked | archived | absent. */
  readonly status: "active" | "locked" | "archived" | "absent";
  /**
   * The host import-trust verdict for the source package, or null when
   * unknown/unresolvable. `null` is treated as DENY (codex-converged:
   * trust==null is deny) for a runtime cube — a runtime cube only serves on a
   * POSITIVE trust signal (`trusted === true`, i.e. integrity-verified +
   * trusted-host + a signature/bootstrap factor; tier `untrusted` never serves).
   */
  readonly trust: { readonly trusted: boolean } | null;
};

/**
 * Decide whether a resolved cube may be SERVED for the actor.
 *
 *   - `isRuntimeCube(cubeId) === false` → bundled cube: ok (install-row bypass;
 *     the tenant predicate still applies downstream).
 *   - runtime cube + facts === null   → no source registration / no facts: DENY
 *     (`cube_not_active`).
 *   - runtime cube not install-active for the actor (not visible, or status not
 *     active|locked) → DENY (`cube_not_active`).
 *   - runtime cube whose trust is null or not a trusted classification → DENY
 *     (`cube_untrusted`).
 *   - otherwise → ok.
 */
export function decideRuntimeCubeServe(input: {
  cubeId: string;
  isRuntimeCube: (cubeId: string) => boolean;
  facts: RuntimeCubeInstallFacts | null;
}): RuntimeCubeServeVerdict {
  if (!input.isRuntimeCube(input.cubeId)) {
    // Bundled host cube: no install row exists by design. Tenant isolation is
    // still enforced by the drizzle-cube predicate downstream.
    return { ok: true };
  }
  const facts = input.facts;
  if (!facts) {
    return {
      ok: false,
      code: "cube_not_active",
      reason: `runtime cube "${input.cubeId}" has no active install for the actor`,
    };
  }
  const isLive = facts.actorVisible && (facts.status === "active" || facts.status === "locked");
  if (!isLive) {
    return {
      ok: false,
      code: "cube_not_active",
      reason: `runtime cube "${input.cubeId}" is not install-active for the actor (status: ${facts.status})`,
    };
  }
  if (!facts.trust || facts.trust.trusted !== true) {
    return {
      ok: false,
      code: "cube_untrusted",
      reason: `runtime cube "${input.cubeId}" source package is not in a trusted state`,
    };
  }
  return { ok: true };
}

/**
 * Filter a CATALOG cube-id list (HTTP `/meta` + MCP `discover`) to the cubes the
 * actor may see: every bundled cube, plus only the runtime cubes that pass the
 * serve-gate for the actor. `factsFor` resolves the install facts for a runtime
 * cube's source package; bundled cubes never call it.
 *
 * This prevents the EXISTENCE of a runtime cube (from another org's install)
 * from leaking through the catalog surfaces, mirroring the serve-gate on
 * load/chart.
 */
export async function filterServeableCubeIds(input: {
  cubeIds: readonly string[];
  isRuntimeCube: (cubeId: string) => boolean;
  factsFor: (cubeId: string) => Promise<RuntimeCubeInstallFacts | null>;
}): Promise<string[]> {
  const out: string[] = [];
  for (const cubeId of input.cubeIds) {
    if (!input.isRuntimeCube(cubeId)) {
      out.push(cubeId);
      continue;
    }
    const facts = await input.factsFor(cubeId);
    const verdict = decideRuntimeCubeServe({ cubeId, isRuntimeCube: input.isRuntimeCube, facts });
    if (verdict.ok) out.push(cubeId);
  }
  return out;
}
