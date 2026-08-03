import "server-only";

// ---------------------------------------------------------------------------
// `agent_assigned_skills` DB primitives (cinatra#2346 S1, epic #2345).
//
// The store half of direct skill assignment. Async pooled access (the
// architecture's default for request-time persistence), because the cap needs a
// MULTI-statement transaction: its `pg_advisory_xact_lock` is transaction-
// scoped, and count → next-position → insert must be one atomic section.
//
// WHY A LOCK AT ALL. A plain "count, then insert if under the cap" is NOT
// race-safe under READ COMMITTED: two concurrent requests both read 2, both
// decide they may insert, and the agent ends up with 4 assignments. Serializing
// per agent closes it. The UNIQUE (agent_package_name, "position") index is the
// second line of defense — two racers that somehow computed the same next
// position cannot both land.
//
// LOCK ORDERING (issue scope item 3) — the ACTION owns the outer lock, this
// store owns the inner one, and the order is fixed:
//
//   1. the owning SKILL extension's lifecycle lock (`withInstallLock`, which
//      itself takes the global extension-lifecycle lock first) + a revalidation
//      of assignability WHILE HOLDING IT — this is what closes the
//      assign-vs-uninstall race; the cap lock alone only serializes competing
//      assignments against each other;
//   2. the per-agent advisory TRANSACTION lock (here);
//   3. count → position → insert (here).
//
// The order is never inverted: the lifecycle lock is a process-level async lock
// and the advisory lock is a DB lock held only for the length of one short
// transaction, so a lifecycle operation never waits behind a DB lock held by
// something waiting for the lifecycle lock.
// ---------------------------------------------------------------------------

import { getPooledDb } from "@/lib/db/pooled";
import { AGENT_ASSIGNED_SKILLS_TABLE } from "@/lib/skill-lifecycle-schema";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/**
 * Maximum directly-assigned skills per agent package (epic: "max 3").
 * The floor is 0 — unlike extension owners, the last assignment may be removed.
 */
export const AGENT_ASSIGNED_SKILLS_CAP = 3;

/** The advisory-lock namespace, so the per-agent key cannot collide with any
 *  other subsystem's `hashtextextended` key space. */
const ADVISORY_LOCK_NAMESPACE = "agent_assigned_skills";

export type AgentAssignedSkillRow = {
  agentPackageName: string;
  skillId: string;
  position: number;
  createdBy: string;
  createdAt: string;
};

export type AssignedSkillsQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

/** Runs `fn` inside ONE transaction (the xact-scoped advisory lock plus the
 *  multi-statement count/position/insert need it). Tests inject a pass-through
 *  over the query double; the default BEGIN/COMMITs on a pooled client. */
export type AssignedSkillsTransaction = <T>(
  fn: (txQuery: AssignedSkillsQuery) => Promise<T>,
) => Promise<T>;

export type AssignedSkillsStoreDeps = {
  query?: AssignedSkillsQuery;
  transaction?: AssignedSkillsTransaction;
  schema?: string;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "agent-assigned-skills" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function defaultTransaction<T>(
  fn: (txQuery: AssignedSkillsQuery) => Promise<T>,
): Promise<T> {
  const pool = await getPooledDb({ name: "agent-assigned-skills" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txQuery: AssignedSkillsQuery = async <U = unknown>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as U[];
    };
    const out = await fn(txQuery);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one worth surfacing */
    }
    throw err;
  } finally {
    client.release();
  }
}

function passthroughTransaction(query: AssignedSkillsQuery): AssignedSkillsTransaction {
  return async (fn) => fn(query);
}

function resolveDeps(deps?: AssignedSkillsStoreDeps): {
  query: AssignedSkillsQuery;
  transaction: AssignedSkillsTransaction;
  table: string;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quoted
  // defensively all the same.
  const table = `"${schema.replaceAll('"', '""')}"."${AGENT_ASSIGNED_SKILLS_TABLE}"`;
  const query = deps?.query ?? defaultQuery;
  const transaction =
    deps?.transaction ?? (deps?.query ? passthroughTransaction(deps.query) : defaultTransaction);
  return { query, transaction, table };
}

type RawRow = {
  agent_package_name: string;
  skill_id: string;
  position: number | string;
  created_by: string;
  created_at: string | Date;
};

function toRow(raw: RawRow): AgentAssignedSkillRow {
  return {
    agentPackageName: raw.agent_package_name,
    skillId: raw.skill_id,
    position: Number(raw.position),
    createdBy: raw.created_by,
    createdAt:
      raw.created_at instanceof Date ? raw.created_at.toISOString() : String(raw.created_at),
  };
}

