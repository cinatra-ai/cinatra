// ---------------------------------------------------------------------------
// reconcile-template-org-ownership — heal agent templates seeded with NO owning org
// ---------------------------------------------------------------------------
//
// cinatra#2619. On a fresh instance the bundled-agent import runs BEFORE any
// organization exists (the documented dev path: `setup dev` -> boot -> the
// wizard creates the Default org). The import therefore has no org to anchor
// the row to, so every seeded `agent_templates` row lands with
// `org_id = NULL` / `owner_id = NULL`, and the boot bootstrap DDL's own
// backfill (`SET owner_level='organization', owner_id=COALESCE(org_id,'')
// WHERE owner_level IS NULL`, src/lib/drizzle-store.ts) then stamps the
// LEVEL without an owner — the empty-string sentinel that comment block
// documents.
//
// `auth-policy.ts`'s organization arm resolves the owning org as
// `template.orgId ?? template.ownerId`, finds NEITHER, and correctly denies
// with `unknown_scope`. The evaluator is right; the row is the defect. Nothing
// backfilled it: the next boot logs "skipped — already up to date", and the
// `set_agent_template_first_run` trigger that COALESCEs `org_id` off a run can
// never fire because the run is refused at creation. That is the deadlock this
// module breaks.
//
// WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
//
//   Predicate (an ownerless ORGANIZATION-scoped row, and nothing else):
//     org_id IS NULL
//     AND (owner_level IS NULL OR owner_level = 'organization')
//     AND (owner_id IS NULL OR owner_id = '')
//
//   A row that already carries ANY owner is untouched — `org_id` set, a
//   non-empty `owner_id`, or a NARROWER declared level (`user` / `team` /
//   `project` / `workspace`). Widening one of those to the organization would
//   hand a personal or team agent to every member of the org, which is exactly
//   the escalation `withDeterminateInstallScope` refuses at the write boundary.
//   The predicate is the whole safety argument for AC2.
//
//   The anchor is written in TWO statements inside ONE TRANSACTION:
//     1. `org_id` only, for the rows that have no anchor. `agent_owner_move_trg`
//        is `AFTER UPDATE OF owner_level, owner_id`, so this statement CANNOT
//        fire it — the same reason migrations/core
//        `core__0013_backfill-agent-template-org-id` writes org_id and nothing else.
//     2. `owner_level = 'organization'` for the rows that carry NO level at all.
//        Needed because a row imported on THIS boot has not met the bootstrap DDL
//        backfill yet, and a NULL level denies (`unknown_scope`, level null) even
//        once the org anchor is present. `owner_id` is deliberately NOT written —
//        a row's owner column is never rewritten by this pass.
//
//   The TRANSACTION is load-bearing, not decoration. Split across two commits, a
//   crash (or a failure) between them would leave a row with `org_id` set and
//   `owner_level` still NULL: still denied, and — under a predicate keyed on
//   `org_id IS NULL` — no longer a candidate, so the heal would have bricked the
//   row more durably than it found it. Both statements commit together.
//
//   Belt and braces, the predicate ALSO admits that shape on its own (arm B
//   below), so a row left level-less by anything else (an interrupted pre-#2619
//   boot, a partial legacy backfill) is picked up too.
//
//   `owner_id` keeps whatever sentinel it had (NULL or ''), and the evaluator
//   reads the owning org off `org_id` — the anchor it prefers.
//
// THE RELOCATION TRIGGER, AND WHY THIS PASS CLEANS UP AFTER IT.
//
//   Statement 2 changes `owner_level`, so `agent_owner_move_trg` fires and
//   enqueues a `path_relocations` row. Because `owner_id` is untouched (NULL or
//   ''), `compute_owner_path_prefix` answers `'workspace'` for BOTH the old and
//   the new tuple, so that row's `old_path` and `new_path` are IDENTICAL. The
//   trigger does not suppress it — it only compares the owner tuple — and the
//   relocation worker, finding the target already present at the same path,
//   would mark it `failed` ("target exists") once per healed template. A
//   same-path relocation carries no information by construction, so this pass
//   DELETES that class of row (same subject, `old_path = new_path`, still
//   `pending`) inside the same transaction, before any of them is visible to the
//   worker. Stated precisely (codex round 2): the WHERE also matches an OLDER
//   pending same-path row for the same subject, if one exists. That is
//   deliberate and harmless — such a row is a no-op by the same construction and
//   its only possible fate is the worker's "target exists" failure. Nothing that
//   describes a REAL move can match, because a real move has
//   `old_path <> new_path`; nothing another worker holds can match, because a
//   claim flips `status` to `in_progress` in the same statement that locks it.
//
// AMBIGUITY IS NOT GUESSED. The owning org is resolved ONLY when the instance
// has EXACTLY ONE organization. With none there is nothing to anchor to; with
// several an instance-wide bundled agent has no determinate owner, and picking
// one would hand another tenant's members a run grant. Both cases skip and
// SURFACE — the same call migrations/core core__0013 makes when a template's runs span
// multiple orgs ("a tenant-isolation red flag ... DELIBERATELY left NULL").
//
// IDEMPOTENT BY CONSTRUCTION: the rows it writes no longer match its own
// predicate, so a second call selects zero candidates and writes nothing at all.
// Safe to call on every boot and again whenever an org comes into existence.
//
// Deliberately NOT importing "server-only": the boot phase list and the store
// tests import this module outside a request scope.

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { db } from "./db";
import { agentTemplates } from "./schema";

