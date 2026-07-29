import "server-only";

// entry-66: these four production deps are STATIC imports. They were
// `await import(...)` lazy-loads (import-light nav purity), but a server-side
// dynamic import whose target subgraph is this heavy detonates Turbopack's
// native compile on linux-x64 CI (unbounded >33GB memory runaway; macOS is
// unaffected) — see the entry-66 CI-memory investigation (2026-07-17). The DI seam below is
// unchanged: tests still inject in-memory deps over the same code path.
import * as store from "@/lib/objects/artifact-promotion-request-store";
import * as objects from "@/lib/objects-store";
import * as writer from "@/lib/object-history/canonical-writer";
import * as errors from "@/lib/object-history/errors";

// ---------------------------------------------------------------------------
// Artifact row-scope promotion — the SUBJECT-SPECIFIC data layer behind the
// shared promotion approvals seam (cinatra#1437, epic #1424; plugs into the
// #1560 `PromotionBackend` seam via `sources/artifact-promotion.ts`).
//
// Widening an individual artifact row's visibility (private → team |
// organization) through the approvals surface. Authorization + the version
// guard + never-narrow + the fail-closed secret/PII scan + the atomic
// row-widen/re-projection/audit ALL live here (subject-specific), exactly as
// the seam specifies — mirroring the memory-promotion shape (#1381) and the
// dynamic-type artifact-visibility backend's "business refusals are VALUES,
// never throws" idiom.
//
// EVERY heavy reader/writer is resolved through injected deps whose production
// default LAZY-imports its store (the request store, the objects store, the
// history-aware CAS writer). Tests inject a complete in-memory deps object over
// the SAME code path (DI — never a live DB), so the CAS/never-narrow/scan/
// authorization ladders are proven without infrastructure.
// ---------------------------------------------------------------------------

import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";
import { redactChatCaptureText } from "@/lib/chat-capture/redact";
import { verifySessionAuthority } from "@/lib/org-write/authority";
import type {
  ArtifactPromotionRequestRow,
  ArtifactPromotionRequestStatus,
  ArtifactPromotionVisibility,
} from "@/lib/objects/artifact-promotion-request-store";

export type { ArtifactPromotionRequestRow, ArtifactPromotionVisibility };

/** The decide result codes — identical strings to the seam's
 *  `PromotionDecideCode`, so the backend adapter maps them 1:1 without this
 *  data-layer importing the app-config seam. */
export type ArtifactPromotionDecideCode =
  | "not_found"
  | "not_authorized"
  | "stale_snapshot"
  | "version_required"
  | "narrowing"
  | "secret_scan"
  | "invalid_state"
  | "conflict"
  | "transient";

export type ArtifactPromotionDecideOutcome =
  | { ok: true }
  | { ok: false; code: ArtifactPromotionDecideCode; message: string };

/** A subject-native review row (mapped to the seam's `PromotionBackendRow` by
 *  the backend adapter). The public CAS `version` is the objects.version the
 *  request captured; an edit-after-request moves the live row past it. */
export interface ArtifactPromotionReviewRow {
  /** Display-only widen-target label (team name snapshot); null for org. */
  toOwnerLabel?: string | null;
  /** The IMMUTABLE widen-target owner id (team id / org id) — what an approve
   *  actually writes; surfaced so reviewers can verify the true destination
   *  (names are mutable + non-unique). */
  toOwnerId: string;
  requestId: string;
  objectId: string;
  title: string;
  status: ArtifactPromotionRequestStatus;
  createdAt: string;
  /** objects.version captured at request time — the CAS token. */
  version: string;
  fromScope: string;
  toScope: string;
  requestedBy: string;
}

/** The artifact object fields the decide path needs (a projection of the
 *  objects-store `ObjectRecord`). */
export interface PromotableObject {
  id: string;
  type: string;
  data: unknown;
  version: number;
  visibility: string;
  ownerLevel: string;
  ownerId: string;
  orgId: string | null;
}

export type WidenOutcome =
  | { ok: true }
  | { ok: false; reason: "version_conflict" | "not_found" | "transient" };

// ── never-narrow scope ranking ──────────────────────────────────────────────

// The never-narrow lattice lives in a pure, dependency-free module so the
// collection-add authorization contract (cinatra#1886) evaluates the SAME
// widen predicate this service enforces (a promotion offer can never name a
// target this flow would reject). Re-exported here so existing consumers /
// tests keep importing it from this module unchanged.
export {
  PROMOTION_SCOPE_RANK,
  promotionScopeRank,
  isWiden,
} from "./promotion-visibility-lattice";
import { isWiden } from "./promotion-visibility-lattice";

