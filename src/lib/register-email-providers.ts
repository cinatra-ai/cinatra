import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for @cinatra-ai/email-connector.
//
// Imported at boot to:
//   1. Configure the email-connector facade with host-side routing +
//      dev-mode override impls (host knows the database; facade does not).
//   2. Register every concrete EmailConnector provider (gmail today;
//      future smtp/ses/outlook providers add their registerEmailConnector
//      calls here).
//
// After this module loads, `sendEmailThroughSystem(msg)` from any caller
// (workspace package or host) routes via the registered provider with
// dev-mode override applied centrally.
// ---------------------------------------------------------------------------

import {
  configureEmailSystem,
  registerEmailConnector,
  emailConnectorRegistry,
  type EmailSystemMessage,
} from "@cinatra-ai/email-connector";
import { gmailEmailConnector } from "@cinatra-ai/gmail-connector";
import { resendEmailConnector, getResendStatus } from "@cinatra-ai/resend-connector";
import { readConnectorConfigFromDatabase } from "@/lib/database";
import { createSessionObjectsClient } from "@cinatra-ai/objects";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

/**
 * These sender-identity reads run on a system/registration path with no user
 * session. Build an org-scoped, ROLE-LESS System actor —
 * `principalType:"System"` + `organizationId` only, no platform/org role —
 * so reads cannot widen beyond the intended org-scoped client behavior.
 * Owner-scoping of the result stays explicit in `findSenderIdentityFor` via
 * `data.ownerLevel`/`data.ownerId`.
 */
