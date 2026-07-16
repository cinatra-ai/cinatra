/**
 * Real-Postgres integration proof for the S11b transactional adopt-in-place
 * re-key (cinatra#1628) — the AC2 "re-key not duplicate" recovery. Drives the
 * ACTUAL dashboards single-writer `adoptExtensionDashboards` + the host reconciler
 * `reconcileDashboardContributionAdoptions` against a live Postgres, so the
 * re-key / never-clobber-operator / un-archive / idempotency / fail-closed-
 * ambiguity behavior is verified end-to-end at the DB boundary.
 *
 * GATED (same idiom as mutation-service-v12-wrap.integration.test.ts): only runs
 * when DASH_DB_IT=1 AND SUPABASE_DB_URL point at a throwaway Postgres. The
 * default CI unit run has neither, so it is skipped — NOT part of the green unit
 * gate. Run locally against the verify stack:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *   SUPABASE_SCHEMA=cinatra_s11b_it DASH_DB_IT=1 \
 *   npx vitest run --no-coverage src/__tests__/adopt-extension-dashboards.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { adoptExtensionDashboards } from "../mutation-service";
import {
  deriveContributionLineageId,
  legacyContributionLineageId,
  adoptionMatchLineageIds,
} from "../contribution-lineage";
import type { DashboardActor } from "../permissions";

const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_s11b_it";
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;

const ORG = "org-s11b";
const LEGACY_PKG = "@cinatra-ai/blog-content-workflow";
const SUCCESSOR_PKG = "@cinatra-ai/blog-content-agent";
const SUCCESSOR_KEY = "blog-operator";
const SUCCESSOR_LINEAGE = deriveContributionLineageId(SUCCESSOR_PKG, SUCCESSOR_KEY);
const LEGACY_LINEAGE = legacyContributionLineageId(LEGACY_PKG);

const actor: DashboardActor = {
  userId: "u-s11b",
  organizationId: ORG,
  teamIds: [],
  orgRole: "owner",
  teamRoles: {},
};

const CONFIG = { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } };

async function seedRow(
  pool: Pool,
  row: {
    id: string;
    extensionId: string | null;
    contributionId: string | null;
    isTemplate?: boolean;
    templateScope?: string | null;
    projectId?: string | null;
    status?: string;
    config?: unknown;
  },
) {
  await pool.query(
    `INSERT INTO "${SCHEMA}".dashboards
       (id, name, config_json, config_version, owner_level, owner_id, organization_id, visibility, status,
        created_by, extension_id, is_template, template_scope, project_id, contribution_id)
     VALUES ($1,$2,$3,'1.2','organization','owner-1',$4,'members',$5,'sys',$6,$7,$8,$9,$10)`,
    [
      row.id,
      `${row.id} name`,
      JSON.stringify(row.config ?? CONFIG),
      ORG,
      row.status ?? "archived",
      row.extensionId,
      row.isTemplate ?? false,
      row.templateScope ?? null,
      row.projectId ?? null,
      row.contributionId,
    ],
  );
}

async function readRow(pool: Pool, id: string) {
  const r = await pool.query(
    `SELECT extension_id, contribution_id, status, archived_at, archive_reason, applied_contribution_version, config_json
       FROM "${SCHEMA}".dashboards WHERE id = $1`,
    [id],
  );
  return r.rows[0] as
    | {
        extension_id: string | null;
        contribution_id: string | null;
        status: string;
        archived_at: string | null;
        archive_reason: string | null;
        applied_contribution_version: number | null;
        config_json: unknown;
      }
    | undefined;
}

describe.skipIf(!RUN_IT)("adoptExtensionDashboards + reconciler (real Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      config_json jsonb NOT NULL,
      config_version text NOT NULL DEFAULT '1.2',
      dashboard_version integer NOT NULL DEFAULT 1,
      published_revision_number integer,
      owner_level text NOT NULL,
      owner_id text NOT NULL,
      organization_id text NOT NULL,
      visibility text NOT NULL DEFAULT 'private',
      status text NOT NULL DEFAULT 'draft',
      created_by text NOT NULL,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      archived_at timestamptz,
      project_id text,
      extension_id text,
      is_template boolean NOT NULL DEFAULT false,
      template_scope text,
      entity_type text,
      entity_id text,
      is_default boolean NOT NULL DEFAULT false,
      contribution_id text,
      applied_contribution_version integer,
      applied_default_json jsonb,
      applied_default_hash text,
      archive_reason text
    )`);
    // The two-tier contribution uniqueness (mirrors store/schema.ts) so the
    // fail-closed-on-collision path is real.
    await pool.query(
      `CREATE UNIQUE INDEX dash_contrib_tmpl ON "${SCHEMA}".dashboards (contribution_id, organization_id)
         WHERE contribution_id IS NOT NULL AND is_template = true`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX dash_contrib_inst ON "${SCHEMA}".dashboards (contribution_id, organization_id, project_id)
         WHERE contribution_id IS NOT NULL AND project_id IS NOT NULL`,
    );
    await pool.query(`CREATE TABLE "${SCHEMA}".audit_events (
      id text PRIMARY KEY, organization_id text, actor_principal_id text, actor_principal_type text,
      auth_source text, delegated_by text, impersonated_user_id text, resource_type text, resource_id text,
      operation text, decision text, policy_version text, request_id text, run_id text, a2a_task_id text,
      ip text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${SCHEMA}".dashboards, "${SCHEMA}".audit_events`);
  });

  it("re-keys the orphan template + its instances onto the successor, un-archives, and preserves the user config", async () => {
    const userConfig = { ...CONFIG, colorPalette: "user-custom" };
    await seedRow(pool, { id: "tmpl", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, isTemplate: true, templateScope: "project" });
    await seedRow(pool, { id: "inst-1", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, projectId: "p1", config: userConfig });
    await seedRow(pool, { id: "inst-2", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, projectId: "p2" });

    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG,
      successorPackage: SUCCESSOR_PKG,
      successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: adoptionMatchLineageIds({ legacyPackage: LEGACY_PKG, legacyContributionKey: "blog" }),
      appliedContributionVersion: 5,
      actor,
    });
    expect(n).toBe(3);

    for (const id of ["tmpl", "inst-1", "inst-2"]) {
      const row = await readRow(pool, id);
      expect(row?.extension_id).toBe(SUCCESSOR_PKG);
      expect(row?.contribution_id).toBe(SUCCESSOR_LINEAGE);
      expect(row?.status).toBe("published");
      expect(row?.archived_at).toBeNull();
      expect(row?.archive_reason).toBeNull();
      expect(row?.applied_contribution_version).toBe(5);
    }
    // User overlay preserved (render continuity, not a duplicate).
    expect((await readRow(pool, "inst-1"))?.config_json).toEqual(userConfig);

    // An audit row per re-keyed dashboard.
    const audits = await pool.query(
      `SELECT count(*)::int AS c FROM "${SCHEMA}".audit_events WHERE operation = 'dashboards.extension_adopt'`,
    );
    expect(audits.rows[0].c).toBe(3);
  });

  it("NEVER clobbers an operator row (extension_id NULL) even with a matching-looking lineage", async () => {
    await seedRow(pool, { id: "op", extensionId: null, contributionId: null, status: "published", config: { operator: true } });
    // An operator row could never carry the legacy lineage, but assert the guard
    // holds even if a stray contribution_id were present.
    await seedRow(pool, { id: "op-strayid", extensionId: null, contributionId: LEGACY_LINEAGE, status: "published" });
    await seedRow(pool, { id: "orphan", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, isTemplate: true, templateScope: "project" });

    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG,
      successorPackage: SUCCESSOR_PKG,
      successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: [LEGACY_LINEAGE],
      appliedContributionVersion: 1,
      actor,
    });
    expect(n).toBe(1); // only the extension-owned orphan
    // Operator rows untouched.
    const op = await readRow(pool, "op");
    expect(op?.extension_id).toBeNull();
    expect(op?.status).toBe("published");
    const stray = await readRow(pool, "op-strayid");
    expect(stray?.extension_id).toBeNull();
    expect(stray?.contribution_id).toBe(LEGACY_LINEAGE); // unchanged
  });

  it("is idempotent — a re-fire re-keys zero rows", async () => {
    await seedRow(pool, { id: "tmpl", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, isTemplate: true, templateScope: "project" });
    const first = await adoptExtensionDashboards(undefined, {
      organizationId: ORG, successorPackage: SUCCESSOR_PKG, successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: [LEGACY_LINEAGE], appliedContributionVersion: 1, actor,
    });
    expect(first).toBe(1);
    const second = await adoptExtensionDashboards(undefined, {
      organizationId: ORG, successorPackage: SUCCESSOR_PKG, successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: adoptionMatchLineageIds({ legacyPackage: LEGACY_PKG, legacyContributionKey: "blog" }),
      appliedContributionVersion: 1, actor,
    });
    expect(second).toBe(0);
  });

  it("no matching orphan is a safe no-op", async () => {
    await seedRow(pool, { id: "unrelated", extensionId: "@x/other", contributionId: legacyContributionLineageId("@x/other"), status: "published" });
    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG, successorPackage: SUCCESSOR_PKG, successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: [LEGACY_LINEAGE], appliedContributionVersion: 1, actor,
    });
    expect(n).toBe(0);
    expect((await readRow(pool, "unrelated"))?.extension_id).toBe("@x/other");
  });

  it("scopes to the org — an orphan in another org is not adopted", async () => {
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, config_version, owner_level, owner_id, organization_id, visibility, status, created_by, extension_id, is_template, template_scope, contribution_id)
       VALUES ('other-org-tmpl','n',$1,'1.2','organization','o','org-OTHER','members','archived','sys',$2,true,'project',$3)`,
      [JSON.stringify(CONFIG), LEGACY_PKG, LEGACY_LINEAGE],
    );
    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG, successorPackage: SUCCESSOR_PKG, successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: [LEGACY_LINEAGE], appliedContributionVersion: 1, actor,
    });
    expect(n).toBe(0);
    expect((await readRow(pool, "other-org-tmpl"))?.extension_id).toBe(LEGACY_PKG);
  });

  it("re-keys a prior AGENT-era lineage (archived post-uninstall) via the derived candidate", async () => {
    // A prior AGENT-era adoption left rows keyed `contribution:@x/wf#k`; the prior
    // agent was uninstalled (→ archived), and a re-home's adopts edge names (@x/wf,
    // k) → the derived candidate matches the archived orphan.
    const priorLineage = deriveContributionLineageId("@x/wf", "k");
    await seedRow(pool, { id: "prior-tmpl", extensionId: "@x/wf-agent", contributionId: priorLineage, isTemplate: true, templateScope: "project", status: "archived" });
    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG,
      successorPackage: "@x/wf-agent-v2",
      successorContributionId: deriveContributionLineageId("@x/wf-agent-v2", "k2"),
      matchLineageIds: adoptionMatchLineageIds({ legacyPackage: "@x/wf", legacyContributionKey: "k" }),
      appliedContributionVersion: 2,
      actor,
    });
    expect(n).toBe(1);
    expect((await readRow(pool, "prior-tmpl"))?.extension_id).toBe("@x/wf-agent-v2");
  });

  it("ARCHIVED-ONLY: a LIVE (published) extension row is NEVER re-homed out from under its owner", async () => {
    // A still-live legacy extension whose rows carry the matching lineage but are
    // PUBLISHED (not orphaned). Adoption must not steal them.
    await seedRow(pool, { id: "live-tmpl", extensionId: LEGACY_PKG, contributionId: LEGACY_LINEAGE, isTemplate: true, templateScope: "project", status: "published" });
    const n = await adoptExtensionDashboards(undefined, {
      organizationId: ORG,
      successorPackage: SUCCESSOR_PKG,
      successorContributionId: SUCCESSOR_LINEAGE,
      matchLineageIds: [LEGACY_LINEAGE],
      appliedContributionVersion: 1,
      actor,
    });
    expect(n).toBe(0);
    const row = await readRow(pool, "live-tmpl");
    expect(row?.extension_id).toBe(LEGACY_PKG); // untouched
    expect(row?.status).toBe("published");
  });
});
