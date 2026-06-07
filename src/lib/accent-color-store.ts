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

/** Read the persisted Avatar accent for a user, or null if unset. */
export async function getUserAccentColor(
  userId: string,
): Promise<ExtensionAccent | null> {
  if (!userId) return null;
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