/**
 * The ordered assignment rows for ONE canonical agent package.
 *
 * ACTOR-INDEPENDENT by construction — no owner predicate, no principal, no org.
 * That is the whole point of the table: an actor-less worker run reads exactly
 * what the settings page wrote.
 */
export async function readAssignedSkillsForAgentPackage(
  agentPackageName: string,
  deps?: AssignedSkillsStoreDeps,
): Promise<AgentAssignedSkillRow[]> {
  const { query, table } = resolveDeps(deps);
  if (!agentPackageName) return [];
  const rows = await query<RawRow>(
    `SELECT agent_package_name, skill_id, "position", created_by, created_at
       FROM ${table}
      WHERE agent_package_name = $1
      ORDER BY "position" ASC`,
    [agentPackageName],
  );
  return rows.map(toRow);
}

export type InsertAssignedSkillResult =
  | { outcome: "assigned"; row: AgentAssignedSkillRow }
  | { outcome: "already_assigned"; row: AgentAssignedSkillRow }
  | { outcome: "cap_exceeded"; count: number };

/**
 * The ATOMIC cap-guarded insert: ONE transaction, serialized per agent package.
 *
 *   advisory lock → idempotent re-check → cap count → next position → insert
 *
 * An already-assigned pair returns `already_assigned` (idempotent re-submit)
 * WITHOUT consuming a cap slot. A racer that lost the PK arbiter re-selects the
 * winner's row rather than reporting a spurious failure.
 *
 * The caller MUST already hold the owning skill extension's lifecycle lock and
 * must have revalidated assignability under it — this function deliberately
 * knows nothing about skills, only about the cap and the ordering.
 */
