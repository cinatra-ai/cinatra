/**
 * Open registration for an end-to-end harness.
 *
 * A fresh instance keeps registration CLOSED: the first account is admitted on
 * the bootstrap exception, and every account after that is refused. Harnesses
 * that mint more than one account — or that mint one on an instance another
 * suite already seeded — therefore have to open the instance first, and say so.
 * That is all this does, and every suite that goes through the public sign-up
 * road calls it before its first sign-up.
 *
 * It is a READ-MODIFY-WRITE on the single instance settings row: every sibling
 * setting on that row survives, so calling this never silently reconfigures the
 * instance a suite runs on. An unreadable or garbled row is replaced with a row
 * that carries just this one setting, which is the only sensible reading of "we
 * could not tell what was there".
 *
 * The application caches this row for a few seconds, so after an actual change
 * the helper waits the cache out — otherwise the first sign-up can still meet
 * the value the application read a moment earlier. When nothing changed (the
 * common case on a re-run) there is nothing to wait for.
 *
 * This is a harness step, not product code: it does not seed accounts and does
 * not touch anything a fixture owns.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

/** The one settings row the registration setting lives on. */
const INSTANCE_IDENTITY_KEY = "connector_config:instance_identity";

/** How long the application holds this row before reading it again. */
const READ_CACHE_MS = 10_000;

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

export type OpenRegistrationOptions = {
  /** Defaults to the same connection string the harnesses resolve. */
  databaseUrl?: string;
  /** Defaults to the same schema the harnesses resolve. */
  schema?: string;
  /** Off only in this helper's own unit tests, which have no cache to wait for. */
  waitOutReadCache?: boolean;
};

export async function openRegistrationForFixtures(
  options: OpenRegistrationOptions = {},
): Promise<void> {
  const envLocal = readEnvLocal();
  const databaseUrl =
    options.databaseUrl ??
    process.env.SUPABASE_DB_URL ??
    envLocal.SUPABASE_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
  const schema = options.schema ?? process.env.SUPABASE_SCHEMA ?? envLocal.SUPABASE_SCHEMA ?? "cinatra";
  const waitOutReadCache = options.waitOutReadCache !== false;

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let changed = false;
  await client.connect();
  try {
    const existing = await client.query<{ value: string | null }>(
      `SELECT value FROM "${schema}"."metadata" WHERE key = $1 LIMIT 1`,
      [INSTANCE_IDENTITY_KEY],
    );

    let settings: Record<string, unknown> = {};
    const raw = existing.rowCount ? existing.rows[0]?.value : null;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        settings = {};
      }
    }

    if (settings.closedRegistration === false) return;

    await client.query(
      `INSERT INTO "${schema}"."metadata" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [INSTANCE_IDENTITY_KEY, JSON.stringify({ ...settings, closedRegistration: false })],
    );
    changed = true;
  } finally {
    await client.end();
  }

  if (changed && waitOutReadCache) {
    await new Promise((done) => setTimeout(done, READ_CACHE_MS + 500));
  }
}
