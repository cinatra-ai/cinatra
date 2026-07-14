import "server-only";

/**
 * Server helpers for the persisted accent colour.
 *
 * Two surfaces:
 *   - `public."user".accent_color`       → per-user Avatar accent
 *   - `cinatra.extension_accent_color`   → per-extension ExtensionCard accent
 *
 * Better Auth `user` lives in the public schema and is pooled through
 * `betterAuthPool`. The cinatra-schema lookup table is pooled through
 * the generic cinatra pool exported by `@/lib/drizzle-store`. Each
 * function uses ONE pool to avoid cross-pool transaction confusion.
 *
 * All values are validated against `EXTENSION_ACCENTS` on read (defence
 * in depth: the DB CHECK constraint already enforces the union, but a
 * future hand-edit or a partial migration could still leave a bad value
 * in the column).
 */

import { betterAuthPool } from "@/lib/better-auth-db";
import { projectsPool } from "@/lib/projects-store";
import {
  asExtensionAccent,
  type ExtensionAccent,
} from "@/lib/extension-accent";

const CINATRA_SCHEMA = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replace(
  /[^A-Za-z0-9_]/g,
  "",
);
const EXT_ACCENT_TABLE = `"${CINATRA_SCHEMA}".extension_accent_color`;

/**
 * Process-memoised guard: does `public."user".accent_color` exist in the live
 * DB? The column is declared by the `accentColor` Better Auth additionalField
 * (src/lib/better-auth-schema.ts) and provisioned by the bootstrap migration
 * runner via `getMigrations().toBeAdded` — on BOTH fresh and existing tables —
 * when `pnpm auth:migrate` / `make setup` runs. But a deployment provisioned
 * before that field landed and not yet re-migrated still lacks the column;
 * issuing the read there parses-and-fails, logging `column "accent_color" does
 * not exist` in Postgres on every authenticated render (cinatra#1497). The
 * layout's `.catch(() => null)` swallows the JS error but the query still hits
 * — and is logged by — Postgres. Preflighting the column (cached) skips the
 * doomed query entirely, so no error is logged. Mirrors the `information_schema`
 * existence-guard pattern already used in `src/lib/auth.ts`.
 */
let userAccentColumnPresent: Promise<boolean> | null = null;

function userAccentColorColumnExists(): Promise<boolean> {
  if (userAccentColumnPresent) return userAccentColumnPresent;
  const probe = betterAuthPool
    .query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'user'
           AND column_name = 'accent_color'
       ) AS exists`,
    )
    .then((result) => Boolean(result.rows[0]?.exists))
    .catch(() => {
      // A transient DB/connection failure must NOT poison the cache: clear the
      // memo (only if we're still the current probe) so the next call retries.
      // Treat this call as "absent" — fail-soft to the muted-ground default.
      if (userAccentColumnPresent === probe) userAccentColumnPresent = null;
      return false;
    });
  userAccentColumnPresent = probe;
  return probe;
}

/** Read the persisted Avatar accent for a user, or null if unset. */
export async function getUserAccentColor(
  userId: string,
): Promise<ExtensionAccent | null> {
  if (!userId) return null;
  // Skip the read on installs where the column has not been provisioned yet —
  // otherwise every render fires a query Postgres logs as failing (cinatra#1497).
  if (!(await userAccentColorColumnExists())) return null;
  const result = await betterAuthPool.query<{ accent_color: string | null }>(
    `SELECT accent_color FROM public."user" WHERE id = $1`,
    [userId],
  );
  if (result.rowCount === 0) return null;
  return asExtensionAccent(result.rows[0]?.accent_color ?? null);
}

/** Persist the Avatar accent for a user. Throws on invalid accent. */
export async function setUserAccentColor(
  userId: string,
  accent: ExtensionAccent,
): Promise<void> {
  if (!userId) throw new Error("setUserAccentColor: userId is required");
  if (!asExtensionAccent(accent)) {
    throw new Error(`setUserAccentColor: invalid accent '${accent}'`);
  }
  // Same guard as the read: on an un-migrated install the column is absent, so
  // fail-soft (warn + no-op) instead of throwing a raw `column ... does not
  // exist`. Re-run `auth:migrate` to provision it, then the write persists.
  if (!(await userAccentColorColumnExists())) {
    console.warn(
      '[accent-color-store] public."user".accent_color is absent; ' +
        "skipping setUserAccentColor. Run `pnpm auth:migrate` to provision it.",
    );
    return;
  }
  await betterAuthPool.query(
    `UPDATE public."user" SET accent_color = $1 WHERE id = $2`,
    [accent, userId],
  );
}

/** Read the persisted ExtensionCard accent for an extension instance. */
export async function getExtensionAccentColor(
  extensionId: string,
): Promise<ExtensionAccent | null> {
  if (!extensionId) return null;
  const result = await projectsPool.query<{ accent_color: string | null }>(
    `SELECT accent_color FROM ${EXT_ACCENT_TABLE} WHERE extension_id = $1`,
    [extensionId],
  );
  if (result.rowCount === 0) return null;
  return asExtensionAccent(result.rows[0]?.accent_color ?? null);
}

/** Persist the ExtensionCard accent for an extension instance (upsert). */
export async function setExtensionAccentColor(
  extensionId: string,
  accent: ExtensionAccent,
): Promise<void> {
  if (!extensionId) {
    throw new Error("setExtensionAccentColor: extensionId is required");
  }
  if (!asExtensionAccent(accent)) {
    throw new Error(`setExtensionAccentColor: invalid accent '${accent}'`);
  }
  await projectsPool.query(
    `INSERT INTO ${EXT_ACCENT_TABLE} (extension_id, accent_color, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (extension_id) DO UPDATE
       SET accent_color = EXCLUDED.accent_color,
           updated_at   = now()`,
    [extensionId, accent],
  );
}
