import "server-only";

// Host-side resolution of the `linkedin-post-draft-writer` capability (the
// lazy/guarded host-access cutover — the same shape as
// `social-media-system-provider.ts` and `crm-integration-providers.ts`).
//
// This file is named by its host MECHANISM (a member post-draft writer
// provider), never by the vendor — core owns integration mechanism, not vendor
// code (epic cinatra#978, vendor-token-core-gate). The LinkedIn identity lives
// ONLY in the host↔connector contract string literals below (capability id +
// draftable type id), exactly as `host-content-editor-dispatch.ts` names the
// shared WordPress/Drupal writer mechanism generically.
//
// The linkedin-connector's `register(ctx)` registers a member post-draft row
// writer behind the `linkedin-post-draft-writer` capability id
// (linkedin-connector#59, cinatra#1457). Unlike the wordpress:post /
// drupal:node EXTERNAL-pointer writers, a LinkedIn draft carries authored
// CONTENT: the writer validates the draft fail-closed against the LinkedIn
// per-network constraints (member text limit, member-only destination,
// provider-URN media references) and upserts a DRAFT row for the host-registered
// `@cinatra-ai/linkedin:post-draft` type (packages/objects/.../register-types.ts,
// #1808) through the host objects surface. It writes draft CONTENT ONLY — never
// a receipt or a lifecycle transition (those ride the publication-operation
// ledger, cinatra#1450/#1774).
//
// The host draft/publish-prep trigger resolves this capability HERE at call
// time — never by value-importing the linkedin-connector package (host-peer
// value-import ban). The trigger supplies the validated draft content plus the
// org/user the draft actor is minted from (REQUIRED: the connector's
// `objects_save` call rejects a null org, and a worker/prep frame has no ambient
// `mcpRequestContextStorage` context).
//
// Degraded mode: with the linkedin-connector absent/inactive no provider is
// registered, so `resolveLinkedinPostDraftWriter()` returns null — a caller
// that can degrade warns and skips; a caller that cannot proceed without it uses
// `requireLinkedinPostDraftWriter()` (fail-loud with an actionable message).

import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

/** The capability id the linkedin-connector registers its member post-draft
 * writer under. Inlined as a literal on BOTH sides (the connector inlines the
 * same string) — the pairing is a host↔connector contract, not an SDK export, so
 * neither half takes a static edge to the other and `packages/sdk-extensions`
 * (a high-risk path) stays untouched. */
export const LINKEDIN_POST_DRAFT_WRITER_CAPABILITY = "linkedin-post-draft-writer";

/** The host-registered draftable type id the writer materializes rows for
 * (registered host-side in packages/objects/.../register-types.ts, #1808). */
export const LINKEDIN_POST_DRAFT_TYPE_ID = "@cinatra-ai/linkedin:post-draft";

/** The validated member post-draft content the trigger hands the writer. A
 * STRUCTURAL mirror of the connector's `LinkedinPostDraftWriteRequest` (the host
 * must not import connector internals): the connector re-validates every field
 * fail-closed against its per-network Zod schema before it writes, so this shape
 * is the permissive host-side view, not the trusted boundary. */
export type LinkedinPostDraftWriteRequest = {
  /** The member share commentary (a media-only draft is legal; the connector's
   * schema requires text OR at least one media asset). */
  content?: string;
  /** The MEMBER destination (the per-network constraint, cinatra#1457): the
   * organization-page draft is a SEPARATE type (#1767). */
  destination: {
    accountId: string;
    destinationType: "member";
    destinationId: string;
  };
  /** Member-network visibility (defaults left to the publish path). */
  visibility?: "PUBLIC" | "CONNECTIONS";
  /** Provider media asset URNs (`urn:li:…`), NEVER artifact ids. */
  mediaAssetRefs?: string[];
  /** Soft-provenance run correlation (drives the host-side (runId,
   * destinationId) dedup identity — never an FK). */
  runId?: string;
  /** Soft-provenance campaign correlation. */
  campaignId?: string;
  /** The org the draft row is scoped to (REQUIRED — objects_save rejects a null
   * org). */
  orgId: string;
  /** The user when the trigger is user-attributed. */
  userId?: string | null;
};

/** The result the writer returns — the host `objects_save` result surfaced back
 * through the connector's `writeDraft`. A structural mirror of
 * `ObjectsSaveResult` (the connector already carries that SDK type). */
export type LinkedinPostDraftWriteResult = {
  objectId: string;
  type: string;
  isNew: boolean;
  wasMerged: boolean;
  confidence: number;
  changeSetId: string;
};

/** The writer surface the capability publishes. */
export type LinkedinPostDraftWriter = {
  writeDraft(request: LinkedinPostDraftWriteRequest): Promise<LinkedinPostDraftWriteResult>;
};

/** Structural guard: a capability impl is `unknown` by contract — this is the
 * runtime trust boundary. */
function isLinkedinPostDraftWriter(impl: unknown): impl is LinkedinPostDraftWriter {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { writeDraft?: unknown }).writeDraft === "function";
}

/** The live LinkedIn member post-draft writer, or null when the
 * linkedin-connector is absent/inactive. */
export function resolveLinkedinPostDraftWriter(): LinkedinPostDraftWriter | null {
  const match = resolveCapabilityProviders(LINKEDIN_POST_DRAFT_WRITER_CAPABILITY).find((p) =>
    isLinkedinPostDraftWriter(p.impl),
  );
  return match ? (match.impl as LinkedinPostDraftWriter) : null;
}

/** Fail-loud resolution for a trigger that cannot proceed without the writer. */
export function requireLinkedinPostDraftWriter(): LinkedinPostDraftWriter {
  const writer = resolveLinkedinPostDraftWriter();
  if (!writer) {
    throw new Error(
      "LinkedIn post-draft writer unavailable — the linkedin-connector extension is not " +
        "installed/active. Install/activate it to create LinkedIn member post drafts.",
    );
  }
  return writer;
}

/**
 * The host draft/publish-prep TRIGGER: resolve the connector's member
 * post-draft writer and materialize a DRAFT row for `@cinatra-ai/linkedin:post-draft`.
 *
 * Fail-closed content validation, the draft-actor mint, and the
 * (runId, destinationId) idempotent upsert all happen connector-side; this host
 * seam only resolves the capability and forwards the request in the caller's
 * trusted org/user frame. Writes draft CONTENT ONLY — the draft→scheduled→published
 * state machine and the publish receipts (post URN/URL) ride the
 * publication-operation ledger (cinatra#1450/#1774), never this path.
 *
 * Returns null in degraded mode (connector absent) so a best-effort prep step
 * can skip rather than crash; pass `require: true` for a step that must not
 * silently no-op.
 */
export async function createLinkedinPostDraft(
  request: LinkedinPostDraftWriteRequest,
  options?: { require?: boolean },
): Promise<LinkedinPostDraftWriteResult | null> {
  const writer = options?.require
    ? requireLinkedinPostDraftWriter()
    : resolveLinkedinPostDraftWriter();
  if (!writer) return null;
  return writer.writeDraft(request);
}
