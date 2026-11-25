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
  // #1625 — the run-scoped test-delivery send submission id + the
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
  // write authority for the `email:body` per-item projections derived from the
  // run-scoped bundles (the delivery agent files the recipient records,
  // cinatra#3089). A body the ledgered writer
  // refuses fails the send visibly (cinatra#3089); any other projection failure
  // is warned and the send goes on. Defaults to the ledger-backed materializer.
  emitEmailFanout?: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
  // Read one approved body revision the send start was handed (cinatra#3089):
  // its text and the body's declared fields, only while the ACTING actor may
  // read the artifact, the run named by `runId` filed it, and it is the
  // artifact's current, undisputed revision of the declared body type in the
  // actor's organization; else a named refusal. Defaults to the host's
  // current-revision reader (`readCurrentDecidedRevision`).
  readDecidedBody?: (
    ref: { artifactId: string; representationRevisionId: string; runId: string },
    actor: PrimitiveActorContext,
  ) => Promise<DecidedBodyRead>;
  // The durable send record of each message the approved form mails
  // (cinatra#3089): claimed before the hand-over to the mail provider, marked
  // sent after it, so a repeated or concurrent send never mails a message
  // twice. Defaults to the materialization ledger's send rows
  // (`claimFanoutMessageSend`). The reference-only form does not use it.
  messageSendLedger?: MessageSendLedger;
};

/** The outcome of claiming one message's mail (see `MessageSendLedger`). */
export type MessageSendClaim =
  | { kind: "won"; ledgerId: string }
  | { kind: "sent" }
  | { kind: "in_doubt" };

/** One message's durable send record: `claim` lets exactly one caller hand the
 *  message over; `markSent` records the provider's acceptance; `release` gives
 *  the message back ONLY when it was demonstrably never handed over. */
export type MessageSendLedger = {
  claim(
    message: { runId: string; outputId: string; artifactId: string; representationRevisionId: string },
    actor: PrimitiveActorContext,
  ): Promise<MessageSendClaim>;
  markSent(ledgerId: string, actor: PrimitiveActorContext): Promise<boolean>;
  release(ledgerId: string, actor: PrimitiveActorContext): Promise<void>;
};

/** Thrown by a `sendEmail` that stopped BEFORE it reached the mail provider (no
 *  transport could be resolved), so the message was certainly not handed over. */
export class MailNotHandedOverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailNotHandedOverError";
  }
}

/** What `readDecidedBody` answers: the revision's whole text and the body's
 *  declared fields (`subject`, `contactId`, …), or a named refusal. */
export type DecidedBodyRead =
  | { ok: true; text: string; data: Record<string, unknown> }
  | { ok: false; error: string };

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
      if (!cachedSend) {
        try {
          cachedSend = await loadDefaultSendEmail();
        } catch (err) {
          // No transport, so no provider was called for this message.
          throw new MailNotHandedOverError(err instanceof Error ? err.message : String(err));
        }
      }
      return cachedSend(message, options);
    },
    getObjectByRef(ref, actor) {
      return fetchObjectsByRef(ref, actor);
    },
    emitEmailFanout(args) {
      return defaultEmitEmailFanout(args);
    },
    async readDecidedBody(ref, actor) {
      const orgId = actor.orgId;
      if (!orgId) {
        return { ok: false, error: "the sending actor carries no organization, so no body can be read" };
      }
      // The kernel actor the objects reads build for this tool actor
      // (`objects_get` reads the bundle under the same one), so the body is
      // admitted exactly as any other read this actor makes of the artifact.
      const [{ kernelActorForRead }, { readCurrentDecidedRevision }] = await Promise.all([
        import("./authz/enforce-resource-access"),
        import("./artifacts/current-decided-revision-read"),
      ]);
      return readCurrentDecidedRevision({
        orgId,
        actor: kernelActorForRead(actor, orgId),
        ...ref,
        objectTypeId: EMAIL_BODY_TYPE_ID,
      });
    },
    messageSendLedger: defaultMessageSendLedger,
  };
}

