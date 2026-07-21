/**
 * TriggerEmailSendUseCases adapter.
 *
 * Implements the contract from `@cinatra-ai/trigger-email-send` for the in-HITL
 * test-send button. Test sends are implemented directly; worker/pipeline methods
 * that do not run under the synchronous send path return explicit unsupported
 * errors.
 *
 * Campaign payload fields read (verified against src/lib/types.ts → Campaign):
 *   - campaign.id
 *   - campaign.draftIds (string[])
 *   - campaign.senderName
 *   - campaign.senderEmail
 *
 * Draft payload fields read (verified against src/lib/types.ts → EmailDraft):
 *   - draft.id
 *   - draft.subject
 *   - draft.body
 *
 * Drafts are stored in the per-tenant `cinatra.drafts` JSON-rows table; the
 * default `getDraftsByIds` reads them via the same postgres-sync path as
 * `getCampaignFromDatabase`. Both heavy modules (`@/lib/database` and
 * `@cinatra-ai/gmail-connector`) are loaded lazily so vitest can run the unit
 * tests without resolving them — tests pass mocked deps via the factory.
 */
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { TriggerEmailSendUseCases } from "@cinatra-ai/trigger-email-send";

// Minimal local shapes so this file does not need to load @/lib/types at the
// top level (kept light for vitest compatibility — types only).
type Campaign = {
  id: string;
  senderName?: string;
  senderEmail?: string;
  draftIds?: string[];
};

type Draft = {
  id: string;
  subject: string;
  body: string;
};

type EmailMessage = {
  to: string[];
  subject: string;
  textBody: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string[];
  providerThreadId?: string;
};

type EmailSendReceipt = {
  providerId: string;
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  sentAt: string;
};

// Soft-provenance correlation threaded from the campaign send loop into the
// sent-email object writer (cinatra#1456). Structural match of the SDK's
// `EmailTransportCorrelation`; kept local so this module stays free of a
// value/type import from @/lib types for vitest.
type SendCorrelation = {
  campaignId?: string;
  contactId?: string;
  runId?: string;
  // eng#548 #1625 — the run-scoped test-delivery send submission id + the
  // specific draft id, threaded per-draft so the send primitive's crash
  // reconciliation can query the outbound correlation store by submissionId and
  // confirm every expected draft was delivered.
  submissionId?: string;
  draftId?: string;
};

export type TriggerEmailSendDeps = {
  getCampaign: (campaignId: string) => Promise<Campaign | null>;
  getDraftsByIds: (draftIds: string[]) => Promise<Draft[]>;
  sendEmail: (
    message: EmailMessage,
    options?: { userId?: string; orgId?: string; correlation?: SendCorrelation },
  ) => Promise<EmailSendReceipt>;
  // Fetch a bundle envelope by ref. Defaults to the deterministic objects
  // client (`fetchObjectsByRef`). Injectable so the initial-send fan-out is
  // unit-testable without loading `@cinatra-ai/objects`.
  getObjectByRef?: (
    ref: string,
    actor: PrimitiveActorContext,
  ) => Promise<ObjectsEnvelope | null>;
  // Pipeline-owned per-email artifact projection (cinatra#1455). The SINGLE
  // write authority for the `email:body` / `email:recipient` per-item
  // projections derived from the run-scoped bundles. Best-effort: a projection
  // failure never fails the send. Defaults to the objects-client materializer.
  emitEmailFanout?: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
};

// Lazy default deps — heavy imports happen only when the adapter is actually
// invoked in production. Unit tests inject mocks via the factory's deps arg.
async function loadDefaultGetCampaign(): Promise<TriggerEmailSendDeps["getCampaign"]> {
  const mod = await import("./database");
  return mod.getCampaignFromDatabase as TriggerEmailSendDeps["getCampaign"];
}

async function loadDefaultGetDraftsByIds(): Promise<TriggerEmailSendDeps["getDraftsByIds"]> {
  // Drafts live in the per-tenant `cinatra.drafts` JSON-rows table. There is
  // no exported single-draft accessor in `@/lib/database` today, so we issue
  // a direct postgres query through the same sync layer used elsewhere.
  const [{ runPostgresQueriesSync }, dbMod] = await Promise.all([
    import("./postgres-sync"),
    import("./database"),
  ]);
  // Reuse the same env helpers via a minimal wrapper. We avoid touching
  // private internals by reading the connection string + schema from env.
  const schema = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not configured.");
  }
  // Reference dbMod to keep the import tree-shake-safe and to ensure schema
  // initialization side-effects (if any) have run before the SELECT.
  void dbMod;
  return async (draftIds: string[]) => {
    if (draftIds.length === 0) return [];
    const placeholders = draftIds.map((_, i) => `$${i + 1}`).join(", ");
    const [result] = runPostgresQueriesSync({
      connectionString,
      queries: [
        {
          text: `SELECT id, payload FROM "${schema}"."drafts" WHERE id IN (${placeholders})`,
          values: draftIds,
        },
      ],
    });
    const rows = (result?.rows ?? []) as Array<{ id: string; payload: string }>;
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.payload) as Draft;
        } catch {
          return null;
        }
      })
      .filter((d): d is Draft => d !== null && typeof d.subject === "string" && typeof d.body === "string");
  };
}

