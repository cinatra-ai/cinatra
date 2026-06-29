// Pure runtime-install lifecycle gate for AGENT consumer surfaces (cinatra#659).
//
// This is the DECISION half of the runtime-sourced "may this agent be
// discovered / executed" predicate — no IO, no DB. The host wraps it by reading
// the canonical `installed_extension` effective status (the org-aggregate
// `readEffectiveStatusByPackageNames`, a Map<packageName, "active"|"archived">)
// and handing the resolved status for ONE package here.
//
// WHY a separate pure module (mirrors `connector-installed-predicate.ts` from
// cinatra#657): the four non-connector consumer surfaces — `agent_run`
// (execution), the workflow `agent_task` executor + its instantiate/start
// re-auth probe, the `/agents/run` picker, and the `agent_list` MCP discovery
// primitive — must apply ONE consistent runtime-lifecycle rule. Centralizing the
// rule in a pure, directly-unit-tested function keeps the four call sites from
// drifting and keeps the fail-open/fail-closed/CG-1 semantics in exactly one place.
//
// CG-1 (the load-bearing invariant): the boot seeder anchors a canonical
// `installed_extension` row ONLY for bundled packages WITH a serverEntry OR
// required-in-prod. For AGENTS (a serverEntry kind) the seeder DOES anchor a row,
// so a runtime archive is observable as an `archived` status. But a legacy
// agent_templates row that predates lifecycle seeding — or any agent whose
// package the canonical store does not track — has NO row (status `undefined`).
// A naive fail-CLOSED flip ("runnable iff a live row") would BLANK such
// built-in/ungoverned agents. So fail-CLOSED applies ONLY to a RUNTIME-archived
// row (`archived`); NO row (`undefined`) falls back to the bundled/ungoverned
// floor — EXACTLY the rule the skills resolver (`isSkillExtensionLiveFailClosed`
// "no lifecycle rows -> image-shipped floor") and the workflow host-deps
// (`assertExtensionAccess` "no install row -> ungoverned -> allow") already use.
//
// Store-OUTAGE is NOT an input here: it is an IO concern the host wrapper owns
// (a status read that throws). The wrapper treats an outage as fail-OPEN for
// these surfaces — execution/discovery must not be blocked by a degraded status
// store, because the FULL execute gate (ownership / tenancy / project grant) runs
// independently and is the real authorization boundary. This gate is the ADDITIVE
// lifecycle-presence layer; a `true` here is never render/execute authorization.

/** The effective canonical install status for a single package, as resolved by
 *  `readEffectiveStatusByPackageNames`. `undefined` = NO canonical row at all. */
export type AgentEffectiveInstallStatus = "active" | "archived" | undefined;

/**
 * Decide whether an agent is runnable/discoverable for the runtime-lifecycle
 * gate, from an already-read effective status.
 *
 * Rule:
 *   1. `packageName == null`        → runnable. A legacy/no-package template is
 *      not lifecycle-tracked; this gate never blocks it (unchanged behavior).
 *   2. status `"active"`            → runnable. The runtime source of truth says
 *      at least one canonical row is `active|locked`.
 *   3. status `"archived"`          → NOT runnable. Every canonical row for this
 *      package is archived — an operator disabled/uninstalled it. FAIL-CLOSED:
 *      the bundled floor must NOT resurrect an explicitly archived agent.
 *   4. status `undefined` (no row)  → runnable. CG-1 bundled/ungoverned floor: a
 *      package the canonical store does not track is "live by being installed"
 *      (same rule skills + workflows use). This is the ONLY case the bundled
 *      fallback applies — a present-but-archived row never falls back.
 *
 * NOTE on store outage: callers that read the status with a try/catch should, on
 * a read failure, pass `undefined` (no proven archive) — which yields `true`
 * (fail-OPEN). Never invent an `archived` on an outage.
 */
export function isAgentRuntimeRunnable(input: {
  packageName: string | null | undefined;
  effectiveStatus: AgentEffectiveInstallStatus;
}): boolean {
  if (input.packageName == null) return true; // (1) untracked legacy template
  if (input.effectiveStatus === "archived") return false; // (3) explicit archive — fail-closed
  // (2) "active" and (4) undefined/no-row both resolve to runnable: a live row is
  // the runtime source of truth; no row is the CG-1 bundled/ungoverned floor.
  return true;
}

/** Override the canonical effective-status reader (tests). Mirrors
 *  `readEffectiveStatusByPackageNames`'s shape: a Map keyed by packageName whose
 *  value is the live-wins effective status; an ABSENT key means NO canonical row. */
export type ReadEffectiveInstallStatus = (
  packageNames: string[],
) => Promise<Map<string, "active" | "archived">>;

/**
 * Read the canonical effective install status for `packageNames` and gate each
 * against {@link isAgentRuntimeRunnable}, returning the set of packageNames that
 * are RUNNABLE (live or no-row/CG-1; not runtime-archived).
 *
 * Fail-OPEN on a canonical-store OUTAGE: a read failure resolves EVERY input as
 * runnable (no proven archive) so a degraded status store never blocks
 * discovery/execution — the ownership/tenancy/project gates at each call site are
 * the real authorization boundary. The status read goes through a FAIL-SOFT
 * dynamic import of `@cinatra-ai/extensions/canonical-store` (the established
 * `@cinatra-ai/agents -> @cinatra-ai/extensions` static-cycle break).
 *
 * Returns a `Set<string>` of runnable names; callers keep only items whose
 * packageName is in the set (and treat a `null` packageName as runnable per
 * the pure gate's case 1).
 */
export async function resolveRunnableAgentPackageNames(
  packageNames: ReadonlyArray<string | null | undefined>,
  deps: { readStatus?: ReadEffectiveInstallStatus } = {},
): Promise<Set<string>> {
  const named = [...new Set(packageNames.filter((p): p is string => typeof p === "string" && p.length > 0))];
  if (named.length === 0) return new Set();
  let statusMap: Map<string, "active" | "archived">;
  try {
    const readStatus =
      deps.readStatus ??
      (await import("@cinatra-ai/extensions/canonical-store")).readEffectiveStatusByPackageNames;
    statusMap = await readStatus(named);
  } catch (err) {
    // Canonical-store OUTAGE → fail-OPEN: every input is runnable (never invent
    // an archive). The per-site ownership/tenancy gates still apply.
    console.warn(
      "[agents/runtime-install-gate] effective-status read failed — treating all agents as runnable (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return new Set(named);
  }
  const runnable = new Set<string>();
  for (const name of named) {
    if (isAgentRuntimeRunnable({ packageName: name, effectiveStatus: statusMap.get(name) })) {
      runnable.add(name);
    }
  }
  return runnable;
}
