"use server";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";
import { requireActorContext } from "@/lib/auth-session";
import { createSessionObjectsClient } from "@cinatra-ai/objects";

// Campaign stage reads route through canonical `objects_*` (objects_list/get)
// carrying full actor context instead of raw `agentBuilderPool.query` against
// cinatra.objects. The kernel applies object.* authz + project_access +
// role-based authorization. The type-OR + JSONB-shape +
// latest-by-createdAt disambiguation that lived in SQL is reproduced
// client-side over the canonical result. Static `@cinatra-ai/campaigns:*`
// bundle types are accepted alongside the legacy `@cinatra-ai/dynamic:*` ids
// for back-compat reads without historical re-typing.
type ObjEnvelope = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt?: string;
  actor?: { runId?: string | null };
};

const RECIPIENTS_TYPES = new Set<string>([
  "@cinatra-ai/campaigns:recipients",
  "@cinatra-ai/dynamic:email-recipients-bundle",
]);
const DRAFT_TYPES = new Set<string>([
  "@cinatra-ai/campaigns:email-draft-bundle", // canonical
  "@cinatra-ai/campaigns:drafts", // legacy standalone-agent variant (back-compat read)
  "@cinatra-ai/dynamic:email-drafts-bundle", // legacy embedded variant (back-compat read)
  "@cinatra-ai/dynamic:approved-email-draft-bundle", // reviewer output (back-compat read)
]);
const FOLLOWUP_TYPES = new Set<string>([
  "@cinatra-ai/campaigns:email-followup-bundle", // canonical
  "@cinatra-ai/campaigns:followups", // legacy standalone-agent variant (back-compat read)
  "@cinatra-ai/dynamic:email-followup-bundle", // legacy embedded variant (back-compat read)
  "@cinatra-ai/dynamic:approved-email-followup-bundle", // reviewer output (back-compat read)
]);

const asArr = (v: unknown): Record<string, unknown>[] | null =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : null;

// Mirror the JSONB shape probes from the retired SQL.
function isDraftShapedRecipients(data: Record<string, unknown>): boolean {
  const cr = asArr(data.confirmedRecipients);
  return !!cr && cr.length > 0 && "body" in cr[0] && "subject" in cr[0];
}
function looksLikeRecipients(o: ObjEnvelope): boolean {
  // type match AND NOT draft-shaped (the SQL's `AND NOT (...)`).
  return RECIPIENTS_TYPES.has(o.type) && !isDraftShapedRecipients(o.data);
}
function looksLikeInitialDraft(o: ObjEnvelope): boolean {
  if (DRAFT_TYPES.has(o.type)) return true;
  const d = asArr(o.data.drafts);
  if (d && d.length > 0 && "body" in d[0]) return true;
  const cr = asArr(o.data.confirmedRecipients);
  return !!cr && cr.length > 0 && "body" in cr[0] && "subject" in cr[0] && !("step" in cr[0]);
}
function looksLikeFollowup(o: ObjEnvelope): boolean {
  if (FOLLOWUP_TYPES.has(o.type)) return true;
  const seq = asArr(o.data.sequence);
  if (seq && seq.length > 0 && "step" in seq[0]) return true;
  const fu = asArr(o.data.followups);
  if (fu && fu.length > 0 && "body" in fu[0]) return true;
  const cr = asArr(o.data.confirmedRecipients);
  return !!cr && cr.length > 0 && "step" in cr[0];
}
function pickLatest(items: ObjEnvelope[]): ObjEnvelope | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  )[0];
}
async function listRunObjects(runId: string): Promise<ObjEnvelope[]> {
  const actor = await requireActorContext();
  const client = createSessionObjectsClient(actor);
  const listed = (await client.list({ runId, limit: 500 })) as { items?: ObjEnvelope[] };
  return Array.isArray(listed.items) ? listed.items : [];
}