async function loadDefaultSendEmail(): Promise<TriggerEmailSendDeps["sendEmail"]> {
  // The provider-neutral facade (dev-mode recipient override + provider
  // routing stay centralized in the email connector layer) resolves through
  // the `email-system` capability the email-connector registers at activation
  // (lazy/guarded host-access cutover). Connector absent → the send fails
  // with a descriptive error (same failure class as "No connected email
  // connector is available.").
  const { requireEmailSystemFacade } = await import("@/lib/email-transport-provider");
  const facade = requireEmailSystemFacade();
  return facade.sendEmail.bind(facade) as unknown as TriggerEmailSendDeps["sendEmail"];
}

function buildLazyDefaultDeps(): TriggerEmailSendDeps {
  let cachedGetCampaign: TriggerEmailSendDeps["getCampaign"] | null = null;
  let cachedGetDrafts: TriggerEmailSendDeps["getDraftsByIds"] | null = null;
  let cachedSend: TriggerEmailSendDeps["sendEmail"] | null = null;
  return {
    async getCampaign(campaignId) {
      if (!cachedGetCampaign) cachedGetCampaign = await loadDefaultGetCampaign();
      return cachedGetCampaign(campaignId);
    },
    async getDraftsByIds(ids) {
      if (!cachedGetDrafts) cachedGetDrafts = await loadDefaultGetDraftsByIds();
      return cachedGetDrafts(ids);
    },
    async sendEmail(message, options) {
      if (!cachedSend) cachedSend = await loadDefaultSendEmail();
      return cachedSend(message, options);
    },
    getObjectByRef(ref, actor) {
      return fetchObjectsByRef(ref, actor);
    },
    emitEmailFanout(args) {
      return defaultEmitEmailFanout(args);
    },
  };
}

// Token replacements: drafts may carry any number of Mustache-style merge
// placeholders (e.g. `{{contact_first_name_or_company}}`,
// `{{contact_full_name_or_company}}`, `{{contact_email}}`,
// `{{contact_company}}`, `{{first_name}}`, …). For test sends the operator
// is the recipient — there is no resolved contact — so we collapse ANY
// `{{...}}` token to a generic placeholder ("there") rather than leaking
// raw `{{...}}` markup into the test email body. The regex matches
// non-greedily and excludes embedded `}` so adjacent tokens don't merge
// into a single match.
const MUSTACHE_TOKEN_RE = /\{\{[^}]+\}\}/g;
function applyTokenReplacements(body: string): string {
  return body.replace(MUSTACHE_TOKEN_RE, "there");
}

function pickRandom<T>(items: T[]): T {
  if (items.length === 0) throw new Error("pickRandom called on empty array");
  const idx = Math.floor(Math.random() * items.length);
  return items[idx]!;
}

function resolveDrafts(
  allDrafts: Draft[],
  selectionMode: "random_initial" | "specific_initial" | "all_initial",
  specificInitialDraftIds?: string[],
): Draft[] {
  if (allDrafts.length === 0) return [];
  if (selectionMode === "random_initial") {
    return [pickRandom(allDrafts)];
  }
  if (selectionMode === "all_initial") {
    return allDrafts;
  }
  // specific_initial
  const wanted = new Set(specificInitialDraftIds ?? []);
  const idToDraft = new Map(allDrafts.map((d) => [d.id, d] as const));
  // Preserve the order of specificInitialDraftIds for deterministic output.
  return Array.from(wanted)
    .map((id) => idToDraft.get(id))
    .filter((d): d is Draft => d !== undefined);
}

// In-process send-state memo. Persists across the LLM's "start" then
// up-to-5 "status" polls during a single request lifecycle. The map key
// is the campaignId. Process-local; cleared on dev-server restart, which
// is fine because the agent's poll loop is short-lived and does not need
// durable state.
type InitialSendStateRow = {
  status: "running" | "completed" | "failed" | "cancelled" | "idle";
  startedAt: string;
  completedAt: string;
  sentCount: number;
  errorMessage?: string;
};
const sendStateByCampaign = new Map<string, InitialSendStateRow>();

type ObjectsEnvelope = {
  id?: string;
  type?: string;
  data?: unknown;
};

type DraftRow = {
  id?: string;
  draftId?: string;
  step?: string | number;
  contactId?: string;
  recipientEmail?: string;
  email?: string;
  subject?: string;
  body?: string;
  bodyHtml?: string;
};

type RecipientRow = {
  contactId?: string;
  email?: string;
  recipientEmail?: string;
  name?: string;
  firstName?: string;
};

async function fetchObjectsByRef(
  ref: string,
  actor: PrimitiveActorContext,
): Promise<ObjectsEnvelope | null> {
  // Lazy-import the deterministic objects client to keep this module
  // unit-test-friendly. The agent's MCP call already lands in a
  // session-aware ALS frame so the actor envelope passed here will
  // resolve the same way the registry does.
  const { createDeterministicObjectsClient } = await import("@cinatra-ai/objects");
  const client = createDeterministicObjectsClient({ actor });
  const result = (await client.get(ref)) as unknown;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // objects_get returns { object: <envelope> | null } in the canonical
  // shape; some adapters return the envelope directly. Unwrap both.
  const env = (r.object ?? r) as ObjectsEnvelope;
  if (!env || typeof env !== "object" || !env.data) return null;
  return env;
}

