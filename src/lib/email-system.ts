import "server-only";

import type { EmailConnectorDefinition } from "@cinatra-ai/sdk-extensions";
import {
  findGmailReplyInThread,
  getGmailConnectorStatus,
  gmailAPIConnector,
  sendGmailMessage,
} from "@cinatra-ai/gmail-connector";
import {
  listInstalledEmailConnectors,
  sendEmailThroughSystem as sendThroughEmailFacade,
} from "@cinatra-ai/email-connector";
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

export async function listInstalledEmailConnectorStatuses(options?: { userId?: string }): Promise<InstalledEmailConnectorStatus[]> {
  const userId = await resolveEmailSystemUserId(options?.userId);
  const gmailStatus = await getGmailConnectorStatus(userId);
  return [
    {
      ...gmailAPIConnector,
      status: gmailStatus.status,
      accountEmail: gmailStatus.accountEmail,
      detail: gmailStatus.detail,
    },
  ];
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

  if (activeConnector.connectorId === "gmail") {
    return sendGmailMessage(effectiveMessage, { userId });
  }

  throw new Error(`Unsupported email connector: ${activeConnector.connectorId}`);
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

  if (activeConnector.connectorId === "gmail") {
    return findGmailReplyInThread({
      ...input,
      userId,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Email purpose routing (instance-level provider assignment)
//
// Distinct from the per-user business-email path above. Some emails are sent
// by Cinatra ITSELF (password reset, email verification, change-email
// confirmation) — pre-auth, no user session, no org actor. Those go through
// the provider-neutral facade with an EXPLICIT connectorId chosen here, NOT
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
  const connectors = listInstalledEmailConnectors();
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
  const to = Array.isArray(input.to) ? input.to : [input.to];
  return sendThroughEmailFacade(
    { to, subject: input.subject, textBody: input.text },
    { connectorId },
  );
}