// The campaign-email-outreach primitive handlers are archived. Stub all
// primitives the HITL renderers call as fallback so they return safe-empty
// values instead of throwing. The primary data path for steps 2-4 is
// fetchChildInterruptOutput() — stubs are the last resort.
const createEmailOutreachPrimitiveHandlers = () => ({
  // Recipients list: reads from the objects table where email-recipients LLM
  // persists confirmed recipients via objects_save (SKILL.md STEP 3.5).
  email_outreach_recipients_list: async (req: unknown) => {
    const runId = (req as { input?: { runId?: string } } | null)?.input?.runId;
    if (!runId) return { items: [], total: 0, hasMore: false };
    try {
      const candidate = pickLatest((await listRunObjects(runId)).filter(looksLikeRecipients));
      if (!candidate) return { items: [], total: 0, hasMore: false };
      const raw = candidate.data as {
        recipients?: Array<Record<string, unknown>>;
        confirmedRecipients?: Array<Record<string, unknown>>;
        sourceListId?: string;
        sourceListName?: string;
        sourceListMemberType?: string;
        sourceListSnapshotAt?: string;
      };
      // LLM saves as confirmedRecipients; legacy objects used recipients
      const recipients = raw.confirmedRecipients ?? raw.recipients ?? [];
      const items: StageRecipient[] = recipients.map((r) => ({
        // startupId is the account/company link target — accountId (falls back
        // to the row's own startupId; NOT contactId, so the company link and
        // the contact link stay distinct).
        startupId: String(r.accountId ?? r.startupId ?? ""),
        startupName: (r.accountName ?? r.startupName) as string | null ?? null,
        contactName: (r.name ?? r.contactName) as string | null ?? null,
        contactEmail: (r.email ?? r.contactEmail) as string | null ?? null,
        contactTitle: (r.title ?? r.contactTitle) as string | null ?? null,
        // Carry the bundle's own contactId (CRM provider-native id) so the
        // renderer's contact-name link resolves on the fetched-bundle path
        // too (not just the preloaded agent-output path).
        contactId: (r.contactId as string | null | undefined) ?? null,
      }));
      // Surface bundle-level list provenance when present.
      // When sourceListId is absent or empty (legacy bundles), omit the `source`
      // key entirely from the response — do NOT return `source: null` or
      // `source: undefined`. The consumer types `source?` as optional and tests
      // assert the key is absent for legacy bundles.
      const sourceListId =
        typeof raw.sourceListId === "string" ? raw.sourceListId.trim() : "";
      const response: {
        items: StageRecipient[];
        total: number;
        hasMore: boolean;
        source?: {
          listId: string;
          listName: string;
          memberType?: string;
          snapshotAt?: string;
        };
      } = { items, total: items.length, hasMore: false };
      if (sourceListId) {
        response.source = {
          listId: sourceListId,
          listName:
            typeof raw.sourceListName === "string" ? raw.sourceListName : "",
          ...(typeof raw.sourceListMemberType === "string" &&
          raw.sourceListMemberType
            ? { memberType: raw.sourceListMemberType }
            : {}),
          ...(typeof raw.sourceListSnapshotAt === "string" &&
          raw.sourceListSnapshotAt
            ? { snapshotAt: raw.sourceListSnapshotAt }
            : {}),
        };
      }
      return response;
    } catch (err) {
      console.warn("[email_outreach_recipients_list] DB query failed:", err instanceof Error ? err.message : String(err));
      return { items: [], total: 0, hasMore: false };
    }
  },
  email_outreach_campaign_async_operation_status: async (_req: unknown) => ({ status: "idle" }),
  // Missing stubs added — safe-empty values; primary data path is fetchChildInterruptOutput()
  email_outreach_recipients_confirm: async (_req: unknown) => ({ ok: true }),
  email_outreach_recipients_clear: async (_req: unknown) => ({ ok: true }),
  // Drafts list: reads from the objects table where drafts-draft LLM persists
  // draft bundle via objects_save with typeHint @cinatra-ai/dynamic:email-drafts-bundle.
  // Accepts either runId (direct) or campaignId (context object ID — resolved to
  // run_id via a join). The classifier sometimes maps the typeHint to a different
  // registered type, so we scan all objects for this run_id that have a data.drafts
  // array regardless of stored type.
  email_outreach_initial_drafts_list: async (req: unknown) => {
    const input = (req as { input?: { runId?: string; campaignId?: string; xRenderer?: string } } | null)?.input;
    const runId = input?.runId;
    const campaignId = input?.campaignId;
    const isFollowups = input?.xRenderer?.includes("followups");
    if (!runId && !campaignId) return { items: [], total: 0 };
    try {
      // Resolve run_id: prefer direct runId, else resolve via campaignId (a
      // context object id whose canonical envelope actor.runId IS the agent run
      // id). objects_get applies authz; falls back to campaignId as run id.
      let resolvedRunId = runId;
      if (!resolvedRunId && campaignId) {
        const actor = await requireActorContext();
        const client = createSessionObjectsClient(actor);
        const got = (await client.get(campaignId)) as {
          object?: { actor?: { runId?: string | null } } | null;
        };
        resolvedRunId = got.object?.actor?.runId ?? campaignId;
      }
      if (!resolvedRunId) return { items: [], total: 0 };
      const runObjects = await listRunObjects(resolvedRunId);
      // Route to follow-up or initial-draft selection client-side over the
      // canonical run objects (replaces the dual raw-SQL type-OR + JSONB-shape
      // probes + ORDER BY created_at DESC LIMIT 1).
      const candidate = pickLatest(
        runObjects.filter(isFollowups ? looksLikeFollowup : looksLikeInitialDraft),
      );
      if (!candidate) return { items: [], total: 0 };
      const raw = candidate.data as {
        drafts?: Array<Record<string, unknown>>;
        sequence?: Array<Record<string, unknown>>;
        confirmedRecipients?: Array<Record<string, unknown>>;
        followups?: Array<Record<string, unknown>>;
      };
      // sequence: approved-email-followup-bundle reviewer output
      // followups / drafts: legacy formats; confirmedRecipients: oldest format
      const drafts = raw.sequence ?? raw.followups ?? raw.drafts ?? raw.confirmedRecipients ?? [];
      const objectId = candidate.id;
      const items: StageDraft[] = drafts.map((d, i) => ({
        id: String(d.id ?? `${objectId}-${i}`),
        recipientId: String(d.recipientEmail ?? d.step ?? d.recipientId ?? i),
        recipientEmail: (d.recipientEmail ?? d.email) as string | null ?? null,
        subject: String(d.subject ?? ""),
        body: String(d.body ?? ""),
        status: String(d.status ?? "draft"),
      }));
      return { items, total: items.length };
    } catch (err) {
      console.warn("[email_outreach_initial_drafts_list] DB query failed:", err instanceof Error ? err.message : String(err));
      return { items: [], total: 0 };
    }
  },
  email_outreach_initial_drafts_update: async (_req: unknown) => ({ ok: true }),
  email_outreach_review_check_run: async (_req: unknown) => ({ ok: true }),
  email_outreach_review_check_get: async (_req: unknown) => ({ status: "idle", recommendations: [] as unknown[] }),
  email_outreach_review_recommendation_dismiss: async (_req: unknown) => ({ ok: true }),
  email_outreach_review_recommendation_apply_start: async (_req: unknown) => ({ ok: true }),
});