function orgOf(actor: PrimitiveActorContext): string {
  if (!actor.orgId) {
    throw new Error("the sending actor carries no organization, so no message send can be recorded");
  }
  return actor.orgId;
}

/** The materialization ledger's send rows (`claimFanoutMessageSend`). */
const defaultMessageSendLedger: MessageSendLedger = {
  async claim(message, actor) {
    const orgId = orgOf(actor);
    const { claimFanoutMessageSend } = await import("./artifacts/materialization-ledger");
    const claim = await claimFanoutMessageSend({ orgId, ...message });
    return claim.kind === "won" ? { kind: "won", ledgerId: claim.ledgerId } : { kind: claim.kind };
  },
  async markSent(ledgerId, actor) {
    const orgId = orgOf(actor);
    const { markFanoutMessageSent } = await import("./artifacts/materialization-ledger");
    return markFanoutMessageSent({ orgId, ledgerId });
  },
  async release(ledgerId, actor) {
    const orgId = orgOf(actor);
    const { releaseFanoutMessageSend } = await import("./artifacts/materialization-ledger");
    await releaseFanoutMessageSend({ orgId, ledgerId });
  },
};

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
  /** The approved form only (cinatra#3089): messages an earlier call already
   *  handed over, which this call skipped. */
  alreadySentCount?: number;
  /** The approved form only: messages claimed but never recorded as sent, which
   *  this call did not mail (they may or may not have gone out). */
  inDoubtCount?: number;
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
  /** The drafting step's name for the draft's contact (its contactId). */
  recipientId?: string;
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
  // by contactId; a draft without an address of its own gets none.
  if (draft.recipientEmail) return draft.recipientEmail;
  if (draft.email) return draft.email;
  if (draft.contactId) {
    const match = recipients.find((r) => r.contactId === draft.contactId);
    if (match?.email) return match.email;
    if (match?.recipientEmail) return match.recipientEmail;
  }
  return null;
}

// ===========================================================================
// Per-email artifact fan-out (cinatra#1455).
//
// The campaign bundles (`@cinatra-ai/campaigns:email-draft-bundle`,
// `:recipients`, …) stay INTERNAL run-scoped machinery — HITL and the send
// loop keep reading arrays out of them, unchanged. This seam is the durable
// PROJECTION: at the initial-send fan-out boundary it materializes one
// `email:body` artifact per draft item (the delivery agent files one
// `email:recipient` record per confirmed recipient, cinatra#3089). It is the
// SINGLE write authority for those per-item bodies; the projection is one-way
// (bundle -> artifact), so no synchronization back to the bundle is needed
// (library-side draft editing is not enabled here — if it ever is, an explicit
// sync-back must be added).
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

/**
 * Deterministic external identity for a per-draft `email:body` projection.
 * `(runScopeId, draftItemId)` is the fan-out key (cinatra#1455). The objects
 * identity resolver lowercases the key, so equal keys converge on one row.
 */
export function emailBodyExternalId(runScopeId: string, draftItemId: string): string {
  return `email-body:${runScopeId}:${draftItemId}`;
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

/** One body of a send, written as a markdown revision on the materialization
 *  ledger (cinatra#3089): `outputId` is the message identity. */
export type EmailFanoutBodyWrite = {
  runId: string;
  outputId: string;
  title: string;
  markdown: string;
  /** The body type's own declared fields — `bodyMarkdown` carries the text. */
  typedData: Record<string, unknown>;
};

export type EmailFanoutBodyWriteResult =
  | { ok: true; artifactId: string; representationRevisionId: string; deduped: boolean }
  | { ok: false; error: string };

export type EmailFanoutBodyWriteFn = (
  input: EmailFanoutBodyWrite,
) => Promise<EmailFanoutBodyWriteResult>;

/**
 * A body the ledgered writer refused or could not file (cinatra#3089). The send
 * boundary lets it through, so the send fails with the refusal named instead of
 * warning and sending on.
 */
export class EmailBodyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailBodyRefusedError";
  }
}