// ── fail-closed secret/PII scan ─────────────────────────────────────────────

/**
 * Fail-CLOSED secret/PII scan of the CAS-bound artifact content. Reuses the
 * chat-capture scrubber: a scrubber output that differs from the input means a
 * secret/PII shape was present, so the row is NOT clean. ANY throw (malformed
 * content, scanner error) also reports NOT clean — a promotion that cannot be
 * proven secret-free is refused.
 */
export function scanArtifactContentForSecrets(content: unknown): { clean: boolean } {
  try {
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return { clean: redactChatCaptureText(text) === text };
  } catch {
    return { clean: false };
  }
}

// ── injected data-layer deps (production lazy-imports; tests inject) ─────────

export interface ArtifactPromotionDeps {
  readRequestById(id: string, orgId: string): ArtifactPromotionRequestRow | null;
  listRequests(input: {
    orgId: string;
    status?: ArtifactPromotionRequestStatus | "all";
    requestedBy?: string;
    excludeRequester?: string;
    limit?: number;
  }): ArtifactPromotionRequestRow[];
  countRequests(input: {
    orgId: string;
    status?: ArtifactPromotionRequestStatus;
    requestedBy?: string;
    excludeRequester?: string;
  }): number;
  casDecideRequest(input: {
    id: string;
    orgId: string;
    decidedBy: string;
    decision: "approve" | "reject";
    note?: string | null;
  }): boolean;
  markSuperseded(input: { id: string; orgId: string }): boolean;
  /** Reverse a just-claimed 'approved' request whose widen did not land: `to:
   *  'superseded'` voids it permanently; `to: 'pending'` makes it re-decidable
   *  after a transient failure. */
  compensateApproved(input: { id: string; orgId: string; to: "pending" | "superseded" }): boolean;
  createRequest(input: {
    orgId: string;
    objectId: string;
    objectTitle: string;
    requestedBy: string;
    fromVisibility: string;
    toVisibility: ArtifactPromotionVisibility;
    toOwnerLevel: string;
    toOwnerId: string;
    toOwnerLabel: string | null;
    rowVersion: number;
  }): ArtifactPromotionRequestRow;
  /** Resolve a widen-target TEAM within the org (tenant containment — codex
   *  finding): with `memberUserId`, additionally requires that user's team
   *  membership. Null is the single indistinguishable refusal. */
  readTeamInOrg(input: {
    teamId: string;
    orgId: string;
    memberUserId?: string;
  }): { id: string; name: string } | null;
  readObject(objectId: string, orgId: string): PromotableObject | null;
  /** Atomically widen the row's visibility/ownership, enqueue the durable
   *  re-projection (lane-move) and append the immutable history audit — all
   *  version-guarded on `expectedBaseVersion`. A CAS miss is a VALUE
   *  (`version_conflict`), never a throw. */
  widenAndReproject(input: {
    object: PromotableObject;
    toVisibility: ArtifactPromotionVisibility;
    toOwnerLevel: string;
    toOwnerId: string;
    expectedBaseVersion: number;
    actor: ApprovalViewer;
  }): Promise<WidenOutcome>;
  scanContent(content: unknown): { clean: boolean };
}

let cachedProdDeps: Promise<ArtifactPromotionDeps> | null = null;

/** Production deps — every heavy reader/writer is LAZY-imported (cached) so this
 *  module's STATIC import graph stays a leaf (import-light nav purity); the
 *  imported store/writer functions are synchronous. */
