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
  assertArchivePackageDoesNotBreakClosure,
  listArchiveClosureBlockersForPackage,
  ClosureCheckUnavailableError,
  DependencyClosureError,
} from "@cinatra-ai/extensions/dependency-closure";
import {
  listInstalledExtensions,
  readEffectiveStatusByPackageNames,
} from "@cinatra-ai/extensions/canonical-store";
import { readAgentTemplatesDependingOn, deleteAgentTemplate } from "./store";
// Type-only (erased): the audit-event shape the injected logger accepts. Injected
// rather than imported-as-value so this gate module keeps no authz/audit runtime
// edge (dependency inversion) — the MCP handler passes its own logAuditEvent.
import type { AuditEventInput } from "@/lib/authz";

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
  // PACKAGE-LEVEL gate (cinatra#1040 S2): removal operates on the package
  // name, so every row of the package is gated (a dependent pinned by a
  // resolved edge to ANY row blocks). Throws
  // DependencyClosureError(ARCHIVE_BREAKS_CLOSURE, dependents[]) when an
  // ACTIVE canonical dependent requires the target — identical to the
  // dispatcher's assertCanonicalArchiveClosure.
  assertArchivePackageDoesNotBreakClosure(packageName, rows);

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
    // Same PACKAGE-LEVEL union the gate refuses on (cinatra#1040 S2) — the
    // preview and the refusal can never disagree.
    for (const n of listArchiveClosureBlockersForPackage(packageName, rows)) names.add(n);
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

/**
 * MCP-side GUARDED agent-template delete (cinatra#1061). The direct
 * `agent_templates` delete in the agents MCP handler bypassed the extension
 * dispatcher choke-point; this re-applies the removal gate BEFORE deleting, then
 * performs the delete + writes the lifecycle audit row. Returns:
 *   - `{ error }`          — a removal REFUSAL (system / dependents / fail-closed
 *                            outage), audited `denied`; the MCP surface renders
 *                            it structurally (not masked).
 *   - `{ deleted: false }` — no row matched the id (caller returns not-found).
 *   - `{ deleted: true }`  — deleted + audited `allowed`.
 *
 * `logAuditEvent` is INJECTED (dependency inversion) so this gate module keeps no
 * authz/audit runtime edge. Extracted from mcp/handlers.ts so re-gating that
 * bypass does not grow the tracked bottleneck file (file-size ratchet).
 */
export async function deleteAgentTemplateGuarded(
  packageName: string | null | undefined,
  templateId: string,
  ctx: {
    logAuditEvent: (event: AuditEventInput) => void;
    actor: { userId?: string; actorType?: string; source?: string } | undefined;
    policyVersion: AuditEventInput["policyVersion"];
  },
): Promise<{ error: string } | { deleted: boolean }> {
  const auditBase: Omit<AuditEventInput, "decision"> = {
    actorPrincipalId: ctx.actor?.userId,
    actorPrincipalType: (ctx.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
    authSource: (ctx.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
    resourceType: "agent_template",
    resourceId: templateId,
    operation: "delete",
    policyVersion: ctx.policyVersion,
    runId: undefined,
  };
  if (packageName) {
    try {
      await assertAgentTemplateRemovable(packageName);
    } catch (gateErr) {
      ctx.logAuditEvent({ ...auditBase, decision: "denied" });
      return { error: gateErr instanceof Error ? gateErr.message : String(gateErr) };
    }
  }
  const deleted = await deleteAgentTemplate(templateId);
  if (!deleted) return { deleted: false };
  ctx.logAuditEvent({ ...auditBase, decision: "allowed" });
  return { deleted: true };
}