function asDraftArray(data: unknown): DraftRow[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const arr =
    (Array.isArray(d.drafts) && d.drafts) ||
    (Array.isArray(d.confirmedRecipients) && d.confirmedRecipients) ||
    [];
  return arr as DraftRow[];
}

function asRecipientArray(data: unknown): RecipientRow[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const arr =
    (Array.isArray(d.confirmedRecipients) && d.confirmedRecipients) ||
    (Array.isArray(d.recipients) && d.recipients) ||
    [];
  return arr as RecipientRow[];
}

function recipientEmailFor(
  draft: DraftRow,
  recipients: ReadonlyArray<RecipientRow>,
): string | null {
  // Priority order: draft.recipientEmail / draft.email > matched recipient
  // by contactId > first recipient's email.
  if (draft.recipientEmail) return draft.recipientEmail;
  if (draft.email) return draft.email;
  if (draft.contactId) {
    const match = recipients.find((r) => r.contactId === draft.contactId);
    if (match?.email) return match.email;
    if (match?.recipientEmail) return match.recipientEmail;
  }
  return recipients[0]?.email ?? recipients[0]?.recipientEmail ?? null;
}

// ===========================================================================
// Per-email artifact fan-out (cinatra#1455).
//
// The campaign bundles (`@cinatra-ai/campaigns:email-draft-bundle`,
// `:recipients`, …) stay INTERNAL run-scoped machinery — HITL and the send
// loop keep reading arrays out of them, unchanged. This seam is the durable
// PROJECTION: at the initial-send fan-out boundary it materializes one
// `email:body` artifact per draft item and one `email:recipient` record per
// confirmed recipient. It is the SINGLE write authority for those per-item
// projections; the projection is one-way (bundle -> artifact), so no
// synchronization back to the bundle is needed (library-side draft editing is
// not enabled here — if it ever is, an explicit sync-back must be added).
//
// Coupling with the email-artifacts pack (cinatra#1454, runs in parallel):
// #1454 CLAIMS these types (claim-only manifest mode, epic #1448) — its
// package registers each claim into `objectTypeRegistry` with an inline JSON
// Schema + `identityKey`, and carries the `email:recipient` `projection:none`
// PII disposition. Until that pack is installed the types are not registered,
// so this seam is DORMANT (guarded on registration — see the `registeredTypes`
// gate in `defaultEmitEmailFanout`). It never mints a dynamic type, matching
// the "types exist only by installation" ruling (epic #1785). Idempotency is
// driven HERE via an explicit `externalId` on each payload, which the objects
// identity resolver honors as its strongest layer
// (`packages/objects/src/identity.ts` Layer 1) — so retried sends UPDATE the
// same row instead of duplicating, independent of #1454's `identityKey`.
//
// Bounded backfill: forward-only. Per-item artifacts materialize from the
// point this ships, at the send boundary; historical campaign bundles are NOT
// retroactively exploded into per-item artifacts (no blind historical
// explosion). A bounded, opt-in backfill — if ever wanted — is deferred to the
// #1454 dev-stack E2E / a dedicated migration.
// ===========================================================================

/** `email:body` claimed artifact type (registered by the #1454 pack). */
export const EMAIL_BODY_TYPE_ID = "@cinatra-ai/email:body";
/** `email:recipient` claimed record type (registered by the #1454 pack). */
export const EMAIL_RECIPIENT_TYPE_ID = "@cinatra-ai/email:recipient";

/**
 * Deterministic external identity for a per-draft `email:body` projection.
 * `(runScopeId, draftItemId)` is the fan-out key (cinatra#1455). The objects
 * identity resolver lowercases the key, so equal keys converge on one row.
 */
export function emailBodyExternalId(runScopeId: string, draftItemId: string): string {
  return `email-body:${runScopeId}:${draftItemId}`;
}

/**
 * Deterministic external identity for a per-recipient `email:recipient`
 * projection. `(runScopeId, contactKey)` where contactKey is the
 * provider-scoped contact id (retry-safe identity) or the normalized-email
 * fallback (cinatra#1454 mitigations).
 */
export function emailRecipientExternalId(runScopeId: string, contactKey: string): string {
  return `email-recipient:${runScopeId}:${contactKey}`;
}

/**
 * Stable per-draft item id for the `(runScopeId, draftItemId)` key. Uses ONLY
 * an explicit, non-PII draft id (`draft.id` / `draft.draftId`), falling back to
 * the draft's position in the approved bundle. Deliberately does NOT fall back
 * to `contactId` (which would COLLAPSE multiple drafts targeting one contact
 * into a single artifact) or to the recipient email (which would leak PII into
 * the body artifact's identity fields). The positional index is stable for a
 * given approved bundle (the ref is immutable per approval), so a retried send
 * of the same approval re-derives the same key. A stable draft id from the
 * bundle producer is preferred — the index is the last resort.
 */
function deriveDraftItemId(draft: DraftRow, index: number): string {
  const explicit = draft.id ?? draft.draftId;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  return `idx-${index}`;
}

/**
 * Retry-safe recipient contact key: provider-scoped contact id first, then a
 * normalized-email fallback. Returns null when neither is present — an
 * unidentifiable recipient is never projected.
 */
function deriveRecipientContactKey(r: RecipientRow): string | null {
  if (typeof r.contactId === "string" && r.contactId.trim() !== "") {
    return `contact:${r.contactId.trim()}`;
  }
  const email = r.email ?? r.recipientEmail;
  if (typeof email === "string" && email.trim() !== "") {
    return `email:${email.trim().toLowerCase()}`;
  }
  return null;
}

