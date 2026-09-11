/**
 * State an instance setting an end-to-end harness depends on.
 *
 * A fresh instance keeps registration CLOSED: the first account is admitted on
 * the bootstrap exception, and every account after that is refused. Harnesses
 * that mint more than one account — or that mint one on an instance another
 * suite already seeded — therefore have to open the instance first, and say so.
 * A harness that wants to prove behaviour ON a closed instance says that just
 * as explicitly, with `closeRegistrationForFixtures`.
 *
 * Every road here is a READ-MODIFY-WRITE on the single instance settings row:
 * sibling settings survive, so stating one setting never silently reconfigures
 * the instance a suite runs on. That matters more than it looks: the settings
 * row carries several instance toggles, and a whole-row write DELETES the ones
 * it does not mention. A deleted `closedRegistration` key does not read as
 * "unchanged" — only an explicit `false` opens the door, so dropping the key
 * closes the instance behind whatever suite opened it. `patchInstanceSettings-
 * ForFixtures` is therefore the only road a suite should take to this row.
 *
 * An unreadable or garbled row is replaced with a row that carries just the
 * requested settings, which is the only sensible reading of "we could not tell
 * what was there".
 *
 * The application caches this row for a few seconds, so after an actual change
 * the helper waits the cache out — otherwise the next request can still meet
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

/**
 * Record `patch` on the instance settings row, preserving every key it does
 * not mention. Writes nothing when every key already holds the asked-for
 * value; waits the application read-cache out when it did write.
 */
export async function patchInstanceSettingsForFixtures(
  patch: Record<string, unknown>,
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

    // Nothing to do when the row already says what the caller wants. Skipping
    // the write also skips the cache wait, which is why a re-run is cheap.
    if (Object.entries(patch).every(([key, value]) => settings[key] === value)) return;

    await client.query(
      `INSERT INTO "${schema}"."metadata" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [INSTANCE_IDENTITY_KEY, JSON.stringify({ ...settings, ...patch })],
    );
    changed = true;
  } finally {
    await client.end();
  }

  if (changed && waitOutReadCache) {
    await new Promise((done) => setTimeout(done, READ_CACHE_MS + 500));
  }
}

/**
 * Open the public sign-up road. Every suite that signs a second account up
 * calls this before its first sign-up.
 */
export async function openRegistrationForFixtures(
  options: OpenRegistrationOptions = {},
): Promise<void> {
  await patchInstanceSettingsForFixtures({ closedRegistration: false }, options);
}

/**
 * Close the public sign-up road explicitly — the posture a real instance ships
 * with. A suite states this when the behaviour it proves only exists on a
 * closed instance, so the assertion cannot quietly pass on an open one.
 */
export async function closeRegistrationForFixtures(
  options: OpenRegistrationOptions = {},
): Promise<void> {
  await patchInstanceSettingsForFixtures({ closedRegistration: true }, options);
}