export type EmailFanoutInput = {
  /** At least the campaign run id; the campaign id is the stable fallback. */
  runScopeId: string;
  campaignId: string;
  drafts: readonly DraftRow[];
  recipients: readonly RecipientRow[];
  /**
   * The approved body of each mailed draft, by the draft's position in
   * `drafts` (cinatra#3089). Given, the fan-out writes NO body: it binds each
   * message to its approved revision through `bindBody` and files nothing for
   * a draft without one.
   */
  approvedBodies?: ReadonlyMap<number, ApprovedFanoutBody>;
};

/** One approved body revision a message of the send is bound to, with the
 *  text the send mails (the revision's own text). */
export type ApprovedFanoutBody = {
  artifactId: string;
  representationRevisionId: string;
  text: string;
};

/** Bind one message to its approved revision on the ledger (cinatra#3089). */
export type EmailFanoutBodyBindFn = (input: {
  runId: string;
  outputId: string;
  markdown: string;
  artifactId: string;
  representationRevisionId: string;
}) => Promise<EmailFanoutBodyWriteResult>;

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
  /** true when the claimed type is not registered yet (#1454 not installed). */
  skipped: { bodies: boolean };
};

/**
 * Pure per-email fan-out materializer — the single write authority for the
 * `email:body` per-item projections. Deterministic (pipeline-owned, never
 * prompt-directed): one `email:body` per draft item, each carrying an explicit
 * `externalId` so a retried run updates rather than duplicates. It writes no
 * `email:recipient` record: the delivery agent files those (cinatra#3089).
 *
 * `writeBody` files each body as a markdown revision on the materialization
 * ledger (cinatra#3089): the message identity and the content hash key it, so
 * a retry reuses the row, and a refusal throws `EmailBodyRefusedError`.
 * `registeredTypes` is the installed-type gate: a type absent from it is
 * skipped, keeping this seam dormant until the #1454 pack registers the claim
 * — no dynamic-type minting.
 */
