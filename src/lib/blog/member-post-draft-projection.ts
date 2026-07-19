import "server-only";

// Typed `@cinatra-ai/linkedin:post-draft` projection at the LinkedIn publish-prep
// call-site (cinatra#1457).
//
// PR #1831 shipped the host trigger `createLinkedinPostDraft` (resolves the
// linkedin-connector's fail-closed member post-draft writer capability) and the
// `assertDraftableWriteAllowed` write-lock gate, but left OPEN which host
// publish-prep stage invokes the trigger. This module is that call-site glue: at
// the actor-scoped blog LinkedIn publish-prep enqueuer (`publishLinkedInDraft`),
// it materializes the durable typed member post-draft row that the merged
// draftable-lock-gate + publication-operation ledger (#1450/#1774) then govern.
//
// Posture — the merged email precedent (`emitEmailFanout` in
// `trigger-email-send-use-cases.ts`) materializes the draftable `email:body`
// type as a durable projection AT the send/publish boundary, org via the actor
// frame, BEST-EFFORT ("a projection failure NEVER fails the send"). This mirrors
// it: the actual LinkedIn transport routes through the social-media-connector
// (`requireSocialMediaSystem().publishPost`), a DIFFERENT connector — so a missing
// linkedin-connector writer must NOT block the publish. Instead the writer-absent
// case surfaces a VISIBLE degraded outcome the caller reports durably (no silent
// skip), and the publish proceeds.
//
// IDEMPOTENCY — the typed type's identity is `(runId, destinationId)` and runId
// must be colon-free. `publishLinkedInDraft` can be retried, so this derives a
// DETERMINISTIC, colon-free run-scope id from the blog draft coordinates
// (`blog-linkedin-<projectId>-<postId>-<draftId>`; the ids are colon-free uuids).
// Combined with the real destinationId the connector writer's objects_save
// upserts the SAME row on retry rather than duplicating (matching the email
// fan-out's deterministic-runScopeId mechanism).
//
// SCOPE — this materializes the row; it does NOT drive the publication ledger
// (schedulePublication has zero production callers anywhere yet — the ledger-driven
// schedule/publish that LOCKS a draftable row is a distinct, still-unwired leg for
// ALL draftable types, exactly as the email precedent leaves email:body
// ledger-unlinked). So the blog publish does NOT automatically lock this row; the
// row is GOVERNABLE by the ledger/lock lifecycle (a subsequent schedule → the
// merged gate refuses edits), which is what #1457 asks this call-site to prove.
//
// MEMBER-ONLY — the organization-page post-draft is a SEPARATE type
// (`@cinatra-ai/linkedin-community:org-post-draft`, cinatra#1767); this fires only
// for `destinationType === "member"` and never on a non-member/non-linkedin draft.

import {
  createLinkedinPostDraft,
  type LinkedinPostDraftWriteRequest,
} from "@/lib/member-post-draft-writer-provider";

/**
 * Deterministic, colon-free run-scope id for the `(runId, destinationId)`
 * identity of the typed `@cinatra-ai/linkedin:post-draft` row derived from a blog
 * LinkedIn draft. Colon-free so it composes unambiguously with `destinationId` in
 * the type's identityKey (`${runId}:${destinationId}`, first colon delimits).
 */
export function blogLinkedinDraftRunScopeId(input: {
  projectId: string;
  postId: string;
  draftId: string;
}): string {
  return `blog-linkedin-${input.projectId}-${input.postId}-${input.draftId}`;
}

/** The outcome of a projection attempt — a discriminated union so the caller can
 * surface the degraded state durably (no silent skip) without string-matching. */
export type LinkedinMemberPostDraftProjectionOutcome =
  | { status: "materialized"; objectId: string; isNew: boolean }
  | { status: "skipped"; reason: string }
  | { status: "degraded"; message: string };

export type ProjectLinkedinMemberPostDraftInput = {
  projectId: string;
  postId: string;
  draftId: string;
  /** The org the typed draft row is scoped to — resolved from the actor frame at
   * the call-site. Null (no actor org) skips the projection (never a null-org
   * write). */
  orgId: string | null;
  userId?: string | null;
  /** The bespoke blog draft's destination — only `member` is projected here. */
  destinationType: "member" | "organization";
  accountId: string;
  destinationId: string;
  /** The LinkedIn copy bytes (same content the publish path reads). */
  content: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
  mediaAssetRefs?: string[];
};

export type ProjectLinkedinMemberPostDraftDeps = {
  create?: typeof createLinkedinPostDraft;
};

/**
 * Materialize the typed member `@cinatra-ai/linkedin:post-draft` row for a blog
 * LinkedIn draft. Pure over the injected `create` (the host trigger in
 * production, a fake in tests). NEVER throws — every failure/absence is returned
 * as a structured outcome the caller reports; it must never abort the publish.
 */
export async function projectLinkedinMemberPostDraft(
  input: ProjectLinkedinMemberPostDraftInput,
  deps: ProjectLinkedinMemberPostDraftDeps = {},
): Promise<LinkedinMemberPostDraftProjectionOutcome> {
  // (d) member-only — org-page posts are the separate type cinatra#1767.
  if (input.destinationType !== "member") {
    return {
      status: "skipped",
      reason: `destinationType "${input.destinationType}" is not a member post (organization-page drafts are cinatra#1767)`,
    };
  }
  // (b) org is REQUIRED — the writer's objects_save rejects a null org, and a
  // null-org write has no scope to resolve claims/identity against.
  if (!input.orgId) {
    return {
      status: "skipped",
      reason: "no organization in the actor frame — the typed LinkedIn draft cannot be org-scoped",
    };
  }
  if (input.accountId.trim() === "" || input.destinationId.trim() === "") {
    return {
      status: "skipped",
      reason: "the blog LinkedIn draft is missing a resolved account/destination",
    };
  }

  const runId = blogLinkedinDraftRunScopeId(input);
  const request: LinkedinPostDraftWriteRequest = {
    content: input.content,
    destination: {
      accountId: input.accountId,
      destinationType: "member",
      destinationId: input.destinationId,
    },
    orgId: input.orgId,
    userId: input.userId ?? null,
    runId,
    ...(input.visibility ? { visibility: input.visibility } : {}),
    ...(input.mediaAssetRefs && input.mediaAssetRefs.length > 0
      ? { mediaAssetRefs: input.mediaAssetRefs }
      : {}),
  };

  const create = deps.create ?? createLinkedinPostDraft;
  try {
    // (c) `require: true` fails LOUD when the linkedin-connector writer is absent
    // — caught here and returned as a degraded outcome (surfaced durably by the
    // caller, no silent skip). NOT rethrown: the publish must proceed.
    const result = await create(request, { require: true });
    if (!result) {
      // `require: true` never returns null; defensive against a future contract
      // change so a degraded writer surfaces rather than throwing.
      return {
        status: "degraded",
        message: "the LinkedIn post-draft writer returned no result",
      };
    }
    return { status: "materialized", objectId: result.objectId, isNew: result.isNew };
  } catch (err) {
    return {
      status: "degraded",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
