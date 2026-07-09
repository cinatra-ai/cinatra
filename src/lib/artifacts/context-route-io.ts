import "server-only";

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentRuntimeMountDir } from "@cinatra-ai/agents/agent-runtime-mount";
import {
  readAgentRunById,
  readAgentRunByContextId,
  readAgentTemplateById,
  type AgentRunRecord,
} from "@cinatra-ai/agents";
import {
  readAgentContextSlotsFromOas,
  type AgentContextSlot,
} from "@cinatra-ai/extensions/agent-context-slots-reader";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { verifyLangGraphBridgeToken } from "@/lib/a2a-auth";
import { resolveAgentRunMcpActor } from "@/lib/agent-run-actor-resolve";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";
import { resolveContextSlot } from "./context-resolver";
import { getInstalledExtensionDescriptors } from "./context-mcp";
import {
  ContextRouteError,
  findBoundChildPackageForSlot,
  normalizeProjectId,
  type ContextCandidate,
} from "./context-route-support";
import {
  CONTEXT_NODE_HEADER,
  CONTEXT_ATTESTATION_HEADER,
  evaluateContextAttestation,
  type ContextNodeKind,
} from "./context-attestation";

// ---------------------------------------------------------------------------
// Heavy IO for the context routes: auth + run + actor derivation (reuses the
// /api/llm-bridge pattern), trusted on-disk OAS slot loading, and candidate
// resolution. Kept separate from context-route-support.ts so the pure logic
// stays unit-testable without the agents / MCP import chain.
// ---------------------------------------------------------------------------

function inRepoSlug(packageName: string | null | undefined): string | null {
  if (typeof packageName !== "string") return null;
  const m = /^@cinatra-ai\/([a-z0-9][a-z0-9-]*)$/.exec(packageName);
  return m ? m[1] : null;
}