export async function materializeEmailFanout(
  input: EmailFanoutInput,
  deps: {
    writeBody?: EmailFanoutBodyWriteFn;
    bindBody?: EmailFanoutBodyBindFn;
    registeredTypes: ReadonlySet<string>;
  },
): Promise<EmailFanoutResult> {
  const { runScopeId, campaignId, drafts, approvedBodies } = input;
  const bodies: EmailFanoutEmission[] = [];

  const canBody = deps.registeredTypes.has(EMAIL_BODY_TYPE_ID);

  // One `email:body` markdown revision per draft item, written through the
  // materialization ledger keyed (run, message identity, content hash)
  // (cinatra#3089). The text lands under the declared `bodyMarkdown` field.
  if (canBody) {
    const writeBody: EmailFanoutBodyWriteFn =
      deps.writeBody ??
      (async () => ({
        ok: false,
        error: "the email fan-out has no ledgered body writer, so no body of this send can be filed",
      }));
    let index = 0;
    for (const draft of drafts) {
      const draftItemId = deriveDraftItemId(draft, index);
      index += 1;
      const externalId = emailBodyExternalId(runScopeId, draftItemId);
      if (approvedBodies) {
        // The approved form (cinatra#3089): the message is bound to the
        // revision a person approved; no body of the bundle is filed.
        const approved = approvedBodies.get(index - 1);
        if (!approved) continue;
        if (!deps.bindBody) {
          throw new EmailBodyRefusedError(
            `the email body ${externalId} cannot be bound: the fan-out has no binder for approved bodies`,
          );
        }
        let bound: EmailFanoutBodyWriteResult;
        try {
          bound = await deps.bindBody({
            runId: runScopeId,
            outputId: externalId,
            markdown: approved.text,
            artifactId: approved.artifactId,
            representationRevisionId: approved.representationRevisionId,
          });
        } catch (err) {
          throw new EmailBodyRefusedError(
            `the email body ${externalId} could not be bound: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!bound.ok) {
          throw new EmailBodyRefusedError(`the email body ${externalId} was refused: ${bound.error}`);
        }
        bodies.push({
          typeId: EMAIL_BODY_TYPE_ID,
          externalId,
          objectId: bound.artifactId,
          isNew: false,
        });
        continue;
      }
      const contactId =
        typeof draft.contactId === "string" && draft.contactId.trim() !== ""
          ? draft.contactId.trim()
          : undefined;
      const subject = draft.subject ?? "";
      const markdown = draft.body ?? draft.bodyHtml ?? "";
      const typedData: Record<string, unknown> = {
        runId: runScopeId,
        campaignId,
        subject,
        bodyMarkdown: markdown,
        // Soft-provenance correlation ONLY (atomicity, epic #1448 rule 2): a
        // plain contact-id string, never an artifact-id reference. No recipient
        // address is stored on the body projection — the address lives on the
        // `email:recipient` record (projection:none), keeping PII off this
        // draftable surface.
        ...(contactId ? { contactId } : {}),
      };
      let res: EmailFanoutBodyWriteResult;
      try {
        res = await writeBody({
          runId: runScopeId,
          outputId: externalId,
          title: subject.trim() !== "" ? subject : "(no subject)",
          markdown,
          typedData,
        });
      } catch (err) {
        throw new EmailBodyRefusedError(
          `the email body ${externalId} could not be filed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        throw new EmailBodyRefusedError(`the email body ${externalId} was refused: ${res.error}`);
      }
      bodies.push({
        typeId: EMAIL_BODY_TYPE_ID,
        externalId,
        objectId: res.artifactId,
        isNew: !res.deduped,
      });
    }
  }

  return {
    bodies,
    skipped: { bodies: !canBody },
  };
}

// Lazy default projection: resolves registered types via the objects client
// (claim-registered artifact types surface through `objects_types_list`), then
// runs the materializer with the ledgered body writer (cinatra#3089).
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
    } catch (err) {
      // The approved form needs every message bound to its revision before
      // any mail, so a failed discovery refuses that send (cinatra#3089).
      if (args.approvedBodies) {
        throw new EmailBodyRefusedError(
          `the registered object types could not be read, so no message can be bound to its approved body: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // The reference-only form keeps its behaviour: if type discovery fails,
      // stay dormant rather than risk a misclassified write — the projection
      // is best-effort there and must never break the send.
      registeredTypes = new Set();
    }
    return materializeEmailFanout(
      {
        runScopeId: args.runScopeId,
        campaignId: args.campaignId,
        drafts: args.drafts,
        recipients: args.recipients,
        ...(args.approvedBodies ? { approvedBodies: args.approvedBodies } : {}),
      },
      {
        bindBody: async (b) => {
          const orgId = args.actor.orgId;
          if (!orgId) {
            return {
              ok: false,
              error: "the sending actor carries no organization, so the body cannot be bound on its run",
            };
          }
          const { bindFanoutMessageRevision } = await import(
            "./artifacts/run-artifact-materializer"
          );
          return bindFanoutMessageRevision({ ...b, orgId, objectTypeId: EMAIL_BODY_TYPE_ID });
        },
        writeBody: async (w) => {
          const orgId = args.actor.orgId;
          if (!orgId) {
            return {
              ok: false,
              error: "the sending actor carries no organization, so the body cannot be filed on its run",
            };
          }
          const { materializeFanoutMessageRevision } = await import(
            "./artifacts/run-artifact-materializer"
          );
          return materializeFanoutMessageRevision({
            runId: w.runId,
            orgId,
            createdBy: args.actor.userId ?? null,
            objectTypeId: EMAIL_BODY_TYPE_ID,
            outputId: w.outputId,
            title: w.title,
            markdown: w.markdown,
            typedData: w.typedData,
          });
        },
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

/** The approved form's send-record counts, only when the answer carries them,
 *  so the reference-only answer keeps exactly its earlier fields. */
function sendRecordCounts(row: InitialSendStateRow): {
  alreadySentCount?: number;
  inDoubtCount?: number;
} {
  return {
    ...(row.alreadySentCount !== undefined ? { alreadySentCount: row.alreadySentCount } : {}),
    ...(row.inDoubtCount !== undefined ? { inDoubtCount: row.inDoubtCount } : {}),
  };
}

/**
 * THE MAIL OF THE APPROVED FORM, AT MOST ONCE PER MESSAGE (cinatra#3089).
 *
 * Every message is already bound to its approved revision on the ledger. For
 * each one, in bundle order, the send first CLAIMS the message's durable send
 * record (`MessageSendLedger.claim`, a conditional insert only one caller wins):
 *   - won: the message is handed to the provider; on success it is marked sent
 *     and counted in `sentCount`;
 *   - sent: an earlier call handed it over; it is skipped and counted in
 *     `alreadySentCount`;
 *   - in doubt: another call holds it (in flight, or stopped after its claim);
 *     it is NOT mailed, it is counted in `inDoubtCount` and named in the answer.
 * A provider error after a won claim leaves the message in doubt (the provider
 * may have taken the mail before it failed) and stops the send; the claim is
 * given back only for an error raised before any provider was reached
 * (`MailNotHandedOverError`), so a later call may mail it. A message in doubt
 * stays unmailed by every later call until a person establishes with the mail
 * provider whether it went out; the answer and the log name it.
 */
async function mailApprovedMessages(args: {
  input: { campaignId: string; senderEmail?: string };
  actor: PrimitiveActorContext;
  sendEmail: TriggerEmailSendDeps["sendEmail"];
  messageSendLedger: MessageSendLedger;
  drafts: readonly DraftRow[];
  recipients: readonly RecipientRow[];
  runScopeId: string;
  approvedByIndex: ReadonlyMap<number, ApprovedFanoutBody & { subject?: string }>;
  messageIdByArtifact: ReadonlyMap<string, string>;
  startedAt: string;
}): Promise<InitialSendStateRow> {
  const { input, actor, sendEmail, messageSendLedger: ledger, runScopeId } = args;
  let sentCount = 0;
  let alreadySentCount = 0;
  const inDoubt: string[] = [];
  let stopped: string | undefined;
  for (const [index, draft] of args.drafts.entries()) {
    const recipientEmail = recipientEmailFor(draft, args.recipients);
    if (!recipientEmail) continue;
    const approved = args.approvedByIndex.get(index);
    const outputId = approved ? args.messageIdByArtifact.get(approved.artifactId) : undefined;
    if (!approved || !outputId) {
      stopped = `draft ${index + 1} of the bundle has no bound approved body, so it was not sent`;
      break;
    }
    const name = `draft ${index + 1} (${outputId})`;
    const contactId =
      typeof draft.contactId === "string" && draft.contactId.trim() !== ""
        ? draft.contactId.trim()
        : undefined;
    let claim: MessageSendClaim;
    try {
      claim = await ledger.claim(
        {
          runId: runScopeId,
          outputId,
          artifactId: approved.artifactId,
          representationRevisionId: approved.representationRevisionId,
        },
        actor,
      );
    } catch (err) {
      stopped = `the mail of ${name} could not be claimed, so it was not sent: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (claim.kind === "sent") {
      alreadySentCount += 1;
      continue;
    }
    if (claim.kind === "in_doubt") {
      inDoubt.push(name);
      console.warn(
        `[trigger-email-send] ${name} of run ${runScopeId} is claimed but not recorded as sent; it was not mailed again`,
      );
      continue;
    }
    try {
      await sendEmail(
        {
          to: [recipientEmail],
          subject: approved.subject ?? draft.subject ?? "(no subject)",
          textBody: approved.text,
          fromEmail: input.senderEmail,
        },
        {
          userId: actor.userId,
          orgId: actor.orgId ?? undefined,
          correlation: {
            campaignId: input.campaignId,
            runId: runScopeId,
            ...(contactId ? { contactId } : {}),
          },
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof MailNotHandedOverError) {
        try {
          await ledger.release(claim.ledgerId, actor);
          stopped = `${name} was not sent, no mail provider was reached: ${reason}`;
        } catch (releaseErr) {
          inDoubt.push(name);
          stopped = `${name} was not sent (${reason}), and its claim could not be given back: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`;
        }
      } else {
        inDoubt.push(name);
        stopped = `the mail provider failed on ${name}, which may or may not have gone out: ${reason}`;
        console.warn(`[trigger-email-send] ${name} of run ${runScopeId} is in doubt: ${reason}`);
      }
      break;
    }
    sentCount += 1;
    try {
      if (!(await ledger.markSent(claim.ledgerId, actor))) {
        console.warn(
          `[trigger-email-send] ${name} of run ${runScopeId} was mailed but its send record was not open; later calls read it as in doubt`,
        );
      }
    } catch (err) {
      console.warn(
        `[trigger-email-send] ${name} of run ${runScopeId} was mailed but could not be recorded as sent; later calls read it as in doubt:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const problems = [
    ...(stopped ? [stopped] : []),
    ...(inDoubt.length > 0
      ? [
          `${inDoubt.length} message(s) in doubt were not mailed by this call: ${inDoubt.join(", ")}. A message in doubt is mailed by no later call until a person establishes with the mail provider whether it went out`,
        ]
      : []),
  ];
  return {
    status: problems.length > 0 ? "failed" : "completed",
    startedAt: args.startedAt,
    completedAt: new Date().toISOString(),
    sentCount,
    alreadySentCount,
    inDoubtCount: inDoubt.length,
    ...(problems.length > 0 ? { errorMessage: problems.join("; ") } : {}),
  };
}

async function runInitialSend(args: {
  input: {
    campaignId: string;
    approvedDraftBundleRef?: string;
    confirmedRecipientsRef?: string;
    senderEmail?: string;
    approvedBodies?: ReadonlyArray<{
      artifactId: string;
      representationRevisionId: string;
      contactId: string;
    }>;
  };
  actor: PrimitiveActorContext;
  sendEmail: TriggerEmailSendDeps["sendEmail"];
  readDecidedBody: NonNullable<TriggerEmailSendDeps["readDecidedBody"]>;
  messageSendLedger: MessageSendLedger;
  getObjectByRef: (
    ref: string,
    actor: PrimitiveActorContext,
  ) => Promise<ObjectsEnvelope | null>;
  emitEmailFanout: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
}): Promise<InitialSendStateRow> {
  const { input, actor, sendEmail, getObjectByRef, emitEmailFanout, readDecidedBody, messageSendLedger } =
    args;
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
    const runScopeId = resolveRunScopeId(draftEnv, recipEnv);
    if (drafts.length === 0) {
      return {
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        sentCount: 0,
        errorMessage: "Approved draft bundle has no drafts.",
      };
    }

    // THE APPROVED FORM (cinatra#3089). Given `approvedBodies`, the send mails,
    // for each draft with an address, the text of ITS approved body revision,
    // never the bundle's body. A body joins its draft by the contact: the
    // entry's `contactId` equals the draft's `contactId`, else its
    // `recipientId`, and names exactly one draft of the bundle; a body that
    // carries a contact of its own must carry the same one. Every check and
    // every read runs before the fan-out and before any mail, and any failure
    // refuses the whole send. Without `approvedBodies` the send reads the
    // bundle exactly as before.
    let approvedByIndex: Map<number, ApprovedFanoutBody & { subject?: string }> | null = null;
    if (input.approvedBodies) {
      const refuse = (reason: string): never => {
        throw new Error(`The send was refused before any email went out: ${reason}`);
      };
      // Each message is bound to its approved revision under the run before
      // any mail, so a send without a run has nothing to bind under.
      if (!runScopeId) {
        throw new EmailBodyRefusedError(
          "The send was refused before any email went out: the campaign bundles carry no run id, so no message can be bound to its approved body",
        );
      }
      const textOf = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
      const contactOf = (draft: DraftRow): string | undefined =>
        textOf(draft.contactId) ?? textOf(draft.recipientId);

      const bodyByContact = new Map<
        string,
        { artifactId: string; representationRevisionId: string; position: number }
      >();
      const namedArtifacts = new Set<string>();
      for (const [i, entry] of input.approvedBodies.entries()) {
        const position = i + 1;
        if (namedArtifacts.has(entry.artifactId)) {
          refuse(`approved body ${position} names artifact ${entry.artifactId} a second time`);
        }
        namedArtifacts.add(entry.artifactId);
        const contact = textOf(entry.contactId) ?? refuse(`approved body ${position} names no contact`);
        const earlier = bodyByContact.get(contact);
        if (earlier) {
          refuse(`approved bodies ${earlier.position} and ${position} are both for contact ${contact}`);
        }
        bodyByContact.set(contact, {
          artifactId: entry.artifactId,
          representationRevisionId: entry.representationRevisionId,
          position,
        });
      }

      const draftsByContact = new Map<string, number[]>();
      for (const [index, draft] of drafts.entries()) {
        const contact = contactOf(draft);
        if (contact) draftsByContact.set(contact, [...(draftsByContact.get(contact) ?? []), index]);
      }
      for (const [contact, body] of bodyByContact) {
        const matches = draftsByContact.get(contact) ?? [];
        if (matches.length === 0) {
          refuse(`approved body ${body.position} is for contact ${contact}, which no draft of the bundle names`);
        }
        if (matches.length > 1) {
          refuse(`approved body ${body.position} is for contact ${contact}, which ${matches.length} drafts of the bundle name`);
        }
      }
      for (const [index, draft] of drafts.entries()) {
        if (!recipientEmailFor(draft, recipients)) continue; // never mailed
        const contact = contactOf(draft);
        if (!contact || !bodyByContact.has(contact)) {
          refuse(`draft ${index + 1} of the bundle has an address but no approved body`);
        }
      }

      approvedByIndex = new Map();
      for (const [contact, body] of bodyByContact) {
        const read = await readDecidedBody(
          {
            artifactId: body.artifactId,
            representationRevisionId: body.representationRevisionId,
            runId: runScopeId,
          },
          actor,
        );
        if (!read.ok) {
          return refuse(`approved body ${body.position}: ${read.error}`);
        }
        const ownContact = textOf(read.data.contactId);
        if (ownContact !== undefined && ownContact !== contact) {
          refuse(`approved body ${body.position} is the body of contact ${ownContact}, not of contact ${contact}`);
        }
        const subject = textOf(read.data.subject) !== undefined ? String(read.data.subject) : undefined;
        approvedByIndex.set(draftsByContact.get(contact)![0]!, {
          artifactId: body.artifactId,
          representationRevisionId: body.representationRevisionId,
          text: read.text,
          ...(subject !== undefined ? { subject } : {}),
        });
      }
    }

    // Durable per-item projection AT the fan-out boundary (cinatra#1455) —
    // where the run-scoped bundle is dissolved into individual items, BEFORE
    // the per-email send. `email:body` is draftable (the delivery agent files
    // the `email:recipient` snapshot, cinatra#3089), so the projection captures
    // the APPROVED drafts independent of the send outcome. A body the
    // ledgered writer refuses is a visible failure of the send (cinatra#3089):
    // it is let through to the outer catch, so nothing is sent and the refusal
    // is named. Any other projection failure is warned and the send goes on.
    //
    // THE APPROVED FORM binds EVERY message to its approved revision on the
    // ledger here, all before the first mail below: any failure (a refused or
    // skipped binding, a failed fan-out) refuses the send with nothing mailed.
    // A retry after a failed mail finds the same bindings (the ledger row of
    // each message is read back, `bindFanoutMessageRevision`) and mails again.
    // The reference-only form keeps its best-effort projection unchanged.
    const messageIdByArtifact = new Map<string, string>();
    if (approvedByIndex && runScopeId) {
      let fanout: EmailFanoutResult;
      try {
        fanout = await emitEmailFanout({
          runScopeId,
          campaignId: input.campaignId,
          drafts,
          recipients,
          approvedBodies: approvedByIndex,
          actor,
        });
      } catch (fanoutErr) {
        if (fanoutErr instanceof EmailBodyRefusedError) throw fanoutErr;
        throw new EmailBodyRefusedError(
          `The send was refused before any email went out: the messages could not be bound to their approved bodies: ${fanoutErr instanceof Error ? fanoutErr.message : String(fanoutErr)}`,
        );
      }
      if (fanout.skipped.bodies) {
        throw new EmailBodyRefusedError(
          `The send was refused before any email went out: the body type ${EMAIL_BODY_TYPE_ID} is not registered, so no message was bound to its approved body`,
        );
      }
      for (const b of fanout.bodies) messageIdByArtifact.set(b.objectId, b.externalId);
      for (const [index, body] of approvedByIndex) {
        if (!messageIdByArtifact.has(body.artifactId)) {
          throw new EmailBodyRefusedError(
            `The send was refused before any email went out: draft ${index + 1} of the bundle was not bound to its approved body`,
          );
        }
      }
    } else if (runScopeId) {
      try {
        await emitEmailFanout({
          runScopeId,
          campaignId: input.campaignId,
          drafts,
          recipients,
          actor,
        });
      } catch (fanoutErr) {
        if (fanoutErr instanceof EmailBodyRefusedError) throw fanoutErr;
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

    if (approvedByIndex && runScopeId) {
      return await mailApprovedMessages({
        input,
        actor,
        sendEmail,
        messageSendLedger,
        drafts,
        recipients,
        runScopeId,
        approvedByIndex,
        messageIdByArtifact,
        startedAt,
      });
    }

    // THE REFERENCE-ONLY FORM mails every draft of the bundle on each call,
    // exactly as before cinatra#3089 (other callers rely on it): it keeps no
    // per-message send record, and a failure reports `sentCount: 0`.
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
          // cinatra#1983 — thread the authenticated actor's org (mirrors the
          // run-scoped test-send path below) so the facade's sent-email object
          // writer receives `routing.orgId` and can persist the semantic record
          // under an authorization-bearing, org-scoped actor. Without it the
          // writer's org-less guard cleanly skips the write and the
          // fully-correlated campaign record (the reason this loop threads
          // campaign/contact/run correlation at all, #1456) would never land.
          // Undefined on an org-less caller preserves the AC3 clean-skip.
          orgId: actor.orgId ?? undefined,
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
 * (#1625, DESIGN-V3 (4) two-phase). Resolves the FINAL concrete draft-id
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
        // #1625 — the run-scoped test-delivery submission id. When
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

      // #1625 (partial-batch-retry regression): track the ids ACTUALLY
      // delivered draft-by-draft. Declared OUTSIDE the try so the catch branch can
      // return the partial prefix that went out before a mid-batch throw. Returning
      // it (even on the failure branch) lets the wrapper persist it so a later retry
      // never re-sends those drafts and the maxGateVisits cap counts the partial.
      const deliveredDraftIds: string[] = [];
      try {
        // #1625 — when the run-scoped wrapper supplies a submissionId,
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
              // #1625 (D1) — thread the run OWNER's org (== run.orgId,
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
    //      fall back to recipientEmail embedded on the draft). Given
    //      `approvedBodies` (cinatra#3089), each mailed draft's text is the
    //      approved body revision joined to it by contact, read and checked
    //      before any mail; the bundle's body is not mailed.
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
        readDecidedBody: deps.readDecidedBody ?? buildLazyDefaultDeps().readDecidedBody!,
        messageSendLedger: deps.messageSendLedger ?? defaultMessageSendLedger,
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
        ...sendRecordCounts(result),
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
        ...sendRecordCounts(state),
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