async function productionDeps(): Promise<ArtifactPromotionDeps> {
  if (cachedProdDeps) return cachedProdDeps;
  cachedProdDeps = (async () => {
    return {
      readRequestById: (id, orgId) => store.readArtifactPromotionRequestById(id, orgId),
      listRequests: (input) => store.listArtifactPromotionRequests(input),
      countRequests: (input) => store.countArtifactPromotionRequests(input),
      casDecideRequest: (input) => store.casDecideArtifactPromotionRequest(input),
      markSuperseded: (input) => store.markArtifactPromotionRequestSuperseded(input),
      compensateApproved: (input) => store.compensateApprovedArtifactPromotionRequest(input),
      createRequest: (input) => store.createArtifactPromotionRequest(input),
      readTeamInOrg: (input) => store.readTeamInOrgSync(input),
      readObject: (objectId, orgId) => {
        const rec = objects.getObjectById(objectId, { orgId });
        if (!rec) return null;
        return {
          id: rec.id,
          type: rec.type,
          data: rec.data,
          version: rec.version,
          visibility: rec.visibility,
          ownerLevel: rec.ownerLevel,
          ownerId: rec.ownerId,
          orgId: rec.orgId,
        };
      },
      widenAndReproject: async (input) => {
        try {
          // Org-write kernel authority (cinatra#1939 wave 3 Stage D), minted
          // HERE rather than threaded from the top of the shared, multi-
          // subject `ApprovalSource.decide` seam (agent-creation and other
          // promotion-adjacent backends share that generic contract; widening
          // it for one subject's kernel authority would ripple into backends
          // that never touch canonical-writer.ts). `input.actor` already
          // carries the fresh session's userId/orgId verified upstream by
          // `decideArtifactPromotion`'s `viewer.isAdmin` gate.
          const authority = await verifySessionAuthority(
            input.actor.userId,
            input.actor.orgId,
          );
          writer.historyAwareUpsert(
            {
              id: input.object.id,
              type: input.object.type,
              data: input.object.data,
              orgId: input.object.orgId,
              ownerLevel: input.toOwnerLevel,
              ownerId: input.toOwnerId,
              visibility: input.toVisibility,
            },
            {
              actor: {
                actorId: input.actor.userId,
                actorKind: "user",
                orgId: input.actor.orgId,
              },
              historyEffect: "reversible-internal",
              expectedBaseVersion: input.expectedBaseVersion,
              authority,
            },
          );
          return { ok: true };
        } catch (error) {
          if (error instanceof errors.VersionConflictError) {
            // A concurrent edit / vanished row moved the CAS anchor.
            return { ok: false, reason: "version_conflict" };
          }
          // FAIL-CLOSED: every other failure is a transient VALUE, never a
          // rethrow — the decide path must always be able to compensate the
          // just-claimed request instead of an escaped exception stranding it
          // falsely 'approved' with an un-widened row.
          console.error("[artifact-row-promotion] widen/re-projection failed:", error);
          return { ok: false, reason: "transient" };
        }
      },
      scanContent: (content) => scanArtifactContentForSecrets(content),
    } satisfies ArtifactPromotionDeps;
  })();
  return cachedProdDeps;
}

async function resolveDeps(override?: ArtifactPromotionDeps): Promise<ArtifactPromotionDeps> {
  return override ?? productionDeps();
}

// ── title projection ────────────────────────────────────────────────────────

function deriveTitle(object: PromotableObject): string {
  const data = object.data as { title?: unknown; name?: unknown } | null | undefined;
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  if (title) return title;
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  if (name) return name;
  return object.type;
}

function toReviewRow(r: ArtifactPromotionRequestRow): ArtifactPromotionReviewRow {
  return {
    requestId: r.id,
    objectId: r.objectId,
    title: r.objectTitle,
    status: r.status,
    createdAt: r.createdAt,
    version: String(r.rowVersion),
    fromScope: r.fromVisibility,
    toScope: r.toVisibility,
    toOwnerLabel: r.toOwnerLabel ?? null,
    toOwnerId: r.toOwnerId,
    requestedBy: r.requestedBy,
  };
}

// ── list / count (subject-native; the backend maps to the seam row) ─────────

/** Pending promotion requests the reviewer must decide — someone ELSE's
 *  requests in the reviewer's org (a self-authored request is "Your requests"
 *  only, never inbox work). */
export async function listArtifactPromotionInbox(
  input: { orgId: string; reviewerId: string },
  depsOverride?: ArtifactPromotionDeps,
): Promise<ArtifactPromotionReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  return deps
    .listRequests({ orgId: input.orgId, status: "pending", excludeRequester: input.reviewerId })
    .map(toReviewRow);
}

/** The requester's OWN promotion requests (optionally narrowed to a status). */
export async function listArtifactPromotionMine(
  input: { orgId: string; requesterId: string; status?: string },
  depsOverride?: ArtifactPromotionDeps,
): Promise<ArtifactPromotionReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  const status = normalizeStatusFilter(input.status);
  return deps
    .listRequests({ orgId: input.orgId, requestedBy: input.requesterId, status })
    .map(toReviewRow);
}

const KNOWN_STATUSES: ArtifactPromotionRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
];

function normalizeStatusFilter(status: string | undefined): ArtifactPromotionRequestStatus | "all" {
  if (status && KNOWN_STATUSES.includes(status as ArtifactPromotionRequestStatus)) {
    return status as ArtifactPromotionRequestStatus;
  }
  return "all";
}

