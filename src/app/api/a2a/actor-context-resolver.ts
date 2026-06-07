import "server-only";

import type { ActorContext } from "@/lib/authz/actor-context";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { RunForActorContext } from "@/lib/authz/build-actor-context-from-run";

// Boot-time guard: crash the process if A2A_DEV_BYPASS is set in
// production. This complements the per-request check below (defense in
// depth) and surfaces misconfiguration immediately at startup.
//
// Exempt `next build` page-data collection from the boot guard: during local
// `pnpm build` against a dev `.env.local`, NODE_ENV is automatically
// "production" and A2A_DEV_BYPASS=true, but the build is just collecting
// metadata, not serving requests. The per-request guard below still fires at
// runtime; this only relaxes the module-load guard during the build phase so
// the build can complete.
if (
  process.env.A2A_DEV_BYPASS === "true" &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "A2A_DEV_BYPASS must not be set in production (server-only module load aborted)",
  );
}

/**
 * Pure resolver for the originating ActorContext of an inbound /api/a2a
 * request. Three branches:
 *
 *   1. Service-account JWT — verifyA2AAccessToken already builds the ctx via
 *      buildActorContextFromServiceAccountJwt. Pass-through.
 *   2. Human-originated runBy — JWT subject is valid but no service account
 *      resolved (or A2A flow originated from a WayFlow callback for a human-
 *      triggered run). We look up agent_runs by the A2A taskId, read runBy,
 *      and build the ActorContext from the user record.
 *   3. Dev bypass — A2A_DEV_BYPASS=true synthesizes a loopback context so
 *      local dev still works when neither of the above paths can resolve.
 *
 * Anything else returns { kind: "error", code: "ACTOR_CONTEXT_UNRESOLVABLE" }
 * — fail-closed at the auth boundary.
 *
 * The resolver itself is pure; all I/O (run lookup, user→ctx build) is
 * supplied via the `deps` slot so unit tests can run without DB access.
 */

export type A2AAuthResultLike =
  | { ok: true; subject: string; actorContext?: ActorContext }
  | { ok: false; response: Response };

export type ResolveA2AActorContextDeps = {
  readAgentRunByTaskId: (taskId: string) => Promise<RunForActorContext | null>;
  buildActorContextFromRun: (run: RunForActorContext) => Promise<ActorContext>;
  // A2A_DEV_BYPASS resolves a real default org via this helper so the
  // dev-bypass loopback ctx has a concrete organizationId. Returns null when
  // no default org is found (CI without seeded auth), in which case the
  // resolver returns ACTOR_CONTEXT_UNRESOLVABLE rather than fabricating an
  // undefined organization.
  resolveDefaultOrgId: () => Promise<string | null>;
};

export type ResolveA2AActorContextOutcome =
  | { kind: "ok"; actorContext: ActorContext }
  | { kind: "error"; code: "ACTOR_CONTEXT_UNRESOLVABLE"; message: string };

function extractTaskId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const msg = p.message as Record<string, unknown> | undefined;
  const msgTaskId = msg?.taskId;
  if (typeof msgTaskId === "string" && msgTaskId.length > 0) return msgTaskId;
  const id = p.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

export async function resolveA2AActorContext(args: {
  authResult: A2AAuthResultLike;
  body: unknown;
  env: { A2A_DEV_BYPASS?: string };
  deps: ResolveA2AActorContextDeps;
}): Promise<ResolveA2AActorContextOutcome> {
  const { authResult, body, env, deps } = args;
  if (!authResult.ok) {
    // Caller is responsible for handling auth failures BEFORE invoking the
    // resolver — defensive guard.
    return {
      kind: "error",
      code: "ACTOR_CONTEXT_UNRESOLVABLE",
      message: "auth failed before ActorContext resolution",
    };
  }

  // Branch 1 — service-account JWT.
  if (authResult.actorContext) {
    return { kind: "ok", actorContext: authResult.actorContext };
  }

  // Branch 2 — run-row resolution.
  // Read orgId directly from the run row, NOT from the user's first
  // membership; membership-derived orgs can select the wrong tenant. On any
  // failure (missing run, OrgIdRequiredError, downstream throw) we fall
  // through to ACTOR_CONTEXT_UNRESOLVABLE rather than propagating up to the
  // route handler as a 500.
  const taskId = extractTaskId(body);
  if (taskId) {
    const run = await deps.readAgentRunByTaskId(taskId);
    if (run) {
      try {
        const ctx = await deps.buildActorContextFromRun(run);
        return { kind: "ok", actorContext: ctx };
      } catch (err) {
        // Defensive — the helper throws OrgIdRequiredError when run.orgId is
        // null. The run-row orgId is expected to be present in production; log
        // internally and fall through to the boundary-safe
        // ACTOR_CONTEXT_UNRESOLVABLE response (no stack to peer).
        console.error(
          "[a2a-actor-context] buildActorContextFromRun failed",
          {
            taskId,
            runId: run.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  // Branch 3 — dev bypass.
  // Hard-fail in production. A2A_DEV_BYPASS synthesizes an unscoped loopback
  // ActorContext that combined with workspace-visibility rows (no actor
  // predicate in the workspace clause) leaks every workspace-visibility row
  // across orgs. Crash the request before the bypass branch fires if
  // NODE_ENV=production.
  if (env.A2A_DEV_BYPASS === "true") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "A2A_DEV_BYPASS must not be set in production (refusing to synthesize loopback ActorContext)",
      );
    }
    // Synthesize a real orgId via resolveDefaultOrgId(). Dev-bypass contexts
    // must carry a concrete organizationId so the OrgIdRequiredError gate does
    // not reject every dev-bypass request.
    const devOrgId = await deps.resolveDefaultOrgId();
    if (!devOrgId) {
      return {
        kind: "error",
        code: "ACTOR_CONTEXT_UNRESOLVABLE",
        message: "A2A_DEV_BYPASS=true but no default org found",
      };
    }
    return {
      kind: "ok",
      actorContext: {
        principalType: "InternalWorker",
        principalId: "dev-bypass-loopback",
        organizationId: devOrgId,
        teamIds: [],
        projectIds: [],
        authSource: "a2a",
        policyVersion: POLICY_VERSION,
      },
    };
  }

  return {
    kind: "error",
    code: "ACTOR_CONTEXT_UNRESOLVABLE",
    message: "Cannot resolve ActorContext for this A2A call",
  };
}
