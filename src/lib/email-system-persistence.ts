import "server-only";

// ---------------------------------------------------------------------------
// Host-side email send-events ledger.
//
// Append-only Postgres ledger of every email send attempt. Two read paths:
//   - Cooldown filter for recipient-selection: "which of these emails were
//     sent within the last N days?"
//   - Per-run results for the outreach orchestrator's results tab.
//
// This host-local module is the live persistence boundary for email send
// events. The workspace email asset package is intentionally not connected
// to the live email pipeline.
// ---------------------------------------------------------------------------

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

export type EmailSendEventStatus =
  | "attempted"
  | "sent"
  | "skipped"
  | "failed"
  | "replied";

export type EmailSendEvent = {
  id: string;
  orgId: string;
  agentPackageName: string;
  agentTemplateId: string;
  campaignId: string | null;
  channel: string;
  recipientEmailNormalized: string;
  contactId: string | null;
  runId: string;
  status: EmailSendEventStatus;
  providerSendId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
};

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Returns the set of recipient emails (normalized) that were sent to within
 * the cooldown window for the given org. Used by recipient-selection HITL
 * to display "N contacts filtered (last sent within N days)" + a toggle.
 *
 * Default cooldown 30 days; configurable via cinatra.json
 * (`limits.cooldownDays`).
 */
export function findRecentlySentRecipients(input: {
  orgId: string;
  candidateEmails: string[];
  cooldownDays?: number;
}): { recentEmails: Set<string>; lastSentByEmail: Map<string, string> } {
  if (input.candidateEmails.length === 0) {
    return { recentEmails: new Set(), lastSentByEmail: new Map() };
  }
  const cooldownDays = input.cooldownDays ?? 30;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const normalized = Array.from(
    new Set(input.candidateEmails.map(normalizeRecipientEmail)),
  );
  const placeholders = normalized.map((_, i) => `$${i + 3}`).join(",");

  const [result] = runPostgresQueriesSync({
    connectionString: connectionString,
    queries: [
      {
        text: `SELECT recipient_email_normalized, MAX(created_at) AS last_sent_at
               FROM "${schema.replaceAll('"', '""')}"."email_send_events"
               WHERE org_id = $1
                 AND status IN ('sent', 'attempted')
                 AND created_at > now() - ($2 || ' days')::interval
                 AND recipient_email_normalized IN (${placeholders})
               GROUP BY recipient_email_normalized`,
        values: [input.orgId, String(cooldownDays), ...normalized],
      },
    ],
  });

  const recentEmails = new Set<string>();
  const lastSentByEmail = new Map<string, string>();
  const rows = (result?.rows ?? []) as Array<{
    recipient_email_normalized: string;
    last_sent_at: string;
  }>;
  for (const row of rows) {
    recentEmails.add(row.recipient_email_normalized);
    lastSentByEmail.set(row.recipient_email_normalized, row.last_sent_at);
  }
  return { recentEmails, lastSentByEmail };
}

/**
 * Append a send event. Idempotent on idempotencyKey via the UNIQUE constraint
 * — duplicate writes from the send executor (twin-fire after retry) are
 * silently dropped via ON CONFLICT DO NOTHING.
 */
export function recordEmailSendEvent(event: {
  orgId: string;
  agentPackageName: string;
  agentTemplateId: string;
  campaignId: string | null;
  recipientEmail: string;
  contactId: string | null;
  runId: string;
  status: EmailSendEventStatus;
  providerSendId: string | null;
  idempotencyKey: string | null;
}): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  runPostgresQueriesSync({
    connectionString: connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."email_send_events"
               (org_id, agent_package_name, agent_template_id, campaign_id,
                recipient_email_normalized, contact_id, run_id, status,
                provider_send_id, idempotency_key)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (idempotency_key) DO NOTHING`,
        values: [
          event.orgId,
          event.agentPackageName,
          event.agentTemplateId,
          event.campaignId,
          normalizeRecipientEmail(event.recipientEmail),
          event.contactId,
          event.runId,
          event.status,
          event.providerSendId,
          event.idempotencyKey,
        ],
      },
    ],
  });
}

/**
 * Per-run summary for the outreach orchestrator's results tab.
 */
export function listSendEventsForRun(input: { runId: string }): EmailSendEvent[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString: connectionString,
    queries: [
      {
        text: `SELECT id, org_id, agent_package_name, agent_template_id, campaign_id,
                      channel, recipient_email_normalized, contact_id, run_id, status,
                      provider_send_id, idempotency_key, created_at
               FROM "${schema.replaceAll('"', '""')}"."email_send_events"
               WHERE run_id = $1
               ORDER BY created_at DESC`,
        values: [input.runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    agentPackageName: String(r.agent_package_name),
    agentTemplateId: String(r.agent_template_id),
    campaignId: r.campaign_id == null ? null : String(r.campaign_id),
    channel: String(r.channel),
    recipientEmailNormalized: String(r.recipient_email_normalized),
    contactId: r.contact_id == null ? null : String(r.contact_id),
    runId: String(r.run_id),
    status: String(r.status) as EmailSendEventStatus,
    providerSendId: r.provider_send_id == null ? null : String(r.provider_send_id),
    idempotencyKey: r.idempotency_key == null ? null : String(r.idempotency_key),
    createdAt: String(r.created_at),
  }));
}
