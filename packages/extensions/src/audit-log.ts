import "server-only";

import type { Actor, PackageRef } from "@cinatra-ai/extension-types";

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
  await insertExtensionLifecycleAudit({
    id: crypto.randomUUID(),
    actorId: actorIdValue,
    actorType: input.actor.actorType,
    orgId: null, // PrimitiveActorContext has no org field; set via caller context if needed
    operation: input.operation,
    packageName: input.packageRef.packageName,
    packageVersion: input.packageRef.version ?? null,
    destroyedRowSnapshot: input.destroyedRowSnapshot,
    danglingReferences: input.danglingReferences,
    reason: input.reason ?? null,
  });
}