export async function countArtifactPromotionInbox(
  input: { orgId: string; reviewerId: string },
  depsOverride?: ArtifactPromotionDeps,
): Promise<number> {
  const deps = await resolveDeps(depsOverride);
  return deps.countRequests({
    orgId: input.orgId,
    status: "pending",
    excludeRequester: input.reviewerId,
  });
}

export async function countArtifactPromotionMine(
  input: { orgId: string; requesterId: string },
  depsOverride?: ArtifactPromotionDeps,
): Promise<number> {
  const deps = await resolveDeps(depsOverride);
  return deps.countRequests({
    orgId: input.orgId,
    status: "pending",
    requestedBy: input.requesterId,
  });
}

// ── create (the request surface calls this; also exercised by tests) ────────

export type CreateArtifactPromotionResult =
  | { ok: true; request: ArtifactPromotionRequestRow }
  | { ok: false; code: ArtifactPromotionDecideCode; message: string };

/**
 * Open a pending promotion request to widen a row's visibility. Never-narrow is
 * enforced at REQUEST time too (a narrowing/no-op request is refused up front),
 * and the objects.version is captured as the CAS anchor. The one-pending
 * partial-unique index makes a second in-flight request a `conflict`.
 */
export async function createArtifactRowPromotionRequest(
  input: {
    orgId: string;
    objectId: string;
    requestedBy: string;
    toVisibility: ArtifactPromotionVisibility;
    /** Required for a team target (the owning team id); ignored for org. */
    targetTeamId?: string;
  },
  depsOverride?: ArtifactPromotionDeps,
): Promise<CreateArtifactPromotionResult> {
  const deps = await resolveDeps(depsOverride);
  const object = deps.readObject(input.objectId, input.orgId);
  if (!object) {
    return { ok: false, code: "not_found", message: `No artifact row '${input.objectId}' in this organization.` };
  }
  if (!isWiden(object.visibility, input.toVisibility)) {
    return {
      ok: false,
      code: "narrowing",
      message: `Promotion must WIDEN visibility: '${object.visibility}' → '${input.toVisibility}' is not a widen.`,
    };
  }
  const target = resolveWidenTarget(input.toVisibility, input.orgId, input.targetTeamId);
  if (!target.ok) return { ok: false, code: target.code, message: target.message };
  // Tenant containment + requester eligibility for a TEAM target (codex
  // finding): the team must exist in THIS org and the requester must be a
  // member of it — otherwise a request could route the row to an arbitrary,
  // foreign, or nonexistent team (an ownership transfer, not a widen). One
  // indistinguishable refusal (no existence-vs-membership probe oracle). The
  // resolved name is snapshotted DISPLAY-ONLY so reviewers see the actual
  // destination.
  let toOwnerLabel: string | null = null;
  if (target.ownerLevel === "team") {
    const team = deps.readTeamInOrg({
      teamId: target.ownerId,
      orgId: input.orgId,
      memberUserId: input.requestedBy,
    });
    if (!team) {
      return {
        ok: false,
        code: "invalid_state",
        message:
          "The target team was not found in this organization (or you are not a member of it).",
      };
    }
    toOwnerLabel = team.name;
  }
  try {
    const request = deps.createRequest({
      orgId: input.orgId,
      objectId: input.objectId,
      objectTitle: deriveTitle(object),
      requestedBy: input.requestedBy,
      fromVisibility: object.visibility,
      toVisibility: input.toVisibility,
      toOwnerLevel: target.ownerLevel,
      toOwnerId: target.ownerId,
      toOwnerLabel,
      rowVersion: object.version,
    });
    return { ok: true, request };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pending promotion already exists|_one_pending|duplicate key/i.test(message)) {
      return {
        ok: false,
        code: "conflict",
        message: `A pending promotion request already exists for artifact '${input.objectId}'.`,
      };
    }
    throw error;
  }
}

type WidenTarget =
  | { ok: true; ownerLevel: string; ownerId: string }
  | { ok: false; code: ArtifactPromotionDecideCode; message: string };

function resolveWidenTarget(
  toVisibility: ArtifactPromotionVisibility,
  orgId: string,
  targetTeamId: string | undefined,
): WidenTarget {
  if (toVisibility === "organization") {
    return { ok: true, ownerLevel: "organization", ownerId: orgId };
  }
  // team
  if (!targetTeamId) {
    return {
      ok: false,
      code: "invalid_state",
      message: "A team promotion requires a target team id.",
    };
  }
  return { ok: true, ownerLevel: "team", ownerId: targetTeamId };
}

