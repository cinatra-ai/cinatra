/**
 * Hermetic test-data seeding for the Release Workflows browser e2e.
 *
 * The release-workflow store is `import "server-only"` (it can't be imported
 * into the Playwright Node context), and the in-app MCP create path runs through
 * the loopback dev-admin bypass — which stamps a platform-admin actor whose org
 * is NOT the freshly-signed-up test user's org, so a bypass-created workflow
 * would be invisible to the test session. We therefore seed directly via `pg`
 * into the TEST USER's org (the same approach the dashboards smoke uses).
 *
 * The seeded workflow is the exact shape the engine-level integration tests
 * cover and that the live walk verified: a PAUSED workflow that already carries
 * an attempt (a succeeded checkpoint) plus an idle dependent — i.e. the
 * "paused-edit with attempts" surface. Because it is paused + user-owned,
 * the detail page renders the editable Gantt + the Target-date control.
 *
 * Idempotent: every run deletes the seeded workflow's rows (in FK-safe order)
 * and re-inserts, so the suite is deterministic on re-run.
 */
import { Pool } from "pg";

export type SeedOptions = {
  readonly email: string;
  readonly databaseUrl: string;
  readonly schema: string;
};

export type SeedResult = {
  readonly userId: string;
  readonly organizationId: string;
  readonly workflowId: string;
};

export const WORKFLOW_ID = "wf_e2e_paused_editable";
const BUILD_TASK_ID = "wtask_e2e_build";
const SHIP_TASK_ID = "wtask_e2e_ship";

// Additive hierarchy (NEW summary parent + 2 NEW leaf children).
// Existing build/ship stay as flat leaves so every prior assertion is untouched.
// The new parent's planned window is the DERIVED aggregate (min(child.start) /
// max(child.end) / max(child.due)) — never placeholder dates, since the seed
// bypasses resolveSchedule.
const PHASE_PARENT_ID = "wtask_e2e_phase_1_release";
const DESIGN_CHILD_ID = "wtask_e2e_design_doc";
const QA_CHILD_ID = "wtask_e2e_qa_pass";

// Screenshot-only status coverage (opt-in via `CAPTURE_SCREENSHOTS=1`).
// Three additional flat tasks covering succeeded/running/failed actual-bar
// statuses; each has a NONZERO planned span (computeActualBarMetrics returns
// null on milestones / zero-width planned bars).
const RESEARCH_TASK_ID = "wtask_e2e_research";
const PROTOTYPE_TASK_ID = "wtask_e2e_prototype";
const AUDIT_TASK_ID = "wtask_e2e_audit";