async function readInstalledOas(
  packageName: string,
): Promise<Record<string, unknown> | null> {
  const slug = inRepoSlug(packageName);
  if (!slug) return null;
  const root = resolveAgentRuntimeMountDir();
  const oasPath = join(root, "cinatra-ai", slug, "cinatra", "oas.json");
  if (!existsSync(oasPath)) return null;
  try {
    return JSON.parse(await readFile(oasPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Load + validate the trusted slot from the parent package's installed OAS.
 *  Throws ContextRouteError(404) when missing/duplicate. NEVER trusts a
 *  caller-supplied OAS body. */
export async function loadTrustedSlot(
  parentPackageName: string,
  slotId: string,
): Promise<AgentContextSlot> {
  const oas = await readInstalledOas(parentPackageName);
  if (!oas) {
    throw new ContextRouteError(
      404,
      "oas_missing",
      `no installed OAS for parent package '${parentPackageName}'`,
    );
  }
  const slots = readAgentContextSlotsFromOas(oas);
  const matches = slots.filter((s) => s.slotId === slotId);
  if (matches.length === 0) {
    throw new ContextRouteError(
      404,
      "slot_missing",
      `no contextSlot '${slotId}' on parent package '${parentPackageName}'`,
    );
  }
  if (matches.length > 1) {
    throw new ContextRouteError(
      404,
      "slot_ambiguous",
      `duplicate contextSlot '${slotId}' on '${parentPackageName}'`,
    );
  }
  return matches[0];
}

export type DerivedContext = {
  actor: ActorContext;
  run: AgentRunRecord;
  projectId: string | undefined;
  /** The run's TEMPLATE package (server-derived, NOT the body). The trust root
   *  for actor + audit-store scoping. */
  trustedPackageName: string;
  /** The verified OWNER of the requested slot: the run package for a leaf run,
   *  or — for an orchestrator resolving a composed child's slot — the child
   *  package that the run package's own installed OAS binds to this slotId.
   *  ALL slot loading MUST use this (never the caller-supplied value); it is
   *  only ever the run package or an execution-structure-verified child. */
  trustedSlotPackageName: string;
};

/** #907 — enforce the per-node context-callback attestation on the composed-
 *  child path. Binds the callback to the ACTUALLY-EXECUTING context-resolution
 *  node (`nodeId` = the compiled `ctx-<slotId>-<kind>` ApiCallStep id the
 *  WayFlow runtime signs), so a composed child cannot resolve a SIBLING's slot
 *  by supplying the sibling's (package, slot) in the body.
 *
 *  Fails CLOSED via ContextRouteError(403) on: a missing trusted context-id
 *  binding, an unconfigured signing key, missing/malformed headers, a bad
 *  signature, an unrecognized/duplicated node (OAS provenance), or a slot/kind
 *  the attested node does not structurally own. `runOas` is the run package's
 *  own installed OAS (the trust root the #825 walk keys on). */
function enforceContextAttestation(input: {
  req: Request;
  a2aContextId: string | null;
  runOas: Record<string, unknown> | null;
  slotId: string;
  expectedKind: ContextNodeKind;
}): void {
  const { req, a2aContextId, runOas, slotId, expectedKind } = input;
  // The full fail-closed decision (context-id binding required, dedicated key
  // required, signature verify, OAS provenance re-anchor, slot + endpoint-kind
  // match) is a PURE function so it is exhaustively unit-testable. Here we only
  // supply the trusted context-id, the dedicated key, and the raw headers.
  const result = evaluateContextAttestation({
    key: process.env.CINATRA_CONTEXT_ATTEST_KEY,
    contextId: a2aContextId,
    nodeIdHeader: req.headers.get(CONTEXT_NODE_HEADER),
    attestationHeader: req.headers.get(CONTEXT_ATTESTATION_HEADER),
    runOas,
    slotId,
    expectedKind,
    // #1192: v2 attestations carry a signed expiry (replay window closed). A
    // legacy v1 (no-expiry) attestation is accepted transitionally so a freshly
    // deployed verifier still authenticates an as-yet-unrolled wayflow minter.
    // Set CINATRA_CONTEXT_ATTEST_ACCEPT_V1=0 to enforce v2-only once the wayflow
    // image has rolled.
    acceptLegacyV1: process.env.CINATRA_CONTEXT_ATTEST_ACCEPT_V1 !== "0",
  });
  if (!result.ok) {
    throw new ContextRouteError(403, result.code, result.message);
  }
  if (result.legacyV1) {
    // Transitional visibility: a legacy v1 (no-expiry) attestation was accepted.
    // Post-rollout this should stop appearing; then enforce v2-only via
    // CINATRA_CONTEXT_ATTEST_ACCEPT_V1=0.
    console.warn(
      "[context-attestation] accepted a legacy v1 (no-expiry) attestation — " +
        "transitional; the intra-run replay window is only closed for v2. Once " +
        "the wayflow minter image has rolled, set CINATRA_CONTEXT_ATTEST_ACCEPT_V1=0.",
    );
  }
}

/** Authorize the request, resolve the parent run (preferring the auth-injected
 *  context-id over the body, like /api/llm-bridge), build the run-user actor,
 *  and reject any caller-supplied parentPackageName that disagrees with the
 *  run's TEMPLATE package (forged-body defense). Throws ContextRouteError on
 *  any failure.
 *
 *  `expectedKind` is the endpoint this call serves ("resolve" for
 *  /api/context-resolve, "finalize" for /api/context-finalize) — bound into the
 *  #907 attestation so a resolve attestation cannot be replayed on finalize. */
export async function deriveContextRouteContext(
  req: Request,
  body: {
    parentRunId: string;
    parentPackageName: string;
    slotId: string;
    projectId?: unknown;
  },
  expectedKind: ContextNodeKind,
): Promise<DerivedContext> {
  // 1. Dual auth: bridge token (WayFlow TS) OR Bearer JWT (Python containers).
  if (!isAuthorizedBridgeRequest(req)) {
    const jwt = await verifyLangGraphBridgeToken(req);
    if (!jwt.ok) {
      throw new ContextRouteError(403, "forbidden", "bridge auth failed");
    }
  }
  // 2. Resolve the parent run. The auth-injected x-cinatra-a2a-context-id is
  //    the TRUSTED run binding (the context FlowNode runs inside the parent
  //    run's WayFlow conversation). Cross-check the body's parentRunId against
  //    it and reject any mismatch (defense against a forged body selecting
  //    another run). Fall back to the body id only when no context-id is
  //    present (mirrors /api/llm-bridge).
  const a2aContextId = req.headers.get("x-cinatra-a2a-context-id");
  let run: AgentRunRecord | null = null;
  if (a2aContextId) {
    // Header present ⇒ it is the TRUSTED binding. Fail CLOSED on an
    // unresolvable context-id (never fall back to the body id) and reject a
    // body parentRunId that disagrees.
    run = await readAgentRunByContextId(a2aContextId);
    if (!run) {
      throw new ContextRouteError(
        403,
        "context_unresolved",
        "x-cinatra-a2a-context-id did not resolve to a run",
      );
    }
    if (body.parentRunId && body.parentRunId !== run.id) {
      throw new ContextRouteError(
        403,
        "run_mismatch",
        `body parentRunId '${body.parentRunId}' does not match the authenticated run`,
      );
    }
  } else {
    // No context-id header ⇒ body fallback (dev loopback / first-call case,
    // matching /api/llm-bridge's own fallback behavior).
    run = await readAgentRunById(body.parentRunId);
  }
  if (!run) {
    throw new ContextRouteError(
      404,
      "run_missing",
      `parent run '${body.parentRunId}' not found`,
    );
  }
  if (!run.orgId || !run.runBy) {
    throw new ContextRouteError(
      403,
      "run_unscoped",
      "parent run has no org/runBy — refusing unscoped context resolution",
    );
  }
  // 3. Forged-body defense. The RUN's TEMPLATE package is the trust root
  //    (server-derived; an AgentRunRecord carries no packageName). A missing
  //    run package fails closed.
  const template = await readAgentTemplateById(run.templateId);
  const runPackageName = template?.packageName ?? null;
  if (!runPackageName) {
    throw new ContextRouteError(
      403,
      "package_unresolved",
      `run template '${run.templateId}' has no package name — cannot trust a slot source`,
    );
  }
  // #822: an orchestrator run resolves context slots that belong to a CHILD
  // agent it composes; that child's inlined subflow calls context-resolve with
  // its OWN package (the slot's owner), not the run package. Accept a non-run
  // package ONLY when the run package's OWN installed OAS binds THIS slotId to
  // exactly that package — i.e. the author-placed context-resolution subflow
  // inlined by the composition names it (see findBoundChildPackageForSlot).
  // This is an execution-STRUCTURE binding, not a declared-deps allow-list, and
  // it fails closed on: an undeclared/arbitrary package, a declared package that
  // is not context-composed in THIS workflow, a MISMATCHED (package, slot) pair
  // (the claimed package is not slotId's bound owner), and an unbound/ambiguous
  // slot — all 403. The verified owner is the slot source; the run package stays
  // the trust root for actor + audit-store scoping (a run's composed slotIds are
  // compiler-distinct, so the run-package-scoped selection key does not collide).
  //
  // KNOWN RESIDUAL (cinatra#907, architectural — needs a WayFlow change, out of
  // scope here): the run shares one bridge auth with no per-child identity
  // signal, so this seam can prove structural (package, slot) consistency but not
  // WHICH child is calling — a caller with the run's auth can resolve ANY
  // structurally-bound (package, slot) in the run (e.g. one composed child
  // reading a sibling's slot). That stays within the run user's OWN artifact
  // visibility (actor scoping is on the run user, never the package) and the
  // endpoint is internal — a defense-in-depth gap among cooperating co-authored
  // children, not a cross-user/org/project escalation.
  let trustedSlotPackageName = runPackageName;
  if (body.parentPackageName !== runPackageName) {
    const runOas = await readInstalledOas(runPackageName);
    // #907: bind the callback to the ACTUALLY-EXECUTING context node before
    // trusting the structural (package, slot) binding. This closes the residual
    // where any holder of the shared run auth could resolve ANY structurally-
    // bound (package, slot) in the run (e.g. a composed child reading a
    // sibling's slot). Fails closed on any attestation failure.
    enforceContextAttestation({
      req,
      a2aContextId,
      runOas,
      slotId: body.slotId,
      expectedKind,
    });
    const boundChildPackage = runOas
      ? findBoundChildPackageForSlot(runOas, body.slotId)
      : null;
    if (!boundChildPackage || boundChildPackage !== body.parentPackageName) {
      throw new ContextRouteError(
        403,
        "package_mismatch",
        `parentPackageName '${body.parentPackageName}' is not the package bound to slot '${body.slotId}' by run package '${runPackageName}'`,
      );
    }
    trustedSlotPackageName = boundChildPackage;
  }
  // Actor + audit-store scoping stays on the RUN package; slot loading uses the
  // verified owner (trustedSlotPackageName), never the raw body.
  const trustedPackageName = runPackageName;
  // 4. Build the run-user actor with team + project visibility (canonical
  //    agent-run actor pattern; mirrors packages/agents mcp/handlers.ts).
  //    resolveAgentRunMcpActor returns null for a non-member/demoted run user
  //    — fail CLOSED (never default to org-scoped "member").
  const mcpActor = await resolveAgentRunMcpActor({
    runId: run.id,
    runBy: run.runBy,
    orgId: run.orgId,
  });
  if (!mcpActor) {
    throw new ContextRouteError(
      403,
      "actor_unresolved",
      "run user is not a current member of the run org — refusing context resolution",
    );
  }
  const teamIds = (await readTeamsForUser(run.runBy, run.orgId)).map((t) => t.id);
  const projectGrants = await readProjectGrantsForUser(run.runBy, run.orgId, {
    teamIds,
  });
  const actor = buildActorContextFromPrimitive(
    {
      actorType: "human",
      source: "agent",
      userId: run.runBy,
    } as Parameters<typeof buildActorContextFromPrimitive>[0],
    run.orgId,
    {
      platformRole: mcpActor.platformRole,
      actorOrganizationId: run.orgId,
      teamIds,
      projectGrants,
    },
  ) as unknown as ActorContext;

  // projectId: the run's project is authoritative; fall back to the normalized
  // body value. Normalize both (a stored "" must not fail-close the resolver).
  const projectId =
    normalizeProjectId(run.projectId) ?? normalizeProjectId(body.projectId);

  return { actor, run, projectId, trustedPackageName, trustedSlotPackageName };
}

/** Resolve candidates for a slot via the existing resolver + server-side
 *  installed-extension discovery. */
export function resolveCandidates(input: {
  actor: ActorContext;
  slot: AgentContextSlot;
  projectId: string | undefined;
}): ContextCandidate[] {
  const refs = resolveContextSlot({
    actor: input.actor,
    slot: input.slot,
    projectId: input.projectId,
    installedExtensions: getInstalledExtensionDescriptors(),
  });
  return refs as ContextCandidate[];
}
