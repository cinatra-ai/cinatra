import "server-only";

// Host email-system surfaces, dispatched over the `email-send` capability.
//
// Transport-registration cutover: this module imports NO email provider package. Every concrete
// provider registers an `EmailConnector` impl behind the `email-send`
// capability from its own `serverEntry`; this module resolves the live set via
// `@/lib/email-send-providers` and dispatches on:
//   - `definition.connectionScope === "user"` for the per-user mailbox surfaces
//     (the old hardcoded per-provider dispatch — now any per-user provider), and
//   - `definition.supportsSystemEmail` for the platform/purpose routing below.

import type { EmailConnectorDefinition } from "@cinatra-ai/sdk-extensions";
import {
  resolveEmailSendProviders,
  findEmailSendProvider,
  resolveHostEmailRouting,
} from "@/lib/email-send-providers";
import { getAuthSession } from "@/lib/auth-session";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import type { EmailReplyMatch, EmailSendReceipt, EmailSystemMessage } from "@/lib/types";

export type InstalledEmailConnectorStatus = EmailConnectorDefinition & {
  status: "connected" | "incomplete" | "not_connected";
  accountEmail?: string;
  detail?: string;
};

export type EmailSystemDevelopmentSettings = {
  developmentModeEnabled: boolean;
  overrideRecipientEmail: string;
};

const EMAIL_SYSTEM_DEVELOPMENT_SETTINGS_KEY = "email-system-development";

export function getEmailSystemDevelopmentSettings(): EmailSystemDevelopmentSettings {
  const stored = readConnectorConfigFromDatabase<Partial<EmailSystemDevelopmentSettings>>(EMAIL_SYSTEM_DEVELOPMENT_SETTINGS_KEY, {});
  return {
    developmentModeEnabled: stored.developmentModeEnabled === true,
    overrideRecipientEmail: String(stored.overrideRecipientEmail ?? "").trim(),
  };
}

export async function saveEmailSystemDevelopmentSettings(input: Partial<EmailSystemDevelopmentSettings>) {
  const current = getEmailSystemDevelopmentSettings();
  writeConnectorConfigToDatabase(EMAIL_SYSTEM_DEVELOPMENT_SETTINGS_KEY, {
    developmentModeEnabled: input.developmentModeEnabled ?? current.developmentModeEnabled,
    overrideRecipientEmail: String(input.overrideRecipientEmail ?? current.overrideRecipientEmail ?? "").trim(),
  });
}

async function resolveEmailSystemUserId(explicitUserId?: string) {
  if (explicitUserId) {
    return explicitUserId;
  }

  const session = await getAuthSession().catch(() => null);
  return typeof session?.user?.id === "string" ? session.user.id : undefined;
}

function applyDevelopmentRecipientOverride(message: EmailSystemMessage): EmailSystemMessage {
  const settings = getEmailSystemDevelopmentSettings();
  if (!settings.developmentModeEnabled) {
    return message;
  }
  if (!settings.overrideRecipientEmail) {
    throw new Error("Development mode is enabled, but no override recipient email is configured.");
  }

  return {
    ...message,
    to: [settings.overrideRecipientEmail],
    cc: [],
    bcc: [],
  };
}

// Per-user mailbox surfaces. Eligibility is an EXPLICIT definition bit
// (`connectionScope: "user"`), never inferred from getStatus(): an
// instance-level transport (e.g. resend) must not be auto-picked as a user's
// personal mailbox even when its instance credentials report "connected".
function perUserEmailSendProviders() {
  return resolveEmailSendProviders().filter(
    (p) => p.definition.connectorId && p.definition.connectionScope === "user",
  );
}

export async function listInstalledEmailConnectorStatuses(options?: { userId?: string }): Promise<InstalledEmailConnectorStatus[]> {
  const userId = await resolveEmailSystemUserId(options?.userId);
  const out: InstalledEmailConnectorStatus[] = [];
  for (const provider of perUserEmailSendProviders()) {
    try {
      const status = await provider.getStatus({ userId });
      out.push({
        ...provider.definition,
        status: status.status,
        accountEmail: status.accountEmail,
        detail: status.detail,
      });
    } catch (err) {
      out.push({
        ...provider.definition,
        status: "not_connected",
        detail: err instanceof Error ? err.message : "Status check failed.",
      });
    }
  }
  return out;
}