export type EmailFanoutSaveResult = {
  objectId: string;
  type: string;
  isNew: boolean;
  wasMerged: boolean;
};

export type EmailFanoutSaveFn = (input: {
  rawData: Record<string, unknown>;
  typeHint: string;
}) => Promise<EmailFanoutSaveResult>;

export type EmailFanoutInput = {
  /** At least the campaign run id; the campaign id is the stable fallback. */
  runScopeId: string;
  campaignId: string;
  drafts: readonly DraftRow[];
  recipients: readonly RecipientRow[];
};

export type EmailFanoutArgs = EmailFanoutInput & {
  actor: PrimitiveActorContext;
};

export type EmailFanoutEmission = {
  typeId: string;
  externalId: string;
  objectId: string;
  isNew: boolean;
};

export type EmailFanoutResult = {
  bodies: EmailFanoutEmission[];
  recipients: EmailFanoutEmission[];
  /** true when the claimed type is not registered yet (#1454 not installed). */
  skipped: { bodies: boolean; recipients: boolean };
};

/**
 * Pure per-email fan-out materializer — the single write authority for the
 * `email:body` / `email:recipient` per-item projections. Deterministic
 * (pipeline-owned, never prompt-directed): one `email:body` per draft item,
 * one `email:recipient` per confirmed recipient, each carrying an explicit
 * `externalId` so a retried run updates rather than duplicates.
 *
 * `save` performs the typed write (the objects deterministic client in
 * production; a fake in tests). `registeredTypes` is the installed-type gate:
 * a type absent from it is skipped, keeping this seam dormant until the #1454
 * pack registers the claim — no dynamic-type minting.
 */
export async function materializeEmailFanout(
  input: EmailFanoutInput,
  deps: { save: EmailFanoutSaveFn; registeredTypes: ReadonlySet<string> },
): Promise<EmailFanoutResult> {
  const { runScopeId, campaignId, drafts, recipients } = input;
  const bodies: EmailFanoutEmission[] = [];
  const recipientsOut: EmailFanoutEmission[] = [];

  const canBody = deps.registeredTypes.has(EMAIL_BODY_TYPE_ID);
  const canRecipient = deps.registeredTypes.has(EMAIL_RECIPIENT_TYPE_ID);

  // One `email:body` artifact per draft item, keyed (runScopeId, draftItemId).
  if (canBody) {
    let index = 0;
    for (const draft of drafts) {
      const draftItemId = deriveDraftItemId(draft, index);
      index += 1;
      const externalId = emailBodyExternalId(runScopeId, draftItemId);
      const contactId =
        typeof draft.contactId === "string" && draft.contactId.trim() !== ""
          ? draft.contactId.trim()
          : undefined;
      const rawData: Record<string, unknown> = {
        externalId,
        runId: runScopeId,
        campaignId,
        draftItemId,
        subject: draft.subject ?? "",
        body: draft.body ?? draft.bodyHtml ?? "",
        // Soft-provenance correlation ONLY (atomicity, epic #1448 rule 2): a
        // plain contact-id string, never an artifact-id reference. No recipient
        // address is stored on the body projection — the address lives on the
        // `email:recipient` record (projection:none), keeping PII off this
        // draftable surface.
        ...(contactId ? { contactId } : {}),
        ...(draft.step !== undefined ? { step: draft.step } : {}),
      };
      const res = await deps.save({ rawData, typeHint: EMAIL_BODY_TYPE_ID });
      bodies.push({
        typeId: EMAIL_BODY_TYPE_ID,
        externalId,
        objectId: res.objectId,
        isNew: res.isNew,
      });
    }
  }

  // One `email:recipient` record per confirmed recipient, keyed
  // (runScopeId, provider-scoped contact key | normalized email).
  if (canRecipient) {
    const seen = new Set<string>();
    for (const r of recipients) {
      const contactKey = deriveRecipientContactKey(r);
      if (!contactKey) continue; // unidentifiable recipient — never projected
      if (seen.has(contactKey)) continue; // de-dupe within the batch
      seen.add(contactKey);
      const externalId = emailRecipientExternalId(runScopeId, contactKey);
      const email = r.email ?? r.recipientEmail;
      const rawData: Record<string, unknown> = {
        externalId,
        runId: runScopeId,
        campaignId,
        // Minimum fields. The `email:recipient` claim carries projection:none
        // (owned by #1454), so the address never lands in a Graphiti
        // title/excerpt.
        ...(typeof r.contactId === "string" && r.contactId.trim() !== ""
          ? { contactId: r.contactId.trim() }
          : {}),
        ...(typeof email === "string" && email.trim() !== ""
          ? { email: email.trim() }
          : {}),
        ...(typeof r.name === "string" && r.name.trim() !== "" ? { name: r.name.trim() } : {}),
      };
      const res = await deps.save({ rawData, typeHint: EMAIL_RECIPIENT_TYPE_ID });
      recipientsOut.push({
        typeId: EMAIL_RECIPIENT_TYPE_ID,
        externalId,
        objectId: res.objectId,
        isNew: res.isNew,
      });
    }
  }

  return {
    bodies,
    recipients: recipientsOut,
    skipped: { bodies: !canBody, recipients: !canRecipient },
  };
}

