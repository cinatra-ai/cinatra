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
 *
 * NO RUN REACHES THE APPROVED SEND THROUGH MCP: the MCP boundary refuses every
 * call of this tool made on a run's frame (src/lib/authz/mcp-boundary.ts, the
 * outward-effect set). A run reaches it only through the declared publishing
 * step's call on the passthrough route (cinatra#3089, the change that follows
 * this one), in the run's frame with its verified run, step and decision.
 *
 * THE INVARIANT OF THE APPROVED SEND (cinatra#3089): a released publish decision
 * starts at most one send call (the caller consumes it once, before the send),
 * and an approved body is handed to a recipient at most once across all calls
 * and all decisions. Each message is claimed durably before the provider call
 * and marked done after it; a message already done is skipped (counted in
 * `alreadySentCount`); a message whose provider call failed, or whose done mark
 * could not be written, stays in doubt and is mailed by no later call (counted
 * in `inDoubtCount` and named in the answer, by draft, message and contact, never
 * by address). A call that did not complete answers `status: "failed"` with a
 * truthful `sentCount`; it stops at the first provider failure. Finishing the
 * rest takes a new approval, whose send mails only the recipients not yet sent
 * and not in doubt. A call governed by a publish decision always takes this
 * ledgered form: the form is chosen by the decision the server resolves for the
 * calling step, never by the request, and a publishing-step call without an
 * approved list is refused.
 */
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { TriggerEmailSendUseCases } from "@cinatra-ai/trigger-email-send";
import type { PublishDecisionRow } from "@cinatra-ai/agents/publish-decision-store";
import type { RevisionEffectLedger, RevisionEffectVerify } from "./artifacts/materialization-ledger";

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
    options?: { userId?: string; orgId?: string; connectorId?: string; correlation?: SendCorrelation },
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
  // done after it, so a repeated or concurrent send never mails a message
  // twice. Absent, `performRevisionEffectOnce` uses the materialization
  // ledger's claim rows. The reference-only form does not use it.
  messageSendLedger?: MessageSendLedger;
  // Whether the steps of a run filed email bodies for review (cinatra#3089). A
  // send of such a run whose calling step released no reviewed list is refused
  // before any mail, so the bundle's text never bypasses the reviewed bodies.
  // Defaults to `runHasFiledReviewArtifacts`: the run's mid-run filings in the
  // actor's organization, each read through the access-checked objects read.
  readRunReviewedBodies?: (runId: string, actor: PrimitiveActorContext) => Promise<boolean>;
  /**
   * The run this call belongs to, read from the server's own context of the
   * call (cinatra#3089), with the verified step that made the call; null when
   * the call carries no verified run. Never a field of the request or of a
   * bundle.
   */
  readCallingRun?: () => Promise<CallingRun | null>;
  /**
   * The publish decision that governs a call of the verified step `stepId` in
   * `runId`, whatever its status: the values frozen when the step stopped (the
   * card is drawn from them), the rows the card declared, and who released
   * it; null when the step governs none. Defaults to
   * `readGoverningPublishDecision`, the one resolution the publishing call
   * guard (`publishCallAllowed`) also claims under: a step nested in a
   * publishing node, or signed with the publishing component's own id, reads
   * the decision of that node, never a lookup by the raw step id.
   */
  readPublishDecision?: (runId: string, stepId: string) => Promise<StepPublishDecision | null>;
  /**
   * The decision `decisionId` of `runId`, by its id, in the run's CURRENT
   * attempt (cinatra#3089): the decision the call's road claimed for this call
   * (`CallingRun.claim`). Null when the run holds no such decision in its
   * current attempt (another run's, or one a reset left behind). Defaults to
   * `readDecisionOfRun`. The approved send reads its list from this decision
   * only, never from "the newest of the attempt".
   */
  readClaimedPublishDecision?: (runId: string, decisionId: string) => Promise<StepPublishDecision | null>;
  /**
   * The runs the HOST RECORDED as writers of the object `objectId` (its row's
   * run and every run of its append-only change history), never a run id the
   * object's own data names (cinatra#3089). Throws when they cannot be read.
   * Defaults to `listObjectWriterRunIds`.
   */
  readObjectRuns?: (objectId: string, actor: PrimitiveActorContext) => Promise<string[]>;
  /**
   * The decision state of an approved body revision, read through `query` (the
   * claim's own connection, inside the transaction that holds the artifact's
   * revision lock): null while the revision is still the current, decided,
   * person-approved revision filed in `runId`, else the reason. Defaults to
   * `readRevisionDecisionState`.
   */
  readRevisionStateUnderLock?: (
    query: Parameters<RevisionEffectVerify>[0],
    ref: { orgId: string; artifactId: string; representationRevisionId: string; runId: string },
  ) => Promise<string | null>;
};

/** The run of a call, the verified step that made it, the publish decision
 *  the runtime signed for the call, when it signed one, and the decision the
 *  call's road CLAIMED for this call (`claim`, the request frame's
 *  `publishCallClaim`: the passthrough route's call check took it), when it
 *  claimed one (see `readCallingRun`). */
export type CallingRun = {
  runId: string;
  stepId?: string;
  publishDecisionId?: string;
  claim?: { runId: string; decisionId: string };
};

/** A step's publish decision, as the send reads it (see `readPublishDecision`). */
export type StepPublishDecision = Pick<PublishDecisionRow, "status" | "decidedBy" | "surfacedValues" | "declaredRows">
  & Partial<Pick<PublishDecisionRow, "id">>;