export async function getActiveEmailConnectorStatus(options?: { userId?: string }): Promise<InstalledEmailConnectorStatus | null> {
  const connectors = await listInstalledEmailConnectorStatuses(options);
  return connectors.find((connector) => connector.status === "connected") ?? null;
}

export async function sendEmailThroughSystem(message: EmailSystemMessage, options?: { userId?: string }): Promise<EmailSendReceipt> {
  const effectiveMessage = applyDevelopmentRecipientOverride(message);
  const userId = await resolveEmailSystemUserId(options?.userId);
  const activeConnector = await getActiveEmailConnectorStatus({ userId });
  if (!activeConnector) {
    throw new Error("No connected email connector is available.");
  }

  if (effectiveMessage.fromEmail && activeConnector.supportsCustomFrom === false) {
    throw new Error(`${activeConnector.name} does not support sending from a campaign-defined sender email.`);
  }

  const provider = findEmailSendProvider(activeConnector.connectorId);
  if (!provider) {
    throw new Error(`Unsupported email connector: ${activeConnector.connectorId}`);
  }
  return provider.send(effectiveMessage, { userId });
}

export async function findReplyInEmailThread(input: {
  providerThreadId?: string;
  recipientEmail: string;
  sentAfter?: string;
  userId?: string;
}): Promise<EmailReplyMatch | null> {
  const userId = await resolveEmailSystemUserId(input.userId);
  const activeConnector = await getActiveEmailConnectorStatus({ userId });
  if (!activeConnector || !input.providerThreadId) {
    return null;
  }

  const provider = findEmailSendProvider(activeConnector.connectorId);
  if (!provider) {
    return null;
  }
  return provider.findReply({
    providerThreadId: input.providerThreadId,
    recipientEmail: input.recipientEmail,
    sentAfter: input.sentAfter,
    userId,
  });
}

// ---------------------------------------------------------------------------
// Email purpose routing (instance-level provider assignment)
//
// Distinct from the per-user business-email path above. Some emails are sent
// by Cinatra ITSELF (password reset, email verification, change-email
// confirmation) — pre-auth, no user session, no org actor. Those go through
// the resolved provider with an EXPLICIT connectorId chosen here, NOT
// through getActiveEmailConnectorStatus (which resolves a per-user connection).
//
// The operator assigns a provider to each purpose at /connectors/email; a
// provider is only eligible if its instance-level getStatus() === "connected"
// (which excludes per-user OAuth providers like gmail that have no instance
// identity at send time).
// ---------------------------------------------------------------------------

export const EMAIL_PURPOSES = [
  {
    id: "platform",
    label: "Platform & transactional",
    description:
      "Emails Cinatra sends on its own behalf: password reset, email verification, and change-email confirmation. Requires an instance-level provider (e.g. Resend).",
    // Only providers with supportsSystemEmail are eligible — a per-user OAuth
    // provider (gmail) cannot send these pre-auth emails even if its
    // getStatus() reports connected from app-level config.
    requiresSystemEmail: true,
  },
] as const;

export type EmailPurpose = (typeof EMAIL_PURPOSES)[number]["id"];

const EMAIL_ROUTING_KEY = "email_routing";
type EmailRouting = Partial<Record<EmailPurpose, string>>;

export function getEmailRouting(): EmailRouting {
  return readConnectorConfigFromDatabase<EmailRouting>(EMAIL_ROUTING_KEY, {});
}

export function setEmailPurposeProvider(purpose: EmailPurpose, connectorId: string | null): void {
  const next: EmailRouting = { ...getEmailRouting() };
  if (connectorId) {
    next[purpose] = connectorId;
  } else {
    delete next[purpose];
  }
  writeConnectorConfigToDatabase(EMAIL_ROUTING_KEY, next);
}