// Lazy default projection: resolves registered types via the objects client
// (claim-registered artifact types surface through `objects_types_list`), then
// runs the materializer with the deterministic objects-save write path.
async function loadDefaultEmitEmailFanout(): Promise<
  NonNullable<TriggerEmailSendDeps["emitEmailFanout"]>
> {
  const { createDeterministicObjectsClient } = await import("@cinatra-ai/objects");
  return async (args: EmailFanoutArgs): Promise<EmailFanoutResult> => {
    const client = createDeterministicObjectsClient({ actor: args.actor });
    let registeredTypes: ReadonlySet<string>;
    try {
      const listed = (await client.typesList()) as { types?: Array<{ type: string }> };
      registeredTypes = new Set((listed?.types ?? []).map((t) => t.type));
    } catch {
      // If type discovery fails, stay dormant rather than risk a misclassified
      // write — the projection is best-effort and must never break the send.
      registeredTypes = new Set();
    }
    return materializeEmailFanout(
      {
        runScopeId: args.runScopeId,
        campaignId: args.campaignId,
        drafts: args.drafts,
        recipients: args.recipients,
      },
      {
        save: (inp) => client.save(inp) as Promise<EmailFanoutSaveResult>,
        registeredTypes,
      },
    );
  };
}

let cachedDefaultEmit: NonNullable<TriggerEmailSendDeps["emitEmailFanout"]> | null = null;
async function defaultEmitEmailFanout(args: EmailFanoutArgs): Promise<EmailFanoutResult> {
  if (!cachedDefaultEmit) cachedDefaultEmit = await loadDefaultEmitEmailFanout();
  return cachedDefaultEmit(args);
}

/**
 * The run-scope id for the fan-out identity: the campaign run id carried on
 * either bundle envelope (system-injected as `cinatraAgentRunId` on every
 * objects_save). Returns null when no real run id is present — the projection
 * is then SKIPPED rather than collapsing distinct runs of the same campaign
 * onto a shared `campaignId` key (which would merge their per-item artifacts).
 * `campaignId` remains on the payload as soft-provenance correlation only, never
 * as the identity key — the key is strictly `(runId, itemKey)` per cinatra#1455.
 */
function resolveRunScopeId(
  draftEnv: ObjectsEnvelope | null,
  recipEnv: ObjectsEnvelope | null,
): string | null {
  const fromEnv = (env: ObjectsEnvelope | null): string | null => {
    const d = (env?.data ?? null) as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return null;
    const rid = d.cinatraAgentRunId ?? d.cinatra_agent_run_id ?? d.runId;
    return typeof rid === "string" && rid.trim() !== "" ? rid.trim() : null;
  };
  return fromEnv(draftEnv) ?? fromEnv(recipEnv);
}

