// ---------------------------------------------------------------------------
// Agent-catalog removal gate (cinatra#1061).
//
// The agent-catalog removal path (`uninstallRegistryPackage` server action and
// the agents MCP delete handler) hard-deletes an `agent_templates` row directly
// via `deleteAgentTemplate` after authorization only — it never went through the
// extension dispatcher choke-point, so it bypassed BOTH the #1036 system-
// extension protection AND the dependency-closure gate. An agent required by
// another installed agent (a legacy `agentDependencies` edge or a canonical
// runtime edge) could be removed with no refusal, breaking closure.
//
// This gate re-applies the SAME refusals the dispatcher's
// `extensionRegistry.uninstall` runs, composed from the extensions primitives
// (imported via the same subpaths this package already depends on) plus this
// package's own reverse-dependency reader. It is a REFUSAL gate only — it does
// NOT reproduce the dispatcher's success-path archive-vs-hard-delete preservation
// cascade (that is out of scope for #1061; tracked as a follow-up). "Refuse
// identically" is the #1061 acceptance, and that is exactly the gate below.
// ---------------------------------------------------------------------------

import { assertCanRemoveExtension } from "@cinatra-ai/extensions/system-extension-inventory";
import {
  assertArchiveDoesNotBreakClosure,
  listArchiveClosureBlockers,
  ClosureCheckUnavailableError,
  DependencyClosureError,
} from "@cinatra-ai/extensions/dependency-closure";
import {
  listInstalledExtensions,
  readEffectiveStatusByPackageNames,
} from "@cinatra-ai/extensions/canonical-store";
import { readAgentTemplatesDependingOn } from "./store";

/**
 * Refuse removal of `packageName` when it would break the runtime — throwing the
 * SAME typed errors the dispatcher uses so the returned-contract classifier
 * (`@cinatra-ai/extensions/removal-failure`) maps them to the user-facing
 * `system` / `dependents` refusal, and the operator log carries the detail:
 *
 *  1. `SystemExtensionRemovalError` (#1036) — a host-declared system extension
 *     can be updated but never removed. Fail-CLOSED (the inventory is read
 *     fail-loud at module load).
 *  2. `ClosureCheckUnavailableError` (#1061) — the canonical store is
 *     unreachable, so closure cannot be proven → REFUSE (fail-closed), matching
 *     the dispatcher's fail-closed archive-closure gate.
 *  3. `DependencyClosureError` (ARCHIVE_BREAKS_CLOSURE) — an ACTIVE dependent
 *     (canonical edge OR legacy `agentDependencies` edge) requires the target;
 *     the message + `.dependents` NAME the blockers.
 *
 * PURE-until-throw: performs no mutation. Call it BEFORE `deleteAgentTemplate`.
 */
export async function assertAgentTemplateRemovable(packageName: string): Promise<void> {
  // (1) System-extension protection (#1036). Runs first, before any store read,
  // so a system package is refused regardless of store reachability.
  assertCanRemoveExtension(packageName, "uninstall");

  // (2) Canonical closure. FAIL-CLOSED on store outage (#1061): the canonical
  // manifest is the authoritative status store; if it cannot be read we cannot
  // prove no active dependent breaks, so refuse.
  let rows: Awaited<ReturnType<typeof listInstalledExtensions>>;
  try {
    rows = await listInstalledExtensions({});
  } catch {
    throw new ClosureCheckUnavailableError(packageName);
  }
  const target = rows.find((r) => r.packageName === packageName);
  if (target) {
    // Throws DependencyClosureError(ARCHIVE_BREAKS_CLOSURE, dependents[]) when an
    // ACTIVE canonical dependent requires the target — identical to the
    // dispatcher's assertCanonicalArchiveClosure.
    assertArchiveDoesNotBreakClosure(target, rows);
  }

  // (3) Legacy agent_templates reverse-dependents (the `agentDependencies` JSONB
  // key set). Mirrors the dispatcher's private `checkDependents` ACTIVE-only
  // refusal, resolving effective status via the SAME canonical helper so the
  // active/archived semantics never drift. An absent canonical row defaults to
  // "active" (fail-safe — over-block a destructive removal rather than drop a
  // live dependent).
  const dependents = await readAgentTemplatesDependingOn(packageName);
  if (dependents.length === 0) return;
  const depNames = dependents
    .map((d) => d.packageName)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const statusMap = await readEffectiveStatusByPackageNames(depNames);
  const activeNames = dependents
    .filter(
      (d) => ((d.packageName ? statusMap.get(d.packageName) : undefined) ?? "active") === "active",
    )
    .map((d) => d.name ?? d.packageName ?? "an active extension");
  if (activeNames.length > 0) {
    throw new DependencyClosureError(
      "ARCHIVE_BREAKS_CLOSURE",
      `Cannot uninstall ${packageName} — required by active dependents: ${activeNames.join(", ")}. Uninstall or archive them first.`,
      activeNames,
    );
  }
}

/**
 * NON-throwing counterpart of `assertAgentTemplateRemovable`'s dependent checks:
 * the display names of ACTIVE dependents that would block removing `packageName`
 * — the union of canonical closure blockers and active legacy `agentDependencies`
 * dependents, computed from the SAME predicates the gate refuses on so a preview
 * and the actual refusal never disagree (cinatra#1061 req 4). Best-effort: a
 * store read failure yields `[]` (the removal gate is still fail-closed and
 * authoritative — this only omits the pre-confirm hint). De-duped; system-
 * extension protection is not reflected here (that is a separate, unconditional
 * refusal surfaced at removal time).
 */
export async function listActiveAgentTemplateDependents(packageName: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    const rows = await listInstalledExtensions({});
    const target = rows.find((r) => r.packageName === packageName);
    if (target) {
      for (const n of listArchiveClosureBlockers(target, rows)) names.add(n);
    }
  } catch {
    // canonical preview omitted — the gate still refuses on the real removal.
  }
  try {
    const dependents = await readAgentTemplatesDependingOn(packageName);
    if (dependents.length > 0) {
      const depNames = dependents
        .map((d) => d.packageName)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      const statusMap = await readEffectiveStatusByPackageNames(depNames);
      for (const d of dependents) {
        const effective = (d.packageName ? statusMap.get(d.packageName) : undefined) ?? "active";
        if (effective === "active") names.add(d.name ?? d.packageName ?? "an active extension");
      }
    }
  } catch {
    // legacy preview omitted — same rationale.
  }
  return [...names];
}
