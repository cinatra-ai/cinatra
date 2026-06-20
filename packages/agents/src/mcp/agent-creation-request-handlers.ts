import "server-only";

import { z } from "zod";
import {
  createAgentCreationRequest,
  readAgentCreationRequestById,
  listAgentCreationRequests,
  editRejectedRequest,
  decideAgentCreationRequestCas,
  markAgentCreationRequestPublished,
  markAgentCreationRequestNotificationSent,
  computeSnapshotHash,
  AgentCreationRequestNotFoundError,
  StaleProposalError,
  InvalidStateTransitionError,
  type AgentCreationRequestSnapshot,
  type AgentCreationRequestRow,
  type AgentCreationRequestNotificationState,
} from "@/lib/agent-creation-requests-store";
import {
  readConnectorConfigFromDatabase,
} from "@/lib/database";
import { logAuditEventStrict } from "@/lib/authz/audit";

// ---------------------------------------------------------------------------
// Agent-Creation Approval Workflow — MCP primitive handlers.
//
// For a NON-admin author the proposal path NEVER touches the live
// agent_source_* tools (those stay admin-only) — the proposal queues at
// 'proposed' for admin review. For a platform_admin author the propose handler
// additionally fires the documented "instant grant" (issue #382): it
// auto-approves + publishes the freshly-created proposal under the admin actor
// via the SAME gated approve→publish pipeline the admin-only decide path uses
// (only platform_admin reaches that branch). All five primitives below are
// exposed to non-admin chat actors EXCEPT `agent_creation_request_decide`,
// which is admin-only at the handler boundary AND not on the delegated-chat
// allowlist.
// ---------------------------------------------------------------------------

const SnapshotSchema = z.object({
  oas: z.unknown(),
  packageJson: z.unknown(),
  skillMd: z.string().nullable().optional(),
});

const ProposeInput = z.object({
  packageSlug: z.string().min(1),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  oas: z.unknown(),
  packageJson: z.unknown(),
  skillMd: z.string().nullable().optional(),
});

const EditInput = z.object({
  id: z.string().min(1),
  packageVersion: z.string().min(1).optional(),
  oas: z.unknown().optional(),
  packageJson: z.unknown().optional(),
  skillMd: z.string().nullable().optional(),
});

const ListInput = z.object({
  status: z.enum(["draft", "proposed", "approved", "rejected", "published", "all"]).optional(),
  authorId: z.string().min(1).optional(),
});

const GetInput = z.object({ id: z.string().min(1) });

const DecideInput = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
  expectedSnapshotHash: z.string().min(1),
});

type ActorEnvelope = {
  actorType: string;
  source: string;
  userId?: string;
  platformRole?: string;
};
type PrimitiveReq<T = Record<string, unknown>> = {
  primitiveName: string;
  input: T;
  actor: ActorEnvelope;
  mode: string;
};

function actorUserIdOrThrow(actor: ActorEnvelope): string {
  if (!actor.userId) throw new Error("authenticated user required");
  return actor.userId;
}

function actorOrgIdOrThrow(
  actor: ActorEnvelope & { orgId?: string | null; organizationId?: string | null },
): string {
  // The MCP registry stamps `orgId`; UI server-actions may stamp
  // `organizationId`. Accept both keys so the handler is callable from
  // either surface (the registry path is the chat reachability fix).
  const orgId = actor.orgId ?? actor.organizationId ?? null;
  if (!orgId) throw new Error("active organization required");
  return orgId;
}

function isPlatformAdminActor(actor: ActorEnvelope): boolean {
  return actor.platformRole === "platform_admin";
}

