import "server-only";

import { can } from "@/lib/authz";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ResourceRef } from "@/lib/authz/resource-ref";
import { logAuditEventStrict } from "@/lib/authz/audit";

// ---------------------------------------------------------------------------
// Authorization + audit gate for the QueueDash operator surface
// (/api/admin/operations/jobs). This is the destructive operator console:
// QueueDash forwards to BullMQ retry/remove/clean/promote/pause/... mutations.
//
// Design (eng#229, codex-converged):
//   - Classify EACH tRPC procedure in the (possibly batched) request by the
//     router's OWN procedure type map (query vs mutation). This is drift-proof:
//     a procedure not present in the router -> unknown -> DENY (fail-closed),
//     so we never have to maintain a hand-written allowlist that silently rots.
//   - read/list (query) procedures  -> require `operations.read`.
//   - destructive (mutation) procedures -> require `operations.execute` AND a
//     strict pre-forward audit row.
//   - Authorization uses the authz kernel against an ORG-LESS `operations`
//     platform resource, so only platform_admin (the sole holder of
//     `operations.*` grants) passes; org_admin/member never do.
//   - The procedure list is parsed from the URL pathname (the tRPC fetch-adapter
//     convention), batch-aware, for both GET and POST. We classify by procedure
//     NAME only — never by HTTP method — so a mutation can never be smuggled
//     past the gate by changing the verb.
//   - STRICT-BEFORE-MUTATION: if ANY procedure is denied/unknown, OR any audit
//     insert throws, we reject the WHOLE batch and forward nothing. No partial,
//     unaudited execution.
// ---------------------------------------------------------------------------

export const OPERATIONS_JOBS_ENDPOINT = "/api/admin/operations/jobs";

/** Org-less platform resource — forces a platform-only authority check. */
const OPERATIONS_RESOURCE: ResourceRef = {
  resourceType: "operations",
  resourceId: "*",
};

export type ProcedureType = "query" | "mutation";

/** Read the procedure-name -> "query" | "mutation" map from the tRPC router. */
export type ProcedureTypeLookup = (procedurePath: string) => ProcedureType | undefined;

export type GateDecision =
  | { kind: "allow"; destructiveProcedures: string[] }
  | { kind: "deny"; status: number; reason: string };

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Parse the tRPC procedure-name list from a fetch-adapter request URL.
 *
 * tRPC's fetch adapter derives the procedure `path` from the URL pathname
 * after the configured endpoint, decodes it, and (when `?batch=1`) splits it
 * on `,`. Returns `null` for a path that does not belong to this endpoint, an
 * empty path, an undecodable path, or an empty batch member (all fail-closed).
 */
export function parseProcedurePaths(req: Request): string[] | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const pathname = trimSlashes(url.pathname);
  const base = trimSlashes(OPERATIONS_JOBS_ENDPOINT);

  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;

  const encoded = trimSlashes(pathname.slice(base.length));
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  const isBatch = url.searchParams.get("batch") === "1";
  const paths = isBatch ? decoded.split(",") : [decoded];
  if (paths.length === 0 || paths.some((p) => p.length === 0)) return null;
  return paths;
}

/**
 * Authorize a QueueDash operator request: classify each procedure, enforce the
 * platform-level permission, and write a strict audit row for every destructive
 * procedure BEFORE the request is forwarded. Returns an allow/deny decision; on
 * any denial, unknown procedure, or audit failure the WHOLE request is denied.
 */
export async function authorizeOperatorRequest(args: {
  req: Request;
  actor: ActorContext;
  lookupProcedureType: ProcedureTypeLookup;
  requestId?: string;
}): Promise<GateDecision> {
  const { req, actor, lookupProcedureType, requestId } = args;

  const procedures = parseProcedurePaths(req);
  if (!procedures) {
    return { kind: "deny", status: 400, reason: "unparseable tRPC request" };
  }

  // First pass: classify + authorize EVERY procedure. Fail closed on any
  // unknown procedure or any missing permission BEFORE writing any audit row
  // or forwarding anything.
  type Classified = { path: string; type: ProcedureType };
  const classified: Classified[] = [];
  for (const path of procedures) {
    const type = lookupProcedureType(path);
    if (!type) {
      // Unknown procedure — fail closed, never forward to QueueDash.
      return { kind: "deny", status: 403, reason: `unknown procedure: ${path}` };
    }
    const requiredPermission = type === "mutation" ? "operations.execute" : "operations.read";
    if (!can(actor, requiredPermission, OPERATIONS_RESOURCE)) {
      return {
        kind: "deny",
        status: 403,
        reason: `missing ${requiredPermission} for ${path}`,
      };
    }
    classified.push({ path, type });
  }

  const destructive = classified.filter((c) => c.type === "mutation");

  // Second pass: strict pre-forward audit for every destructive procedure. Any
  // insert failure aborts the WHOLE batch (no partial, unaudited execution).
  for (let i = 0; i < destructive.length; i++) {
    const { path } = destructive[i]!;
    try {
      await logAuditEventStrict({
        actorPrincipalId: actor.principalId,
        actorPrincipalType: "human",
        authSource: "route",
        organizationId: actor.organizationId,
        resourceType: "background_job",
        resourceId: `operations:${path}`,
        operation: path,
        decision: "allowed",
        policyVersion: actor.policyVersion,
        metadata: {
          ...(requestId ? { requestId } : {}),
          batchIndex: i,
          procedure: path,
        },
      });
    } catch {
      // Audit write failed — abort the entire batch. Nothing is forwarded.
      return { kind: "deny", status: 503, reason: "audit write failed" };
    }
  }

  return { kind: "allow", destructiveProcedures: destructive.map((d) => d.path) };
}