function systemActorForOrg(orgId: string | null): ActorContext {
  return {
    principalType: "System",
    principalId: "system",
    ...(orgId ? { organizationId: orgId } : {}),
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Routing resolver
// ---------------------------------------------------------------------------

const SENDER_IDENTITY_TYPE = "@cinatra-ai/email:sender-identity";

type SenderIdentityData = {
  connectorId?: string;
  fromEmail?: string;
  ownerLevel?: "user" | "team" | "organization" | "workspace";
  ownerId?: string;
};

/**
 * List sender-identity objects scoped to a given owner. Uses the
 * deterministic objects client (read-only, no actor required for orgId-
 * scoped reads). Returns parsed-data identities; non-matching rows
 * filtered out client-side because `objects_list` only filters by type +
 * category, not by `data.<field>`. This is acceptable because
 * sender-identity record counts are expected to be small per org.
 */
// A user/org realistically has 1-3 sender-identity objects, but OTHER-owner
// sender-identity records share the same type and could push the target past a
// small page. Bump the page budget so the client-side owner filter doesn't miss
// a valid identity behind unrelated rows. (Server-side data.<field> filtering
// isn't exposed by objects_list; promoting to a structured filter is a
// future-scale TODO.)
const SENDER_IDENTITY_PAGE_BUDGET = 200;

async function findSenderIdentityFor(opts: {
  ownerLevel: "user" | "organization";
  ownerId: string;
  orgId?: string;
}): Promise<SenderIdentityData | null> {
  try {
    const client = createSessionObjectsClient(systemActorForOrg(opts.orgId ?? null));
    const { items } = await client.list({
      type: SENDER_IDENTITY_TYPE,
      limit: SENDER_IDENTITY_PAGE_BUDGET,
    });
    for (const item of items as Array<{ data?: Record<string, unknown> }>) {
      const data = item.data as SenderIdentityData | undefined;
      if (!data) continue;
      if (data.ownerLevel === opts.ownerLevel && data.ownerId === opts.ownerId) {
        if (typeof data.connectorId === "string" && data.connectorId.length > 0) {
          return data;
        }
      }
    }
    return null;
  } catch (err) {
    // This is an AUTO-resolve step (the caller did NOT explicitly pick this
    // identity) so a best-effort fall-through to the next chain step is
    // correct, but it must NOT be silent. A transient objects-layer failure
    // that routes to the org/first-registered connector is operationally
    // significant; surface it.
    console.warn(
      `[email-connector] sender-identity auto-resolve failed for ${opts.ownerLevel}:${opts.ownerId} ` +
        `(falling through to next routing step): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * When the caller EXPLICITLY passes a senderIdentityId, a lookup ERROR must NOT
 * silently route to a different connector — that would send from the wrong
 * identity, a correctness bug.
 * Distinguish:
 *   - genuine not-found / no-connector → return null (chain falls through;
 *     the explicit id was stale, next step is acceptable)
 *   - real lookup error (permission / backend / schema) → THROW so the send
 *     fails loudly rather than mis-routing.
 */
async function resolveSenderIdentityById(
  senderIdentityId: string,
  orgId?: string,
): Promise<SenderIdentityData | null> {
  let obj: unknown;
  try {
    const client = createSessionObjectsClient(systemActorForOrg(orgId ?? null));
    obj = await client.get(senderIdentityId);
  } catch (err) {
    throw new Error(
      `Explicit senderIdentityId "${senderIdentityId}" could not be resolved ` +
        `(refusing to mis-route to a fallback connector): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = (obj as { data?: Record<string, unknown> } | null)?.data as
    | SenderIdentityData
    | undefined;
  if (!data) return null; // genuinely not found → chain may fall through
  return typeof data.connectorId === "string" && data.connectorId.length > 0
    ? data
    : null;
}

/**
 * Routing chain:
 *   1. Explicit `connectorId` if caller passed one (no DB / object lookup)
 *   2. Explicit `senderIdentityId` → `objects_get` → identity's connectorId
 *   3. `userId` → first @cinatra-ai/email:sender-identity object owned by user
 *   4. `orgId` → first @cinatra-ai/email:sender-identity object owned by org
 *   5. Fallback → first registered connector
 *
 * Fall-through semantics:
 *   - Step 2 (EXPLICIT senderIdentityId): genuine not-found → fall through
 *     to step 3; a real lookup error → THROW (refuse to mis-route from an
 *     explicitly-chosen identity to a fallback connector).
 *   - Steps 3-4 (AUTO-resolve user/org): any failure → warn + fall through
 *     (the caller did not pick these; best-effort is correct here).
 *   - Step 5: first registered connector from the registry.
 */
async function resolveConnectorId(opts: {
  explicitConnectorId?: string;
  senderIdentityId?: string;
  userId?: string;
  orgId?: string;
}): Promise<string> {
  if (opts.explicitConnectorId) {
    return opts.explicitConnectorId;
  }

  if (opts.senderIdentityId) {
    const id = await resolveSenderIdentityById(opts.senderIdentityId, opts.orgId);
    if (id?.connectorId) return id.connectorId;
  }

  if (opts.userId) {
    const userId = await findSenderIdentityFor({
      ownerLevel: "user",
      ownerId: opts.userId,
      orgId: opts.orgId,
    });
    if (userId?.connectorId) return userId.connectorId;
  }

  if (opts.orgId) {
    const orgId = await findSenderIdentityFor({
      ownerLevel: "organization",
      ownerId: opts.orgId,
      orgId: opts.orgId,
    });
    if (orgId?.connectorId) return orgId.connectorId;
  }

  const first = emailConnectorRegistry.listAll()[0];
  if (!first) {
    throw new Error(
      "No email connector is registered. Add a `registerEmailConnector(...)` call in src/lib/register-email-providers.ts.",
    );
  }
  return first.definition.connectorId;
}

// ---------------------------------------------------------------------------
// Dev-mode recipient override
// ---------------------------------------------------------------------------

const DEV_OVERRIDE_KEY = "email-system-development";

function applyDevModeOverride(msg: EmailSystemMessage): EmailSystemMessage {
  const settings = readConnectorConfigFromDatabase<{
    developmentModeEnabled?: boolean;
    overrideRecipientEmail?: string;
  }>(DEV_OVERRIDE_KEY, {});
  if (settings.developmentModeEnabled !== true) return msg;
  const override = String(settings.overrideRecipientEmail ?? "").trim();
  if (!override) {
    throw new Error(
      "Development mode is enabled, but no override recipient email is configured.",
    );
  }
  return { ...msg, to: [override], cc: [], bcc: [] };
}

// ---------------------------------------------------------------------------
// Sent-email object writer
// ---------------------------------------------------------------------------

/**
 * Best-effort write of `@cinatra-ai/email:sent-email` after a successful
 * provider.send(). The facade calls this and swallows errors — the email
 * has already been delivered by this point, so failure here only loses
 * the semantic object record (the email_send_events audit row is still
 * written by the orchestration layer in trigger-email-send-use-cases.ts).
 *
 * Identity key on the @cinatra-ai/email:sent-email object type is
 * `idempotencyKey`. We synthesize it as
 * `email-send:<providerId>:<providerMessageId>` — a provider message id is
 * unique within a provider, so this is stable + collision-free across
 * recipients. The key does not include recipient and does not need to.
 */
async function saveSentEmailObject(input: {
  msg: import("@cinatra-ai/email-connector").EmailSystemMessage;
  receipt: import("@cinatra-ai/email-connector").EmailSendReceipt;
  routing: {
    connectorId: string;
    senderIdentityId?: string;
    userId?: string;
    orgId?: string;
  };
}): Promise<void> {
  // Defense-in-depth. The facade already wraps this callback in `.catch()`, but
  // a best-effort writer must be robust regardless of caller — never let an
  // objects-layer failure here surface as a thrown error to whatever invoked the
  // facade (the email was already delivered by the time this runs).
  try {
    const { objectsClient } = await import("@cinatra-ai/objects");
    const idempotencyKey =
      `email-send:${input.receipt.providerId}:${input.receipt.providerMessageId}`;
    await objectsClient.save({
      typeHint: "@cinatra-ai/email:sent-email",
      rawData: {
        auditId: idempotencyKey, // synthetic — standalone email_send path has no real audit row
        idempotencyKey,
        connectorId: input.routing.connectorId,
        fromEmail: input.msg.fromEmail,
        toEmail: input.msg.to[0] ?? "",
        subject: input.msg.subject,
        providerMessageId: input.receipt.providerMessageId,
        providerThreadId: input.receipt.providerThreadId,
        internetMessageId: input.receipt.internetMessageId,
        sentAt: input.receipt.sentAt,
      },
    });
  } catch (err) {
    console.warn(
      `[email-connector] sent-email object write failed (send already succeeded): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let _registered = false;

export function registerEmailProviders(): void {
  if (_registered) return;
  _registered = true;

  configureEmailSystem({
    resolveConnectorId,
    applyDevModeOverride,
    saveSentEmailObject,
  });

  registerEmailConnector(gmailEmailConnector);
  registerEmailConnector(resendEmailConnector);

  // Future providers register here:
  // registerEmailConnector(smtpEmailConnector);
  // registerEmailConnector(sesEmailConnector);

  // Boot summary (non-secret): confirms the registry actually populated and
  // surfaces why platform mail is/isn't routable in production. All imports in
  // THIS module use the "@cinatra-ai/*" package specifier (same as
  // email-system.ts), so the registry read here is the SAME singleton instance
  // the send path consumes — no dual-instance hazard. Logs registered connector
  // IDs + Resend instance status/detail + env-key presence (boolean only).
  try {
    const ids = emailConnectorRegistry.listAll().map((c) => c.definition.connectorId);
    const rs = getResendStatus();
    console.log(
      `[register-email-providers] boot: registry=[${ids.join(", ")}] ` +
        `resendStatus=${rs.status}${rs.detail ? ` (${rs.detail})` : ""} ` +
        `envKey=${Boolean(process.env.RESEND_API_KEY)}`,
    );
  } catch (err) {
    console.warn(
      `[register-email-providers] boot summary failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Auto-register on module load — boot paths import this module at startup
// (via instrumentation.node.ts or worker entrypoints).
registerEmailProviders();
