import "server-only";

// ---------------------------------------------------------------------------
// Email correlation query seam (cinatra#1456).
//
// The indexed, server-side read path for the thread / campaign / contact views
// over the email transport records (`@cinatra-ai/email:sent-email`,
// `@cinatra-ai/email:received-reply`, `@cinatra-ai/email:recipient`,
// `@cinatra-ai/email:body`). It exists because a generic list cannot otherwise
// filter by `data.<field>` — the correlation ids (`threadId` / `campaignId` /
// `contactId`) live in the JSONB `data` column, so these views would otherwise
// be a client-side scan over every email object.
//
// AUTHORIZATION. Reads route through the CANONICAL `objects_list` primitive
// (createSessionObjectsClient(actor).list), so every row is gated by the same
// per-row `object.read` authorization objects_list applies — the seam invents
// NO authority of its own. The only thing new here is the allow-listed
// `dataEquals` filter, which objects_list pushes into SQL as `data->>'<key>' =
// $n` backed by the partial expression indexes (`objects_data_thread_idx` /
// `_campaign_idx` / `_contact_idx`). The seam takes the CALLER's ActorContext
// (the viewing user in production); it never fabricates a privileged actor.
//
// A thread is a RELATIONSHIP, not an artifact (epic #1448 atomicity rule 2):
// there is NO `@cinatra-ai/email:thread` row read here and NO object-id-array
// resolution. The correlation ids are SOFT provenance — a missing / tombstoned
// campaign / contact / thread target simply yields an empty view and never
// affects the read / pin / delete / GC / lifecycle of any email record.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import { createSessionObjectsClient } from "@cinatra-ai/objects";
import { deriveThreadId } from "@/lib/email-thread-key";

export { deriveThreadId } from "@/lib/email-thread-key";

const SENT_EMAIL_TYPE = "@cinatra-ai/email:sent-email";
const RECEIVED_REPLY_TYPE = "@cinatra-ai/email:received-reply";
const RECIPIENT_TYPE = "@cinatra-ai/email:recipient";
const BODY_TYPE = "@cinatra-ai/email:body";

// Per-type page budget. objects_list caps `limit` at 500. A single thread /
// contact holds few records; a campaign can exceed this — each list surfaces a
// `truncated` flag (list length === VIEW_LIMIT) so a caller can page rather than
// silently believing it saw every record.
const VIEW_LIMIT = 500;

type DataEquals = ReadonlyArray<{
  key: "threadId" | "campaignId" | "contactId" | "connectorId";
  value: string;
}>;

export type EmailCorrelationRecord = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type EmailCorrelationList = {
  records: EmailCorrelationRecord[];
  /** True when the page hit VIEW_LIMIT — more records may exist (page by time). */
  truncated: boolean;
};

type ObjectsListItem = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  createdAt: string;
};

async function listByData(
  actor: ActorContext,
  type: string,
  dataEquals: DataEquals,
): Promise<EmailCorrelationList> {
  const client = createSessionObjectsClient(actor);
  const { items } = await client.list({ type, dataEquals, limit: VIEW_LIMIT });
  const records = (items as ObjectsListItem[]).map((it) => ({
    id: it.id,
    type: it.type,
    data: (it.data ?? {}) as Record<string, unknown>,
    createdAt: it.createdAt,
  }));
  return { records, truncated: records.length >= VIEW_LIMIT };
}

export type EmailThreadView = {
  threadId: string;
  sends: EmailCorrelationList;
  replies: EmailCorrelationList;
};

/**
 * Thread view: every sent-email + received-reply sharing the derived
 * `(connectorId, providerThreadId)` thread key. Renders PURELY from the indexed
 * `data->>'threadId'` lookup — ZERO object-id-array reads, no
 * `@cinatra-ai/email:thread` row fetch (issue #1456 acceptance).
 */
export async function getEmailThreadView(input: {
  actor: ActorContext;
  connectorId: string;
  providerThreadId: string;
}): Promise<EmailThreadView> {
  const threadId = deriveThreadId(input.connectorId, input.providerThreadId);
  if (!threadId) {
    // No usable provider thread id → no bucket to read.
    return {
      threadId: "",
      sends: { records: [], truncated: false },
      replies: { records: [], truncated: false },
    };
  }
  const filter: DataEquals = [{ key: "threadId", value: threadId }];
  const [sends, replies] = await Promise.all([
    listByData(input.actor, SENT_EMAIL_TYPE, filter),
    listByData(input.actor, RECEIVED_REPLY_TYPE, filter),
  ]);
  return { threadId, sends, replies };
}

export type CampaignEmailView = {
  campaignId: string;
  sends: EmailCorrelationList;
  replies: EmailCorrelationList;
  recipients: EmailCorrelationList;
  bodies: EmailCorrelationList;
};

/**
 * Campaign view: all sends / replies / recipient snapshots / message bodies
 * carrying `data.campaignId` (the fan-out correlates all four — #1455/#1456).
 * Indexed via `objects_data_campaign_idx`.
 */
export async function getCampaignEmailView(input: {
  actor: ActorContext;
  campaignId: string;
}): Promise<CampaignEmailView> {
  const filter: DataEquals = [{ key: "campaignId", value: input.campaignId }];
  const [sends, replies, recipients, bodies] = await Promise.all([
    listByData(input.actor, SENT_EMAIL_TYPE, filter),
    listByData(input.actor, RECEIVED_REPLY_TYPE, filter),
    listByData(input.actor, RECIPIENT_TYPE, filter),
    listByData(input.actor, BODY_TYPE, filter),
  ]);
  return { campaignId: input.campaignId, sends, replies, recipients, bodies };
}

export type ContactEmailView = {
  connectorId: string;
  contactId: string;
  sends: EmailCorrelationList;
  replies: EmailCorrelationList;
};

/**
 * Contact view: sends + replies for a provider-native `contactId`, scoped by
 * `connectorId` — a provider-native contact id is only meaningful within its
 * connector, so the filter is the PAIR `(connectorId, contactId)` (indexed via
 * `objects_data_contact_idx`, whose leading `connectorId` column makes the pair
 * selective). Two providers sharing a native id never collide.
 */
export async function getContactEmailView(input: {
  actor: ActorContext;
  connectorId: string;
  contactId: string;
}): Promise<ContactEmailView> {
  const filter: DataEquals = [
    { key: "connectorId", value: input.connectorId },
    { key: "contactId", value: input.contactId },
  ];
  const [sends, replies] = await Promise.all([
    listByData(input.actor, SENT_EMAIL_TYPE, filter),
    listByData(input.actor, RECEIVED_REPLY_TYPE, filter),
  ]);
  return {
    connectorId: input.connectorId,
    contactId: input.contactId,
    sends,
    replies,
  };
}