/** Kill switch — an operator can disable the reconcile without a redeploy. */
const DISABLE_ENV = "CINATRA_DISABLE_AGENT_TEMPLATE_ORG_RECONCILE";

/**
 * The app schema `path_relocations` lives in. Resolved exactly the way
 * `./schema` resolves it for every agents table, so the two can never disagree.
 * Passed through `sql.identifier`, never interpolated as text.
 */
const RELOCATION_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

export type OrgOwnershipReconcileResult = {
  /** What the pass did. `skipped` means it wrote nothing and says why. */
  status: "healed" | "noop" | "skipped" | "disabled";
  /** The org every healed row was anchored to; null when nothing was resolved. */
  orgId: string | null;
  /** Candidate rows matching the ownerless predicate. */
  scanned: number;
  /** Rows given an `org_id` anchor. */
  anchored: number;
  /** Rows that also needed `owner_level` stamped. */
  levelStamped: number;
  /** Same-path relocation rows the level stamp manufactured and this pass dropped. */
  relocationsDropped?: number;
  /** The template ids touched (stable order) — the store-tier proof reads this. */
  templateIds: string[];
  /** Present on `skipped` / `disabled`. */
  reason?:
    | "no-organization"
    | "ambiguous-organizations"
    | "no-ownerless-rows"
    | "kill-switch";
  /** Organization count observed, when it mattered to the decision. */
  organizationCount?: number;
};

export type ReconcileOrgOwnershipDeps = {
  /**
   * Every organization id on the instance. Injected because the organization
   * table lives in the Better Auth store, not the agents schema — and because
   * the store-tier proof drives this function against known org sets.
   */
  listOrganizationIds: () => Promise<string[]>;
};

/**
 * The ownerless-organization-scoped predicate. Exported so the proof asserts
 * against the SAME expression the writes use, never a restated copy.
 */
export function ownerlessOrgScopedTemplatePredicate() {
  // An empty `owner_id` is the sentinel the bootstrap DDL writes
  // (`COALESCE(org_id,'')`); NULL is what a fresh insert leaves. Both mean
  // "no owner", and neither is a real id — org ids are non-empty.
  const noOwner = or(isNull(agentTemplates.ownerId), eq(agentTemplates.ownerId, ""));
  return or(
    // Arm A — no org anchor at all. Level is either absent, or already the
    // organization the DDL backfill stamped without an owner.
    and(
      isNull(agentTemplates.orgId),
      or(
        isNull(agentTemplates.ownerLevel),
        eq(agentTemplates.ownerLevel, "organization"),
      ),
      noOwner,
    ),
    // Arm B — anchored, but carrying NO level, so the evaluator still denies
    // (`unknown_scope`, level null). This is the shape a crash between this
    // pass's two statements would leave, and the shape a pre-#2619 boot could
    // leave on its own. Its owning org is already determinate (`org_id`), so
    // only the level is stamped — never the anchor, and never a wider scope
    // than the shipped bootstrap DDL already assigns such a row
    // (`owner_level IS NULL -> 'organization'`).
    and(isNotNull(agentTemplates.orgId), isNull(agentTemplates.ownerLevel), noOwner),
  );
}