export type EmailProviderStatus = {
  connectorId: string;
  name: string;
  description: string;
  settingsHref: string;
  status: "connected" | "incomplete" | "not_connected";
  detail?: string;
  accountEmail?: string;
  /** Whether this provider can serve platform/system mail (instance-level). */
  supportsSystemEmail: boolean;
};

// Instance-level status (NO userId) for every registered connector — used by
// the /connectors/email hub to show which providers are connected vs. need
// configuration.
export async function listEmailProvidersWithStatus(): Promise<EmailProviderStatus[]> {
  const connectors = resolveEmailSendProviders();
  const out: EmailProviderStatus[] = [];
  for (const connector of connectors) {
    let status: { status: "connected" | "incomplete" | "not_connected"; detail?: string; accountEmail?: string };
    try {
      status = await connector.getStatus();
    } catch (err) {
      status = {
        status: "not_connected",
        detail: err instanceof Error ? err.message : "Status check failed.",
      };
    }
    out.push({
      connectorId: connector.definition.connectorId,
      name: connector.definition.name,
      description: connector.definition.description,
      settingsHref: connector.definition.settingsHref,
      status: status.status,
      detail: status.detail,
      accountEmail: status.accountEmail,
      supportsSystemEmail: connector.definition.supportsSystemEmail === true,
    });
  }
  return out;
}

// Resolve the effective provider for a purpose: explicit assignment first,
// else fall back to the single connected instance-level provider so a fresh
// install with exactly one configured provider (e.g. Resend) works without a
// manual routing step. Returns null when nothing is connected.
async function resolvePurposeConnectorId(purpose: EmailPurpose): Promise<string | null> {
  const purposeDef = EMAIL_PURPOSES.find((p) => p.id === purpose);
  const requiresSystemEmail = purposeDef?.requiresSystemEmail === true;
  const assigned = getEmailRouting()[purpose];
  const providers = await listEmailProvidersWithStatus();

  // Eligible = connected AND (if the purpose needs it) instance-level capable.
  // The capability gate is what excludes per-user OAuth providers (gmail) from
  // platform mail regardless of what their getStatus() reports.
  const eligible = providers.filter(
    (p) => p.status === "connected" && (!requiresSystemEmail || p.supportsSystemEmail),
  );

  if (assigned) {
    return eligible.some((p) => p.connectorId === assigned) ? assigned : null;
  }
  return eligible.length === 1 ? eligible[0].connectorId : null;
}

// Send a platform/system email through the chosen provider for the "platform"
// purpose. Text-only by design (the EmailSystemMessage contract is text-only,
// and plaintext auth links maximize deliverability + minimize phishing surface).
// Dispatches DIRECTLY on the resolved provider with the same dev-mode override
// + best-effort sent-email object write the email facade applies (resolved from
// the shared host routing service so the two paths cannot drift).
export async function sendPlatformEmail(input: {
  to: string | string[];
  subject: string;
  text: string;
}): Promise<EmailSendReceipt> {
  const connectorId = await resolvePurposeConnectorId("platform");
  if (!connectorId) {
    throw new Error(
      "No connected email provider is assigned to platform mail. " +
        "Configure one at /connectors/email (and the provider itself at /connectors/<provider>).",
    );
  }
  const provider = findEmailSendProvider(connectorId);
  if (!provider) {
    throw new Error(`Email provider "${connectorId}" is not registered.`);
  }
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const routing = resolveHostEmailRouting();
  const msg: EmailSystemMessage = { to, subject: input.subject, textBody: input.text };
  const effective = routing
    ? routing.applyDevModeOverride(msg)
    : applyDevelopmentRecipientOverride(msg);
  const receipt = await provider.send(effective);
  if (routing?.saveSentEmailObject) {
    void routing
      .saveSentEmailObject({ msg: effective, receipt, routing: { connectorId } })
      .catch(() => {
        /* best-effort — the send already succeeded */
      });
  }
  return receipt;
}