function toEnvelope(
  result: AgentCreationRequestRow | AgentCreationRequestRow[] | null,
  meta?: Record<string, unknown>,
) {
  const payload = result === null ? { request: null, ...meta } : Array.isArray(result)
    ? { requests: result, ...meta }
    : { request: result, ...meta };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// agent_creation_request_propose — chat authoring entry point.
// Captures the proposal snapshot + runs the existing agent_creation_review,
// creating an agent_creation_request row at status 'proposed'.
//
// For a NON-admin author the row is returned as-is (queues for admin review).
// For a platform_admin author the documented "instant grant" fires (issue
// #382): the proposal is immediately auto-approved + published under the admin
// actor via the SAME gated approve→publish pipeline the reviewer decide path
// uses — the admin publishes directly rather than waiting on the approvals UI.
// The non-admin path itself NEVER calls agent_source_write/write_files/compile/
// publish; only the admin instant-grant reaches them (under the admin actor).
// ---------------------------------------------------------------------------
export async function handleAgentCreationRequestPropose(
  req: PrimitiveReq,
): Promise<unknown> {
  const input = ProposeInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { organizationId?: string });

  const snapshot: AgentCreationRequestSnapshot = {
    oas: input.oas as Record<string, unknown>,
    packageJson: input.packageJson as Record<string, unknown>,
    skillMd: input.skillMd ?? null,
  };

  // Early collision feedback (best-effort UX — the hard block runs at publish).
  // Importing readAgentTemplates lazily avoids a circular handlers.ts dep.
  let collisionWarning: string | undefined;
  try {
    const { readAgentTemplates } = await import("../store");
    const templates = await readAgentTemplates();
    if (templates.items.some((t) => t.packageName === input.packageName)) {
      collisionWarning =
        `An agent_template with packageName '${input.packageName}' already exists. ` +
        `The publish-time check will REJECT this proposal — ` +
        `please choose a different packageName before submitting.`;
    }
  } catch {
    // best-effort only; the hard collision check is in decide().
  }

  // Run the existing agent_creation_review primitive
  // on the proposed OAS + package.json + SKILL.md so admins see blockers /
  // warnings BEFORE deciding. Lazy import the live handler to avoid a circular
  // dep at the type layer.
  let reviewReport: unknown = { collisionWarning };
  try {
    const reviewMod = await import("../agent-creation-review");
    const reviewResult = (await reviewMod.handleAgentCreationReview({
      primitiveName: "agent_creation_review",
      input: {
        // agent_creation_review expects oasJson as a STRING (not a parsed object).
        oasJson: JSON.stringify(input.oas),
        packageJson:
          typeof input.packageJson === "string"
            ? input.packageJson
            : JSON.stringify(input.packageJson),
        ...(input.skillMd ? { skillMd: input.skillMd } : {}),
        packageSlug: input.packageSlug,
      },
      actor: req.actor as Record<string, unknown>,
      mode: "deterministic",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as Record<string, unknown>;
    reviewReport = { ...reviewResult, ...(collisionWarning ? { collisionWarning } : {}) };
  } catch (err) {
    // Non-fatal — admins can still decide on the proposal; surface the failure.
    reviewReport = {
      ...(collisionWarning ? { collisionWarning } : {}),
      reviewError: err instanceof Error ? err.message : String(err),
    };
  }

  const row = createAgentCreationRequest({
    orgId,
    authorId: userId,
    packageSlug: input.packageSlug,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    proposalSnapshot: snapshot,
    reviewReport,
  });

  // Admin "instant grant" (issue #382): when the authoring actor is a
  // platform_admin, the documented design is that the admin publishes DIRECTLY
  // — they do not queue behind a manual approval step (the approvals UI exists
  // for NON-admin proposals). Since the live agent_source_* tools are
  // intentionally NOT chat-reachable (prompt-injection boundary), the faithful
  // way to honor "admin publishes directly" from the chat-authoring surface is
  // to auto-approve+publish the freshly-created proposal under the admin actor,
  // reusing the SAME gated approve→publish pipeline the reviewer decide path
  // uses (collision checks, private-scoped publish, strict audit). This does
  // NOT widen who can publish: only platform_admin — exactly the role
  // agent_creation_request_decide already authorizes — reaches this branch.
  //
  // The reviewer self-approval guard is deliberately NOT applied here: it
  // protects the approvals-UI reviewer from rubber-stamping their own
  // proposal, which is a different concern from an admin publishing the agent
  // they authored. A NON-admin actor falls through and returns the `proposed`
  // row unchanged (the proposal still queues for admin review).
  if (isPlatformAdminActor(req.actor)) {
    const grant = (await approveAndPublishCreationRequest({
      current: row,
      adminActor: req.actor,
      orgId,
      decidedBy: userId,
      expectedSnapshotHash: row.snapshotHash,
      decisionOrigin: "admin_authoring_instant_grant",
    })) as { error?: string; structuredContent?: Record<string, unknown> };
    // On a materialize/publish failure the row stays at `approved`; surface the
    // error to the admin (recoverable via agent_creation_request_retry_publish),
    // mirroring the reviewer decide path's failure contract.
    if (grant.error) {
      return { ...grant, instantGrant: true };
    }
    // Success: the proposal was auto-approved + published. Re-attach the
    // collisionWarning meta (best-effort) so the chat surface keeps parity
    // with the non-admin propose response shape.
    if (collisionWarning && grant.structuredContent) {
      grant.structuredContent = { ...grant.structuredContent, collisionWarning };
    }
    return grant;
  }

  return toEnvelope(row, collisionWarning ? { collisionWarning } : undefined);
}

// ---------------------------------------------------------------------------
// agent_creation_request_edit — author re-snapshots a rejected request.
// ---------------------------------------------------------------------------
export async function handleAgentCreationRequestEdit(req: PrimitiveReq): Promise<unknown> {
  const input = EditInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { organizationId?: string });

  const cur = readAgentCreationRequestById(input.id, orgId);
  if (!cur) {
    return { error: `agent_creation_request '${input.id}' not found` };
  }
  if (cur.authorId !== userId) {
    return { error: "only the original author may edit a rejected request" };
  }
  const newSnapshot: AgentCreationRequestSnapshot = {
    oas: (input.oas as Record<string, unknown> | undefined) ?? cur.proposalSnapshot.oas,
    packageJson:
      (input.packageJson as Record<string, unknown> | undefined) ?? cur.proposalSnapshot.packageJson,
    skillMd: input.skillMd ?? cur.proposalSnapshot.skillMd,
  };
  // Rerun review on the edited snapshot (review-report generation also applies to edit).
  let editReviewReport: unknown | undefined;
  try {
    const reviewMod = await import("../agent-creation-review");
    editReviewReport = (await reviewMod.handleAgentCreationReview({
      primitiveName: "agent_creation_review",
      input: {
        oasJson: JSON.stringify(newSnapshot.oas),
        packageJson:
          typeof newSnapshot.packageJson === "string"
            ? newSnapshot.packageJson
            : JSON.stringify(newSnapshot.packageJson),
        ...(newSnapshot.skillMd ? { skillMd: newSnapshot.skillMd } : {}),
        packageSlug: cur.packageSlug,
      },
      actor: req.actor as Record<string, unknown>,
      mode: "deterministic",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as unknown;
  } catch {
    editReviewReport = { reviewError: "edit-time review failed; admin should decide based on the snapshot." };
  }
  try {
    const row = editRejectedRequest({
      id: input.id,
      orgId,
      authorId: userId,
      newSnapshot,
      newReviewReport: editReviewReport,
      packageVersion: input.packageVersion,
    });
    return toEnvelope(row);
  } catch (err) {
    if (err instanceof InvalidStateTransitionError) {
      return { error: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// agent_creation_request_list / get — non-admin reads own; admin reads all.
// ---------------------------------------------------------------------------
export async function handleAgentCreationRequestList(req: PrimitiveReq): Promise<unknown> {
  const input = ListInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { organizationId?: string });
  const admin = isPlatformAdminActor(req.actor);
  const rows = listAgentCreationRequests({
    orgId,
    status: input.status,
    authorId: admin ? input.authorId : userId,
  });
  return toEnvelope(rows);
}

export async function handleAgentCreationRequestGet(req: PrimitiveReq): Promise<unknown> {
  const input = GetInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { organizationId?: string });
  const admin = isPlatformAdminActor(req.actor);
  const row = readAgentCreationRequestById(input.id, orgId);
  if (!row) return { error: `agent_creation_request '${input.id}' not found` };
  if (!admin && row.authorId !== userId) {
    return { error: "forbidden — not your request" };
  }
  return toEnvelope(row);
}

// ---------------------------------------------------------------------------
// Self-approval config (admin-overridable). Stored in the `connector_config`
// substrate (not as a bare metadata key).
// ---------------------------------------------------------------------------
const SELF_APPROVAL_CONFIG_KEY = "agent_creation";
type AgentCreationConfig = { allowSelfApproval?: boolean };
function readAllowSelfApproval(): boolean {
  try {
    const cfg = readConnectorConfigFromDatabase<AgentCreationConfig>(SELF_APPROVAL_CONFIG_KEY, {});
    return cfg.allowSelfApproval === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Author-facing decision notification (issue #79). The idempotency claim is
// stamped ATOMICALLY by the decide CAS itself (decideAgentCreationRequestCas
// writes notification_state = {decision, claimedAt} in the same UPDATE that
// wins proposed → decided), so this helper runs exactly when the caller owns
// the current decision cycle's notification — at-most-once, mirroring the
// workflow reconciler's `notification_state.solicitedAt` pattern. The dedupe
// key carries `decidedAt` (a fresh timestamp per decision), so a re-decision
// after an author edit mints a fresh key while a retried send of THIS
// decision collapses via the (user_id, dedupe_key) unique index.
// Best-effort: every failure (dynamic import, write) is logged and never
// blocks the decide — the decision is already committed and audited.
// ---------------------------------------------------------------------------
async function notifyAuthorOfDecision(after: AgentCreationRequestRow): Promise<void> {
  const decided = after.status === "approved" ? ("approved" as const) : ("rejected" as const);
  // Reason comes from the COMMITTED row (persisted only for rejections) —
  // never from raw caller input that may not have been stored.
  const reason = after.rejectionReason ?? undefined;
  // The claim identity stamped by the decide CAS — threaded through to the
  // sentAt stamp so a stalled notifier can only ever acknowledge ITS OWN
  // cycle's claim (never a later cycle's, after an edit + re-decision).
  const claim = after.notificationState as AgentCreationRequestNotificationState | null;
  try {
    // Register the notifications host adapters before touching the /server
    // writers (idempotent side-effect; same contract as
    // src/lib/workflow-notifier.ts). Without it a decide reached through a
    // path that never loaded the facade/boot graph would throw inside
    // createNotificationForRecipient and silently drop the notification.
    await import("@/lib/notifications-host");
    const { createNotificationForRecipient } = await import(
      "@cinatra-ai/notifications/server"
    );
    await createNotificationForRecipient(
      // Recipient is server-derived from the persisted author row — never
      // caller-controlled (no fanout escalation).
      { kind: "user", userId: after.authorId },
      {
        title: decided === "approved" ? "Agent proposal approved" : "Agent proposal rejected",
        body:
          `Your agent creation request '${after.packageName}' was ${decided}.` +
          (reason ? ` Reason: ${reason}` : ""),
        kind: decided === "approved" ? "success" : "warning",
        // No href: the request detail page is admin-only; authors follow up
        // via the chat `agent_creation_request_get/list` primitives.
        dedupeKey: `agent-creation-request:${after.id}:${decided}:${after.decidedAt ?? ""}`,
      },
    );
    if (claim) {
      markAgentCreationRequestNotificationSent({
        id: after.id,
        orgId: after.orgId,
        decision: claim.decision,
        claimedAt: claim.claimedAt,
      });
    }
  } catch (err) {
    console.warn(
      "[agent_creation_request_decide] author notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared approve→publish pipeline. Performs the CAS proposed → approved, the
// STRICT audit, the author notification, then materialize + publish under the
// admin actor, then markPublished. Used by BOTH the manual reviewer decide
// path (handleAgentCreationRequestDecide, after reviewer policy — admin gate +
// self-approval guard — has passed) AND the platform_admin authoring
// "instant grant" path (handleAgentCreationRequestPropose). Extracting it
// keeps the privileged side-effects (audit parity, private-scoped publish,
// failure semantics) identical across both callers.
//
// The caller owns reviewer policy: this helper performs NO self-approval check
// (the admin-authoring instant grant is a distinct documented semantic — the
// self-approval guard exists only to stop a reviewer rubber-stamping their own
// proposal from the approvals UI, NOT to block an admin publishing their own
// authored agent).
//
// Returns the published-row envelope on success, or { error, request } when a
// materialize/publish step fails (the row stays at `approved`; the admin can
// retry via agent_creation_request_retry_publish — same recovery contract as
// the manual decide path).
// ---------------------------------------------------------------------------
async function approveAndPublishCreationRequest(input: {
  current: AgentCreationRequestRow;
  adminActor: ActorEnvelope;
  orgId: string;
  decidedBy: string;
  expectedSnapshotHash: string;
  /** Distinguishes the auto instant-grant from a manual reviewer decision in
   *  the audit trail. */
  decisionOrigin: "reviewer_decide" | "admin_authoring_instant_grant";
}): Promise<unknown> {
  const { current: cur, adminActor, orgId, decidedBy, expectedSnapshotHash, decisionOrigin } = input;

  // CAS update proposed → approved. StaleProposalError if the snapshot hash
  // changed since this approval was prepared.
  let after: AgentCreationRequestRow;
  try {
    after = decideAgentCreationRequestCas({
      id: cur.id,
      orgId,
      decidedBy,
      decision: "approve",
      expectedSnapshotHash,
    });
  } catch (err) {
    if (err instanceof StaleProposalError || err instanceof InvalidStateTransitionError
        || err instanceof AgentCreationRequestNotFoundError) {
      return { error: err.message };
    }
    throw err;
  }

  // STRICT audit — privileged approval; propagate failures. operation:"approve"
  // for parity with the manual decide path; decisionOrigin records WHICH path.
  await logAuditEventStrict({
    organizationId: orgId,
    actorPrincipalId: decidedBy,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "agent_creation_request",
    resourceId: cur.id,
    operation: "approve",
    decision: "allowed",
    metadata: {
      snapshotHash: expectedSnapshotHash,
      packageName: cur.packageName,
      authorId: cur.authorId,
      decisionOrigin,
    },
  });

  // Author-facing decision notification — winning the decide CAS above IS the
  // notification claim. The decision stands regardless of the publish outcome
  // below (retry_publish never re-notifies).
  await notifyAuthorOfDecision(after);

  // Materialize snapshot to disk + compile + publish (PRIVATE) under the admin
  // actor. Each step is hard-checked; the row stays at `approved` if anything
  // fails (admin retries via retry_publish; no auto-rollback — by design).
  const result = await materializeAndPublish({
    request: after,
    adminActor,
  });
  if (result.error) {
    return { error: result.error, request: after };
  }
  const published = markAgentCreationRequestPublished({
    id: cur.id,
    orgId,
    publishResult: result.publishResult,
  });
  return toEnvelope(published);
}

// ---------------------------------------------------------------------------
// agent_creation_request_decide — admin-only. CAS-guarded. Approve dispatches
// the existing gated publish under the approving admin's actor frame.
// State machine: proposed → approved (durable intermediate) → published
// (after publish succeeds).
// ---------------------------------------------------------------------------
export async function handleAgentCreationRequestDecide(req: PrimitiveReq): Promise<unknown> {
  const input = DecideInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { organizationId?: string });
  if (!isPlatformAdminActor(req.actor)) {
    return { error: "Unauthorized — admin session required to decide an agent creation request." };
  }

  const cur = readAgentCreationRequestById(input.id, orgId);
  if (!cur) {
    return { error: `agent_creation_request '${input.id}' not found` };
  }
  // Self-approval (off by default; admin-overridable via connector_config).
  // Reviewer-UI rubber-stamp protection: an admin acting as reviewer must not
  // approve a proposal they themselves authored. (The admin-authoring instant
  // grant in handleAgentCreationRequestPropose is a distinct path and is NOT
  // subject to this guard.)
  if (input.decision === "approve" && cur.authorId === userId && !readAllowSelfApproval()) {
    return {
      error:
        "self-approval is disallowed (set connector_config.agent_creation.allowSelfApproval=true to override).",
    };
  }

  if (input.decision === "reject") {
    // Reject path: CAS proposed → rejected, audit, notify. No publish.
    let after: AgentCreationRequestRow;
    try {
      after = decideAgentCreationRequestCas({
        id: input.id,
        orgId,
        decidedBy: userId,
        decision: "reject",
        reason: input.reason,
        expectedSnapshotHash: input.expectedSnapshotHash,
      });
    } catch (err) {
      if (err instanceof StaleProposalError || err instanceof InvalidStateTransitionError
          || err instanceof AgentCreationRequestNotFoundError) {
        return { error: err.message };
      }
      throw err;
    }
    await logAuditEventStrict({
      organizationId: orgId,
      actorPrincipalId: userId,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "agent_creation_request",
      resourceId: input.id,
      operation: "reject",
      decision: "allowed",
      metadata: {
        snapshotHash: input.expectedSnapshotHash,
        packageName: cur.packageName,
        authorId: cur.authorId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    await notifyAuthorOfDecision(after);
    return toEnvelope(after);
  }

  // Approve path — delegate to the shared approve→publish pipeline.
  return approveAndPublishCreationRequest({
    current: cur,
    adminActor: req.actor,
    orgId,
    decidedBy: userId,
    expectedSnapshotHash: input.expectedSnapshotHash,
    decisionOrigin: "reviewer_decide",
  });
}

// ---------------------------------------------------------------------------
// agent_creation_request_retry_publish — admin retry for a stuck `approved`
// row. If publish failed after the CAS to approved, the row stays
// at `approved` and the UI surfaces a Retry button that calls this primitive
// to re-attempt materialize + publish (no second decide / no second CAS).
// ---------------------------------------------------------------------------
export async function handleAgentCreationRequestRetryPublish(req: PrimitiveReq): Promise<unknown> {
  const input = GetInput.parse(req.input);
  const userId = actorUserIdOrThrow(req.actor);
  const orgId = actorOrgIdOrThrow(req.actor as ActorEnvelope & { orgId?: string; organizationId?: string });
  if (!isPlatformAdminActor(req.actor)) {
    return { error: "Unauthorized — admin session required to retry a publish." };
  }
  const cur = readAgentCreationRequestById(input.id, orgId);
  if (!cur) return { error: `agent_creation_request '${input.id}' not found` };
  if (cur.status !== "approved") {
    return { error: `request is in status '${cur.status}'; retry-publish is only valid for 'approved'` };
  }
  await logAuditEventStrict({
    organizationId: orgId,
    actorPrincipalId: userId,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "agent_creation_request",
    resourceId: input.id,
    operation: "retry_publish",
    decision: "allowed",
    metadata: { snapshotHash: cur.snapshotHash, packageName: cur.packageName },
  });
  const result = await materializeAndPublish({ request: cur, adminActor: req.actor });
  if (result.error) return { error: result.error };
  const published = markAgentCreationRequestPublished({
    id: input.id,
    orgId,
    publishResult: result.publishResult,
  });
  return toEnvelope(published);
}

// ---------------------------------------------------------------------------
// Approve-path materialization. Calls the live agent_source_* handlers
// in-process under the admin actor (acceptable adapter with hard error
// checks at each step + multi-step rollback via publish_result).
// ---------------------------------------------------------------------------
async function materializeAndPublish(input: {
  request: AgentCreationRequestRow;
  adminActor: ActorEnvelope;
}): Promise<{ error?: string; publishResult?: unknown }> {
  // Lazy import to avoid a circular handlers.ts dep.
  const handlersMod = await import("./handlers");
  const handlerMap = handlersMod.createAgentBuilderPrimitiveHandlers() as Record<
    string,
    (r: PrimitiveReq) => Promise<unknown>
  >;
  const { request, adminActor } = input;

  // Hardcoded approve-path invariant: publish PRIVATE-scoped.
  const adminEnvelope = { ...adminActor, platformRole: "platform_admin" } as ActorEnvelope;

  // Slug collision check (on-disk + DB).
  try {
    const { readAgentTemplates } = await import("../store");
    const templates = await readAgentTemplates();
    if (templates.items.some((t) => t.packageName === request.packageName)) {
      return {
        error:
          `package-name collision: an agent_template already uses packageName '${request.packageName}'. ` +
          `The proposal cannot be published; the author must choose a different name.`,
      };
    }
  } catch {
    // non-fatal; downstream write will fail if the slug already exists.
  }

  const oasJsonString = JSON.stringify(request.proposalSnapshot.oas);
  const writeRes = (await handlerMap["agent_source_write"]({
    primitiveName: "agent_source_write",
    input: { packageSlug: request.packageSlug, content: oasJsonString },
    actor: adminEnvelope,
    mode: "deterministic",
  })) as { error?: string };
  if (writeRes.error) return { error: `agent_source_write: ${writeRes.error}` };

  const writeFilesRes = (await handlerMap["agent_source_write_files"]({
    primitiveName: "agent_source_write_files",
    input: {
      packageSlug: request.packageSlug,
      packageJson: JSON.stringify(request.proposalSnapshot.packageJson),
      skillMd: request.proposalSnapshot.skillMd ?? "# SKILL\n",
    },
    actor: adminEnvelope,
    mode: "deterministic",
  })) as { error?: string; nameNormalized?: { from: string | null; to: string } };
  if (writeFilesRes.error) return { error: `agent_source_write_files: ${writeFilesRes.error}` };

  // Post-normalization collision check. write_files normalizes
  // `package.json#name` to `@<vendor>/<packageSlug>` AND only emits
  // `nameNormalized` when it actually changed the name. So we must check
  // EVERY candidate name (input, snapshot's package.json#name, and the
  // normalized value when emitted) against existing agent_templates.
  // No version-bump path here — collisions hard-fail.
  try {
    const { readAgentTemplates } = await import("../store");
    const templates = await readAgentTemplates();
    const existing = new Set(templates.items.map((t) => t.packageName).filter(Boolean));
    const snapshotName =
      (request.proposalSnapshot.packageJson as { name?: string } | undefined)?.name;
    const candidates = new Set<string>([
      request.packageName,
      ...(snapshotName ? [snapshotName] : []),
      ...(writeFilesRes.nameNormalized?.to ? [writeFilesRes.nameNormalized.to] : []),
    ]);
    for (const candidate of candidates) {
      if (existing.has(candidate)) {
        return {
          error:
            `package-name collision: '${candidate}' already exists as an agent_template. ` +
            `The author must choose a different packageSlug ` +
            `(no version-bump path).`,
        };
      }
    }
  } catch {
    // best-effort; the publish handler will surface any downstream error.
  }

  const compileRes = (await handlerMap["agent_source_compile"]({
    primitiveName: "agent_source_compile",
    input: { packageSlug: request.packageSlug },
    actor: adminEnvelope,
    mode: "deterministic",
  })) as { error?: string };
  if (compileRes.error) return { error: `agent_source_compile: ${compileRes.error}` };

  const publishRes = (await handlerMap["agent_source_publish"]({
    primitiveName: "agent_source_publish",
    input: { packageSlug: request.packageSlug, destination: "private" as const },
    actor: adminEnvelope,
    mode: "deterministic",
  })) as { error?: string };
  if (publishRes.error) return { error: `agent_source_publish: ${publishRes.error}` };

  return { publishResult: publishRes };
}
