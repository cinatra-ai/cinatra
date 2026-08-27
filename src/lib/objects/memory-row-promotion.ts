import "server-only";

// entry-66 (cinatra#1437 precedent): these production deps are STATIC imports.
// A server-side dynamic import whose target subgraph is this heavy detonates
// Turbopack's native compile on linux-x64 CI (unbounded memory runaway; macOS
// is unaffected). The DI seam below is unchanged: tests inject in-memory deps
// over the same code path.
import * as store from "@/lib/objects/memory-promotion-request-store";
import * as objects from "@/lib/objects-store";
import * as writer from "@/lib/object-history/canonical-writer";
import * as errors from "@/lib/object-history/errors";
import { mcpRequestContextStorage } from "@/lib/mcp-request-context";

// ---------------------------------------------------------------------------
// Memory row promotion — the SUBJECT-SPECIFIC data layer behind the shared
// promotion approvals seam (cinatra#1381, epic #1373; plugs into the #1560
// `PromotionBackend` seam via `sources/memory-promotion.ts`).
//
// Widening ONE memory row's ownership/visibility TUPLE through review.
// Authorization, the CAS version guard, never-narrow, the fail-closed
// secret/PII scan and the atomic apply ALL live here, exactly as the seam
// specifies. The shared source owns the feed row, decide routing, counts,
// availability and the `approvals_*` MCP decision tools; none of that is
// rebuilt here.
//
// TWO THINGS DIFFER FROM THE ARTIFACT SIBLING, both deliberate:
//
//   1. THE TRANSITION MATRIX IS A TUPLE RULE, not a visibility rank. Only three
//      moves exist: `user/private -> team/team`, `user/private ->
//      organization/organization`, `team/team -> organization/organization`.
//      Never-narrow is implied by all three (each strictly widens), and the
//      rank lattice is ALSO evaluated as defence in depth — but the matrix is
//      what decides, so a shape the lattice would happily widen (a user-owned
//      `team`-visible row, which is not team-readable at all) is refused rather
//      than promoted from a state nobody modelled.
//
//   2. THE APPLY IS ONE TRANSACTION. The artifact flow claims the request, then
//      applies the widen, then compensates the claim when the apply fails. This
//      flow co-commits the claim WITH the widen, the immutable history append
//      and the durable Graphiti re-projection enqueue
//      (`HistoryWriteOptions.coCommitStatements`), so there is no
//      claimed-but-unapplied state, nothing to compensate, and no window in
//      which a reader sees an `approved` request over an un-widened row. Every
//      failure below therefore leaves the request PENDING and the row
//      UNTOUCHED.
//
// EVERY heavy reader/writer is resolved through injected deps. Tests inject a
// complete in-memory deps object over the SAME code path (DI — never a live
// DB), so the CAS / matrix / scan / authorization ladders are proven without
// infrastructure.
// ---------------------------------------------------------------------------

import type { ApprovalViewer } from "@/lib/approvals/sources/types";
import {
  collectMemoryScannableStrings,
  detectMemoryCredentialPattern,
} from "@cinatra-ai/memory/secret-scan";
import {
  verifySessionAuthority,
  OrgWriteAuthorityError,
} from "@/lib/org-write/authority";
import type {
  MemoryPromotionRequestRow,
  MemoryPromotionRequestStatus,
  MemoryPromotionVisibility,
} from "@/lib/objects/memory-promotion-request-store";

import { isWiden } from "./promotion-visibility-lattice";

export type { MemoryPromotionRequestRow, MemoryPromotionVisibility };

/**
 * The memory concept object type. INLINED rather than imported from
 * `@cinatra-ai/objects/register-object-types` for the same reason
 * `packages/objects/src/mcp/handlers.ts` inlines it: this module is reachable
 * from the import-light promotion contract, and the type registry is a heavy
 * module. `memory-row-promotion.test.ts` pins this constant against the
 * registry's exported one, so the two can never drift silently.
 */
export const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";

/** The decide result codes — identical strings to the seam's
 *  `PromotionDecideCode`, so the backend adapter maps them 1:1 without this
 *  data layer importing the seam. */