/** One message's durable send record (see `performRevisionEffectOnce`). */
export type MessageSendLedger = RevisionEffectLedger;

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

/**
 * The shipped mail sender, in two parts split at the hand-over to the provider's
 * transport.
 *
 * BEFORE the hand-over, every step that can refuse runs here, and any failure
 * throws `EffectNotStartedError` (nothing reached a provider, so a retry may
 * mail the message): the provider-neutral facade must be installed (it resolves
 * through the `email-system` capability the email connector registers); the
 * host routing resolves the connector (the sender identity's, else the first
 * installed one, as the facade does) and that connector must be installed and
 * report its mailbox connected; the development redirect is applied once, so a
 * redirect switched on with no address refuses here.
 *
 * THE HAND-OVER is the facade's send, pinned to the connector resolved above.
 * Any failure from there on may follow the provider's acceptance (a timeout, a
 * reset connection, an error answer: the connectors throw a plain error for
 * every provider answer, a rejected recipient included, so nothing shows the
 * provider took nothing), and it is thrown as it is: the caller keeps the
 * message in doubt. The facade repeats its routing and the redirect inside
 * that call; a failure there is read as in doubt too, which never mails twice.
 */
export function createDefaultSendEmail(): TriggerEmailSendDeps["sendEmail"] {
  return async (message, options) => {
    let send: TriggerEmailSendDeps["sendEmail"];
    let connectorId: string;
    try {
      const [{ requireEmailSystemFacade }, { resolveEmailSendProviders, resolveHostEmailRouting }] =
        await Promise.all([import("@/lib/email-transport-provider"), import("@/lib/email-send-providers")]);
      const facade = requireEmailSystemFacade();
      const routing = resolveHostEmailRouting();
      if (!routing) throw new Error("The host email routing is not registered.");
      const providers = resolveEmailSendProviders();
      const routed = await routing.resolveConnectorId({ userId: options?.userId, orgId: options?.orgId });
      const provider = routed ? providers.find((p) => p.definition.connectorId === routed) : providers[0];
      if (!provider) {
        throw new Error(
          routed ? `The email connector ${routed} is not installed.` : "No connected email connector is available.",
        );
      }
      const status = await provider.getStatus({ userId: options?.userId });
      if (status.status !== "connected") {
        throw new Error(
          `The mailbox of ${provider.definition.name} is not connected${status.detail ? `: ${status.detail}` : "."}`,
        );
      }
      routing.applyDevModeOverride(message);
      connectorId = provider.definition.connectorId;
      send = facade.sendEmail.bind(facade) as unknown as TriggerEmailSendDeps["sendEmail"];
    } catch (err) {
      const { EffectNotStartedError } = await import("./artifacts/materialization-ledger");
      throw new EffectNotStartedError(err instanceof Error ? err.message : String(err));
    }
    return send(message, { ...options, connectorId });
  };
}

