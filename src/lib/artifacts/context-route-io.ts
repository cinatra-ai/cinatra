import "server-only";

import { readFile } from "node:fs/promises";
import { probeInstalledOasPathForRead } from "@cinatra-ai/agents/installed-oas-path";
import {
  readAgentRunById,
  readAgentRunByContextId,
  readAgentRunByTokenHash,
  readAgentTemplateById,
  type AgentRunRecord,
} from "@cinatra-ai/agents";
import { verifyRunToken, RUN_TOKEN_HEADER } from "@/lib/agent-run-token";
import {
  readAgentContextSlotsFromOas,
  type AgentContextSlot,
} from "@cinatra-ai/extensions/agent-context-slots-reader";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { verifyLangGraphBridgeToken } from "@/lib/a2a-auth";
import { resolveAgentRunMcpActor } from "@/lib/agent-run-actor-resolve";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";
import { resolveContextSlot } from "./context-resolver";
import { captureSnapshotsForContextSlot } from "./object-content-snapshot";
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
import {
  recordContextRouteResolutionPath,
  recordContextTrustRootOasMiss,
  type ContextRouteServedBy,
} from "./context-route-observability";
import { resolveExtensionDataRoot } from "@/lib/extension-data-root";

// ---------------------------------------------------------------------------
// Heavy IO for the context routes: auth + run + actor derivation (reuses the
// /api/llm-bridge pattern), trusted on-disk OAS slot loading, and candidate
// resolution. Kept separate from context-route-support.ts so the pure logic
// stays unit-testable without the agents / MCP import chain.
// ---------------------------------------------------------------------------