// ---------------------------------------------------------------------------
// Actor context — all stage actions are user-initiated from the UI
// ---------------------------------------------------------------------------

const STAGE_ACTOR: PrimitiveActorContext = {
  actorType: "human",
  source: "ui",
};

// ---------------------------------------------------------------------------
// Internal helper — creates a fresh in-process transport per call
// ---------------------------------------------------------------------------

async function callPrimitive<T = unknown>(
  primitiveName: string,
  input: Record<string, unknown>,
): Promise<T> {
  const transport = createInProcessPrimitiveTransport(
    createEmailOutreachPrimitiveHandlers(),
  );
  return invokePrimitive<Record<string, unknown>, T>(transport, {
    primitiveName,
    input,
    actor: STAGE_ACTOR,
    mode: "deterministic",
  });
}

// ---------------------------------------------------------------------------
// Local UI-shape types — renderers use these, not package internals
// ---------------------------------------------------------------------------

export type StageRecipient = {
  startupId: string;
  startupName?: string | null;
  website?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactTitle?: string | null;
  /**
   * CRM provider-native contact id (e.g. Twenty Person id) carried straight
   * from the recipients bundle. Optional: legacy bundles persisted before
   * the bundle stored a contactId render the name only. Kept on the type
   * for forward compat with downstream consumers; the recipients-review
   * renderer no longer surfaces it as a clickable link (CRM browse lives
   * in Twenty, reached via the `crm_*` MCP facade — not in cinatra UI).
   */
  contactId?: string | null;
};

export type StageDraft = {
  id: string;
  recipientId: string;
  recipientEmail?: string | null;
  subject: string;
  body: string;
  status?: string;
};

export type StageReviewCheck = {
  status: string;
  recommendations: Array<{
    id: string;
    severity: string;
    title: string;
    description?: string;
    draftId?: string | null;
  }>;
};

// ---------------------------------------------------------------------------
// Child interrupt output — WayFlow child-run state inspection is not
// implemented yet, so renderers fall back to their stub data path.
// ---------------------------------------------------------------------------

export async function fetchChildInterruptOutput(
  _childRunId: string,
): Promise<string | null> {
  // ---------------------------------------------------------------------------
  // The child-run interrupt-state probe is removed. HITL renderers fall back
  // to their stub data path until WayFlow child-run state inspection is
  // implemented.
  // ---------------------------------------------------------------------------
  return null;
}

