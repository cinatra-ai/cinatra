// ---------------------------------------------------------------------------
// THE ASSISTANT DELIVERY SEAM (cinatra#2815 S3, epic #2812).
//
// An assignment made for an assistant on a scope page used to reach nothing:
// the assistant execution branch derived required, declared-edge and
// personal-delta members only. This is the missing channel — and it is
// deliberately the SAME channel the agent-run path uses, not a parallel one:
//
//   * the same per-scope assignment store,
//   * the same resolution-time assignability REVALIDATION,
//   * the same effective-5 chain (project -> user -> team(s) -> organization ->
//     workspace) over an IMMUTABLE snapshot,
//   * the same injection ceiling of 8, applied by the injection contract above.
//
// The only thing that differs is WHERE the snapshot comes from: an agent run
// carries its own, an assistant turn resolves the THREAD's. It resolves through
// the thread id the surface vetted as the session — never through
// `assistant_threads.project_id`, which is mutable, and never through the live
// membership of the person typing.
//
// ASSISTANTS TAKE NO CONTEXT ARTIFACTS. There is no artifact read here and the
// injection contract has no context port, so there is no path for one to arrive
// through; the epic's "assistants Skills-only" line holds structurally rather
// than by discipline.
//
// FAIL-CLOSED, NEVER FATAL — the same posture as the agent tier it delegates
// to: every arm that cannot prove a set yields the EMPTY one and the turn
// proceeds. A conversation that loses its assigned skills is degraded; a
// conversation that ENDS because a thread row was briefly unreadable is an
// outage.
// ---------------------------------------------------------------------------
import "server-only";

import { resolveAssignedSkillTier } from "@/lib/agent-assigned-skills-injection";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// ---------------------------------------------------------------------------
// The THREAD's frozen assignment scopes, as a read (cinatra#2815 S3, epic
// #2812).
//
// `assistant_threads.assignment_scope_snapshot` is the immutable twin of
// `agent_runs.assignment_scope_snapshot`: the scopes a conversation was created
// under, decided ONCE. It exists because `assistant_threads.project_id` is
// MUTABLE — a person can move a thread into another project, and if assignment
// scope were read from that column the move would silently re-point the
// conversation at skills nobody gave it. So this read never touches that
// column, and the delivery seam never reads anything else.
//
// It lives HERE rather than as one more function on the assistant-thread store
// for two reasons: the store is a large sync module every chat surface reaches
// and this read is wanted on the assistant DELIVERY path only, and the four
// route graphs that reach this seam have locked module counts which may only
// ever shrink — so the seam and the one read it needs are one module, not two.
// It uses exactly the thread store's own sync primitives, so it is callable
// from the same places.
//
// Returns the RAW payload. The version rule, the shape rule and the sole legacy
// fallback belong to `@cinatra-ai/agents/assignment-scope-snapshot`, and a
// second interpretation here would be a second authority.
// ---------------------------------------------------------------------------
export type ThreadAssignmentScope = {
  /** The raw `assignment_scope_snapshot` payload, or null when the row carries none. */
  snapshot: unknown;
  /** The thread's own organization — the legacy fallback's organization floor. */
  orgId: string | null;
};

/**
 * Read one thread's frozen assignment scopes, or `null` when there is no such
 * thread.
 *
 * NEVER THROWS. The assistant delivery seam is fail-closed: a thread read that
 * fails must degrade a turn's assigned skills, not end the conversation. `null`
 * therefore means "this build cannot vouch for any scope here", which the chain
 * resolves to its narrowest answer.
 */
export function readThreadAssignmentScope(
  threadId: string,
): ThreadAssignmentScope | null {
  const id = typeof threadId === "string" ? threadId.trim() : "";
  if (id === "") return null;
  try {
    ensurePostgresSchema();
    const schema = postgresSchema.replaceAll('"', '""');
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT assignment_scope_snapshot, org_id
                   FROM "${schema}"."assistant_threads" WHERE id = $1 LIMIT 1`,
          values: [id],
        },
      ],
    });
    const row = res?.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const orgId =
      typeof row.org_id === "string" && row.org_id.trim() !== "" ? row.org_id.trim() : null;
    return { snapshot: row.assignment_scope_snapshot ?? null, orgId };
  } catch (err) {
    console.warn(
      "[assistant-assignment-scope] thread scope read failed — the delivery seam " +
        "resolves its narrowest answer (fail-closed); the turn proceeds. cause:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export type AssistantAssignedSkillsDeps = {
  /** The thread's frozen scopes. Default = the real (fail-closed) read. */
  readThreadScope?: (threadId: string) => ThreadAssignmentScope | null;
  /** The shared assigned-skill tier. Default = the real one. NEVER re-derived. */
  resolveTier?: typeof resolveAssignedSkillTier;
};

/**
 * The assigned skill ids one assistant turn receives.
 *
 * `sessionId` is the session the surface vetted. When it names a durable thread
 * the thread's frozen snapshot is what the chain walks; when it names a
 * per-turn binding (the runtime mints one when the surface bound no thread)
 * there is no thread and therefore no snapshot, and the chain resolves its
 * narrowest answer rather than inventing scopes for a conversation that has
 * none. That is the same rule the run path applies to an unattributable
 * dispatch.
 */
export async function resolveAssistantAssignedSkillIds(
  input: { agentId: string; sessionId: string },
  deps: AssistantAssignedSkillsDeps = {},
): Promise<string[]> {
  const agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
  if (agentId === "" || sessionId === "") return [];

  const scope = (deps.readThreadScope ?? readThreadAssignmentScope)(sessionId);

  const outcome = await (deps.resolveTier ?? resolveAssignedSkillTier)(agentId, null, {
    runScope: {
      snapshot: scope?.snapshot ?? undefined,
      // The thread's own organization is the fallback's organization floor —
      // the one layer every conversation in this instance has always had. It is
      // read from the SAME row as the snapshot, so a thread cannot end up
      // floored on an organization it does not belong to.
      durableOrgId: scope?.orgId ?? null,
    },
  });
  return outcome.skillIds;
}