async function readInstalledOas(
  packageName: string,
): Promise<Record<string, unknown> | null> {
  // cinatra#1196 — multi-vendor trust root: resolve the installed OAS via the
  // SHARED resolver (scope-derived `<root>/<vendor>/<slug>/cinatra/oas.json`),
  // not the historical first-party-only regex + literal "cinatra-ai" path
  // segment. An operator/third-party-vendor agent resolves identically to a
  // first-party one; an unscoped/malformed name or an uninstalled package
  // still yields null (→ oas_missing at the front door, unchanged #1197
  // rejection surface).
  //
  // cinatra#2297 — the PROBE form of that resolver. In production it is the
  // same single deploy-owned runtime mount, resolved by the same guard and the
  // same naming rule; in DEV ONLY it also probes the git-native dev source
  // tree, the tree a stock `setup:dev` actually ingests and the dev wayflow
  // container bind-mounts. Every miss now says WHICH roots were probed.
  //
  // `resolveExtensionDataRoot()` is called ONLY on the two miss branches, never
  // on the hit path: with no `CINATRA_EXTENSION_DATA_ROOT` set it falls through
  // to a SYNCHRONOUS Postgres metadata read, so it is paid on the rejection
  // path (already the slow, logged path) and nowhere else.
  const probe = probeInstalledOasPathForRead(packageName);
  if (!probe.path) {
    recordContextTrustRootOasMiss({
      packageName,
      reason: "not_found",
      extensionDataRoot: resolveExtensionDataRoot(),
      roots: probe.roots,
    });
    return null;
  }
  try {
    return JSON.parse(await readFile(probe.path, "utf8")) as Record<string, unknown>;
  } catch {
    // Resolved but unreadable/unparseable — a distinct, equally opaque failure
    // (the front door still answers oas_missing). Name the file.
    recordContextTrustRootOasMiss({
      packageName,
      reason: "unreadable",
      extensionDataRoot: resolveExtensionDataRoot(),
      roots: probe.roots,
      resolvedPath: probe.path,
    });
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
  /** Which binding resolved the run (#1193 W2 token-first vs legacy split) —
   *  carried so the route-level success trace (#1197) can name the path. */
  servedBy: ContextRouteServedBy;
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
  /** cinatra#1194 — true only when the run was resolved via the run token
   *  (servedBy === "run_token"). Gates the declaration re-anchor for slim
   *  (declaration-only) specs; the legacy marker anchor is unaffected. */
  runTokenServed: boolean;
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
    // cinatra#1194 — the declaration re-anchor (injection grammar + installed
    // contextSlots declaration) is admitted ONLY on the run-token path.
    allowDeclarationAnchor: input.runTokenServed,
  });
  if (!result.ok) {
    throw new ContextRouteError(403, result.code, result.message);
  }
  // cinatra#1194 — which-anchor metric for the slim-format rollout (ids only).
  console.info(
    `[context-attestation] node anchored via=${result.anchor} ` +
      `slot=${result.slotId} kind=${result.kind}`,
  );
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
  // 2. Resolve the parent run. The dispatch-minted per-run token in the
  //    x-cinatra-run-token header is the ONLY accepted run identity (#1193
  //    legacy retirement): a single unique-index probe (verifyRunToken), no
  //    newest-wins tie-break, no fallback. A body id can never SELECT the run —
  //    only be cross-checked.
  //
  //    RETIRED HERE: the legacy `context_id` serving channel (the auth-injected
  //    x-cinatra-a2a-context-id header) and the legacy dev-loopback `body`
  //    channel. Both could promote a run from a signal weaker than the one
  //    credential, so both are gone; an absent or unresolvable token now fails
  //    CLOSED with a distinct stable code.
  //
  //    The context-id HEADER is still read and still required — it is the
  //    attestation context for the #907 per-node composed-child binding in step
  //    3, and a token-selected run cross-checks it. Retiring the channel means it
  //    no longer SELECTS a run, not that it left the wire.
  //
  //    Every first-party task carries a token: the worker dispatch and the host
  //    content-editor dispatch mint one into the initial message, and each
  //    RESUMED leg mints its own into the A2A message metadata (see
  //    packages/agents/src/wayflow-run-token-carrier.ts). The resumed leg is the
  //    one that matters most here — the compiled context subflow interrupts at
  //    the HITL gate, so /api/context-finalize ALWAYS runs in a resumed task.
  const a2aContextId = req.headers.get("x-cinatra-a2a-context-id");
  const runTokenHeader = req.headers.get(RUN_TOKEN_HEADER);
  let run: AgentRunRecord | null = null;
  const servedBy: ContextRouteServedBy = "run_token";
  {
    // The token is the trust root. verifyRunToken hashes it and resolves the run
    // by the unique index. ABSENT and UNRESOLVABLE both fail CLOSED, with
    // DISTINCT codes so an operator can tell "the loader never attached a
    // credential" (a wiring/rollout fault) from "a credential was presented and
    // did not resolve" (tampering, or a run whose credentials were pruned).
    const verified = await verifyRunToken(runTokenHeader, readAgentRunByTokenHash);
    if (!verified.ok) {
      throw new ContextRouteError(
        403,
        verified.reason === "absent"
          ? "run_token_absent"
          : "run_token_unresolvable",
        verified.reason === "absent"
          ? "x-cinatra-run-token is required — run identity rides the run token only"
          : "x-cinatra-run-token did not resolve to a run",
      );
    }
    // Re-read the FULL record by the SERVER-derived id (never a body id) for the
    // downstream template/OBO/project fields. Defense-in-depth: the re-read must
    // not diverge from the verified {orgId, runBy} projection (a torn/rewritten
    // row) — deny on divergence.
    run = await readAgentRunById(verified.run.id);
    if (
      !run ||
      run.orgId !== verified.run.orgId ||
      run.runBy !== verified.run.runBy
    ) {
      throw new ContextRouteError(
        403,
        "run_token_divergent",
        "run-token row diverged from the verified projection",
      );
    }
    // If a context-id header is ALSO present it must name the SAME run — the two
    // dispatch-owned bindings cannot disagree. (A composed-child call still
    // REQUIRES the context-id for the #907 attestation in step 3; the run token
    // never substitutes for the attestation context.)
    if (a2aContextId) {
      const byCtx = await readAgentRunByContextId(a2aContextId);
      if (!byCtx || byCtx.id !== run.id) {
        throw new ContextRouteError(
          403,
          "run_mismatch",
          "x-cinatra-a2a-context-id does not match the run-token run",
        );
      }
    }
    // A supplied body parentRunId is cross-checked, never used to select.
    if (body.parentRunId && body.parentRunId !== run.id) {
      throw new ContextRouteError(
        403,
        "run_mismatch",
        `body parentRunId '${body.parentRunId}' does not match the run-token run`,
      );
    }
  }
  if (!run) {
    throw new ContextRouteError(
      404,
      "run_missing",
      `parent run '${body.parentRunId}' not found`,
    );
  }
  // #1193 run-token spine (W2): which-path-served metric for the W3 legacy-
  // removal gate — per-(kind, via) counter + info line (#1197). Ids only — the
  // raw token and its hash are NEVER logged.
  recordContextRouteResolutionPath({
    kind: expectedKind,
    via: servedBy,
    runId: run.id,
    contextId: a2aContextId,
  });
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
      // cinatra#1194 — the declaration re-anchor for slim specs is admitted
      // only when the run token selected the run (strongest binding).
      runTokenServed: servedBy === "run_token",
    });
    const boundChildPackage = runOas
      ? findBoundChildPackageForSlot(runOas, body.slotId, {
          allowDeclarationBinding: servedBy === "run_token",
        })
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

  // Carry the agent's OBO scope-ceiling on this actor (same derivation as the
  // bridge mint path). Re-derive from the run's LOCKED template anchor + project
  // launch; prefer the run's PERSISTED chain when it contains the re-derived
  // elements (superset-safe for composed-child parent elements), else the fresh
  // derivation. A corrupt anchor derives null → no ceiling carried. No surface
  // enforces it yet; this path attaches (never hard-fails on this internal
  // context-resolution seam).
  const recomputedCeiling = deriveOboCeilingChain({
    ownerLevel: template?.ownerLevel ?? null,
    ownerId: template?.ownerId ?? null,
    orgId: run.orgId,
    projectId: run.projectId,
  });
  if (recomputedCeiling) {
    actor.oboCeiling =
      run.oboCeiling && oboCeilingContains(run.oboCeiling, recomputedCeiling)
        ? run.oboCeiling
        : recomputedCeiling;
  }

  // projectId: the run's project is authoritative; fall back to the normalized
  // body value. Normalize both (a stored "" must not fail-close the resolver).
  const projectId =
    normalizeProjectId(run.projectId) ?? normalizeProjectId(body.projectId);

  return { actor, run, projectId, servedBy, trustedPackageName, trustedSlotPackageName };
}

