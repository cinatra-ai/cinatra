import "server-only";

// ---------------------------------------------------------------------------
// Package-level AGENT / ASSISTANT eligibility (cinatra#2346 S1, epic #2345).
//
// The write side of direct skill assignment has to answer two questions about a
// canonical package name, and both answers must come from AUTHORITATIVE data —
// never a `-agent` / `-assistant` name suffix, never template-shape inference:
//
//   * is it an AGENT-kind extension?  → `installed_extension.kind`.
//   * is it an ASSISTANT?             → the persisted assistant DECLARATION on
//     the canonical row (`installed_extension.assistant_declaration`, exactly
//     what `readAssistantRegistryForActor` joins on to build the registry) OR
//     the registry LINKAGE (`agent_templates.agent_kind = 'assistant'`).
//     Either one present is proof.
//
// Assistants are excluded because their injection branch ignores the
// recommendation channel this epic feeds: an assignment there could never be
// delivered, so accepting one would be a silent lie to the admin.
//
// The two tables are declared locally with ONLY the columns read here, the same
// convention `assistant-registry-reader.ts` uses for the core-store handles that
// `better-auth-db` does not export.
// ---------------------------------------------------------------------------

import { and, eq, isNotNull, or } from "drizzle-orm";
import { jsonb, pgSchema, text } from "drizzle-orm/pg-core";

import { betterAuthDb } from "@/lib/better-auth-db";

const CORE_STORE_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const coreStoreSchema = pgSchema(CORE_STORE_SCHEMA);

const agentTemplates = coreStoreSchema.table("agent_templates", {
  id: text("id").primaryKey(),
  packageName: text("package_name"),
  agentKind: text("agent_kind"),
});

const installedExtension = coreStoreSchema.table("installed_extension", {
  id: text("id").primaryKey(),
  packageName: text("package_name").notNull(),
  kind: text("kind"),
  status: text("status"),
  assistantDeclaration: jsonb("assistant_declaration"),
});

/** Minimal drizzle read surface (injectable — the default is `betterAuthDb`). */
type ReaderDb = Pick<typeof betterAuthDb, "select">;

/** Install states in which a row is live. Mirrors the install anchor. */
const LIVE_STATUSES = ["active", "locked"] as const;

/**
 * The canonical `cinatra.kind` for a package, from its `installed_extension`
 * rows. Prefers the LIVE rows; falls back to any row so an archived agent still
 * reads as an agent (the assignability predicate, not the kind gate, is what
 * refuses an archived target). `null` when there is no row, or when live rows
 * disagree — an ambiguous kind fails closed at the caller.
 */
export async function readCanonicalPackageKind(
  packageName: string,
  db: ReaderDb = betterAuthDb,
): Promise<string | null> {
  if (!packageName) return null;
  const rows = await db
    .select({ kind: installedExtension.kind, status: installedExtension.status })
    .from(installedExtension)
    .where(eq(installedExtension.packageName, packageName));
  if (rows.length === 0) return null;
  const live = rows.filter((r) => LIVE_STATUSES.includes(r.status as (typeof LIVE_STATUSES)[number]));
  const considered = live.length > 0 ? live : rows;
  const kinds = [...new Set(considered.map((r) => r.kind).filter((k): k is string => Boolean(k)))];
  return kinds.length === 1 ? kinds[0]! : null;
}

/**
 * Is this package an ASSISTANT? Authoritative: a persisted assistant
 * declaration on its canonical row, or an `agent_kind='assistant'` template
 * row. THROWS on a read failure so the caller can fail closed — "the read
 * broke" must never be reported as "not an assistant".
 */
export async function isAssistantPackageName(
  packageName: string,
  db: ReaderDb = betterAuthDb,
): Promise<boolean> {
  if (!packageName) return false;
  const [declared, linked] = await Promise.all([
    db
      .select({ id: installedExtension.id })
      .from(installedExtension)
      .where(
        and(
          eq(installedExtension.packageName, packageName),
          isNotNull(installedExtension.assistantDeclaration),
        ),
      )
      .limit(1),
    db
      .select({ id: agentTemplates.id })
      .from(agentTemplates)
      .where(
        and(
          eq(agentTemplates.packageName, packageName),
          or(eq(agentTemplates.agentKind, "assistant")),
        ),
      )
      .limit(1),
  ]);
  return declared.length > 0 || linked.length > 0;
}
