import "server-only";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString } from "@/lib/database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantProfile = {
  assistantUserId: string;
  webhookUrl?: string;
  webhookSecret?: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let _schemaEnsured = false;

function ensureAssistantProfilesTable(): void {
  if (_schemaEnsured) return;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `CREATE TABLE IF NOT EXISTS assistant_profiles (
          id text PRIMARY KEY,
          payload jsonb NOT NULL
        )`,
      },
    ],
  });
  _schemaEnsured = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseProfile(payload: unknown): AssistantProfile | null {
  if (!payload || typeof payload !== "string") return null;
  try {
    return JSON.parse(payload) as AssistantProfile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// readAssistantProfile
// ---------------------------------------------------------------------------

export function readAssistantProfile(assistantUserId: string): AssistantProfile | null {
  ensureAssistantProfilesTable();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text: `SELECT payload FROM assistant_profiles WHERE id = $1`, values: [assistantUserId] }],
  });
  const row = result?.rows[0];
  if (!row) return null;
  const payload = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
  return safeParseProfile(payload);
}

// ---------------------------------------------------------------------------
// upsertAssistantProfile
// ---------------------------------------------------------------------------

export function upsertAssistantProfile(profile: AssistantProfile): void {
  ensureAssistantProfilesTable();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO assistant_profiles (id, payload)
               VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
        values: [profile.assistantUserId, JSON.stringify(profile)],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// deleteAssistantProfile
// ---------------------------------------------------------------------------

export function deleteAssistantProfile(assistantUserId: string): void {
  ensureAssistantProfilesTable();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text: `DELETE FROM assistant_profiles WHERE id = $1`, values: [assistantUserId] }],
  });
}