export type MemoryPromotionDecideCode =
  | "not_found"
  | "not_authorized"
  | "stale_snapshot"
  | "version_required"
  | "narrowing"
  | "secret_scan"
  | "invalid_state"
  | "conflict"
  | "transient";

export type MemoryPromotionDecideOutcome =
  | { ok: true }
  | { ok: false; code: MemoryPromotionDecideCode; message: string };

/** A subject-native review row (mapped to the seam's `PromotionBackendRow` by
 *  the backend adapter). */
export interface MemoryPromotionReviewRow {
  requestId: string;
  objectId: string;
  title: string;
  status: MemoryPromotionRequestStatus;
  createdAt: string;
  /** objects.version captured at request time — the CAS token. */
  version: string;
  fromScope: string;
  toScope: string;
  /** DISPLAY-ONLY widen-target label (team name snapshot); null for org. */
  toOwnerLabel: string | null;
  /** The IMMUTABLE widen-target owner id — what an approve actually writes, so
   *  a reviewer can verify the true destination (names are mutable and
   *  non-unique). */
  toOwnerId: string;
  requestedBy: string;
  /** The memory-specific ADVISORY duplicate signal, populated for the reviewer
   *  inbox only (a requester looking at their own list has nothing to decide).
   *  A non-identifying count sentence, or null when there is nothing to say. */
  duplicateHint?: string | null;
}

/** The memory object fields the promotion paths need (a projection of the
 *  objects-store `ObjectRecord`). */
export interface PromotableMemoryObject {
  id: string;
  type: string;
  data: unknown;
  version: number;
  visibility: string;
  ownerLevel: string;
  ownerId: string;
  orgId: string | null;
  projectId: string | null;
}

export type ApplyOutcome =
  | { ok: true }
  | {
      ok: false;
      /** `cas_miss` covers BOTH in-transaction CAS asserts — the request claim
       *  and the row widen. They raise the same SQLSTATE, so the decide path
       *  re-reads the request to say which fired; that read is sound precisely
       *  because either way the transaction rolled back and nothing changed. */
      reason: "cas_miss" | "not_found" | "transient" | "not_authorized";
    };

// ── the transition matrix (the memory-specific rule) ────────────────────────

/** An ownership/visibility TUPLE — the state a promotion moves between. */
export interface ScopeTuple {
  ownerLevel: string;
  visibility: string;
}

/** The three moves this flow allows, and nothing else. */
const ALLOWED_TRANSITIONS: ReadonlyArray<{ from: ScopeTuple; to: ScopeTuple }> = [
  { from: { ownerLevel: "user", visibility: "private" }, to: { ownerLevel: "team", visibility: "team" } },
  { from: { ownerLevel: "user", visibility: "private" }, to: { ownerLevel: "organization", visibility: "organization" } },
  { from: { ownerLevel: "team", visibility: "team" }, to: { ownerLevel: "organization", visibility: "organization" } },
];

/**
 * True iff `(from -> to)` is one of the three allowed moves. Fail-closed on
 * everything else — an unmodelled source tuple, a no-op, a narrowing, a
 * `public` target, an owner-level change that does not match its visibility.
 */
export function isAllowedMemoryPromotion(from: ScopeTuple, to: ScopeTuple): boolean {
  return ALLOWED_TRANSITIONS.some(
    (t) =>
      t.from.ownerLevel === from.ownerLevel &&
      t.from.visibility === from.visibility &&
      t.to.ownerLevel === to.ownerLevel &&
      t.to.visibility === to.visibility,
  );
}

/** The owner axes a `toVisibility` implies. `team` needs the target team id. */
export function widenTargetFor(
  toVisibility: MemoryPromotionVisibility,
  orgId: string,
  targetTeamId: string | undefined,
): { ok: true; ownerLevel: string; ownerId: string } | { ok: false; code: MemoryPromotionDecideCode; message: string } {
  if (toVisibility === "organization") {
    return { ok: true, ownerLevel: "organization", ownerId: orgId };
  }
  if (!targetTeamId) {
    return { ok: false, code: "invalid_state", message: "A team promotion requires a target team id." };
  }
  return { ok: true, ownerLevel: "team", ownerId: targetTeamId };
}