// ---------------------------------------------------------------------------
// Async status helper (used by HITL renderers)
// ---------------------------------------------------------------------------

/**
 * Polls async operation status.
 */
export async function checkEmailOutreachAsyncStatus(input: {
  campaignId: string;
  kind: string;
}): Promise<{ status: string; phase?: string }> {
  const result = await callPrimitive<{ status: string; phase?: string }>(
    "email_outreach_campaign_async_operation_status",
    { campaignId: input.campaignId, kind: input.kind },
  );
  return { status: result?.status ?? "pending", phase: result?.phase };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Fetch recipients for a run. The underlying lookup uses run_id + type =
 * '@cinatra-ai/campaigns:recipients' instead of data->>'campaignId'.
 * Recipients are stored as their own typed object.
 */
export async function fetchCampaignRecipients(
  runId: string,
): Promise<{
  items: StageRecipient[];
  total: number;
  source?: {
    listId: string;
    listName: string;
    memberType?: string;
    snapshotAt?: string;
  };
}> {
  const result = await callPrimitive<{
    items: StageRecipient[];
    total: number;
    source?: {
      listId: string;
      listName: string;
      memberType?: string;
      snapshotAt?: string;
    };
  }>("email_outreach_recipients_list", { runId });
  return result;
}

export async function confirmCampaignRecipients(campaignId: string): Promise<void> {
  await callPrimitive("email_outreach_recipients_confirm", { campaignId });
}

export async function removeEmailOutreachRecipient(input: {
  campaignId: string;
  startupId: string;
}): Promise<void> {
  await callPrimitive("email_outreach_recipients_clear", {
    campaignId: input.campaignId,
    startupIds: [input.startupId],
  });
}

/**
 * Batch variant: clears multiple recipients in a single server call.
 * The underlying primitive `email_outreach_recipients_clear` already accepts an
 * array of startupIds — this helper just forwards it directly so callers can
 * flush many staged removals without N round-trips.
 *
 * Caller is responsible for de-duplicating startupIds before calling.
 */
export async function removeEmailOutreachRecipients(input: {
  campaignId: string;
  startupIds: string[];
}): Promise<void> {
  if (input.startupIds.length === 0) return;
  await callPrimitive("email_outreach_recipients_clear", {
    campaignId: input.campaignId,
    startupIds: input.startupIds,
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function fetchInitialDrafts(
  campaignId: string | undefined,
  runId?: string,
  xRenderer?: string,
): Promise<{ items: StageDraft[]; total: number }> {
  const result = await callPrimitive<{ items: StageDraft[]; total: number }>(
    "email_outreach_initial_drafts_list",
    { campaignId, runId, xRenderer },
  );
  return result;
}

export async function updateInitialDraft(input: {
  campaignId: string;
  draftId: string;
  subject: string;
  body: string;
  status?: string;
}): Promise<void> {
  await callPrimitive("email_outreach_initial_drafts_update", {
    campaignId: input.campaignId,
    draftId: input.draftId,
    subject: input.subject,
    body: input.body,
    status: input.status ?? "draft",
  });
}

// ---------------------------------------------------------------------------
// Review check
// ---------------------------------------------------------------------------

export async function runReviewCheck(input: {
  serviceId: string;
  campaignId: string;
}): Promise<void> {
  await callPrimitive("email_outreach_review_check_run", {
    serviceId: input.serviceId,
    campaignId: input.campaignId,
  });
}

export async function getReviewCheckState(
  campaignId: string,
): Promise<StageReviewCheck> {
  const result = await callPrimitive<StageReviewCheck>(
    "email_outreach_review_check_get",
    { campaignId },
  );
  return {
    status: result?.status ?? "idle",
    recommendations: Array.isArray(result?.recommendations)
      ? result.recommendations
      : [],
  };
}

export async function dismissReviewRecommendation(input: {
  serviceId: string;
  campaignId: string;
  ids: string[];
}): Promise<void> {
  await callPrimitive("email_outreach_review_recommendation_dismiss", {
    serviceId: input.serviceId,
    campaignId: input.campaignId,
    ids: input.ids,
  });
}

export async function applyReviewRecommendation(input: {
  serviceId: string;
  campaignId: string;
  ids: string[];
}): Promise<void> {
  await callPrimitive("email_outreach_review_recommendation_apply_start", {
    serviceId: input.serviceId,
    campaignId: input.campaignId,
    ids: input.ids,
  });
}