/** Resolve candidates for a slot via the existing resolver + server-side
 *  installed-extension discovery.
 *
 *  cinatra#1430 "capture at RESOLUTION time": BEFORE resolving, capture (or
 *  keyed-reuse) content snapshots for the actor-visible CLAIMED typed rows
 *  matching the slot — a typed row only becomes a candidate WITH a concrete
 *  representation revision id, which its snapshot provides. Capture is
 *  fail-soft per row (a redaction-blocked/oversized row is skipped, never
 *  fails the resolution) and idempotent (unchanged rows reuse). */
export async function resolveCandidates(input: {
  actor: ActorContext;
  slot: AgentContextSlot;
  projectId: string | undefined;
}): Promise<ContextCandidate[]> {
  const installedExtensions = getInstalledExtensionDescriptors();
  const capture = await captureSnapshotsForContextSlot({
    actor: input.actor,
    slot: input.slot,
    projectId: input.projectId,
    installedExtensions,
  });
  const refs = resolveContextSlot({
    actor: input.actor,
    slot: input.slot,
    projectId: input.projectId,
    installedExtensions,
    // Claimed rows resolve ONLY through the snapshots pinned at THIS
    // resolution (never "latest revision") — see ResolveContextSlotInput.
    snapshotPins: capture.pins,
  });
  return refs as ContextCandidate[];
}