// ── fail-closed secret/PII scan (the #1378 detector, REUSED) ────────────────

/**
 * Fail-CLOSED credential scan of the CAS-BOUND memory content, using the
 * cinatra#1378 detector (`@cinatra-ai/memory/secret-scan`) rather than a second
 * implementation — a promotion gate with its own regex set would drift away
 * from the ingest gate and let through exactly what ingest refuses.
 *
 * Fail-closed in both directions, the same way #1378 is: a credential-shaped
 * literal ANYWHERE in the envelope is NOT clean, and a scan that cannot
 * COMPLETE (a cyclic value, a bound exceeded, a scanner error) is NOT clean
 * either. "Could not look" and "looked and found nothing" must never produce
 * the same answer.
 *
 * The matched text is never returned — only the boolean and, for the caller's
 * message, nothing at all.
 */
export function scanMemoryContentForSecrets(content: unknown): { clean: boolean } {
  try {
    if (content === null || typeof content !== "object" || Array.isArray(content)) {
      // A memory row's data is an envelope object. Anything else is not a shape
      // this scan can vouch for, so it is not clean.
      return { clean: false };
    }
    const values = collectMemoryScannableStrings(content, "data");
    for (const { value } of values) {
      if (detectMemoryCredentialPattern(value) !== null) return { clean: false };
    }
    return { clean: true };
  } catch {
    return { clean: false };
  }
}

// ── injected data-layer deps (production wired below; tests inject) ─────────

export interface MemoryPromotionDeps {
  readRequestById(id: string, orgId: string): MemoryPromotionRequestRow | null;
  listRequests(input: {
    orgId: string;
    status?: MemoryPromotionRequestStatus | "all";
    requestedBy?: string;
    excludeRequester?: string;
    limit?: number;
  }): MemoryPromotionRequestRow[];
  countRequests(input: {
    orgId: string;
    status?: MemoryPromotionRequestStatus;
    requestedBy?: string;
    excludeRequester?: string;
  }): number;
  casReject(input: { id: string; orgId: string; decidedBy: string; note?: string | null }): boolean;
  markSuperseded(input: { id: string; orgId: string }): boolean;
  createRequest(input: {
    orgId: string;
    objectId: string;
    objectTitle: string;
    requestedBy: string;
    fromOwnerLevel: string;
    fromOwnerId: string;
    fromVisibility: string;
    toVisibility: MemoryPromotionVisibility;
    toOwnerLevel: string;
    toOwnerId: string;
    toOwnerLabel: string | null;
    rowVersion: number;
  }): MemoryPromotionRequestRow;
  /** Resolve a widen-target TEAM within the org (tenant containment): with
   *  `memberUserId`, additionally requires that user's team membership. Null is
   *  the single indistinguishable refusal. */
  readTeamInOrg(input: { teamId: string; orgId: string; memberUserId?: string }): { id: string; name: string } | null;
  /** Org-scoped, actor-UNfiltered read. The request surface does the actor-gated
   *  read; the decide path runs as a vetted org admin over a row the requester
   *  themselves nominated. */
  readObject(objectId: string, orgId: string): PromotableMemoryObject | null;
  /** Advisory duplicate count over memory ALREADY visible to the target
   *  audience. Never gates a decision. */
  countAudienceDuplicates(input: {
    orgId: string;
    objectId: string;
    objectType: string;
    toVisibility: MemoryPromotionVisibility;
    toOwnerId: string;
  }): number;
  /** THE ATOMIC APPLY: ONE transaction containing the request's CAS transition
   *  to `approved`, the CAS widen of the row's ownership/visibility tuple, the
   *  immutable object-history append and the durable Graphiti re-projection
   *  outbox enqueue. A CAS miss or an infra failure is a VALUE, never a throw,
   *  and leaves the request pending and the row untouched. */
  applyApproval(input: {
    request: MemoryPromotionRequestRow;
    object: PromotableMemoryObject;
    actor: ApprovalViewer;
    note: string | null;
  }): Promise<ApplyOutcome>;
  scanContent(content: unknown): { clean: boolean };
}

