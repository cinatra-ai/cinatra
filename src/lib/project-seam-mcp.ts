import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  resourceWithinCeiling,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { readAgentRunById, readAgentTemplateById } from "@cinatra-ai/agents";
import {
  readProjectInstance,
  type ProjectInstanceRecord,
} from "@cinatra-ai/agents/project-instance-store";
import { acquireProjectLease } from "@cinatra-ai/agents/project-lease-store";
import {
  materializeProjectTemplate,
  readyItems,
  PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { instantiateProject } from "@/lib/project-instantiation";
import { dispatchProjectWorker } from "@/lib/project-dispatch";
import { resolveInstalledProjectTemplate } from "@/lib/project-template-resolve";
import { resolvePersistedPmWorkStore } from "@/lib/pm-work-store-selection";

// ---------------------------------------------------------------------------
// Host tool seam for the project-manager pilot (cinatra#1033 W3 / #1032 D3).
//
// Exposes the three W2 host primitives — instantiateProject (+ deterministic
// materialization), the readyItems tick context, and dispatchProjectWorker — as
// RUN-TOKEN-AUTHENTICATED MCP tools the host offers to the PM seat's OWN agent
// run. The seat agent (project-manager-agent) drives them from its tick-shell
// OAS; the authoritative agent-supplied-vs-host-derived field split is pinned by
// that repo's `metadata.cinatra.projectPrimitiveTools` contract and its
// tick-shell-contract tests. The advertised inputSchema below is the reciprocal
// host-side pin: the tool advertises EXACTLY the agent-suppliable fields, and a
// `.strict()` parse fail-closed REFUSES any trust operand an agent tries to
// smuggle (orgId / pmAgentPackage / items / lease / parentRunId).
//
// AUTH — compose the shipped run-identity spine, NO new mechanism:
//   * the calling identity is resolved from the MCP request CONTEXT
//     (mcpRequestContextStorage), the frame the transport stamps from the
//     resolved run context (resolveRequestRunContext precedence
//     obo > durable > registry > header). A verified agent-run OBO token is the
//     only channel that carries `oboCeiling`, so its PRESENCE (+ a runId + an
//     orgId + a live run row in that org) is the run-token gate. Absent / invalid
//     run context → REJECT (fail closed). Session / chat / A2A / machine callers
//     carry no chain and are refused.
//   * every host-derived TRUST OPERAND is bound server-side: orgId + parentRunId
//     from the run token, pmAgentPackage from the calling run's own agent
//     package, `items` from the persisted provider's live PmWorkStore, and the
//     project `lease` acquired AS the calling run. None is ever read from input.
//   * OBO SCOPE-CEILING CONTAINMENT: the target project scope
//     ({ orgId, projectId }) must fall within the calling run's persisted
//     oboCeiling (resourceWithinCeiling — satisfy-all, never a vacuous allow), so
//     a run anchored to one project can never drive another. The dispatch
//     primitive additionally re-derives + composes the CHILD run's ceiling from
//     this same parent chain (server-side); the seam never copies a ceiling.
//
// Never throws to the transport: every failure resolves to a structured tool
// envelope whose `status` is one of the primitive's declared outcomes.
// ---------------------------------------------------------------------------

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The project lease TTL the seam acquires per dispatch — long enough to fence
 *  one dispatch against a concurrent tick, short enough that a crashed tick's
 *  lease expires and recovers. The dispatch ledger (not the lease) is the real
 *  idempotency claim; the lease is the mutual-exclusion fence. */
const PROJECT_LEASE_TTL_MS = 5 * 60_000;

// Fixed, self-contained model-visible messages. No upstream-derived string
// (provider id, package name, resolver reason) is ever forwarded to the model —
// the structured CODE carries the actionable signal and the specifics are logged
// server-side only.
const MSG_PROVIDER_DISCONNECTED = "the project's PM work-store provider is not connected";
const MSG_TEMPLATE_UNRESOLVED = "the project's template package no longer resolves to a valid install";

/** The closed NotReadyReason vocabulary (mirrors the sdk-extensions
 *  project-template contract). Only a value on THIS in-file allowlist is echoed
 *  to the model, so an upstream change can never smuggle an arbitrary string. */
const NOT_READY_REASONS: ReadonlySet<string> = new Set([
  "not_pickable_status",
  "claimed",
  "deps_unmet",
  "not_yet_started",
]);

// ── agent-suppliable input schemas (`.strict()` = the reciprocal pin) ────────
// Trust operands (orgId, pmAgentPackage, items, lease, parentRunId) are NOT
// declared here, and `.strict()` rejects them if an agent supplies them anyway.

const instantiateSchema = z
  .object({
    projectRef: z.string().min(1),
    templatePackage: z.string().min(1),
    anchorDate: z.string().regex(YMD, "anchorDate must be YYYY-MM-DD"),
    projectId: z.string().min(1).optional(),
    configuredProviderId: z.string().min(1).optional(),
  })
  .strict();

const tickContextSchema = z
  .object({
    projectRef: z.string().min(1),
    asOf: z.string().regex(YMD, "asOf must be YYYY-MM-DD").optional(),
  })
  .strict();

const dispatchSchema = z
  .object({
    projectRef: z.string().min(1),
    pick: z.string().min(1),
    role: z.string().min(1),
    asOf: z.string().regex(YMD, "asOf must be YYYY-MM-DD"),
    actionVersion: z.number().int().min(0),
    runInput: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** The agent-suppliable field lists — asserted against the OAS contract by the
 *  seam test, and the source of the advertised schemas above. */
export const PROJECT_SEAM_AGENT_SUPPLIED = {
  project_instantiate: ["projectRef", "templatePackage", "anchorDate", "projectId", "configuredProviderId"],
  project_tick_context: ["projectRef", "asOf"],
  project_dispatch_worker: ["projectRef", "pick", "role", "asOf", "actionVersion", "runInput"],
} as const;

/** Trust operands an agent must NEVER be able to supply on ANY tool. */
export const PROJECT_SEAM_FORBIDDEN_FIELDS = [
  "orgId",
  "pmAgentPackage",
  "items",
  "lease",
  "parentRunId",
] as const;

const TOOL_META = {
  project_instantiate: {
    description:
      "Instantiate (or idempotently re-resolve) a PM project and materialize its template into the configured PM work store. You supply { projectRef, templatePackage, anchorDate, projectId?, configuredProviderId? }; the host derives orgId + the PM seat (this run's own agent package). The host enforces the PM-seat kind gate, sticky fail-closed provider selection, and template authority — never pass orgId or pmAgentPackage. Returns { status: 'instantiated' | 'already_instantiated' | 'rejected' | 'failed', code, providerId, ... }; both instantiated and already_instantiated are success.",
    inputSchema: instantiateSchema,
  },
  project_tick_context: {
    description:
      "Read the machine-computed tick context for an instantiated project: the persisted binding, the live work items, and the deterministic ready set (deps done + pickable + unclaimed + start-date reached). You supply { projectRef, asOf? } (asOf defaults to today UTC); the host derives orgId, the instance, the items, and the ready set. Consume the ready set verbatim — never add, drop, or reorder eligibility. Returns { status: 'context' | 'rejected' | 'failed', asOf, instance, items[], readySet[] }. Read-only.",
    inputSchema: tickContextSchema,
  },
  project_dispatch_worker: {
    description:
      "Dispatch the worker agent bound to a ready task's role. You supply { projectRef, pick, role, asOf, actionVersion, runInput }; the host derives orgId, the live items, the project lease (held AS this tick run), and parentRunId (this run). role is the template task's role token — never a package name; the host resolves the binding and enforces the allowlist. Reuse the SAME actionVersion on a crash re-run so the ledger converges (already_dispatched is success). Returns { status: 'dispatched' | 'already_dispatched' | 'rejected' | 'failed', code?, runId?, ... }.",
    inputSchema: dispatchSchema,
  },
} as const;

// ── envelope helpers ─────────────────────────────────────────────────────────

function envelope(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function rejected(code: string, message: string, extra?: Record<string, unknown>) {
  return envelope({ status: "rejected", code, message, ...(extra ?? {}) });
}

function failed(code: string, message: string, extra?: Record<string, unknown>) {
  return envelope({ status: "failed", code, message, ...(extra ?? {}) });
}

/** Forward a composed primitive's `rejected`/`failed` outcome WITHOUT leaking its
 *  raw message. The composed primitives embed raw exception text in SOME of
 *  their failure messages (e.g. project-instantiation.ts / project-dispatch.ts
 *  build a message from `err.message`); the structured CODE is the contract the
 *  agent reports, so keep it and log the underlying message server-side only. */
function forwardMiss(
  status: "rejected" | "failed",
  code: string,
  rawMessage: string,
  extra?: Record<string, unknown>,
) {
  console.warn(`[project-seam] primitive ${status} ${code}:`, rawMessage);
  const generic =
    status === "rejected" ? "the request was refused by project policy" : "the project operation failed";
  return status === "rejected" ? rejected(code, generic, extra) : failed(code, generic, extra);
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** Log a raw fault server-side and return ONLY a generic, display-safe message
 *  to the model — never leak the underlying exception text (provider internals,
 *  file paths, SQL) to the agent. Mirrors the approvals-mcp soft-fail posture. */
function sanitize(context: string, err: unknown, generic: string): string {
  console.warn(`[project-seam] ${context}:`, err instanceof Error ? err.message : err);
  return generic;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Wrap a tool handler so it can NEVER throw to the transport: any unexpected
 *  fault (a store read, a lease write, a resolver) resolves to a structured,
 *  sanitized `failed` envelope. The known business misses are already structured
 *  values returned by the handlers; this is the fail-closed backstop. */
function guarded(handler: (input: unknown) => Promise<ReturnType<typeof envelope>>) {
  return async (input: unknown) => {
    try {
      return await handler(input);
    } catch (err) {
      return failed(
        "PROJECT_SEAM_ERROR",
        sanitize("unhandled tool error", err, "the project host tool encountered an unexpected error"),
      );
    }
  };
}

// ── the run-token seat resolver (fail-closed) ────────────────────────────────

type ResolvedSeat = {
  runId: string;
  orgId: string;
  oboCeiling: OboCeilingChain;
  /** The calling run row (raw read — the run token already authorizes AS it). */
  run: NonNullable<Awaited<ReturnType<typeof readAgentRunById>>>;
};

type SeatResolution =
  | { ok: true; seat: ResolvedSeat }
  | { ok: false; code: "RUN_CONTEXT_REQUIRED"; message: string };

/**
 * Resolve + verify the calling PM seat from the run token. Fail-closed at every
 * gap: a verified agent-run OBO token carries a runId, an orgId, and a non-empty
 * oboCeiling; the runId must resolve to a real run in that org. Anything else is
 * refused — the host tools never run outside a bounded agent-run identity.
 */
async function resolveSeat(): Promise<SeatResolution> {
  const ctx = mcpRequestContextStorage.getStore();

  // Defense-in-depth on the run-token invariant: the transport stamps
  // `oboCeiling` ONLY for a verified agent-run OBO delegation, but reject any
  // NON-agent-run delegation (a chat-delegated token, or the delegated-chat
  // restricted perimeter) explicitly here too — a prompt-injected chat must
  // never drive project instantiation / dispatch, even hypothetically.
  if (ctx?.delegatedRestricted || (ctx?.delegatedActor && ctx.delegatedActor.delegation !== "agent_run")) {
    return {
      ok: false,
      code: "RUN_CONTEXT_REQUIRED",
      message: "a chat-delegated or restricted caller cannot drive the project host tools (fail-closed)",
    };
  }

  const agentRunActor =
    ctx?.delegatedActor && ctx.delegatedActor.delegation === "agent_run"
      ? ctx.delegatedActor
      : null;

  const runId = (ctx?.runId ?? agentRunActor?.runId ?? "").trim();
  const orgId = (ctx?.orgId ?? agentRunActor?.orgId ?? "").trim();
  const oboCeiling = ctx?.oboCeiling ?? agentRunActor?.oboCeiling;

  if (!runId || !orgId) {
    return {
      ok: false,
      code: "RUN_CONTEXT_REQUIRED",
      message: "no authenticated agent-run identity in the request context (fail-closed)",
    };
  }
  if (!Array.isArray(oboCeiling) || oboCeiling.length === 0) {
    return {
      ok: false,
      code: "RUN_CONTEXT_REQUIRED",
      message:
        "the caller carries no OBO scope-ceiling — only a run-token-authenticated agent run may drive the project host tools (fail-closed)",
    };
  }

  const run = await readAgentRunById(runId);
  if (!run || run.orgId !== orgId) {
    return {
      ok: false,
      code: "RUN_CONTEXT_REQUIRED",
      message: `run "${runId}" does not resolve to a run in org ${orgId} (fail-closed)`,
    };
  }

  return { ok: true, seat: { runId, orgId, oboCeiling, run } };
}

/** Does the target project scope fall within the calling run's OBO ceiling?
 *  The org floor is always present; a project-tier ceiling additionally pins the
 *  refinement. `resourceWithinCeiling` never vacuously allows (empty chain =
 *  deny). */
function projectWithinCeiling(orgId: string, projectId: string | null, oboCeiling: OboCeilingChain): boolean {
  return resourceWithinCeiling({ orgId, projectId }, oboCeiling);
}

/** Scope a provider's work-item list to THIS project. `PmWorkStore.listWorkItems`
 *  returns every cinatra-marked item in the provider's project scope, and one
 *  provider can back several logical projectRefs — so filter to the caller's
 *  project by the immutable `<projectRef><SEP><taskId>` natural-key prefix
 *  (the same prefix the dispatch primitive enforces on the pick). This keeps a
 *  sibling project's items out of both the tick context AND the dispatch
 *  readiness set. */
function scopeItemsToProject<T extends { naturalKey: string }>(items: readonly T[], projectRef: string): T[] {
  const prefix = `${projectRef}${PROJECT_TEMPLATE_NATURAL_KEY_SEPARATOR}`;
  return items.filter((it) => it.naturalKey.startsWith(prefix));
}

// ── project_instantiate ──────────────────────────────────────────────────────

async function handleInstantiate(input: unknown) {
  const parsed = instantiateSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = await resolveSeat();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { orgId, oboCeiling, run } = resolution.seat;

  // pmAgentPackage (host-derived) = the calling run's OWN agent package — the PM
  // seat is this run. instantiateProject kind-gates it (must declare the
  // pm-work-store binding); the seam never accepts a seat from input.
  const seatTemplate = await readAgentTemplateById(run.templateId);
  const pmAgentPackage = seatTemplate?.packageName?.trim();
  if (!pmAgentPackage) {
    return rejected(
      "NOT_PM_SEAT",
      `calling run "${run.id}" does not resolve to an installed agent package — it cannot hold the PM seat`,
    );
  }

  const { projectRef, templatePackage, anchorDate, projectId, configuredProviderId } = parsed.data;
  const targetProjectId = projectId ?? null;

  if (!projectWithinCeiling(orgId, targetProjectId, oboCeiling)) {
    return rejected(
      "CEILING_VIOLATION",
      `project scope (project ${targetProjectId ?? "none"}) is outside the calling run's OBO ceiling`,
    );
  }

  try {
    const outcome = await instantiateProject({
      orgId,
      projectRef,
      projectId: targetProjectId,
      templatePackage,
      pmAgentPackage,
      configuredProviderId: configuredProviderId ?? null,
    });

    if (outcome.status === "rejected") {
      return forwardMiss("rejected", outcome.code, outcome.message);
    }
    if (outcome.status === "failed") {
      return forwardMiss("failed", outcome.code, outcome.message);
    }

    // Defense-in-depth: re-assert the AUTHORITATIVE persisted binding is within
    // the ceiling before materializing. A sticky `already_instantiated` resolves
    // by projectRef and can return an instance whose projectId the pre-check
    // (over the agent-SUPPLIED projectId) never saw — never materialize into a
    // project outside the calling run's ceiling.
    if (!projectWithinCeiling(orgId, outcome.instance.projectId, oboCeiling)) {
      return rejected(
        "CEILING_VIOLATION",
        "the resolved project instance is outside the calling run's OBO ceiling",
      );
    }

    // instantiated | already_instantiated — deterministic materialization into
    // the persisted provider's PmWorkStore (find-or-create, idempotent).
    const materialized = await materializeInstance(outcome.instance, anchorDate);
    if (!materialized.ok) {
      return failed("MATERIALIZATION_FAILED", materialized.message, {
        providerId: outcome.instance.providerId,
      });
    }

    return envelope({
      status: outcome.status,
      code: null,
      providerId: outcome.instance.providerId,
      projectRef: outcome.instance.projectRef,
      materializedCount: materialized.count,
      message: `project "${outcome.instance.projectRef}" ${outcome.status} on provider "${outcome.instance.providerId}"; ${materialized.count} work item(s) materialized`,
    });
  } catch (err) {
    return failed(
      "PROJECT_INSTANTIATION_FAILED",
      sanitize("instantiate", err, "instantiation failed unexpectedly"),
    );
  }
}

/** Materialize the instance's pinned template into the persisted provider's
 *  PmWorkStore (find-or-create per natural key — safe to re-run). Never throws:
 *  a provider outage / unresolved template / write fault is a structured miss. */
async function materializeInstance(
  instance: ProjectInstanceRecord,
  anchorDate: string,
): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const providerRes = resolvePersistedPmWorkStore(instance);
  if (!providerRes.ok) {
    console.warn(`[project-seam] materialize: provider "${providerRes.providerId}" disconnected`);
    return { ok: false, message: MSG_PROVIDER_DISCONNECTED };
  }
  const templateRes = await resolveInstalledProjectTemplate(instance.templatePackage, instance.orgId);
  if (!templateRes.ok) {
    console.warn(
      `[project-seam] materialize: template "${instance.templatePackage}" unresolved (${templateRes.reason})`,
    );
    return { ok: false, message: MSG_TEMPLATE_UNRESOLVED };
  }

  try {
    const drafts = materializeProjectTemplate(templateRes.template, {
      projectRef: instance.projectRef,
      anchorDate,
    });
    for (const item of drafts) {
      await providerRes.store.createWorkItem({ item: item.draft });
    }
    return { ok: true, count: drafts.length };
  } catch (err) {
    return { ok: false, message: sanitize("materialize", err, "work-store materialization failed") };
  }
}

// ── project_tick_context ─────────────────────────────────────────────────────

async function handleTickContext(input: unknown) {
  const parsed = tickContextSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = await resolveSeat();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { orgId, oboCeiling } = resolution.seat;

  const { projectRef } = parsed.data;
  const asOf = parsed.data.asOf ?? todayUtc();

  const instance = await readProjectInstance(orgId, projectRef);
  if (!instance) {
    return rejected(
      "PROJECT_NOT_INSTANTIATED",
      `project "${projectRef}" has no instance in org ${orgId} — instantiate it first`,
    );
  }
  if (!projectWithinCeiling(orgId, instance.projectId, oboCeiling)) {
    return rejected("CEILING_VIOLATION", `project "${projectRef}" is outside the calling run's OBO ceiling`);
  }

  const providerRes = resolvePersistedPmWorkStore(instance);
  if (!providerRes.ok) {
    console.warn(`[project-seam] tick: provider "${providerRes.providerId}" disconnected`);
    return failed("PROVIDER_DISCONNECTED", MSG_PROVIDER_DISCONNECTED);
  }

  // The template supplies the per-item role binding + approval gate the tick
  // needs to route dispatch vs human tasks; the live items supply state.
  const templateRes = await resolveInstalledProjectTemplate(instance.templatePackage, orgId);
  if (!templateRes.ok) {
    console.warn(
      `[project-seam] tick: template "${instance.templatePackage}" unresolved (${templateRes.reason})`,
    );
    return failed("TEMPLATE_UNRESOLVED", MSG_TEMPLATE_UNRESOLVED);
  }
  const byKey = new Map(
    materializeProjectTemplate(templateRes.template, { projectRef, anchorDate: asOf }).map((m) => [
      m.draft.naturalKey,
      m,
    ]),
  );

  let allItems: Awaited<ReturnType<typeof providerRes.store.listWorkItems>>;
  try {
    allItems = await providerRes.store.listWorkItems();
  } catch (err) {
    return failed(
      "WORK_STORE_UNAVAILABLE",
      sanitize("listWorkItems", err, "the PM work store is temporarily unavailable"),
    );
  }
  // Scope to THIS project — a shared provider must never surface a sibling
  // project's items into the tick context or the readiness scan.
  const items = scopeItemsToProject(allItems, projectRef);

  const ready = readyItems(items, asOf);
  const readySet = ready.map((it) => {
    const mat = byKey.get(it.naturalKey);
    return {
      pick: it.naturalKey,
      role: mat?.worker?.role ?? null,
      requiresApproval: mat?.requiresApproval ?? false,
      title: it.title,
      body: it.body ?? null,
    };
  });

  return envelope({
    status: "context",
    asOf,
    instance: {
      projectRef: instance.projectRef,
      projectId: instance.projectId,
      templatePackage: instance.templatePackage,
      templateId: instance.templateId,
      pmAgentPackage: instance.pmAgentPackage,
      providerId: instance.providerId,
    },
    items: items.map((it) => ({
      naturalKey: it.naturalKey,
      title: it.title,
      status: it.status,
      startDate: it.startDate ?? null,
      dueDate: it.dueDate ?? null,
      assigneeIds: it.assigneeIds ?? [],
      dependsOn: it.dependsOn ?? [],
    })),
    readySet,
    message: `${readySet.length} ready item(s) of ${items.length} at ${asOf}`,
  });
}

// ── project_dispatch_worker ──────────────────────────────────────────────────

async function handleDispatch(input: unknown) {
  const parsed = dispatchSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = await resolveSeat();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { runId, orgId, oboCeiling, run } = resolution.seat;

  const { projectRef, pick, role, asOf, actionVersion, runInput } = parsed.data;

  const instance = await readProjectInstance(orgId, projectRef);
  if (!instance) {
    return rejected(
      "PROJECT_NOT_INSTANTIATED",
      `project "${projectRef}" has no instance in org ${orgId} — instantiate it first`,
    );
  }
  if (!projectWithinCeiling(orgId, instance.projectId, oboCeiling)) {
    return rejected("CEILING_VIOLATION", `project "${projectRef}" is outside the calling run's OBO ceiling`);
  }

  const providerRes = resolvePersistedPmWorkStore(instance);
  if (!providerRes.ok) {
    console.warn(`[project-seam] dispatch: provider "${providerRes.providerId}" disconnected`);
    return failed("PROVIDER_DISCONNECTED", MSG_PROVIDER_DISCONNECTED);
  }

  // `items` (host-derived): the live cinatra-managed work items — the ready
  // validator's context. Never accepted from input (a caller could otherwise
  // fake readiness), and scoped to THIS project so a shared provider's sibling
  // items never enter the readiness evaluation.
  let allItems: Awaited<ReturnType<typeof providerRes.store.listWorkItems>>;
  try {
    allItems = await providerRes.store.listWorkItems();
  } catch (err) {
    return failed(
      "WORK_STORE_UNAVAILABLE",
      sanitize("listWorkItems", err, "the PM work store is temporarily unavailable"),
    );
  }
  const items = scopeItemsToProject(allItems, projectRef);

  // `lease` (host-derived): acquired AS this tick run (holderId === parentRunId)
  // so a caller can never pair one run's seat authority with a foreign lease.
  const lease = await acquireProjectLease({
    orgId,
    projectRef,
    holderId: runId,
    ttlMs: PROJECT_LEASE_TTL_MS,
  });
  if (!lease) {
    return rejected("LEASE_NOT_HELD", `another tick holds the live lease for project "${projectRef}"`);
  }

  const outcome = await dispatchProjectWorker({
    orgId,
    projectRef,
    items,
    pick,
    asOf,
    actionVersion,
    role,
    runInput,
    runBy: run.runBy ?? null,
    lease: { holderId: lease.holderId, version: lease.version },
    parentRunId: runId,
  });

  switch (outcome.status) {
    case "dispatched":
      return envelope({
        status: "dispatched",
        code: null,
        runId: outcome.runId,
        attemptId: outcome.attemptId,
        idempotencyKey: outcome.idempotencyKey,
        message: `dispatched "${pick}" as role "${role}" (run ${outcome.runId})`,
      });
    case "already_dispatched":
      return envelope({
        status: "already_dispatched",
        code: null,
        runId: outcome.runId,
        attemptId: outcome.attemptId,
        message: `"${pick}" already dispatched (run ${outcome.runId})`,
      });
    case "rejected":
      return forwardMiss("rejected", outcome.code, outcome.message, {
        // Echo the not-ready reason ONLY when it is a value on the in-file
        // closed allowlist — never an arbitrary upstream string.
        ...(outcome.notReadyReason && NOT_READY_REASONS.has(outcome.notReadyReason)
          ? { notReadyReason: outcome.notReadyReason }
          : {}),
      });
    case "failed":
      return forwardMiss("failed", outcome.code, outcome.message);
  }
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerProjectSeamPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "project_instantiate",
    { title: "project_instantiate", ...TOOL_META.project_instantiate },
    guarded(handleInstantiate) as never,
  );
  server.registerTool(
    "project_tick_context",
    { title: "project_tick_context", ...TOOL_META.project_tick_context },
    guarded(handleTickContext) as never,
  );
  server.registerTool(
    "project_dispatch_worker",
    { title: "project_dispatch_worker", ...TOOL_META.project_dispatch_worker },
    guarded(handleDispatch) as never,
  );
}

export function createProjectSeamMcpModule() {
  return { registerCapabilities: registerProjectSeamPrimitives };
}