export async function reconcileAgentTemplateOrgOwnership(
  deps: ReconcileOrgOwnershipDeps,
): Promise<OrgOwnershipReconcileResult> {
  const empty = {
    orgId: null,
    scanned: 0,
    anchored: 0,
    levelStamped: 0,
    relocationsDropped: 0,
    templateIds: [] as string[],
  };

  if (process.env[DISABLE_ENV] === "true") {
    return { status: "disabled", reason: "kill-switch", ...empty };
  }

  // Candidates FIRST, so a healthy instance answers before the org lookup.
  // COST, stated honestly: no index covers this predicate (`agent_templates`
  // carries a created-at, a package-name and an `(owner_level, owner_id)` index),
  // so this is a scan of `agent_templates` — a table with one row per installed
  // agent, i.e. tens on a normal instance. It is cheap, not free, which is why
  // the non-boot caller bounds how often it may run rather than calling it per
  // request.
  const candidates = await db
    .select({
      id: agentTemplates.id,
      orgId: agentTemplates.orgId,
      ownerLevel: agentTemplates.ownerLevel,
    })
    .from(agentTemplates)
    .where(ownerlessOrgScopedTemplatePredicate())
    .orderBy(agentTemplates.id);

  if (candidates.length === 0) {
    return { status: "noop", reason: "no-ownerless-rows", ...empty };
  }

  const orgIds = await deps.listOrganizationIds();
  if (orgIds.length === 0) {
    return {
      status: "skipped",
      reason: "no-organization",
      organizationCount: 0,
      ...empty,
      scanned: candidates.length,
    };
  }
  if (orgIds.length > 1) {
    return {
      status: "skipped",
      reason: "ambiguous-organizations",
      organizationCount: orgIds.length,
      ...empty,
      scanned: candidates.length,
    };
  }

  const orgId = orgIds[0];
  // Arm A (no anchor) needs `org_id`; arm B (anchored, level-less) does not.
  const needAnchorIds = candidates.filter((c) => c.orgId === null).map((c) => c.id);
  const needLevelIds = candidates.filter((c) => c.ownerLevel === null).map((c) => c.id);

  const { anchoredIds, levelStamped, relocationsDropped } = await db.transaction(
    async (tx) => {
      // (1) Anchor. Re-asserts the predicate in the WHERE so a row another
      // writer claimed between the read and here is left alone (no lost update).
      const anchoredRows =
        needAnchorIds.length > 0
          ? await tx
              .update(agentTemplates)
              .set({ orgId, updatedAt: new Date() })
              .where(
                and(
                  inArray(agentTemplates.id, needAnchorIds),
                  ownerlessOrgScopedTemplatePredicate(),
                ),
              )
              .returning({ id: agentTemplates.id })
          : [];

      // (2) Level stamp for every candidate that carries no level — whether this
      // pass just anchored it (arm A) or it was already anchored (arm B). The
      // WHERE re-asserts "still level-less, still ownerless, and now anchored",
      // so a concurrent writer that gave the row a real scope wins.
      const stampedRows =
        needLevelIds.length > 0
          ? await tx
              .update(agentTemplates)
              .set({ ownerLevel: "organization", updatedAt: new Date() })
              .where(
                and(
                  inArray(agentTemplates.id, needLevelIds),
                  isNotNull(agentTemplates.orgId),
                  isNull(agentTemplates.ownerLevel),
                  or(isNull(agentTemplates.ownerId), eq(agentTemplates.ownerId, "")),
                ),
              )
              .returning({ id: agentTemplates.id })
          : [];

      // (3) Drop the SAME-PATH relocation rows statement (2) just manufactured,
      // before the worker can ever see them (see the trigger note at the top).
      // Scoped three ways — this pass's own stamped subjects, `old_path =
      // new_path`, and still `pending` — so a relocation describing a REAL move
      // (`old_path <> new_path`), or one a worker already claimed
      // (`status = 'in_progress'`), can never match.
      let dropped = 0;
      if (stampedRows.length > 0) {
        const stampedIds = stampedRows.map((r) => r.id);
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from ${sql.identifier(RELOCATION_SCHEMA)}.${sql.identifier("path_relocations")}
          where subject_kind = 'agent_template'
            and status = 'pending'
            and old_path = new_path
            and subject_id in (${sql.join(stampedIds.map((id) => sql`${id}`), sql`, `)})
          returning id
        `);
        dropped = deleted.rows?.length ?? 0;
      }

      return {
        anchoredIds: new Set(anchoredRows.map((r) => r.id)),
        levelStamped: stampedRows.length,
        relocationsDropped: dropped,
      };
    },
  );

  const touched = anchoredIds.size + levelStamped;
  const templateIds = [...new Set([...anchoredIds, ...needLevelIds])].sort();
  return {
    status: touched > 0 ? "healed" : "noop",
    orgId,
    scanned: candidates.length,
    anchored: anchoredIds.size,
    levelStamped,
    relocationsDropped,
    templateIds: touched > 0 ? templateIds : [],
    ...(touched === 0 ? { reason: "no-ownerless-rows" as const } : {}),
  };
}

/**
 * The instance's organization ids, read straight from the Better Auth store.
 * Kept out of {@link reconcileAgentTemplateOrgOwnership} so that function stays
 * injectable; this is the ONE production wiring every caller shares.
 */
export async function listInstanceOrganizationIds(): Promise<string[]> {
  const { betterAuthDb, betterAuthOrganizations } = await import("@/lib/better-auth-db");
  const rows = await betterAuthDb
    .select({ id: betterAuthOrganizations.id })
    .from(betterAuthOrganizations);
  return rows
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Human-readable one-liner for the boot / bootstrap logs. */
export function describeReconcileResult(r: OrgOwnershipReconcileResult): string {
  if (r.status === "disabled") return `disabled (${DISABLE_ENV}=true)`;
  if (r.status === "skipped") {
    return `skipped — ${r.reason} (candidates=${r.scanned}, organizations=${r.organizationCount ?? "?"})`;
  }
  if (r.status === "noop") return "nothing to heal";
  const reloc = r.relocationsDropped ? `; ${r.relocationsDropped} same-path relocation(s) dropped` : "";
  return `healed ${r.anchored} anchor(s) + ${r.levelStamped} level stamp(s) onto org=${r.orgId} (scanned ${r.scanned}${reloc})`;
}