let cachedProdDeps: Promise<MemoryPromotionDeps> | null = null;

async function productionDeps(): Promise<MemoryPromotionDeps> {
  if (cachedProdDeps) return cachedProdDeps;
  cachedProdDeps = (async () => {
    return {
      readRequestById: (id, orgId) => store.readMemoryPromotionRequestById(id, orgId),
      listRequests: (input) => store.listMemoryPromotionRequests(input),
      countRequests: (input) => store.countMemoryPromotionRequests(input),
      casReject: (input) => store.casRejectMemoryPromotionRequest(input),
      markSuperseded: (input) => store.markMemoryPromotionRequestSuperseded(input),
      createRequest: (input) => store.createMemoryPromotionRequest(input),
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
          projectId: rec.projectId,
        };
      },
      countAudienceDuplicates: (input) => store.countAudienceVisibleMemoryDuplicates(input),
      applyApproval: async (input) => {
        try {
          // Org-write kernel authority, minted HERE (the shared multi-subject
          // decide seam carries no kernel authority). It is MEMBERSHIP-grounded:
          // a platform admin who is not a member of this org cannot mint one,
          // which is what makes this the "approver authority over the TARGET
          // scope" check rather than a bare role bit.
          const authority = await verifySessionAuthority(input.actor.userId, input.actor.orgId);
          const claim = store.buildMemoryPromotionApproveClaim({
            id: input.request.id,
            orgId: input.request.orgId,
            decidedBy: input.actor.userId,
            note: input.note,
            expectedRowVersion: input.request.rowVersion,
          });
          // PROJECT FRAME NEUTRALIZED. `historyAwareUpsert` auto-tags the row
          // with the ACTIVE project frame's project id, and the shared decide
          // path is reachable from the `approvals_*` MCP tools — which do run
          // inside an MCP request context. Approving a promotion must never
          // move a row into the approver's current project room, so the write
          // runs with no project frame at all and the statement's
          // `COALESCE($16, project_id)` preserves what the row already had.
          const write = () =>
            writer.historyAwareUpsert(
              {
                id: input.object.id,
                type: input.object.type,
                data: input.object.data,
                orgId: input.object.orgId,
                ownerLevel: input.request.toOwnerLevel,
                ownerId: input.request.toOwnerId,
                visibility: input.request.toVisibility,
              },
              {
                actor: {
                  actorId: input.actor.userId,
                  actorKind: "user",
                  orgId: input.actor.orgId,
                },
                historyEffect: "reversible-internal",
                expectedBaseVersion: input.request.rowVersion,
                authority,
                // THE ATOMIC APPLY: the claim rides INSIDE the same guarded
                // transaction as the widen + the history event + the Graphiti
                // outbox row. A lost claim raises and rolls all four back.
                coCommitStatements: [claim],
              },
            );
          const ctx = mcpRequestContextStorage.getStore();
          if (ctx) {
            mcpRequestContextStorage.run({ ...ctx, projectContext: undefined } as never, write);
          } else {
            write();
          }
          return { ok: true };
        } catch (error) {
          if (error instanceof errors.VersionConflictError) {
            // EITHER in-transaction CAS assert. Nothing was written.
            return { ok: false, reason: "cas_miss" };
          }
          if (error instanceof OrgWriteAuthorityError) {
            // The DECIDER holds no org-write authority for this org. PERMANENT
            // for this decider, never "transient": mapping it to a retryable
            // outcome would loop the same refusal forever.
            return { ok: false, reason: "not_authorized" };
          }
          // FAIL-CLOSED: every other failure is a transient VALUE, never a
          // rethrow. The transaction rolled back, so the request is still
          // pending and the row is still where it was.
          console.error("[memory-row-promotion] atomic apply failed:", error);
          return { ok: false, reason: "transient" };
        }
      },
      scanContent: (content) => scanMemoryContentForSecrets(content),
    } satisfies MemoryPromotionDeps;
  })();
  return cachedProdDeps;
}

async function resolveDeps(override?: MemoryPromotionDeps): Promise<MemoryPromotionDeps> {
  return override ?? productionDeps();
}

// ── title projection ────────────────────────────────────────────────────────