export async function seedWorkflowFixtures(opts: SeedOptions): Promise<SeedResult> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    const userRow = await pool.query(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [opts.email]);
    if (userRow.rows.length === 0) {
      throw new Error(`seedWorkflowFixtures: user not found for ${opts.email} — run auth.setup.ts first`);
    }
    const userId = userRow.rows[0].id as string;

    // Resolve (or bootstrap) the user's org. Org CREATION is API-restricted on
    // some instances (`YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION`), so we
    // seed a dedicated org + owner membership directly when the user has none —
    // auth.setup then `set-active`s it (membership, not creation, is all that
    // needs).
    const memberRow = await pool.query(`SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`, [
      userId,
    ]);
    let organizationId: string;
    if (memberRow.rows.length > 0) {
      organizationId = memberRow.rows[0].organizationId as string;
    } else {
      organizationId = "org_e2e_workflows";
      await pool.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt")
         VALUES ($1, 'Workflows E2E Org', 'workflows-e2e-org', now())
         ON CONFLICT (id) DO NOTHING`,
        [organizationId],
      );
      await pool.query(
        `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
         VALUES ('mem_e2e_workflows', $1, $2, 'owner', now())
         ON CONFLICT (id) DO NOTHING`,
        [organizationId, userId],
      );
    }

    // CI race-guard: on a userCount===1 instance,
    // `getAuthSession()` fires `ensureInitialAdminBootstrap` AND
    // `ensureDefaultOrganizationMembership` CONCURRENTLY inside the layout's
    // Promise.all — both try to INSERT a "default" org with slug='default', one
    // wins, the others throw on the unique-slug constraint, the layout catches
    // it, sets setupComplete=false, and the page renders the setup wizard
    // instead of the requested route. Promoting the user to `admin` BEFORE
    // sign-in flips `hasRole` true on the very first page load so the bootstrap
    // branch is skipped — same effect RBAC achieves by signing up two users
    // (userCount!==1 short-circuits the same code path).
    await pool.query(`UPDATE public."user" SET role = 'admin' WHERE id = $1`, [userId]);

    // FK-safe teardown of any prior seed (attempt/event → dep → task → workflow).
    await pool.query(`DELETE FROM ${schema}.workflow_task_attempt WHERE workflow_id = $1`, [WORKFLOW_ID]);
    await pool.query(`DELETE FROM ${schema}.workflow_event WHERE workflow_id = $1`, [WORKFLOW_ID]);
    await pool.query(`DELETE FROM ${schema}.workflow_dependency WHERE workflow_id = $1`, [WORKFLOW_ID]);
    await pool.query(`DELETE FROM ${schema}.workflow_task WHERE workflow_id = $1`, [WORKFLOW_ID]);
    await pool.query(`DELETE FROM ${schema}.workflow WHERE id = $1`, [WORKFLOW_ID]);

    const release = new Date(Date.now() + 30 * 24 * 3_600_000); // 30d out
    const buildDue = new Date(Date.now() - 24 * 3_600_000); // yesterday (already ran)
    const shipDue = new Date(Date.now() + 7 * 24 * 3_600_000); // next week

    // PAUSED workflow, user-owned (→ manageable → editable Gantt + Target ctrl).
    await pool.query(
      `INSERT INTO ${schema}.workflow
         (id, name, product, target_at_utc, target_tz, status, owner_level, owner_id, org_id, spec_version, lock_version, created_by)
       VALUES ($1, $2, $3, $4, 'UTC', 'paused', 'user', $5, $6, 1, 2, $5)`,
      [WORKFLOW_ID, "E2E Paused Editable", "E2E Suite", release, userId, organizationId],
    );

    // Succeeded checkpoint (carries an attempt → frozen execution identity).
    await pool.query(
      `INSERT INTO ${schema}.workflow_task
         (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, lock_version)
       VALUES ($1, $2, 'build', 'checkpoint', 'Build', 'succeeded', $3, $3, $3, 1)`,
      [BUILD_TASK_ID, WORKFLOW_ID, buildDue],
    );
    // Idle manual dependent (editable bar).
    await pool.query(
      `INSERT INTO ${schema}.workflow_task
         (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, lock_version)
       VALUES ($1, $2, 'ship', 'manual', 'Ship', 'idle', $3, $3, $3, 1)`,
      [SHIP_TASK_ID, WORKFLOW_ID, shipDue],
    );

    await pool.query(
      `INSERT INTO ${schema}.workflow_dependency (id, workflow_id, task_id, depends_on_task_id, outcome)
       VALUES ('wdep_e2e_ship_build', $1, $2, $3, 'success')`,
      [WORKFLOW_ID, SHIP_TASK_ID, BUILD_TASK_ID],
    );

    // The attempt that makes `build` evidence-bearing (the attempt-FK case).
    await pool.query(
      `INSERT INTO ${schema}.workflow_task_attempt
         (id, workflow_id, task_id, attempt_no, idempotency_key, status, started_at, completed_at)
       VALUES ('watt_e2e_build_1', $1, $2, 1, 'e2e-build-1', 'succeeded', $3, $3)`,
      [WORKFLOW_ID, BUILD_TASK_ID, buildDue],
    );

    // One audit event so the read-only Activity panel renders real data.
    await pool.query(
      `INSERT INTO ${schema}.workflow_event (id, workflow_id, task_key, kind, source, created_at)
       VALUES ('wevt_e2e_started', $1, NULL, 'workflow_started', 'lifecycle', $2)`,
      [WORKFLOW_ID, buildDue],
    );

    // -----------------------------------------------------------------------
    // Additive hierarchy. Two new leaf children whose parent is a
    // NEW summary parent. Two-phase parent_task_id write per the established
    // pattern (insert rows with NULL parent_task_id, then UPDATE) so the
    // self-FK never dangles. Parent's planned window = derived aggregate over
    // the children.
    const designStart = new Date(Date.now() + 1 * 24 * 3_600_000); // tomorrow
    const designDue = new Date(Date.now() + 4 * 24 * 3_600_000); // +4d
    const qaStart = new Date(Date.now() + 5 * 24 * 3_600_000); // +5d
    const qaDue = new Date(Date.now() + 10 * 24 * 3_600_000); // +10d

    // Parent: window = min(child.start) .. max(child.end), due = max(child.due)
    await pool.query(
      `INSERT INTO ${schema}.workflow_task
         (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, lock_version)
       VALUES ($1, $2, 'phase-1-release', 'checkpoint', 'Phase 1: Release', 'idle', $3, $4, $4, 1)`,
      [PHASE_PARENT_ID, WORKFLOW_ID, designStart, qaDue],
    );
    // Children (no parent_task_id yet — phase-1 of the two-phase write).
    await pool.query(
      `INSERT INTO ${schema}.workflow_task
         (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, lock_version)
       VALUES ($1, $2, 'design-doc', 'manual', 'Design doc', 'idle', $3, $4, $4, 1)`,
      [DESIGN_CHILD_ID, WORKFLOW_ID, designStart, designDue],
    );
    await pool.query(
      `INSERT INTO ${schema}.workflow_task
         (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, lock_version)
       VALUES ($1, $2, 'qa-pass', 'manual', 'QA pass', 'idle', $3, $4, $4, 1)`,
      [QA_CHILD_ID, WORKFLOW_ID, qaStart, qaDue],
    );
    // Phase-2 of the two-phase write: point children at parent.
    await pool.query(
      `UPDATE ${schema}.workflow_task SET parent_task_id = $1 WHERE id = ANY($2::text[])`,
      [PHASE_PARENT_ID, [DESIGN_CHILD_ID, QA_CHILD_ID]],
    );

    // Optional status-coverage tasks (screenshot grid only). Each carries a
    // NONZERO planned span + actuals so computeActualBarMetrics renders the
    // ghost actual-bar overlay; spans straddle "now" so the today-line cuts
    // through them. Gated by env so the durable e2e suite is unaffected.
    if (process.env.CAPTURE_SCREENSHOTS === "1") {
      const researchStart = new Date(Date.now() - 6 * 24 * 3_600_000); // -6d
      const researchEnd = new Date(Date.now() - 2 * 24 * 3_600_000); // -2d
      const prototypeStart = new Date(Date.now() - 3 * 24 * 3_600_000); // -3d
      const prototypeEnd = new Date(Date.now() + 4 * 24 * 3_600_000); // +4d
      const auditStart = new Date(Date.now() - 4 * 24 * 3_600_000); // -4d
      const auditEnd = new Date(Date.now() - 1 * 24 * 3_600_000); // -1d
      const auditActualEnd = new Date(Date.now() + 1 * 24 * 3_600_000); // +1d (overrun)

      // Succeeded (actuals fully within planned window).
      await pool.query(
        `INSERT INTO ${schema}.workflow_task
           (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, actual_start_utc, actual_end_utc, lock_version)
         VALUES ($1, $2, 'research', 'agent_task', 'Research', 'succeeded', $3, $4, $4, $3, $4, 1)`,
        [RESEARCH_TASK_ID, WORKFLOW_ID, researchStart, researchEnd],
      );
      // Running (actualStart only; ghost clips to "now").
      await pool.query(
        `INSERT INTO ${schema}.workflow_task
           (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, actual_start_utc, lock_version)
         VALUES ($1, $2, 'prototype', 'agent_task', 'Prototype', 'running', $3, $4, $4, $3, 1)`,
        [PROTOTYPE_TASK_ID, WORKFLOW_ID, prototypeStart, prototypeEnd],
      );
      // Failed (overran planned end → slip-days > 0).
      await pool.query(
        `INSERT INTO ${schema}.workflow_task
           (id, workflow_id, key, type, title, status, planned_start_utc, planned_end_utc, due_at_utc, actual_start_utc, actual_end_utc, lock_version)
         VALUES ($1, $2, 'audit', 'agent_task', 'Audit', 'failed', $3, $4, $4, $3, $5, 1)`,
        [AUDIT_TASK_ID, WORKFLOW_ID, auditStart, auditEnd, auditActualEnd],
      );
    }

    return { userId, organizationId, workflowId: WORKFLOW_ID };
  } finally {
    await pool.end();
  }
}

/**
 * Point ALL of the user's live sessions at `organizationId` by writing
 * `public.session.activeOrganizationId` directly. The Better Auth `set-active`
 * endpoint behaves inconsistently under Playwright's request context (it can
 * reject an org the freshly-minted session doesn't yet "see"); writing the
 * column is the deterministic equivalent, and RSC reads
 * `session.activeOrganizationId` straight off this row. Returns the row count.
 */
export async function activateSessionsForUser(
  opts: SeedOptions & { organizationId: string },
): Promise<number> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  try {
    const userRow = await pool.query(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [opts.email]);
    if (userRow.rows.length === 0) return 0;
    const userId = userRow.rows[0].id as string;
    const res = await pool.query(
      `UPDATE public."session" SET "activeOrganizationId" = $1 WHERE "userId" = $2`,
      [opts.organizationId, userId],
    );
    return res.rowCount ?? 0;
  } finally {
    await pool.end();
  }
}
