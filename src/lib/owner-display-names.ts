import { sql } from "drizzle-orm";

import { betterAuthDb } from "@/lib/better-auth-db";
import { toPgTextArrayLiteral } from "@/lib/pg-array";

// ---------------------------------------------------------------------------
// Batch owner display-name resolution (cinatra#1905).
//
// The canonical <ScopeBadge> can name the owning entity ("TEAM — Best Team
// Ever"); this is the one place that turns (ownership level, owner id) into a
// display name. Extracted from the project detail page's inline lookups so
// every badge mount resolves names the same way.
//
// Contract:
//  - BATCH: callers pass every ref they have (a list page passes all rows);
//    ids are deduped and the resolver issues AT MOST ONE query per level.
//  - Best-effort PER LEVEL: a failing lookup degrades only that level's
//    names (the map simply lacks those keys → callers render today's
//    level-only badge). It never throws.
//  - `workspace` / `project` are never owner-name levels (workspace is
//    ambient; project is not an ownership tier) — such refs are ignored,
//    as are empty/whitespace ids.
// ---------------------------------------------------------------------------

export type OwnerNameLevel = "user" | "team" | "organization";

export type OwnerRef = {
  readonly level: OwnerNameLevel;
  readonly id: string;
};

/** Map key for a resolved owner name: `${level}:${id}`. */
export function ownerNameKey(level: OwnerNameLevel, id: string): string {
  return `${level}:${id}`;
}

const OWNER_NAME_LEVELS: ReadonlySet<string> = new Set(["user", "team", "organization"]);

export async function readOwnerDisplayNames(
  refs: readonly OwnerRef[],
): Promise<Map<string, string>> {
  const idsByLevel = new Map<OwnerNameLevel, Set<string>>();
  for (const ref of refs) {
    if (!ref || !OWNER_NAME_LEVELS.has(ref.level)) continue;
    const id = typeof ref.id === "string" ? ref.id.trim() : "";
    if (!id) continue;
    const set = idsByLevel.get(ref.level) ?? new Set<string>();
    set.add(id);
    idsByLevel.set(ref.level, set);
  }

  const out = new Map<string, string>();
  await Promise.all(
    [...idsByLevel.entries()].map(async ([level, idSet]) => {
      const ids = toPgTextArrayLiteral([...idSet]);
      try {
        if (level === "user") {
          const r = await betterAuthDb.execute<{
            id: string;
            name: string | null;
            email: string | null;
          }>(sql`
            SELECT id, name, email FROM public."user" WHERE id = ANY(${ids}::text[])
          `);
          for (const row of r.rows) {
            const name = row.name?.trim() || row.email?.trim() || "";
            if (name) out.set(ownerNameKey(level, row.id), name);
          }
          return;
        }
        const table = level === "team" ? sql.raw(`public."team"`) : sql.raw(`public."organization"`);
        const r = await betterAuthDb.execute<{ id: string; name: string | null }>(sql`
          SELECT id, name FROM ${table} WHERE id = ANY(${ids}::text[])
        `);
        for (const row of r.rows) {
          const name = row.name?.trim() ?? "";
          if (name) out.set(ownerNameKey(level, row.id), name);
        }
      } catch {
        // Per-level degrade: this level's names stay unresolved; the badge
        // renders level-only. Other levels are unaffected.
      }
    }),
  );
  return out;
}

/** Single-ref convenience over the batch read; null when unresolved. */
export async function readOwnerDisplayName(
  level: string,
  id: string,
): Promise<string | null> {
  if (!OWNER_NAME_LEVELS.has(level)) return null;
  const ownerLevel = level as OwnerNameLevel;
  const names = await readOwnerDisplayNames([{ level: ownerLevel, id }]);
  return names.get(ownerNameKey(ownerLevel, id)) ?? null;
}