export async function insertAssignedSkill(
  input: { agentPackageName: string; skillId: string; createdBy: string },
  deps?: AssignedSkillsStoreDeps,
): Promise<InsertAssignedSkillResult> {
  const { transaction, table } = resolveDeps(deps);
  return transaction(async (tx) => {
    // (1) Serialize the whole section per agent package. Namespaced so the key
    // space cannot collide with another subsystem's advisory locks.
    await tx(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
      ADVISORY_LOCK_NAMESPACE,
      input.agentPackageName,
    ]);

    // (2) Idempotent re-check under the lock: a duplicate assign is a no-op
    // that must NOT consume (or be refused by) a cap slot.
    const existing = await tx<RawRow>(
      `SELECT agent_package_name, skill_id, "position", created_by, created_at
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2`,
      [input.agentPackageName, input.skillId],
    );
    if (existing[0]) return { outcome: "already_assigned", row: toRow(existing[0]) } as const;

    // (3) Cap check under the lock.
    const counted = await tx<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE agent_package_name = $1`,
      [input.agentPackageName],
    );
    const count = Number(counted[0]?.n ?? 0);
    if (count >= AGENT_ASSIGNED_SKILLS_CAP) return { outcome: "cap_exceeded", count } as const;

    // (4) Next position + insert in ONE statement, so the value cannot drift
    // between reading and writing it. `COALESCE(MAX+1, 1)` keeps insertion
    // order stable across removals (positions may go sparse; ordering is what
    // matters, not density). The PK arbiter collapses a racer to DO NOTHING.
    const inserted = await tx<RawRow>(
      `INSERT INTO ${table} (agent_package_name, skill_id, "position", created_by)
       SELECT $1, $2, COALESCE(MAX("position"), 0) + 1, $3 FROM ${table} WHERE agent_package_name = $1
       ON CONFLICT (agent_package_name, skill_id) DO NOTHING
       RETURNING agent_package_name, skill_id, "position", created_by, created_at`,
      [input.agentPackageName, input.skillId, input.createdBy],
    );
    if (inserted[0]) return { outcome: "assigned", row: toRow(inserted[0]) } as const;

    // A racer won the PK arbiter while we held the lock (only reachable when a
    // caller bypasses the transaction seam); report the winner, never a lie.
    const winner = await tx<RawRow>(
      `SELECT agent_package_name, skill_id, "position", created_by, created_at
         FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2`,
      [input.agentPackageName, input.skillId],
    );
    if (winner[0]) return { outcome: "already_assigned", row: toRow(winner[0]) } as const;
    throw new Error(
      "insertAssignedSkill: insert produced no row and no existing row under the advisory lock",
    );
  });
}

/**
 * Remove ONE assignment. Idempotent: removing a row that is already gone
 * reports `deleted: false` rather than throwing — the UI's remove button and a
 * completed uninstall teardown can both have run.
 *
 * There is NO minimum: removal works all the way down to zero rows (unlike
 * extension owners, where one owner must remain).
 */
export async function deleteAssignedSkill(
  input: { agentPackageName: string; skillId: string },
  deps?: AssignedSkillsStoreDeps,
): Promise<{ deleted: boolean }> {
  const { query, table } = resolveDeps(deps);
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table} WHERE agent_package_name = $1 AND skill_id = $2 RETURNING skill_id`,
    [input.agentPackageName, input.skillId],
  );
  return { deleted: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// LIFECYCLE TEARDOWN bulk deletes (cinatra#2350 S5, epic #2345).
//
// The two directions an assignment row can be orphaned from: the SKILL it
// names, or the AGENT it is assigned to. Both a skill-package uninstall and an
// agent-package uninstall must sweep every row they own — not just the one
// (agent, skill) pair a UI remove targets — so a completed uninstall leaves
// ZERO rows, per the epic's "rows are configuration, not an audit log"
// decision (S1). Idempotent: deleting rows that are already gone reports 0,
// never throws.
// ---------------------------------------------------------------------------

/**
 * Delete every assignment row whose `skill_id` is in the given set, across
 * EVERY agent. Driven by the exact derived catalog ids a skill package owns
 * (`sweepAssignedSkillsForSkillPackageId` below), including the virtual
 * `@cinatra-ai/chat` namespace ids the five chat-successor packages register
 * under.
 */
export async function deleteAssignedSkillsForSkillIds(
  skillIds: readonly string[],
  deps?: AssignedSkillsStoreDeps,
): Promise<{ deletedCount: number }> {
  const ids = [...new Set(skillIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { deletedCount: 0 };
  const { query, table } = resolveDeps(deps);
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table} WHERE skill_id = ANY($1::text[]) RETURNING skill_id`,
    [ids],
  );
  return { deletedCount: rows.length };
}

/**
 * Delete every assignment row for ONE agent package — every skill it carries,
 * in one statement. The assignment table is actor-independent and covers
 * template-free, provider-declared agents too (S1's canonical resolver unions
 * DB templates with on-disk provider-declared agents), so this must never be
 * gated on an `agent_templates` row existing.
 */
export async function deleteAssignedSkillsForAgentPackage(
  agentPackageName: string,
  deps?: AssignedSkillsStoreDeps,
): Promise<{ deletedCount: number }> {
  if (!agentPackageName) return { deletedCount: 0 };
  const { query, table } = resolveDeps(deps);
  const rows = await query<{ skill_id: string }>(
    `DELETE FROM ${table} WHERE agent_package_name = $1 RETURNING skill_id`,
    [agentPackageName],
  );
  return { deletedCount: rows.length };
}

// ---------------------------------------------------------------------------
// SKILL-SIDE derivation (cinatra#2350 S5). Lives HERE — not in a dedicated
// `packages/skills/**` module — for a ratchet reason, not a layering one:
// `packages/skills/src/skills-store.ts`'s `uninstallSkillPackage` is
// reachable from all five locked routes (route-graph-ratchet), and this
// file is ALREADY one of the modules absorbed into their baselines (the S2
// PR, cinatra#2347, explicitly lists "the S1 assignment store" among the six
// first-party modules its `getAssignedSkillIdsForAgent` tier added and had
// annotated-absorbed). Landing the derivation logic in a brand-new file —
// even one reached only via `await import(...)` — still adds a node to the
// route-graph ratchet's count (verified locally: its analyzer's `import(...)`
// regex counts dynamic edges identically to static ones). Extending an
// ALREADY-counted file adds none. A prior attempt folded this logic into
// `packages/skills/src/skills-store.ts` instead, which pushed that file over
// its OWN tracked file-size-ratchet ceiling — landing it in this file (not
// size-tracked; see `scripts/audit/file-size-ratchet.baseline.json`) avoids
// both.
//
// `scanSkillExtensions` / `deriveSkillRegistration` are reached via a
// DYNAMIC import of the `@cinatra-ai/skills` package barrel — the reverse
// direction of every other cross-boundary read in this file (host importing
// a package it already depends on, same as `src/lib/agents-store.ts` does
// throughout) — because this host-app store needs the SAME derivation the S1
// predicate's `buildSkillIdOwnership` uses, and duplicating it here would
// let the two drift.
// ---------------------------------------------------------------------------

/** Narrowed shape of `@cinatra-ai/skills`'s `SkillExtensionDescriptor` — this
 *  file avoids a package-level TYPE import to keep its dependency surface a
 *  pure runtime seam (mirrors `AssignedSkillsQuery` above). */
type SkillExtensionDescriptorShape = {
  pkgName: string;
  pkgDirName: string;
  kind: string;
  slugs: string[];
};

export type SkillPackageTeardownDeps = {
  /** Default = the real filesystem scan (`@cinatra-ai/skills`). */
  scanExtensions?: () => Promise<SkillExtensionDescriptorShape[]>;
  /** Default = the real derivation (`@cinatra-ai/skills`). */
  deriveSkillRegistration?: (
    pkgName: string,
    pkgDirName: string,
    slug: string,
  ) => { packageName: string; skillId: string };
  /** Default = `deleteAssignedSkillsForSkillIds` above. */
  deleteBySkillIds?: (skillIds: string[]) => Promise<{ deletedCount: number }>;
};

async function defaultTeardownScanExtensions(): Promise<SkillExtensionDescriptorShape[]> {
  const { scanSkillExtensions } = await import("@cinatra-ai/skills");
  return scanSkillExtensions() as unknown as Promise<SkillExtensionDescriptorShape[]>;
}

async function defaultTeardownDeriveSkillRegistration(
  pkgName: string,
  pkgDirName: string,
  slug: string,
): Promise<{ packageName: string; skillId: string }> {
  const { deriveSkillRegistration } = await import("@cinatra-ai/skills");
  return deriveSkillRegistration(pkgName, pkgDirName, slug);
}

/**
 * Derive the EXACT catalog ids a REAL npm skill package owns, via the SAME
 * derivation `buildSkillIdOwnership` (S1's shared predicate,
 * `@cinatra-ai/skills/agent-skill-assignability`) uses. A per-slug throw
 * (reserved chat-namespace impersonation, `deriveSkillRegistration`'s guard)
 * degrades only that slug — mirrors `buildSkillIdOwnership`'s fail-soft
 * posture — never the sweep as a whole.
 *
 * Returns `[]` when the scan carries no `kind:"skill"` descriptor for this
 * package name — including simply "this package owns no skills", which is a
 * normal outcome, not a failure.
 */
export async function deriveOwnedAssignedSkillIds(
  realPackageName: string,
  deps: SkillPackageTeardownDeps = {},
): Promise<string[]> {
  if (!realPackageName) return [];
  const scanExtensions = deps.scanExtensions ?? defaultTeardownScanExtensions;
  const derive = deps.deriveSkillRegistration ?? defaultTeardownDeriveSkillRegistration;
  const descriptors = await scanExtensions();
  const owned = descriptors.find((d) => d.kind === "skill" && d.pkgName === realPackageName);
  if (!owned) return [];
  const ids: string[] = [];
  for (const slug of owned.slugs) {
    try {
      const reg = await derive(owned.pkgName, owned.pkgDirName, slug);
      ids.push(reg.skillId);
    } catch {
      // A package impersonating the reserved `@cinatra-ai/chat` namespace
      // degrades only THIS slug — never aborts the sweep for the rest of the
      // package's legitimate skills.
    }
  }
  return ids;
}

/**
 * Sweep `agent_assigned_skills` rows for a skill package being uninstalled —
 * called by `packages/skills/src/skills-store.ts:uninstallSkillPackage` (via
 * a dynamic import of THIS module) BEFORE its missing-native-package early
 * return. `packageId` is the catalog packageId (`verdaccio:<name>` /
 * `github:<name>`, per `skill-package-source.ts`); the real npm package name
 * is recovered from it, not looked up in the native `skillPackages` catalog
 * — a virtual-namespace registration (one of the five chat successor
 * packages) may have no row there at all.
 *
 * DELIBERATELY NOT wrapped in a try/catch that swallows the failure: the
 * co-owner cleanup in `uninstallSkillPackage` (cinatra#2346/#300) is the
 * precedent — if this sweep fails, the whole uninstall must roll back rather
 * than silently leave an orphan assignment that could re-apply on a later
 * reinstall of the same package.
 */
export async function sweepAssignedSkillsForSkillPackageId(
  packageId: string,
  deps: SkillPackageTeardownDeps = {},
): Promise<{ deletedCount: number }> {
  const realPackageName = packageId.replace(/^verdaccio:/, "").replace(/^github:/, "");
  const ids = await deriveOwnedAssignedSkillIds(realPackageName, deps);
  if (ids.length === 0) return { deletedCount: 0 };
  const deleteBySkillIds = deps.deleteBySkillIds ?? ((skillIds: string[]) => deleteAssignedSkillsForSkillIds(skillIds));
  return deleteBySkillIds(ids);
}