async function runInitialSend(args: {
  input: {
    campaignId: string;
    approvedDraftBundleRef?: string;
    confirmedRecipientsRef?: string;
    senderEmail?: string;
  };
  actor: PrimitiveActorContext;
  sendEmail: TriggerEmailSendDeps["sendEmail"];
  getObjectByRef: (
    ref: string,
    actor: PrimitiveActorContext,
  ) => Promise<ObjectsEnvelope | null>;
  emitEmailFanout: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
}): Promise<InitialSendStateRow> {
  const { input, actor, sendEmail, getObjectByRef, emitEmailFanout } = args;
  const startedAt = new Date().toISOString();
  sendStateByCampaign.set(input.campaignId, {
    status: "running",
    startedAt,
    completedAt: "",
    sentCount: 0,
  });

  if (!input.approvedDraftBundleRef || !input.confirmedRecipientsRef) {
    const errorMessage =
      "approvedDraftBundleRef and confirmedRecipientsRef are required";
    return {
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      sentCount: 0,
      errorMessage,
    };
  }

  try {
    const [draftEnv, recipEnv] = await Promise.all([
      getObjectByRef(input.approvedDraftBundleRef, actor),
      getObjectByRef(input.confirmedRecipientsRef, actor),
    ]);
    if (!draftEnv || !recipEnv) {
      return {
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        sentCount: 0,
        errorMessage: "Could not fetch approvedDraftBundle or confirmedRecipients.",
      };
    }
    const drafts = asDraftArray(draftEnv.data);
    const recipients = asRecipientArray(recipEnv.data);
    if (drafts.length === 0) {
      return {
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        sentCount: 0,
        errorMessage: "Approved draft bundle has no drafts.",
      };
    }

    // Durable per-item projection AT the fan-out boundary (cinatra#1455) —
    // where the run-scoped bundle is dissolved into individual items, BEFORE
    // the per-email send. `email:body` is draftable and `email:recipient` is
    // the confirmed-recipient snapshot, so the projection captures the
    // CONFIRMED campaign set independent of the send outcome. Best-effort: a
    // projection failure NEVER fails the send — the send is the critical path;
    // the artifacts are the derived, idempotent projection.
    const runScopeId = resolveRunScopeId(draftEnv, recipEnv);
    if (runScopeId) {
      try {
        await emitEmailFanout({
          runScopeId,
          campaignId: input.campaignId,
          drafts,
          recipients,
          actor,
        });
      } catch (fanoutErr) {
        console.warn(
          "[trigger-email-send] per-email artifact fan-out failed (send unaffected):",
          fanoutErr instanceof Error ? fanoutErr.message : String(fanoutErr),
        );
      }
    } else {
      // No run id on either bundle — skip rather than key the fan-out on a
      // campaign scope shared across runs (cinatra#1455 identity is (runId, …)).
      console.warn(
        "[trigger-email-send] skipping per-email fan-out: no run id on the campaign bundles",
      );
    }

    let sentCount = 0;
    for (const draft of drafts) {
      const recipientEmail = recipientEmailFor(draft, recipients);
      if (!recipientEmail) continue;
      const subject = draft.subject ?? "(no subject)";
      const body = draft.body ?? draft.bodyHtml ?? "";
      // Thread campaign / contact / run correlation onto the send so the
      // facade's sent-email object writer lands a fully-correlated record for
      // the thread / campaign / contact views (cinatra#1456). `contactId` is
      // the provider-native id on the draft item (connector-scoped on the
      // record by its `connectorId`); `runScopeId` is the fan-out run frame
      // (may be null → the field is omitted, never sent as "").
      const contactId =
        typeof draft.contactId === "string" && draft.contactId.trim() !== ""
          ? draft.contactId.trim()
          : undefined;
      await sendEmail(
        {
          to: [recipientEmail],
          subject,
          textBody: body,
          fromEmail: input.senderEmail,
        },
        {
          userId: actor.userId,
          correlation: {
            campaignId: input.campaignId,
            ...(runScopeId ? { runId: runScopeId } : {}),
            ...(contactId ? { contactId } : {}),
          },
        },
      );
      sentCount += 1;
    }

    return {
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      sentCount,
    };
  } catch (err) {
    return {
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      sentCount: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pure phase-1 selection planner for the run-scoped test-delivery send
 * (eng#548 #1625, DESIGN-V3 (4) two-phase). Resolves the FINAL concrete draft-id
 * set ONCE — `random_initial` is pinned to a concrete id here and must never be
 * rerandomized on a retry (the caller persists these ids into the ledger claim
 * BEFORE any outbound send). Reuses the SAME selection + membership logic as
 * `sendTestEmail`, so the pinned batch cannot drift from what the send would
 * pick. NO side-effects. Campaign-not-found is an invariant violation here (the
 * caller already authorized the campaign as an object) and throws.
 */
export async function planTestSendSelection(
  input: {
    campaignId: string;
    recipientEmail: string;
    selectionMode: "random_initial" | "specific_initial" | "all_initial";
    specificInitialDraftIds?: string[];
    specificFollowUpDraftIds?: string[];
  },
  deps: TriggerEmailSendDeps = buildLazyDefaultDeps(),
): Promise<
  | { ok: true; recipientEmail: string; selectedDraftIds: string[] }
  | { ok: false; reason: "no_drafts_selected" | "invalid_recipient" }
> {
  const recipient = (input.recipientEmail ?? "").trim();
  if (recipient.length === 0 || !recipient.includes("@")) {
    return { ok: false, reason: "invalid_recipient" };
  }
  const campaign = await deps.getCampaign(input.campaignId);
  if (!campaign) {
    // Invariant: the send path authorizes the campaign as an object BEFORE
    // planning; a missing campaign row here is a data-integrity fault, not a
    // user-correctable state.
    throw new Error("Campaign not found.");
  }
  const draftIds = campaign.draftIds ?? [];
  const campaignDraftIdSet = new Set(draftIds);
  const safeSpecificInitialDraftIds = input.specificInitialDraftIds?.filter((id) =>
    campaignDraftIdSet.has(id),
  );
  const safeSpecificFollowUpDraftIds = (input.specificFollowUpDraftIds ?? []).filter((id) =>
    campaignDraftIdSet.has(id),
  );
  const allDrafts = await deps.getDraftsByIds(draftIds);
  const initialSelected = resolveDrafts(allDrafts, input.selectionMode, safeSpecificInitialDraftIds);
  const idToDraft = new Map(allDrafts.map((d) => [d.id, d] as const));
  const followUpSelected = safeSpecificFollowUpDraftIds
    .map((id) => idToDraft.get(id))
    .filter((d): d is Draft => d !== undefined);
  const selectedById = new Map<string, Draft>();
  for (const draft of [...initialSelected, ...followUpSelected]) {
    selectedById.set(draft.id, draft);
  }
  const selectedDraftIds = [...selectedById.keys()];
  if (selectedDraftIds.length === 0) {
    return { ok: false, reason: "no_drafts_selected" };
  }
  return { ok: true, recipientEmail: recipient, selectedDraftIds };
}

export function createTriggerEmailSendUseCases(
  deps: TriggerEmailSendDeps = buildLazyDefaultDeps(),
): TriggerEmailSendUseCases {
  return {
    async sendTestEmail(
      input: {
        campaignId: string;
        recipientEmail: string;
        selectionMode: "random_initial" | "specific_initial" | "all_initial";
        specificInitialDraftIds?: string[];
        specificFollowUpDraftIds?: string[];
        // eng#548 #1625 — the run-scoped test-delivery submission id. When
        // present (the `email_test_delivery_run_send` wrapper's phase-2 send),
        // it is threaded (with each draft's id) into the sendEmail correlation so
        // a crashed-claim reconciliation can query the outbound store by
        // submission and confirm per-draft coverage. Absent on the public path.
        submissionId?: string;
      },
      actor: PrimitiveActorContext,
    ): Promise<Record<string, unknown>> {
      // Campaign-not-found is an INVARIANT violation for the wrapped send path
      // (the run-scoped wrapper resolves the campaign under authz BEFORE calling
      // this use-case; the public route pre-checks it). It is NOT a
      // user-correctable expected-failure state, so it still THROWS — the
      // enumerated `reason` failure space (contract (6)) covers only the states a
      // user can fix at the gate and re-submit.
      const campaign = await deps.getCampaign(input.campaignId);
      if (!campaign) {
        throw new Error("Campaign not found.");
      }

      // FAILURE-AS-DATA (DESIGN-V3 contract (6)): an EXPECTED send failure must
      // be a resolved value the workflow can route back into the gate as
      // `lastSendResult` — never a thrown error that fails the whole run. This
      // use-case therefore returns a DISCRIMINATED result. Only UNEXPECTED faults
      // (a genuinely unknown exception, an invariant violation) propagate.
      //
      // Reason coverage note: `no_drafts_selected`, `invalid_recipient`, and
      // `send_failed` are the states this shared use-case can determine on its
      // own. The finer connector taxonomy (`connector_unavailable`,
      // `dev_mode_recipient_required`) and the ledger/crash reasons
      // (`previous_send_unknown`, `send_in_progress`) are refined by the
      // run-scoped `email_test_delivery_run_send` wrapper primitive, which owns
      // the send ledger and the connector-availability signal.
      const recipient = (input.recipientEmail ?? "").trim();
      if (recipient.length === 0 || !recipient.includes("@")) {
        return {
          ok: false,
          reason: "invalid_recipient",
          message: "Enter a valid recipient email address for the test send.",
        };
      }

      const draftIds = campaign.draftIds ?? [];
      // Defensively intersect any client-supplied draft id list with the
      // campaign's own draftIds before they reach `getDraftsByIds`. This is the
      // membership predicate that prevents cross-campaign draft exfiltration:
      // any id NOT in `campaign.draftIds` is dropped (applies equally to initial
      // and follow-up selections).
      const campaignDraftIdSet = new Set(draftIds);
      const safeSpecificInitialDraftIds = input.specificInitialDraftIds?.filter((id) =>
        campaignDraftIdSet.has(id),
      );
      // FOLLOW-UP DRAFT-ID FIX (contract (6)): `specificFollowUpDraftIds` was
      // accepted but never read, so selected follow-ups were silently dropped.
      // Follow-up drafts live in the SAME `campaign.draftIds` set as initial
      // drafts; the renderer marks which ids are follow-ups (followUpDraftOptions)
      // and passes them here. Membership-check them against the campaign draft set
      // (same cross-campaign guard) and add the surviving drafts to the send set.
      const safeSpecificFollowUpDraftIds = (input.specificFollowUpDraftIds ?? []).filter(
        (id) => campaignDraftIdSet.has(id),
      );
      const allDrafts = await deps.getDraftsByIds(draftIds);
      const initialSelected = resolveDrafts(
        allDrafts,
        input.selectionMode,
        safeSpecificInitialDraftIds,
      );
      const idToDraft = new Map(allDrafts.map((d) => [d.id, d] as const));
      const followUpSelected = safeSpecificFollowUpDraftIds
        .map((id) => idToDraft.get(id))
        .filter((d): d is Draft => d !== undefined);
      // Union initial + follow-up, deduped by draft id (a follow-up id that also
      // matched an initial selection must not double-send).
      const selectedById = new Map<string, Draft>();
      for (const draft of [...initialSelected, ...followUpSelected]) {
        selectedById.set(draft.id, draft);
      }
      const selected = [...selectedById.values()];
      if (selected.length === 0) {
        return {
          ok: false,
          reason: "no_drafts_selected",
          message: "No test emails were selected to send.",
        };
      }

      const fromEmail = campaign.senderEmail;
      const fromName = campaign.senderName;

      // eng#548 #1625 (partial-batch-retry regression): track the ids ACTUALLY
      // delivered draft-by-draft. Declared OUTSIDE the try so the catch branch can
      // return the partial prefix that went out before a mid-batch throw. Returning
      // it (even on the failure branch) lets the wrapper persist it so a later retry
      // never re-sends those drafts and the maxGateVisits cap counts the partial.
      const deliveredDraftIds: string[] = [];
      try {
        // eng#548 #1625 — when the run-scoped wrapper supplies a submissionId,
        // thread it (with the specific draft id) into the sendEmail correlation
        // so the sent-email object carries the (submissionId, draftId) pair the
        // wrapper's crash reconciliation queries. Omitted on the public path
        // (correlation absent → the writer adds no test-delivery fields).
        const submissionId =
          typeof input.submissionId === "string" && input.submissionId.trim() !== ""
            ? input.submissionId.trim()
            : undefined;
        for (const draft of selected) {
          await deps.sendEmail(
            {
              to: [recipient],
              subject: `[Test] ${draft.subject}`,
              textBody: applyTokenReplacements(draft.body),
              fromName,
              fromEmail,
              replyTo: fromEmail,
            },
            {
              userId: actor.userId,
              // eng#548 #1625 (D1) — thread the run OWNER's org (== run.orgId,
              // coherent per DESIGN-V3 §334-337) so the routing chain
              // (register-email-providers.resolveConnectorId step-3) can resolve
              // the owner's USER-level sender-identity from the ORG-partitioned
              // objects store. Dropping it made the objects read org-less, so the
              // owner's own mailbox was invisible and the send fell through to the
              // first-registered connector (gmail) → "Google OAuth is not
              // connected". Undefined on the public path preserves prior behavior.
              orgId: actor.orgId ?? undefined,
              ...(submissionId
                ? {
                    correlation: {
                      campaignId: input.campaignId,
                      submissionId,
                      draftId: draft.id,
                    },
                  }
                : {}),
            },
          );
          deliveredDraftIds.push(draft.id);
        }

        return {
          ok: true,
          recipientEmail: recipient,
          sentTo: recipient,
          sentCount: deliveredDraftIds.length,
          deliveredDraftIds,
          message: `Test email sent to ${recipient}.`,
        };
      } catch (err) {
        // A transport-layer send failure is an EXPECTED, user-correctable state
        // (bad recipient, transient connector error): surface it as data so the
        // gate can show an honest banner and let the user retry — do not fail the
        // run. The wrapper primitive refines this into the finer connector
        // reasons + records the ledger `failed` row. `deliveredDraftIds` carries
        // the partial prefix that DID go out (the drafts sent before the throw) so
        // the wrapper never re-sends them on a retry.
        return {
          ok: false,
          reason: "send_failed",
          deliveredDraftIds,
          message: err instanceof Error ? err.message : "The test send failed.",
        };
      }
    },

    // Initial-send loop adapted for the cinatra-objects paradigm
    // (no Campaign table).
    //
    // Synchronous, in-line implementation:
    //   1. Fetch the approved-email-draft-bundle by ref via objects_get.
    //   2. Fetch the confirmedRecipients by ref via objects_get.
    //   3. For each draft, look up the recipient (by contactId match, or
    //      fall back to recipientEmail embedded on the draft).
    //   4. sendGmailMessage for each pair — dev recipient override
    //      (packages/connector-gmail/src/index.ts:312) routes the
    //      outbound to the configured override address.
    //   5. Stash a tiny send-state record in module memory so a
    //      subsequent getInitialSendStatus poll returns "completed"
    //      with sentCount.
    //
    // The agent's SKILL.md polls up to 5 times — sync completion plus
    // memo'd state mean the first poll always reports completed.
    async startInitialSend(input, actor) {
      const result = await runInitialSend({
        input,
        actor,
        sendEmail: deps.sendEmail,
        // Fall back to the production defaults when an injected deps object
        // (e.g. a unit test) omits the optional fan-out seams.
        getObjectByRef: deps.getObjectByRef ?? fetchObjectsByRef,
        emitEmailFanout: deps.emitEmailFanout ?? defaultEmitEmailFanout,
      });
      sendStateByCampaign.set(input.campaignId, result);
      return {
        operationId: input.campaignId,
        kind: "initial_send",
        status: result.status,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        sentCount: result.sentCount,
        errorMessage: result.errorMessage,
      } as unknown as ReturnType<TriggerEmailSendUseCases["startInitialSend"]> extends Promise<infer R>
        ? R
        : never;
    },

    async getInitialSendStatus(input, _actor) {
      const state =
        sendStateByCampaign.get(input.campaignId) ?? {
          status: "idle" as const,
          startedAt: "",
          completedAt: "",
          sentCount: 0,
          errorMessage: undefined,
        };
      return {
        operationId: input.campaignId,
        kind: "initial_send",
        status: state.status,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        sentCount: state.sentCount,
        errorMessage: state.errorMessage,
      } as unknown as ReturnType<TriggerEmailSendUseCases["getInitialSendStatus"]> extends Promise<infer R>
        ? R
        : never;
    },

    async cancelInitialSend(input, _actor) {
      const prior =
        sendStateByCampaign.get(input.campaignId) ?? {
          status: "idle" as const,
          startedAt: "",
          completedAt: "",
          sentCount: 0,
        };
      sendStateByCampaign.set(input.campaignId, {
        ...prior,
        status: "cancelled",
        completedAt: new Date().toISOString(),
      });
      return {
        operationId: input.campaignId,
        kind: "initial_send",
        status: "cancelled",
        startedAt: prior.startedAt,
        completedAt: new Date().toISOString(),
        sentCount: prior.sentCount,
      } as unknown as ReturnType<TriggerEmailSendUseCases["cancelInitialSend"]> extends Promise<infer R>
        ? R
        : never;
    },

    async runInitialSendWorker(_input, _actor) {
      // RETIRED under the synchronous send path (the BullMQ background worker no
      // longer exists). Return a typed not_supported result instead of throwing
      // so an MCP caller receives a structured response, not an exception. If
      // BullMQ background sending is ever re-introduced, the worker entry point
      // lives here.
      return {
        ok: false as const,
        status: "not_supported" as const,
        reason: "The initial-send worker is retired under the synchronous send path.",
      };
    },

    async processDueFollowUps(_input, _actor) {
      // RETIRED under the synchronous send path (follow-up scheduling ran on the
      // removed BullMQ worker). Return a typed not_supported result, not a throw.
      return {
        ok: false as const,
        status: "not_supported" as const,
        reason: "Due follow-up processing is not implemented under the synchronous send path.",
      };
    },
  };
}