// ── the CAS decide (authorization + version guard + never-narrow + scan) ────

export interface DecideArtifactPromotionArgs {
  requestId: string;
  action: string;
  reason?: string;
  expectedVersion?: string;
  viewer: ApprovalViewer;
}

/**
 * Non-redirecting CAS decide. Ladder, fail-closed (every gate short-circuits a
 * VALUE before the next):
 *
 *   1. reviewer is not an admin                 → 'not_authorized'
 *   2. request unknown (or another org's)       → 'not_found'
 *   3. request not pending                       → 'invalid_state'
 *   4. reject  → CAS pending→rejected, row UNTOUCHED; a lost CAS is 'conflict'
 *   5. approve →
 *        a. no expectedVersion                   → 'version_required'
 *        b. the row vanished                      → 'not_found'
 *        c. the reviewer's snapshot ≠ the request's captured version, OR the
 *           live row moved past it (edit-after-request) → SUPERSEDE the request,
 *           'stale_snapshot'
 *        d. toScope not strictly wider than the CURRENT visibility → 'narrowing'
 *        d2. a TEAM destination no longer in this org → 'invalid_state'
 *            (tenant containment re-check; no state change)
 *        e. content fails the fail-closed secret/PII scan → 'secret_scan'
 *        f. CAS claim pending→approved (lost → 'conflict')
 *        g. atomic version-guarded widen + durable re-projection + audit; a
 *           widen CAS miss (a race squeaked in) → SUPERSEDE, 'stale_snapshot';
 *           an infra failure → 'transient'
 */