/**
 * The reviewer-facing label for a memory row: the concept's own frontmatter
 * title, else its concept id (a bundle-relative path), else the type. Never a
 * raw internal object id, and never the body.
 */
export function deriveMemoryTitle(object: PromotableMemoryObject): string {
  const data = object.data as
    | { conceptId?: unknown; frontmatter?: { title?: unknown } | null }
    | null
    | undefined;
  const fmTitle = data?.frontmatter?.title;
  if (typeof fmTitle === "string" && fmTitle.trim()) return fmTitle.trim();
  const conceptId = data?.conceptId;
  if (typeof conceptId === "string" && conceptId.trim()) return conceptId.trim();
  return object.type;
}

function toReviewRow(r: MemoryPromotionRequestRow): MemoryPromotionReviewRow {
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
export async function listMemoryPromotionInbox(
  input: { orgId: string; reviewerId: string },
  depsOverride?: MemoryPromotionDeps,
): Promise<MemoryPromotionReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  const requests = deps.listRequests({
    orgId: input.orgId,
    status: "pending",
    excludeRequester: input.reviewerId,
  });
  // The advisory duplicate signal is attached HERE, from the request rows this
  // read already holds — no second lookup, and no way for a caller to ask for
  // a hint about a request it did not just read out of its own inbox.
  return Promise.all(
    requests.map(async (r) => ({
      ...toReviewRow(r),
      duplicateHint: await memoryDuplicateHint(r, deps),
    })),
  );
}

/** The requester's OWN promotion requests (optionally narrowed to a status). */
export async function listMemoryPromotionMine(
  input: { orgId: string; requesterId: string; status?: string },
  depsOverride?: MemoryPromotionDeps,
): Promise<MemoryPromotionReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  return deps
    .listRequests({ orgId: input.orgId, requestedBy: input.requesterId, status: normalizeStatusFilter(input.status) })
    .map(toReviewRow);
}

const KNOWN_STATUSES: MemoryPromotionRequestStatus[] = ["pending", "approved", "rejected", "superseded"];

function normalizeStatusFilter(status: string | undefined): MemoryPromotionRequestStatus | "all" {
  if (status && KNOWN_STATUSES.includes(status as MemoryPromotionRequestStatus)) {
    return status as MemoryPromotionRequestStatus;
  }
  return "all";
}

export async function countMemoryPromotionInbox(
  input: { orgId: string; reviewerId: string },
  depsOverride?: MemoryPromotionDeps,
): Promise<number> {
  const deps = await resolveDeps(depsOverride);
  return deps.countRequests({ orgId: input.orgId, status: "pending", excludeRequester: input.reviewerId });
}

export async function countMemoryPromotionMine(
  input: { orgId: string; requesterId: string },
  depsOverride?: MemoryPromotionDeps,
): Promise<number> {
  const deps = await resolveDeps(depsOverride);
  return deps.countRequests({ orgId: input.orgId, status: "pending", requestedBy: input.requesterId });
}

// ── the advisory duplicate signal (memory-specific) ─────────────────────────

/**
 * A NON-IDENTIFYING advisory summary for ONE pending request: how many memory
 * concepts with the same identity are ALREADY visible to the requested target
 * audience. Returns `null` when there is nothing to say.
 *
 * It is a COUNT and nothing else — no title, no owner, no id, no excerpt — and
 * the store's query excludes every private row, so it can neither surface
 * another user's content nor answer "does person X hold a note like this?".
 *
 * ADVISORY: it never gates a decision. A failure to compute it is swallowed to
 * `null` on purpose: a broken hint must not make a promotion undecidable.
 */
export async function memoryDuplicateHint(
  request: MemoryPromotionRequestRow,
  depsOverride?: MemoryPromotionDeps,
): Promise<string | null> {
  const deps = await resolveDeps(depsOverride);
  let count = 0;
  try {
    count = deps.countAudienceDuplicates({
      orgId: request.orgId,
      objectId: request.objectId,
      objectType: MEMORY_CONCEPT_TYPE_ID,
      toVisibility: request.toVisibility,
      toOwnerId: request.toOwnerId,
    });
  } catch {
    return null;
  }
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1
    ? "Advisory: 1 concept with the same identity is already visible to the target audience."
    : `Advisory: ${count} concepts with the same identity are already visible to the target audience.`;
}

