import "server-only";

import type { Actor, PackageRef } from "@cinatra-ai/extension-types";
import type { ResolvedRowIdentity } from "./lifecycle-target-resolver";

// ---------------------------------------------------------------------------
// DanglingReferences type
// agent_runs_count: exact number, or the string "47+" when the count query
// exceeds the 2s timeout. agent_runs_count_capped: true when the cap fired.
// dependent_extensions: all templates that declare a dep on the target package.
// dependent_extensions_capped: true when the dependents query could not resolve
// within the shared 2s budget — distinguishes the timeout-empty case from a
// real "no dependents" empty array. Without this flag, audit consumers could
// not tell whether [] meant "no other templates declare a dep" or "we never got
// to find out".
// ---------------------------------------------------------------------------
export type DanglingReferences = {
  agent_runs_count: number | string;
  agent_runs_count_capped: boolean;
  dependent_extensions: PackageRef[];
  dependent_extensions_capped: boolean;
};

const TIMEOUT_FALLBACK = "47+";

// ---------------------------------------------------------------------------
// computeDanglingReferences
// Counts agent_runs linked to the target template and collects dependent
// extension package refs. The run-count query races a 2s timeout; on timeout
// the slot is capped to "47+" so the audit row is always written promptly.
// ---------------------------------------------------------------------------
export async function computeDanglingReferences(
  ref: PackageRef,
  options: { timeoutMs?: number } = {},
): Promise<DanglingReferences> {
  const timeoutMs = options.timeoutMs ?? 2000;

  const {
    readAgentTemplateByPackageName,
    countRunsForTemplate,
    readAgentTemplatesDependingOn,
  } = await import("@cinatra-ai/agents");

  const template = await readAgentTemplateByPackageName(ref.packageName);

  // Even when no agent_templates row exists for the package, still query
  // dependents — a force-delete that follows an earlier hard-delete should
  // still capture which OTHER templates declared a dep on the now-missing
  // package. An early return would drop that information from the audit row.
  // Capture the timer handle and clearTimeout in finally so the 2s pending
  // timer doesn't keep the Node event loop alive after the races resolve.
  // Critical for CLI / job-worker contexts at process shutdown.
  // Both queries are raced against a SHARED 2s budget so the dependents query
  // cannot blow past the documented timeout on a slow JSONB `?` lookup.
  const runCountPromise: Promise<number> = template
    ? countRunsForTemplate(template.id)
    : Promise.resolve(0);
  const dependentsPromise = readAgentTemplatesDependingOn(ref.packageName);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  type Resolved = { count: number; dependents: Awaited<typeof dependentsPromise> };
  const bothPromise: Promise<Resolved> = Promise.all([
    runCountPromise,
    dependentsPromise,
  ]).then(([count, dependents]) => ({ count, dependents }));

  let outcome: Resolved | "timeout";
  try {
    outcome = await Promise.race([bothPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome === "timeout") {
    return {
      agent_runs_count: TIMEOUT_FALLBACK,
      agent_runs_count_capped: true,
      // dependents could not be resolved within budget; return [] to honor
      // the timeout contract rather than block on a slow JSONB lookup.
      // dependent_extensions_capped preserves the truth that we never got to
      // find out — audit consumers must not mistake this empty array for "no
      // dependents existed".
      dependent_extensions: [],
      dependent_extensions_capped: true,
    };
  }

  const dependent_extensions: PackageRef[] = outcome.dependents.map((d) => ({
    registryUrl: "",
    packageName: d.packageName ?? "",
    version: d.packageVersion ?? "",
  }));

  return {
    agent_runs_count: outcome.count,
    agent_runs_count_capped: false,
    dependent_extensions,
    dependent_extensions_capped: false,
  };
}

// ---------------------------------------------------------------------------
// writeExtensionLifecycleAuditEntry
// Persists an extension lifecycle event to the extension_lifecycle_audit table.
// Must be called BEFORE the destructive operation — a write failure aborts
// the destroy (no silent deletion without an audit trail).
// ---------------------------------------------------------------------------
export async function writeExtensionLifecycleAuditEntry(input: {
  actor: Actor;
  operation:
    | "force_delete"
    // Platform-admin hard-delete uninstall branch: same pre-destruction
    // provenance record as force_delete (destroyed-row snapshot + dangling
    // references + resolved-row identities) for the other package-global
    // hard-delete path that fires durable teardown (cinatra#1276).
    | "uninstall"
    | "purge"
    | "registry_unpublish"
    | "registry_delete"
    // Purge saga lifecycle states form an append-only trail.
    | "purge_started"
    | "purge_committed"
    | "purge_partial"
    | "purge_rolled_back";
  packageRef: PackageRef;
  destroyedRowSnapshot: unknown;
  danglingReferences: DanglingReferences;
  reason?: string;
  // P5 (cinatra#1130): the canonical rows the (platform-admin-only) package-
  // global destruction affected — recorded so an audit reader can prove which
  // rows were destroyed. Optional (legacy callers omit it). When exactly one
  // row is present its org anchors the audit `orgId`.
  resolvedRows?: ResolvedRowIdentity[];
}): Promise<void> {
  const { insertExtensionLifecycleAudit } = await import("@/lib/database");
  // Prefer the actor's userId (set by trustworthy callers — UI form actions
  // wire session.user.id; MCP registry wires session.user.id from the admin
  // gate). Fall back to a clearly-marked sentinel "system:<source>" for any
  // legacy code path that still constructs an actor without a userId. This
  // avoids a literal "unknown" string masquerading as a real user in audit
  // queries.
  const actorIdValue =
    input.actor.userId ??
    `system:${input.actor.source ?? "unknown"}`;
  const resolvedRows = input.resolvedRows;
  await insertExtensionLifecycleAudit({
    id: crypto.randomUUID(),
    actorId: actorIdValue,
    actorType: input.actor.actorType,
    // Anchor the audit org to the resolved row when exactly one was targeted;
    // a package-global platform-admin destruction (>1 row) leaves orgId null and
    // records every affected row id in the snapshot below.
    orgId:
      resolvedRows && resolvedRows.length === 1
        ? resolvedRows[0].organizationId
        : null,
    operation: input.operation,
    packageName: input.packageRef.packageName,
    packageVersion: input.packageRef.version ?? null,
    // Preserve the destroyed-row snapshot; additively carry the resolved-row
    // identities so an audit reader can prove exactly which canonical rows the
    // op destroyed (escalation-detection signal).
    destroyedRowSnapshot:
      resolvedRows && resolvedRows.length > 0
        ? { snapshot: input.destroyedRowSnapshot, resolvedRows }
        : input.destroyedRowSnapshot,
    danglingReferences: input.danglingReferences,
    reason: input.reason ?? null,
  });
}

// ---------------------------------------------------------------------------
// writeExtensionLifecycleTransitionAudit (P5, cinatra#1130)
// One durable audit row per ROW-SCOPED lifecycle transition (archive / restore /
// activate / soft-uninstall) — the org-admin parity ops. The retired
// package-wide fan-out must never resurrect as N unlabeled transitions, so every
// resolved-row transition records:
//   - the standing-VERIFIED actor (userId + actorType; orgId + role in the row);
//   - the RESOLVED row identity (installed_extension id / organizationId /
//     ownerLevel / ownerId) — so an org-A admin audit row can be proven to never
//     carry an org-B or NULL-org row id.
// The transition itself (`transitionExtensionLifecycle`) flips the canonical
// status but does NOT persist an audit row; this is that durable trail. Unlike
// force_delete's audit (written BEFORE destruction, failure aborts), a
// reversible transition's audit is BEST-EFFORT — a write failure is logged, not
// thrown, so a restorable archive/restore is never aborted by a transient audit
// error (the canonical row is authoritative + the op is reversible).
// ---------------------------------------------------------------------------
export async function writeExtensionLifecycleTransitionAudit(input: {
  actor: Actor;
  operation: "archive" | "restore" | "activate" | "uninstall";
  packageRef: PackageRef;
  resolvedRow: ResolvedRowIdentity;
  /** The standing role that authorized the transition (platform_admin /
   *  org_owner / org_admin) — recorded in `reason`. */
  standingReason: string;
}): Promise<void> {
  try {
    const { insertExtensionLifecycleAudit } = await import("@/lib/database");
    const actorIdValue =
      input.actor.userId ?? `system:${input.actor.source ?? "unknown"}`;
    await insertExtensionLifecycleAudit({
      id: crypto.randomUUID(),
      actorId: actorIdValue,
      actorType: input.actor.actorType,
      orgId: input.resolvedRow.organizationId,
      operation: input.operation,
      packageName: input.packageRef.packageName,
      packageVersion: input.packageRef.version ?? null,
      // No destroyed row (reversible) — carry the resolved-row identity so the
      // audit proves which single row transitioned.
      destroyedRowSnapshot: { resolvedRow: input.resolvedRow },
      danglingReferences: null,
      reason: input.standingReason,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[extensions] lifecycle transition audit write failed for ${input.operation} of ${input.packageRef.packageName} (row ${input.resolvedRow.id}) — reversible op left committed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