export async function decideArtifactPromotion(
  args: DecideArtifactPromotionArgs,
  depsOverride?: ArtifactPromotionDeps,
): Promise<ArtifactPromotionDecideOutcome> {
  const deps = await resolveDeps(depsOverride);
  const { viewer } = args;

  // 1. authorization — cheap, first, fail-closed.
  if (!viewer.isAdmin) {
    return { ok: false, code: "not_authorized", message: "Only an admin can decide an artifact promotion request." };
  }

  // 2/3. request existence + state (org-scoped read; another org's id reads null).
  const request = deps.readRequestById(args.requestId, viewer.orgId);
  if (!request) {
    return { ok: false, code: "not_found", message: `Unknown artifact promotion request '${args.requestId}'.` };
  }
  if (request.status !== "pending") {
    return {
      ok: false,
      code: "invalid_state",
      message: `Artifact promotion request '${args.requestId}' is '${request.status}', not pending.`,
    };
  }

  // 4. reject — the row is NEVER touched; a lost CAS is a conflict.
  if (args.action === "reject") {
    const won = deps.casDecideRequest({
      id: request.id,
      orgId: viewer.orgId,
      decidedBy: viewer.userId,
      decision: "reject",
      note: args.reason ?? null,
    });
    if (!won) {
      return { ok: false, code: "conflict", message: "The request was decided concurrently; re-open the inbox." };
    }
    return { ok: true };
  }

  if (args.action !== "approve") {
    // The shared source only ever forwards approve|reject, but fail closed.
    return { ok: false, code: "invalid_state", message: `Unknown promotion action '${args.action}'.` };
  }

  // 5a. version guard — the CAS token captured at review must be echoed back.
  if (args.expectedVersion == null || args.expectedVersion === "") {
    return { ok: false, code: "version_required", message: "A promotion approval requires the reviewed row version." };
  }
  const expected = Number(args.expectedVersion);

  // 5b. the row must still exist.
  const object = deps.readObject(request.objectId, viewer.orgId);
  if (!object) {
    return { ok: false, code: "not_found", message: `The artifact row '${request.objectId}' no longer exists.` };
  }

  // 5c. CAS: the reviewer's snapshot must match the request's captured version,
  // and the LIVE row must not have moved past it (an edit-after-request
  // supersedes). Either mismatch supersedes the request and refuses.
  if (!Number.isFinite(expected) || expected !== request.rowVersion || object.version !== request.rowVersion) {
    deps.markSuperseded({ id: request.id, orgId: viewer.orgId });
    return {
      ok: false,
      code: "stale_snapshot",
      message: "The artifact row changed since this promotion was requested — the request was superseded.",
    };
  }

  // 5d. never-narrow — measured against the CURRENT live visibility.
  if (!isWiden(object.visibility, request.toVisibility)) {
    return {
      ok: false,
      code: "narrowing",
      message: `Promotion must WIDEN visibility: '${object.visibility}' → '${request.toVisibility}' is not a widen.`,
    };
  }

  // 5d2. TEAM-target revalidation (codex finding): the destination team must
  // STILL exist in this org at approve time — a deleted/foreign team id must
  // never become the row's owner. No state change: the admin rejects the dead
  // request with a reason (the one-pending index otherwise blocks a re-request).
  //
  // RESIDUAL (documented for the maintainer, mirrors the ratified claim/apply
  // residual): this check and the widen below are separate transactions, so a
  // team deleted/reassigned in the window ends up as the row's owner id. The
  // blast radius is confidentiality-FAIL-CLOSED: object reads are org_id-scoped
  // FIRST, so a team id now foreign to this org matches no reader here (no
  // cross-tenant leak), and a deleted team id matches nobody — the row becomes
  // LESS visible, never more. True atomicity needs the containment predicate
  // inside canonical-writer's transactional CTE (same out-of-scope class as
  // co-committing the decision with the widen).
  if (request.toOwnerLevel === "team") {
    const team = deps.readTeamInOrg({ teamId: request.toOwnerId, orgId: viewer.orgId });
    if (!team) {
      return {
        ok: false,
        code: "invalid_state",
        message:
          "The target team no longer exists in this organization — reject this request.",
      };
    }
  }

  // 5e. fail-closed secret/PII scan of the CAS-bound content.
  if (!deps.scanContent(object.data).clean) {
    return {
      ok: false,
      code: "secret_scan",
      message: "The artifact content did not pass the secret/PII scan — promotion refused (fail-closed).",
    };
  }

  // 5f. CLAIM the decision (pending→approved) FIRST — this is what makes the
  // apply fail-CLOSED. A concurrent decider that loses the claim never proceeds
  // to widen, so at most ONE apply runs; and the row is NOT widened until the
  // whole apply succeeds, so any failure leaves the row at its original (never
  // over-exposed) visibility. (Claim-first + a durable 'approved' intermediate +
  // a separate apply mirrors the landed agent_creation_request idiom.)
  const claimed = deps.casDecideRequest({
    id: request.id,
    orgId: viewer.orgId,
    decidedBy: viewer.userId,
    decision: "approve",
    note: args.reason ?? null,
  });
  if (!claimed) {
    return { ok: false, code: "conflict", message: "The request was decided concurrently; re-open the inbox." };
  }

  // 5g. apply: atomic version-guarded widen + durable re-projection (lane-move) +
  // history audit. The widen is CAS-bound (`expectedBaseVersion`), so a
  // concurrent edit conflicts rather than clobbering. On ANY apply failure the
  // just-claimed 'approved' request is COMPENSATED so it is never left falsely
  // approved with an un-widened row:
  //   - version_conflict / not_found → 'superseded' (the approval is void);
  //   - transient                    → back to 'pending' (re-decidable; the
  //     version-guarded widen is idempotent on the retry).
  let widened: WidenOutcome;
  try {
    widened = await deps.widenAndReproject({
      object,
      toVisibility: request.toVisibility,
      toOwnerLevel: request.toOwnerLevel,
      toOwnerId: request.toOwnerId,
      expectedBaseVersion: request.rowVersion,
      actor: viewer,
    });
  } catch {
    // Defense in depth: `widenAndReproject` is contractually value-returning
    // (fail-closed), but a throwing dep must NEVER strand the just-claimed
    // request as falsely 'approved' — reverse it to pending (retryable).
    deps.compensateApproved({ id: request.id, orgId: viewer.orgId, to: "pending" });
    return { ok: false, code: "transient", message: "The promotion apply failed; retry the approval." };
  }
  if (!widened.ok) {
    if (widened.reason === "version_conflict") {
      deps.compensateApproved({ id: request.id, orgId: viewer.orgId, to: "superseded" });
      return {
        ok: false,
        code: "stale_snapshot",
        message: "The artifact row changed during approval — the request was superseded.",
      };
    }
    if (widened.reason === "not_found") {
      deps.compensateApproved({ id: request.id, orgId: viewer.orgId, to: "superseded" });
      return { ok: false, code: "not_found", message: `The artifact row '${request.objectId}' no longer exists.` };
    }
    deps.compensateApproved({ id: request.id, orgId: viewer.orgId, to: "pending" });
    return { ok: false, code: "transient", message: "The promotion apply failed transiently; retry the approval." };
  }

  return { ok: true };
}
