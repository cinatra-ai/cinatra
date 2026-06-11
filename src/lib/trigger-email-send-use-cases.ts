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

export type TriggerEmailSendDeps = {
  getCampaign: (campaignId: string) => Promise<Campaign | null>;
  getDraftsByIds: (draftIds: string[]) => Promise<Draft[]>;
  sendEmail: (message: EmailMessage, options?: { userId?: string }) => Promise<EmailSendReceipt>;
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

async function runInitialSend(args: {
  input: {
    campaignId: string;
    approvedDraftBundleRef?: string;
    confirmedRecipientsRef?: string;
    senderEmail?: string;
  };
  actor: PrimitiveActorContext;
  sendEmail: TriggerEmailSendDeps["sendEmail"];
}): Promise<InitialSendStateRow> {
  const { input, actor, sendEmail } = args;
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
      fetchObjectsByRef(input.approvedDraftBundleRef, actor),
      fetchObjectsByRef(input.confirmedRecipientsRef, actor),
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

    let sentCount = 0;
    for (const draft of drafts) {
      const recipientEmail = recipientEmailFor(draft, recipients);
      if (!recipientEmail) continue;
      const subject = draft.subject ?? "(no subject)";
      const body = draft.body ?? draft.bodyHtml ?? "";
      await sendEmail(
        {
          to: [recipientEmail],
          subject,
          textBody: body,
          fromEmail: input.senderEmail,
        },
        { userId: actor.userId },
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
      },
      actor: PrimitiveActorContext,
    ): Promise<Record<string, unknown>> {
      const campaign = await deps.getCampaign(input.campaignId);
      if (!campaign) {
        throw new Error("Campaign not found.");
      }

      const draftIds = campaign.draftIds ?? [];
      // Defensively intersect any client-supplied draft id list with
      // the campaign's own draftIds before they reach `getDraftsByIds`. Today
      // `resolveDrafts` already filters against `allDrafts` (which is sourced
      // from `campaign.draftIds`), so this is belt-and-braces against a
      // future refactor that loosens `getDraftsByIds`'s input set and would
      // otherwise open a cross-campaign exfiltration vector.
      const campaignDraftIdSet = new Set(draftIds);
      const safeSpecificInitialDraftIds = input.specificInitialDraftIds?.filter((id) =>
        campaignDraftIdSet.has(id),
      );
      const allDrafts = await deps.getDraftsByIds(draftIds);
      const selected = resolveDrafts(
        allDrafts,
        input.selectionMode,
        safeSpecificInitialDraftIds,
      );
      if (selected.length === 0) {
        throw new Error("No test emails were selected to send.");
      }

      const fromEmail = campaign.senderEmail;
      const fromName = campaign.senderName;

      let sentCount = 0;
      for (const draft of selected) {
        await deps.sendEmail(
          {
            to: [input.recipientEmail],
            subject: `[Test] ${draft.subject}`,
            textBody: applyTokenReplacements(draft.body),
            fromName,
            fromEmail,
            replyTo: fromEmail,
          },
          { userId: actor.userId },
        );
        sentCount += 1;
      }

      return {
        ok: true,
        recipientEmail: input.recipientEmail,
        sentCount,
      };
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
      // The synchronous send path makes the worker a no-op. If we
      // re-introduce BullMQ background sending, this is
      // where the worker entry point lives.
      throw new Error("runInitialSendWorker is a no-op under the synchronous send path.");
    },

    async processDueFollowUps(_input, _actor) {
      // Follow-up scheduling is a separate concern and is not part of
      // the synchronous initial-send path.
      throw new Error("processDueFollowUps is not implemented under the synchronous send path.");
    },
  };
}