// ── create (the request surface calls this; also exercised by tests) ────────

export type CreateMemoryPromotionResult =
  | { ok: true; request: MemoryPromotionRequestRow }
  | { ok: false; code: MemoryPromotionDecideCode; message: string };

/**
 * Open a pending promotion request for ONE memory row. The transition matrix
 * and the CAS anchor are enforced HERE, at request time, as well as at approve
 * time — a request that could never be approved is refused up front rather than
 * parked in a reviewer's inbox.
 *
 * `not_found` is INDISTINGUISHABLE for an absent row, a row in another org, and
 * a row that is not a memory concept: none of them tells a caller anything
 * about what exists.
 */
export async function createMemoryRowPromotionRequest(
  input: {
    orgId: string;
    objectId: string;
    requestedBy: string;
    toVisibility: MemoryPromotionVisibility;
    /** Required for a team target (the owning team id); ignored for org. */
    targetTeamId?: string;
  },
  depsOverride?: MemoryPromotionDeps,
): Promise<CreateMemoryPromotionResult> {
  const deps = await resolveDeps(depsOverride);
  const notFound: CreateMemoryPromotionResult = {
    ok: false,
    code: "not_found",
    message: `No memory row '${input.objectId}' in this organization.`,
  };
  const object = deps.readObject(input.objectId, input.orgId);
  if (!object) return notFound;
  if (object.type !== MEMORY_CONCEPT_TYPE_ID) return notFound;
  // Fail-closed tenant assertion: a row whose org axis is not this org (or is
  // system-level) is not promotable through an org-scoped review.
  if (object.orgId !== input.orgId) return notFound;

  const target = widenTargetFor(input.toVisibility, input.orgId, input.targetTeamId);
  if (!target.ok) return { ok: false, code: target.code, message: target.message };

  const from: ScopeTuple = { ownerLevel: object.ownerLevel, visibility: object.visibility };
  const to: ScopeTuple = { ownerLevel: target.ownerLevel, visibility: input.toVisibility };
  if (!isAllowedMemoryPromotion(from, to)) {
    // Split the refusal so the message is actionable: a genuine no-op/narrowing
    // is `narrowing`; a widen the matrix does not model is `invalid_state`.
    if (!isWiden(object.visibility, input.toVisibility)) {
      return {
        ok: false,
        code: "narrowing",
        message: `Promotion must WIDEN visibility: '${object.visibility}' -> '${input.toVisibility}' is not a widen.`,
      };
    }
    return {
      ok: false,
      code: "invalid_state",
      message: `Memory promotion allows only user/private -> team/team, user/private -> organization/organization and team/team -> organization/organization; '${object.ownerLevel}/${object.visibility}' -> '${target.ownerLevel}/${input.toVisibility}' is not one of them.`,
    };
  }

  // Tenant containment + requester eligibility for a TEAM target: the team must
  // exist in THIS org and the requester must be a member of it — otherwise a
  // request could route the row to a foreign or nonexistent team (an ownership
  // transfer, not a widen). ONE indistinguishable refusal, so there is no
  // existence-vs-membership probe oracle. The name is snapshotted DISPLAY-ONLY.
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
        message: "The target team was not found in this organization (or you are not a member of it).",
      };
    }
    toOwnerLabel = team.name;
  }

  try {
    const request = deps.createRequest({
      orgId: input.orgId,
      objectId: input.objectId,
      objectTitle: deriveMemoryTitle(object),
      requestedBy: input.requestedBy,
      fromOwnerLevel: object.ownerLevel,
      fromOwnerId: object.ownerId,
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
    if (/pending promotion already exists|mpr_one_pending|duplicate key|unique constraint/i.test(message)) {
      return {
        ok: false,
        code: "conflict",
        message: `A pending promotion request already exists for memory row '${input.objectId}'.`,
      };
    }
    throw error;
  }
}

// ── the CAS decide (authorization + version guard + matrix + scan + apply) ──

export interface DecideMemoryPromotionArgs {
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
 *   1. reviewer is not an org admin                → 'not_authorized'
 *   2. request unknown (or another org's)          → 'not_found'
 *   3. request not pending                          → 'invalid_state'
 *   4. reject  → CAS pending->rejected, row UNTOUCHED; a lost CAS is 'conflict'
 *   5. approve →
 *        a. no expectedVersion                      → 'version_required'
 *        b. the row vanished / is not a memory row / is another org's
 *                                                   → 'not_found'
 *        c. the reviewer's snapshot != the request's captured version, OR the
 *           live row moved past it (edit-after-request) → SUPERSEDE the request,
 *           'stale_snapshot'
 *        d. the LIVE tuple -> the request's target is not an allowed transition
 *                                                   → 'narrowing'/'invalid_state'
 *        e. an ORGANIZATION target that is not the reviewer's org, or a TEAM
 *           target no longer in it                  → 'not_authorized'/'invalid_state'
 *        f. content fails the fail-closed secret scan → 'secret_scan'
 *        g. THE ATOMIC APPLY — one transaction: claim the request, widen the
 *           row, append immutable history, enqueue the Graphiti re-projection.
 *           A CAS miss inside it rolls everything back; the request is then
 *           re-read to say whether a concurrent DECIDER won ('conflict') or the
 *           ROW moved ('stale_snapshot', and the request is superseded).
 */
export async function decideMemoryPromotion(
  args: DecideMemoryPromotionArgs,
  depsOverride?: MemoryPromotionDeps,
): Promise<MemoryPromotionDecideOutcome> {
  const deps = await resolveDeps(depsOverride);
  const { viewer } = args;

  // 1. authorization — cheap, first, fail-closed. The org-write authority mint
  //    inside the apply is the second, membership-grounded half of it.
  if (!viewer.isAdmin) {
    return { ok: false, code: "not_authorized", message: "Only an admin can decide a memory promotion request." };
  }

  // 2/3. request existence + state (org-scoped read; another org's id reads null).
  const request = deps.readRequestById(args.requestId, viewer.orgId);
  if (!request) {
    return { ok: false, code: "not_found", message: `Unknown memory promotion request '${args.requestId}'.` };
  }
  if (request.status !== "pending") {
    return {
      ok: false,
      code: "invalid_state",
      message: `Memory promotion request '${args.requestId}' is '${request.status}', not pending.`,
    };
  }

  // 4. reject — the row is NEVER touched; a lost CAS is a conflict.
  if (args.action === "reject") {
    const won = deps.casReject({
      id: request.id,
      orgId: viewer.orgId,
      decidedBy: viewer.userId,
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

  // 5b. the row must still exist, still be a memory row, still be this org's.
  const object = deps.readObject(request.objectId, viewer.orgId);
  if (!object || object.type !== MEMORY_CONCEPT_TYPE_ID || object.orgId !== viewer.orgId) {
    return { ok: false, code: "not_found", message: `The memory row '${request.objectId}' no longer exists.` };
  }

  // 5c. CAS: the reviewer's snapshot must match the request's captured version,
  // and the LIVE row must not have moved past it. Either mismatch supersedes.
  if (!Number.isFinite(expected) || expected !== request.rowVersion || object.version !== request.rowVersion) {
    deps.markSuperseded({ id: request.id, orgId: viewer.orgId });
    return {
      ok: false,
      code: "stale_snapshot",
      message: "The memory row changed since this promotion was requested — the request was superseded.",
    };
  }

  // 5d. the transition matrix, measured against the LIVE tuple (never-narrow
  // included: none of the three allowed moves narrows).
  const from: ScopeTuple = { ownerLevel: object.ownerLevel, visibility: object.visibility };
  const to: ScopeTuple = { ownerLevel: request.toOwnerLevel, visibility: request.toVisibility };
  if (!isAllowedMemoryPromotion(from, to)) {
    if (!isWiden(object.visibility, request.toVisibility)) {
      return {
        ok: false,
        code: "narrowing",
        message: `Promotion must WIDEN visibility: '${object.visibility}' -> '${request.toVisibility}' is not a widen.`,
      };
    }
    return {
      ok: false,
      code: "invalid_state",
      message: `'${object.ownerLevel}/${object.visibility}' -> '${request.toOwnerLevel}/${request.toVisibility}' is not an allowed memory promotion.`,
    };
  }

  // 5e. APPROVER AUTHORITY OVER THE TARGET SCOPE.
  //
  // An ORGANIZATION target must be the reviewer's OWN org: the row's new owner
  // id is written verbatim, so a request carrying a foreign org id must never
  // be applied by this org's admin.
  if (request.toOwnerLevel === "organization" && request.toOwnerId !== viewer.orgId) {
    return {
      ok: false,
      code: "not_authorized",
      message: "This request names an organization other than yours as its target.",
    };
  }
  // A TEAM target must STILL exist in this org at approve time — a deleted or
  // now-foreign team id must never become the row's owner.
  //
  // RESIDUAL, stated rather than hidden: this containment read is not inside
  // the apply transaction, so a team deleted or reassigned in the window
  // between it and the commit ends up as the row's owner id. The blast radius
  // is confidentiality-FAIL-CLOSED: reads are org_id-scoped first, so a team id
  // now foreign to this org matches no reader here, and a deleted team id
  // matches nobody — the row becomes LESS visible, never more. True atomicity
  // needs the containment predicate inside the writer's own transactional CTE.
  if (request.toOwnerLevel === "team") {
    const team = deps.readTeamInOrg({ teamId: request.toOwnerId, orgId: viewer.orgId });
    if (!team) {
      return {
        ok: false,
        code: "invalid_state",
        message: "The target team no longer exists in this organization — reject this request.",
      };
    }
  }

  // 5f. fail-closed secret scan of the CAS-BOUND content. It runs on the row
  // read under the version guard above, so a credential planted between the
  // request and this approve is scanned — and refused — rather than promoted.
  if (!deps.scanContent(object.data).clean) {
    return {
      ok: false,
      code: "secret_scan",
      message: "The memory content did not pass the credential scan — promotion refused (fail-closed).",
    };
  }

  // 5g. THE ATOMIC APPLY.
  let applied: ApplyOutcome;
  try {
    applied = await deps.applyApproval({
      request,
      object,
      actor: viewer,
      note: args.reason ?? null,
    });
  } catch {
    // Defence in depth: `applyApproval` is contractually value-returning. A
    // throwing dep still leaves the transaction rolled back, so the request is
    // pending and the row untouched — the retry is safe.
    return { ok: false, code: "transient", message: "The promotion apply failed; retry the approval." };
  }
  if (applied.ok) return { ok: true };

  if (applied.reason === "cas_miss") {
    // ONE of the two in-transaction CAS asserts fired and rolled everything
    // back. Re-read the request to say WHICH: a request that is no longer
    // pending means a concurrent decider won the claim; a still-pending request
    // means the ROW moved under the widen, so the reviewed snapshot is dead.
    const now = deps.readRequestById(request.id, viewer.orgId);
    if (!now || now.status !== "pending") {
      return { ok: false, code: "conflict", message: "The request was decided concurrently; re-open the inbox." };
    }
    deps.markSuperseded({ id: request.id, orgId: viewer.orgId });
    return {
      ok: false,
      code: "stale_snapshot",
      message: "The memory row changed during approval — the request was superseded.",
    };
  }
  if (applied.reason === "not_found") {
    deps.markSuperseded({ id: request.id, orgId: viewer.orgId });
    return { ok: false, code: "not_found", message: `The memory row '${request.objectId}' no longer exists.` };
  }
  if (applied.reason === "not_authorized") {
    // PERMANENT for this decider (no org-write authority in this org — the
    // platform-admin-who-is-not-a-member case). The request is untouched, so a
    // member admin can decide it; the message says so instead of inviting an
    // endless retry.
    return {
      ok: false,
      code: "not_authorized",
      message:
        "You are not a member of this organization, so you cannot apply this promotion — it stays pending for an organization admin to decide.",
    };
  }
  return { ok: false, code: "transient", message: "The promotion apply failed transiently; retry the approval." };
}