function buildLazyDefaultDeps(): TriggerEmailSendDeps {
  let cachedGetCampaign: TriggerEmailSendDeps["getCampaign"] | null = null;
  let cachedGetDrafts: TriggerEmailSendDeps["getDraftsByIds"] | null = null;
  const defaultSend = createDefaultSendEmail();
  return {
    async getCampaign(campaignId) {
      if (!cachedGetCampaign) cachedGetCampaign = await loadDefaultGetCampaign();
      return cachedGetCampaign(campaignId);
    },
    async getDraftsByIds(ids) {
      if (!cachedGetDrafts) cachedGetDrafts = await loadDefaultGetDraftsByIds();
      return cachedGetDrafts(ids);
    },
    sendEmail(message, options) {
      return defaultSend(message, options);
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
    async readRunReviewedBodies(runId, actor) {
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("the sending actor carries no organization, so the filings of its run cannot be read");
      }
      const [{ kernelActorForRead }, { runHasFiledReviewArtifacts }] = await Promise.all([
        import("./authz/enforce-resource-access"),
        import("./artifacts/current-decided-revision-read"),
      ]);
      return runHasFiledReviewArtifacts({
        actor: kernelActorForRead(actor, orgId),
        orgId,
        runId,
        objectTypeId: EMAIL_BODY_TYPE_ID,
      });
    },
    // The run of the call is a verified channel of the request frame only: an
    // agent-run token's signed run, or the run a run-bound seam proved
    // (`verifiedRunScopeId`, or the frame's run id beside a verified step: a
    // verified step is never stamped on a frame without a verified run).
    async readCallingRun() {
      const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server/request-context");
      const ctx = mcpRequestContextStorage.getStore();
      const agentRun = ctx?.delegatedActor?.delegation === "agent_run" ? ctx.delegatedActor : undefined;
      const runId = agentRun?.runId ?? ctx?.verifiedRunScopeId ?? (ctx?.verifiedStepId ? ctx.runId : undefined);
      if (typeof runId !== "string" || runId.trim() === "") return null;
      const stepId = ctx?.verifiedStepId ?? agentRun?.verifiedStepId;
      // The decision the runtime signed beside the verified source (cinatra#3745), never request input.
      const publishDecisionId = ctx?.verifiedPublishDecisionId;
      // The decision the passthrough route's call check CLAIMED for this call (cinatra#4762), as the server took it.
      const claim = ctx?.publishCallClaim;
      return {
        runId: runId.trim(),
        ...(typeof stepId === "string" && stepId !== "" ? { stepId } : {}),
        ...(typeof publishDecisionId === "string" && publishDecisionId !== "" ? { publishDecisionId } : {}),
        ...(claim && typeof claim.runId === "string" && typeof claim.decisionId === "string" && claim.decisionId !== ""
          ? { claim: { runId: claim.runId, decisionId: claim.decisionId } }
          : {}),
      };
    },
    async readObjectRuns(objectId, actor) {
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("the sending actor carries no organization, so the writers of its bundles cannot be read");
      }
      const [{ kernelActorForRead }, { listObjectWriterRunIds }] = await Promise.all([
        import("./authz/enforce-resource-access"),
        import("./artifacts/current-decided-revision-read"),
      ]);
      return listObjectWriterRunIds({ actor: kernelActorForRead(actor, orgId), orgId, objectId });
    },
    async readRevisionStateUnderLock(query, ref) {
      const { readRevisionDecisionState } = await import("./artifacts/current-decided-revision-read");
      const state = await readRevisionDecisionState(query, ref);
      return state.ok ? null : state.error;
    },
    async readPublishDecision(runId, stepId) {
      const { readGoverningPublishDecision } = await import("@cinatra-ai/agents/publish-decision-actions");
      return readGoverningPublishDecision(runId, stepId);
    },
    async readClaimedPublishDecision(runId, decisionId) {
      const { readDecisionOfRun } = await import("@cinatra-ai/agents/publish-decision-store");
      return readDecisionOfRun(runId, decisionId);
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
  /** The approved form only (cinatra#3089): messages an earlier call already
   *  handed over, which this call skipped. */
  alreadySentCount?: number;
  /** The approved form only: messages claimed but never recorded as sent, which
   *  this call did not mail (they may or may not have gone out). */
  inDoubtCount?: number;
};
const sendStateByCampaign = new Map<string, InitialSendStateRow>();

/**
 * THE FIXED REASONS OF THE APPROVED SEND (cinatra#3089). No text from the mail connector, the provider or the send
 * record's store reaches the answer or the log: a provider's error can quote the recipient's address (a rejected
 * recipient) and a mailbox status can name the mailbox, so each failure stage answers one of these codes, and the
 * raw text is dropped (it is kept nowhere). The one reason passed on is a refusal under the revision's lock
 * (`refused`), whose text is the host's own decision-state reading of the body.
 */
const SEND_FAILURE_CODE = {
  claim: "send_record_claim_failed",
  refused: "body_refused",
  not_started: "provider_not_reached",
  act: "provider_error",
  release: "send_record_release_failed",
  mark: "send_record_write_failed",
} as const;

/** What the answer of an approved send tells a person about a message in doubt (cinatra#3089). No tool or route clears
 *  an in-doubt mark: it is a manual check. */
const IN_DOUBT_MANUAL_CHECK =
  "A message in doubt is never mailed again by this or any later send, also not under a new approval: the mail " +
  "provider may have accepted it. Check the sent mail of the connected mailbox for each message named (by its contact, " +
  "in this campaign) to learn whether it went out. Nothing in the app clears an in-doubt mark; this is a manual check, " +
  "and a message that did not go out must be sent by hand";

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
 * `(runScopeId, draftItemId)` is the fan-out key (cinatra#1455); a message of
 * the approved form is keyed by its approved body artifact instead
 * (`(runScopeId, artifactId)`, cinatra#3089). The objects identity resolver
 * lowercases the key, so equal keys converge on one row.
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
      if (approvedBodies) {
        // The approved form (cinatra#3089): the message is bound to the
        // revision a person approved; no body of the bundle is filed. Its
        // identity is the approved body ARTIFACT of the run, never a draft id
        // or a list position the bundle can change: one artifact is one
        // message, mailed at most once per run whatever revision of it is
        // approved later and whatever the bundle says (the send refuses a list
        // that names one artifact twice before anything is bound).
        const approved = approvedBodies.get(index - 1);
        if (!approved) continue;
        const externalId = emailBodyExternalId(runScopeId, approved.artifactId);
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
        } catch {
          // The binder's thrown text is never passed on (a store error may quote stored data): a fixed reason.
          throw new EmailBodyRefusedError(`the email body ${externalId} could not be bound (bind_failed)`);
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
      const externalId = emailBodyExternalId(runScopeId, draftItemId);
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
 * Every run id the two bundle envelopes name (`cinatraAgentRunId`,
 * `cinatra_agent_run_id`, `runId`; the draft bundle first), each non-empty one
 * once, in that order. An agent may change a bundle after the approval, so a
 * named run is never the run of a send (cinatra#3089): it is only looked up,
 * all of them, for bodies filed for review, and the first one keys the
 * reference-only fan-out of a call that carries no run (cinatra#1455: the key
 * is `(runId, itemKey)`, never the campaign; with no run id the projection is
 * skipped).
 */
function bundleRunIds(
  draftEnv: ObjectsEnvelope | null,
  recipEnv: ObjectsEnvelope | null,
): string[] {
  const ids: string[] = [];
  for (const env of [draftEnv, recipEnv]) {
    const d = (env?.data ?? null) as Record<string, unknown> | null;
    if (!d || typeof d !== "object") continue;
    for (const rid of [d.cinatraAgentRunId, d.cinatra_agent_run_id, d.runId]) {
      if (typeof rid === "string" && rid.trim() !== "" && !ids.includes(rid.trim())) ids.push(rid.trim());
    }
  }
  return ids;
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
  readDecidedBody: NonNullable<TriggerEmailSendDeps["readDecidedBody"]>;
  messageSendLedger: MessageSendLedger | undefined;
  readRunReviewedBodies: NonNullable<TriggerEmailSendDeps["readRunReviewedBodies"]>;
  readCallingRun: NonNullable<TriggerEmailSendDeps["readCallingRun"]>;
  readPublishDecision: NonNullable<TriggerEmailSendDeps["readPublishDecision"]>;
  readClaimedPublishDecision: NonNullable<TriggerEmailSendDeps["readClaimedPublishDecision"]>;
  readObjectRuns: NonNullable<TriggerEmailSendDeps["readObjectRuns"]>;
  readRevisionStateUnderLock: NonNullable<TriggerEmailSendDeps["readRevisionStateUnderLock"]>;
  getObjectByRef: (
    ref: string,
    actor: PrimitiveActorContext,
  ) => Promise<ObjectsEnvelope | null>;
  emitEmailFanout: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
}): Promise<InitialSendStateRow> {
  const {
    input,
    actor,
    sendEmail,
    getObjectByRef,
    emitEmailFanout,
    readDecidedBody,
    messageSendLedger,
    readRunReviewedBodies,
    readCallingRun,
    readPublishDecision,
    readClaimedPublishDecision,
    readObjectRuns,
    readRevisionStateUnderLock,
  } = args;
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
    // THE RUN OF THE SEND (cinatra#3089) is the run of the call, from the
    // server's own context of the call; a run id written in a bundle (empty,
    // or naming another run) never decides it.
    let callingRun: CallingRun | null;
    try {
      callingRun = await readCallingRun();
    } catch (err) {
      throw new Error(
        `The send was refused before any email went out: the run of this call could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const namedRunIds = bundleRunIds(draftEnv, recipEnv);
    const runScopeId = callingRun?.runId ?? null;
    if (drafts.length === 0) {
      return {
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        sentCount: 0,
        errorMessage: "Approved draft bundle has no drafts.",
      };
    }
    const refuse = (reason: string): never => {
      throw new Error(`The send was refused before any email went out: ${reason}`);
    };
    const textOf = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    // A value of the released decision is used exactly as it was frozen, shown
    // and compared: never trimmed or folded on the way to the mail. An id or an
    // address must therefore carry no white space around it (the card would
    // show it, and a check would compare it, in another form than the one
    // sent); a subject is compared and sent byte for byte.
    const exactOf = (value: unknown): string | undefined =>
      typeof value === "string" && value !== "" && value.trim() === value ? value : undefined;

    // WHAT A PERSON APPROVED (cinatra#3089) is the publish decision a person
    // released for the calling step: its values were frozen when the step
    // stopped, and the card was drawn from them. The approved list is the ONE
    // surfaced value that is a list of approved bodies (artifact, revision,
    // contact, address, subject); a list row of the card must show each
    // message's address and subject in their own columns, in the same order,
    // and an artifacts row must draw the bodies of that same list
    // (`releasedDecisionList`). The sender is the text the card's own row for
    // `senderEmail` showed (`releasedDecisionText`): a sender surfaced but
    // never shown, a call that names another sender, or a sender the card did
    // not show is refused; with none shown the connected default mailbox
    // sends. The campaign is the decision's surfaced `campaignId`, which must
    // be the campaign the call names. Nothing of the request decides what is
    // mailed: the request carries no list.
    //
    // EVERY VALUE THE APPROVED SEND MAILS WITH WAS SHOWN to the person who
    // released it: the bodies (artifacts row), each address and subject (their
    // columns of the list row), the sender (its text row). The values that
    // AUTHORIZE but are identifiers no person reads (the artifact and revision
    // ids, the contact id, the campaign id) are bound instead: frozen in the
    // released decision of the server-verified calling step, and checked
    // against the run (each revision filed in the run of the call, read again
    // under the revision's lock at the claim) and the call (the campaign).
    //
    // Every value the approved send authorizes or mails with comes from (a) the
    // released decision's frozen values, (b) the decided revision itself (its
    // text; its state verified again when each message is claimed), or (c) the
    // server's context of the call (the run and the step). The body object's own `data` can be
    // changed after the decision without a new revision, so it never
    // authorizes: its `contactId` and `campaignId` are read only to REFUSE a
    // body that disagrees with the decision. The bundle is likewise read only
    // to refuse a send whose bundle changed after the card.
    let released: {
      list: Array<Record<string, string>>;
      campaignId: string;
      senderEmail: string | undefined;
    } | null = null;
    const stepId = callingRun?.stepId;
    if (runScopeId && stepId) {
      const decisionOf = `step ${stepId} of run ${runScopeId}`;
      let governing: StepPublishDecision | null = null;
      try {
        governing = await readPublishDecision(runScopeId, stepId);
      } catch (err) {
        refuse(`the publish decision of ${decisionOf} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The decision the runtime signed for this call names the visit it was
      // made under: the governing decision must be that very decision.
      const signed = callingRun?.publishDecisionId;
      if (signed !== undefined && governing?.id !== signed) {
        refuse(`the call was signed for another publish decision than the one that governs ${decisionOf}`);
      }
      // THE SEND USES EXACTLY ONE DECISION (cinatra#3089): the one the call's
      // road claimed for this call (`claim`). Its list is read by that id, in
      // the run's current attempt, never as "the newest of the attempt". A
      // governed call with no claim, a claim of another run, a claim that the
      // signed decision contradicts, a claimed decision the current attempt no
      // longer holds (a reset left it behind), or one a newer decision of the
      // step superseded is refused before any mail; a claimed decision that is
      // not released is refused by the list read below.
      let decision: StepPublishDecision | null = null;
      if (governing) {
        const claim = callingRun?.claim;
        if (!claim) refuse(`no publish decision was claimed for this call (${decisionOf}) (decision_not_claimed)`);
        if (claim!.runId !== runScopeId) refuse(`the call claimed a publish decision of another run (${decisionOf}) (decision_claim_other_run)`);
        if (signed !== undefined && signed !== claim!.decisionId) {
          refuse(`the call was signed for another publish decision than the one it claimed (${decisionOf}) (decision_claim_conflict)`);
        }
        try {
          decision = await readClaimedPublishDecision(runScopeId, claim!.decisionId);
        } catch {
          refuse(`the publish decision this call claimed could not be read (${decisionOf}) (decision_claim_unreadable)`);
        }
        if (!decision || decision.id !== claim!.decisionId) {
          refuse(`the publish decision this call claimed is not a decision of the current attempt of the run (${decisionOf}) (decision_claim_not_current)`);
        }
        if (governing.id !== claim!.decisionId) {
          refuse(`the publish decision this call claimed was superseded by a newer decision of the step (${decisionOf}) (decision_claim_superseded)`);
        }
      }
      if (decision) {
        const { releasedDecisionList } = await import("@cinatra-ai/agents/publish-decision-store");
        const read = releasedDecisionList({
          decision,
          entryFields: ["artifactId", "representationRevisionId", "contactId", "recipientEmail", "subject"],
          shownFields: [
            { field: "recipientEmail", column: "email" },
            { field: "subject", column: "subject" },
          ],
        });
        if (!read.ok) return refuse(`${read.error} (${decisionOf})`);
        // THE BRANCH IS CHOSEN BY THE DECISION, NEVER BY THE REQUEST: a call
        // whose step is governed by a publish decision is a publishing-step
        // call, and it sends only through the approved (ledgered) form below.
        // A decision with no approved list cannot route it into the
        // reference-only form (which keeps no per-message record): it is
        // refused before any mail.
        if (!read.list) {
          const { ReviewedArtifactsRequiredError } = await import("./artifacts/current-decided-revision-read");
          throw new ReviewedArtifactsRequiredError(
            `The send was refused before any email went out: the publish decision that governs ${decisionOf} holds no list of approved bodies, and a publishing step sends only the bodies a person released`,
          );
        }
        {
          const surfaced = decision.surfacedValues;
          const frozenCampaign = Object.prototype.hasOwnProperty.call(surfaced, "campaignId") ? surfaced.campaignId : undefined;
          if (textOf(frozenCampaign) === undefined) refuse(`the released publish decision carries no campaign (${decisionOf})`);
          const campaignId = exactOf(frozenCampaign)
            ?? refuse(`the released publish decision carries its campaign with white space around it (${decisionOf})`);
          if (campaignId !== input.campaignId) {
            refuse(`the call names another campaign than the released publish decision carries (${decisionOf})`);
          }
          const { releasedDecisionText } = await import("@cinatra-ai/agents/publish-decision-store");
          const shownSender = releasedDecisionText({ decision, input: "senderEmail" });
          if (!shownSender.ok) return refuse(`${shownSender.error} (${decisionOf})`);
          const senderEmail = shownSender.value ?? undefined;
          if (senderEmail !== undefined && exactOf(senderEmail) === undefined) {
            refuse(`the sender the released publish card showed carries white space around it (${decisionOf})`);
          }
          // The call's sender, when it names one, must be the shown sender byte for byte.
          const callSender = textOf(input.senderEmail) === undefined ? undefined : input.senderEmail;
          if (callSender !== undefined && callSender !== senderEmail) {
            refuse(
              senderEmail
                ? `the call names another sender than the released publish card showed (${decisionOf})`
                : `the call names a sender the released publish card did not show (${decisionOf})`,
            );
          }
          released = { list: read.list, campaignId, senderEmail };
        }
      }
    }

    // Without a released list the send reads the bundle exactly as before,
    // unless a step filed bodies for review: the bundle's text is then not what
    // a person reviewed, so the send is refused before any mail
    // (`ReviewedArtifactsRequiredError`). The runs looked up are the run of the
    // call (the server's context) AND every run the HOST RECORDED as a writer
    // of either bundle object (`readObjectRuns`: the row's run and every run of
    // its append-only change history). A run id in a bundle's data
    // (`cinatraAgentRunId`, which a save keeps as the caller sent it) decides
    // nothing here. A call that carries no run (a person's direct call: an
    // agent's call always carries its run, by its token or the run-bound seam)
    // on bundles no run ever wrote keeps the reference-only send it had before
    // cinatra#3089: no run made them, so no body of theirs was filed for review.
    if (!released) {
      const writerRuns: string[] = [];
      for (const [ref, env] of [
        [input.approvedDraftBundleRef, draftEnv],
        [input.confirmedRecipientsRef, recipEnv],
      ] as const) {
        const objectId = textOf(env.id) ?? ref;
        try {
          writerRuns.push(...(await readObjectRuns(objectId, actor)));
        } catch (err) {
          refuse(`which runs wrote object ${objectId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const runId of [...new Set([...(runScopeId ? [runScopeId] : []), ...writerRuns])]) {
        let reviewed: boolean;
        try {
          reviewed = await readRunReviewedBodies(runId, actor);
        } catch (err) {
          throw new Error(
            `The send was refused before any email went out: whether run ${runId} filed artifacts for review could not be read: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (reviewed) {
          const { ReviewedArtifactsRequiredError } = await import("./artifacts/current-decided-revision-read");
          throw new ReviewedArtifactsRequiredError(
            `The send was refused before any email went out: run ${runId} filed artifacts for review, and the calling step holds no list a person released`,
          );
        }
      }
    }

    // THE APPROVED FORM mails, for each draft with an address, the text of ITS
    // approved body revision, never the bundle's body. A body joins its draft by
    // the contact: the entry's `contactId` equals the draft's `contactId`, else
    // its `recipientId`, and names exactly one draft of the bundle; a body that
    // carries a contact of its own must carry the same one, and the body must be
    // filed for the released campaign. The address and the subject mailed are
    // the released entry's, exactly as the card's list row showed them; the
    // bundle's draft must still resolve the same address (its own value
    // trimmed, the entry's byte for byte) and hold the same subject byte for
    // byte, so a bundle
    // changed after the card refuses the send. The revision's text must equal
    // the body the bundle's draft holds (trailing white space aside, as the
    // delivery pack's read step compares them before the card), so two entries
    // swapped between drafts, or a draft changed after its body was filed, are
    // refused. Every check and every read runs before the fan-out and before
    // any mail, and any failure refuses the whole send.
    let approvedByIndex: Map<
      number,
      ApprovedFanoutBody & { subject: string; recipientEmail: string; contactId: string }
    > | null = null;
    if (released) {
      // Each message is bound to its approved revision under the run of the
      // call before any mail (a released list is only read for a run's step).
      const runId = runScopeId!;
      const contactOf = (draft: DraftRow): string | undefined =>
        textOf(draft.contactId) ?? textOf(draft.recipientId);

      const bodyByContact = new Map<
        string,
        {
          artifactId: string;
          representationRevisionId: string;
          recipientEmail: string;
          subject: string;
          position: number;
        }
      >();
      const namedArtifacts = new Set<string>();
      for (const [i, entry] of released.list.entries()) {
        const position = i + 1;
        if (textOf(entry.artifactId) === undefined || textOf(entry.representationRevisionId) === undefined) {
          refuse(`approved body ${position} names no artifact revision`);
        }
        // The released values are used as frozen: an id or address with white
        // space around it is refused rather than trimmed (see `exactOf`).
        for (const field of ["artifactId", "representationRevisionId", "contactId", "recipientEmail"] as const) {
          if (textOf(entry[field]) !== undefined && exactOf(entry[field]) === undefined) {
            refuse(`approved body ${position} carries its ${field} with white space around it`);
          }
        }
        if (namedArtifacts.has(entry.artifactId!)) {
          refuse(`approved body ${position} names artifact ${entry.artifactId} a second time`);
        }
        namedArtifacts.add(entry.artifactId!);
        const contact = textOf(entry.contactId) ?? refuse(`approved body ${position} names no contact`);
        const earlier = bodyByContact.get(contact);
        if (earlier) {
          refuse(`approved bodies ${earlier.position} and ${position} are both for contact ${contact}`);
        }
        if (textOf(entry.recipientEmail) === undefined) {
          refuse(`approved body ${position} names no recipient address`);
        }
        bodyByContact.set(contact, {
          artifactId: entry.artifactId!,
          representationRevisionId: entry.representationRevisionId!,
          recipientEmail: entry.recipientEmail!,
          subject: entry.subject!,
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
      // The address mailed is the released entry's, never the bundle's. The
      // address the send resolves for the draft (`recipientEmailFor`) must still
      // equal it, so a bundle changed after the card refuses the send rather
      // than being mailed or ignored. Both are the intended recipient BEFORE the
      // development redirect, a separate, later replacement in the email
      // connector. The refusal names the draft and its contact, never an
      // address.
      for (const [contact, body] of bodyByContact) {
        const index = draftsByContact.get(contact)![0]!;
        const where = `draft ${index + 1} of the bundle (contact ${contact})`;
        const resolved = recipientEmailFor(drafts[index]!, recipients);
        if (!resolved) {
          refuse(`approved body ${body.position} is for ${where}, which has no address`);
        }
        if (resolved!.trim() !== body.recipientEmail) {
          refuse(`${where}: the recipient's address changed after the card was shown`);
        }
      }

      approvedByIndex = new Map();
      for (const [contact, body] of bodyByContact) {
        const read = await readDecidedBody(
          {
            artifactId: body.artifactId,
            representationRevisionId: body.representationRevisionId,
            runId,
          },
          actor,
        );
        if (!read.ok) {
          return refuse(`approved body ${body.position}: ${read.error}`);
        }
        // The body object's `data` only refuses (see above): a value of it that
        // disagrees with the decision refuses the send; agreeing authorizes
        // nothing, the decision's entry already binds the contact and the
        // decision the campaign.
        const ownContact = textOf(read.data.contactId);
        if (ownContact !== undefined && ownContact !== contact) {
          refuse(`approved body ${body.position} is the body of contact ${ownContact}, not of contact ${contact}`);
        }
        if (textOf(read.data.campaignId) !== released.campaignId) {
          refuse(`approved body ${body.position} is not filed for campaign ${released.campaignId}`);
        }
        const index = draftsByContact.get(contact)![0]!;
        const draftText = String(drafts[index]!.body ?? drafts[index]!.bodyHtml ?? "");
        if (read.text.trimEnd() !== draftText.trimEnd()) {
          refuse(`approved body ${body.position} is not the body of draft ${index + 1} of the bundle (contact ${contact})`);
        }
        // ONE subject per message: the one the released card showed, which the
        // send mails. The subject the bundle's draft holds must equal it
        // exactly, so a draft changed after the card refuses the send. The body
        // artifact's own `subject` field is read by no reviewer (the review
        // shows its text and title), so it neither decides the mailed subject
        // nor blocks it.
        if ((drafts[index]!.subject ?? "(no subject)") !== body.subject) {
          refuse(`draft ${index + 1} of the bundle (contact ${contact}): the subject changed after the card was shown`);
        }
        approvedByIndex.set(index, {
          artifactId: body.artifactId,
          representationRevisionId: body.representationRevisionId,
          text: read.text,
          subject: body.subject,
          recipientEmail: body.recipientEmail,
          contactId: contact,
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
    // The bind writes ledger rows only, never an object. The reference-only
    // form keeps its best-effort projection unchanged.
    const messageIdByArtifact = new Map<string, string>();
    // The reference-only form keys its projection and its correlation on the
    // run of the call, and on a call that carries no run, as before, on the
    // first run the bundles name: a key of the projection, never a check.
    const referenceRunId = runScopeId ?? namedRunIds[0] ?? null;
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
    } else if (referenceRunId) {
      try {
        await emitEmailFanout({
          runScopeId: referenceRunId,
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

    // THE MAIL OF THE APPROVED FORM, AT MOST ONCE PER MESSAGE: each message, in
    // bundle order, is mailed through `performRevisionEffectOnce` under its
    // binding (claim, hand-over, done mark). A message an earlier call mailed is
    // skipped and counted in `alreadySentCount`; one another call holds is not
    // mailed and is counted in `inDoubtCount`. A provider error after a won
    // claim leaves the message in doubt and STOPS the send: the later messages
    // are not attempted by this call, since a provider that just failed may
    // fail (or half-accept) again, and each further attempt could add a message
    // in doubt; a new approval sends them. The claim is given back only for an
    // error raised before the hand-over to the transport
    // (`EffectNotStartedError`). A mail handed over whose done mark cannot be
    // written is counted in `sentCount` AND in `inDoubtCount`. A message in doubt
    // is mailed by no later call, under any decision: nothing clears the mark
    // (IN_DOUBT_MANUAL_CHECK). The answer names it by draft, message and
    // contact; the log names it by draft and message, never by address. A
    // failure answers a fixed code (SEND_FAILURE_CODE): no provider, connector
    // or store text reaches the answer or the log.
    if (approvedByIndex && runScopeId) {
      let sentCount = 0;
      let alreadySentCount = 0;
      const inDoubt: string[] = [];
      // Mailed (handed over), but no sent record could be written.
      const unrecorded: string[] = [];
      // Refused at its send time: the body was no longer decided (or read
      // another text), so it was not mailed and its claim was given back.
      const refusedAtSend: string[] = [];
      let stopped: string | undefined;
      const fromEmail = released?.senderEmail;
      const { EffectNotStartedError, performRevisionEffectOnce } = await import("./artifacts/materialization-ledger");
      for (const [index, draft] of drafts.entries()) {
        if (!recipientEmailFor(draft, recipients)) continue;
        const approved = approvedByIndex.get(index);
        const outputId = approved ? messageIdByArtifact.get(approved.artifactId) : undefined;
        if (!approved || !outputId) {
          stopped = `draft ${index + 1} of the bundle has no bound approved body, so it was not sent`;
          break;
        }
        const name = `draft ${index + 1} (${outputId})`;
        let notDecidedNow: string | undefined;
        const outcome = await performRevisionEffectOnce({
          claimKey: {
            runId: runScopeId,
            path: "email_fanout",
            bindingOutputId: outputId,
            effect: "message-send",
            artifactId: approved.artifactId,
            representationRevisionId: approved.representationRevisionId,
          },
          actor,
          ...(messageSendLedger ? { ledger: messageSendLedger } : {}),
          // THE START IS VERIFIED UNDER THE REVISION'S LOCK: the claim's own
          // transaction holds the lock every revision writer takes and reads
          // the revision's decision state again; the claim commits (the mail
          // is started) only while the revision is still current and decided.
          verifyUnderLock: (query) =>
            readRevisionStateUnderLock(query, {
              orgId: actor.orgId ?? "",
              artifactId: approved.artifactId,
              representationRevisionId: approved.representationRevisionId,
              runId: runScopeId,
            }),
          // THE CHECK AND THE MAIL ARE BOUND PER MESSAGE: with the claim won,
          // the decided-revision read runs again right before the hand-over,
          // and the text mailed is the one it reads then. A revision no longer
          // current and decided (superseded, reopened, sent back or repaired
          // since the check), a read that fails, or another text, stops this
          // message before anything started, so its claim is given back.
          act: async () => {
            let now: DecidedBodyRead;
            try {
              now = await readDecidedBody(
                {
                  artifactId: approved.artifactId,
                  representationRevisionId: approved.representationRevisionId,
                  runId: runScopeId,
                },
                actor,
              );
            } catch {
              // The reader's thrown text is never passed on (it may quote stored data): a fixed reason.
              now = { ok: false, error: "its body could not be read at its send time (body_read_failed)" };
            }
            if (!now.ok || now.text !== approved.text) {
              notDecidedNow = now.ok ? "its revision read another text at its send time than the one checked" : now.error;
              throw new EffectNotStartedError(notDecidedNow);
            }
            return sendEmail(
              {
                to: [approved.recipientEmail],
                subject: approved.subject,
                textBody: now.text,
                ...(fromEmail ? { fromEmail } : {}),
              },
              {
                userId: actor.userId,
                orgId: actor.orgId ?? undefined,
                correlation: {
                  campaignId: input.campaignId,
                  runId: runScopeId,
                  contactId: approved.contactId,
                },
              },
            );
          },
        });
        if (outcome.alreadyDone) {
          alreadySentCount += 1;
          continue;
        }
        if (outcome.done) sentCount += 1;
        const failure = outcome.failure;
        if (!failure) {
          if (outcome.inDoubt) {
            inDoubt.push(`${name} for contact ${approved.contactId}`);
            console.warn(
              `[trigger-email-send] ${name} of run ${runScopeId} is claimed but not recorded as sent; it was not mailed again`,
            );
          }
          continue;
        }
        if (failure.stage === "refused") {
          refusedAtSend.push(`${name} was not sent, its body was refused when its mail was claimed: ${failure.reason}`);
          continue;
        }
        if (failure.stage === "not_started" && notDecidedNow !== undefined) {
          refusedAtSend.push(`${name} was not sent, its body was refused at its send time: ${notDecidedNow}`);
          continue;
        }
        if (failure.stage === "mark") {
          unrecorded.push(`${name} was mailed, but its sent record could not be written (${SEND_FAILURE_CODE.mark}) (contact ${approved.contactId})`);
          console.warn(
            `[trigger-email-send] ${name} of run ${runScopeId} was mailed but could not be recorded as sent; it is in doubt (${SEND_FAILURE_CODE.mark})`,
          );
          continue;
        }
        if (outcome.inDoubt) inDoubt.push(`${name} for contact ${approved.contactId}`);
        stopped =
          failure.stage === "claim"
            ? `the mail of ${name} could not be claimed, so it was not sent (${SEND_FAILURE_CODE.claim})`
            : failure.stage === "not_started"
              ? `${name} was not sent, no mail provider was reached (${SEND_FAILURE_CODE.not_started})`
              : failure.stage === "release"
                ? `${name} was not sent, and its claim could not be given back (${SEND_FAILURE_CODE.release})`
                : `the mail provider failed on ${name}, which may or may not have gone out (${SEND_FAILURE_CODE.act})`;
        console.warn(`[trigger-email-send] ${name} of run ${runScopeId} stopped the send (${SEND_FAILURE_CODE[failure.stage]})`);
        break;
      }
      const problems = [
        ...refusedAtSend,
        ...(stopped ? [stopped] : []),
        ...unrecorded,
        ...(inDoubt.length > 0 ? [`${inDoubt.length} message(s) are in doubt: ${inDoubt.join(", ")}`] : []),
        ...(inDoubt.length + unrecorded.length > 0 ? [IN_DOUBT_MANUAL_CHECK] : []),
      ];
      return {
        status: problems.length > 0 ? "failed" : "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        sentCount,
        alreadySentCount,
        inDoubtCount: inDoubt.length + unrecorded.length,
        ...(problems.length > 0 ? { errorMessage: problems.join("; ") } : {}),
      };
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
      // record by its `connectorId`); `referenceRunId` is the fan-out run frame
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
            ...(referenceRunId ? { runId: referenceRunId } : {}),
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
    //      fall back to recipientEmail embedded on the draft). When the
    //      calling step's released publish decision holds the approved list
    //      (cinatra#3089), each mailed draft's text is the approved body
    //      revision joined to it by contact, read and checked before any mail;
    //      the bundle's body is not mailed.
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
      let defaults: TriggerEmailSendDeps | null = null;
      const fallback = () => (defaults ??= buildLazyDefaultDeps());
      const result = await runInitialSend({
        input,
        actor,
        sendEmail: deps.sendEmail,
        // Fall back to the production defaults when an injected deps object
        // (e.g. a unit test) omits the optional fan-out seams.
        getObjectByRef: deps.getObjectByRef ?? fetchObjectsByRef,
        emitEmailFanout: deps.emitEmailFanout ?? defaultEmitEmailFanout,
        readDecidedBody: deps.readDecidedBody ?? fallback().readDecidedBody!,
        messageSendLedger: deps.messageSendLedger,
        readRunReviewedBodies: deps.readRunReviewedBodies ?? fallback().readRunReviewedBodies!,
        readCallingRun: deps.readCallingRun ?? fallback().readCallingRun!,
        readPublishDecision: deps.readPublishDecision ?? fallback().readPublishDecision!,
        readClaimedPublishDecision: deps.readClaimedPublishDecision ?? fallback().readClaimedPublishDecision!,
        readObjectRuns: deps.readObjectRuns ?? fallback().readObjectRuns!,
        readRevisionStateUnderLock: deps.readRevisionStateUnderLock ?? fallback().readRevisionStateUnderLock!,
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
        ...(result.alreadySentCount !== undefined ? { alreadySentCount: result.alreadySentCount } : {}),
        ...(result.inDoubtCount !== undefined ? { inDoubtCount: result.inDoubtCount } : {}),
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
        ...(state.alreadySentCount !== undefined ? { alreadySentCount: state.alreadySentCount } : {}),
        ...(state.inDoubtCount !== undefined ? { inDoubtCount: state.inDoubtCount } : {}),
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
