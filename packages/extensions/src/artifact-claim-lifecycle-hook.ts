import "server-only";

// FAIL-CLOSED artifact-extension CLAIM-ARCHIVAL lifecycle seam (cinatra#1454 —
// wiring the ratified "rows governed by extension lifecycle" disposition). When
// a `kind:"artifact"` extension is ARCHIVED — an org-admin uninstall, a
// platform-admin archive-branch uninstall, or an explicit archive — the
// extension's manifest `objectTypes` claims must be RETIRED and its eligible
// semantic assertions (the canonical rows it governs) ARCHIVED. That is the
// durable, replayable half of the claim lifecycle
// (`@/lib/objects/artifact-claim-lifecycle` `retireArtifactExtensionClaims`).
// Before this seam the archive/uninstall dispatch only LOGGED
// (artifact-handler.ts), so an archived artifact extension left its type claims
// live and its governed rows un-archived — the gap #1454 closes.
//
// LAYERING: the archival IMPLEMENTATION lives in the host (`@/lib/objects`),
// which `@cinatra-ai/extensions` cannot import (it would invert the dependency
// direction), so the host injects it via a `globalThis`-anchored slot — the
// same pattern as `setExtensionDashboardLifecycleHook` /
// `setExtensionDataTeardownHook`. The dispatcher AWAITS it.
//
// FAIL-CLOSED — the crucial difference from the dashboard / data-teardown seams
// (which are best-effort and SWALLOW a throw, because a migration orphan sweep +
// the reader gate back them up). There is NO boot backstop that re-archives a
// MISSED archival: the install-anchor boot backstop only re-ACTIVATES
// install-active packages, it never re-archives an uninstalled one. So a
// swallowed or skipped archival is a PERMANENT leak — the retired extension's
// type claims stay live and its governed rows stay un-archived. This seam
// therefore:
//   - PROPAGATES a throwing hook. The dispatcher fires this BEFORE it commits
//     the durable row transition, so a throw aborts the whole archive/uninstall
//     (the row stays active and the operator retries) — "reports, never
//     silently drops".
//   - THROWS when NO host hook is wired. The wiring is co-located with the
//     artifact handler's registration (handler-bootstrap.ts + the MCP boot
//     path), and the dispatcher fires this ONLY for `typeId === "artifact"`, so
//     an unwired slot means archival genuinely cannot run in this worker — a
//     fail-closed error, not a silent skip.
//
// SCOPE: the seam itself maps `organizationId == null` → "platform" (the claim
// registry is scope-keyed and platform claims exist), so it is capable of a
// platform-scoped retire. The DISPATCHER, however, currently fires this ONLY for
// ORG-SCOPED rows (see `fireArtifactClaimArchivalForRow` in index.ts): the
// "platform" uninstall scope archives assertions across EVERY org (no org
// filter), a cross-org sweep whose destructive semantics are still unresolved
// (cinatra#1454 remainder R1). The org-scoped path is scope-exact and safe.
//
// REPORTED REMAINDERS (cinatra#1454; codex convergence 2026-07-19 — owner/design
// -gated, NOT silently dropped):
//   R1 platform-scope (NULL-org) archive retirement — needs the cross-org
//      "platform" archival semantics defined before wiring.
//   R2 package-GLOBAL destructive paths (platform-admin hard-delete, forceDelete,
//      purge) — need an ALL-SCOPES retirement primitive; not wired here.
//   R3 RESTORE reactivation — once an org archive retires claims, restore only
//      re-converges at the next boot via the install-anchor claim backstop, not
//      synchronously. Immediate restore reactivation is a follow-up.
//   R4 archive/install SERIALIZATION — archive/uninstall do not hold the install
//      lifecycle lock, so a concurrent update could interleave with retirement; a
//      lock/CAS/fence is a follow-up.

export interface ExtensionArtifactClaimArchivalInput {
  packageName: string;
  /** null | undefined ⇒ platform scope; a string ⇒ `org:<id>` scope. */
  organizationId: string | null | undefined;
  /** The archived row's installed version (recorded on the uninstall operation). */
  extensionVersion: string;
  /** The canonical install row id (recorded on the uninstall operation). */
  installId?: string | null;
  /** The acting principal id (event actor on the operation); a system id when absent. */
  actorPrincipalId?: string;
}

/**
 * Performs the durable claim retirement + assertion archival for a
 * (package, scope). Returns anything (e.g. retired/archived counts) — the
 * result is logged, not depended on. May be sync or async; the firer awaits it.
 */
export type ExtensionArtifactClaimArchivalHook = (
  input: ExtensionArtifactClaimArchivalInput,
) => unknown | Promise<unknown>;

const HOOK_SLOT = Symbol.for("cinatra.extensions.artifactClaimArchivalHook.v1");
type HookHolder = { hook: ExtensionArtifactClaimArchivalHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the durable claim retirement + archival. Pass
 *  `null` to clear (tests). */
export function setExtensionArtifactClaimArchivalHook(
  hook: ExtensionArtifactClaimArchivalHook | null,
): void {
  hookHolder().hook = hook;
}

/**
 * Fire (and AWAIT) the injected claim archival for (package, scope). FAIL-CLOSED
 * (see the module header): a throwing hook PROPAGATES, and a missing host hook
 * THROWS. The dispatcher fires this only for `kind:"artifact"` and BEFORE it
 * commits the durable row transition, so either failure aborts the
 * archive/uninstall (reports, never silently drops). Never swallows.
 */
export async function fireExtensionArtifactClaimArchival(
  input: ExtensionArtifactClaimArchivalInput,
): Promise<void> {
  const { hook } = hookHolder();
  if (!hook) {
    throw new Error(
      `[cinatra:extensions] artifact claim-archival hook is not wired — cannot retire the ` +
        `object-type claims for "${input.packageName}" on archive/uninstall (fail-closed: ` +
        `refusing to archive the extension while its governed rows / type claims stay live)`,
    );
  }
  await hook(input);
}
