import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { requireDashboardAccess, DashboardAccessError, type DashboardAuthzActor } from "@/lib/dashboards/authz";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-dash04";

async function client() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

// Insert a dashboard row directly (test-only; bypasses the single-writer service).
async function seedDashboard(c: Client, row: { ownerLevel: string; ownerId: string; projectId: string | null; visibility?: string }): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO "${SCHEMA}"."dashboards" (id, name, config_json, owner_level, owner_id, organization_id, visibility, status, created_by, project_id, extension_id, is_template, template_scope)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'published','seed',$8,$9,$10,$11)`,
    [id, "D", JSON.stringify({}), row.ownerLevel, row.ownerId, ORG, row.visibility ?? "members", row.projectId, row.projectId ? "@cinatra-ai/x-workflow" : null, false, null],
  );
  return id;
}

let userDash: string;
let orgDash: string;
let projDash: string;

// Uses the REAL resolved kernel role enum `org_admin` (NOT the dashboard-local
// "admin") to exercise the app wrapper's role normalization: if it regressed,
// resolveDashboardAccess would not see an admin and the org-owned read/admin
// cases below would fail.
//
// NOTE: this cross-package DB integration test (app wrapper → @cinatra-ai/dashboards
// resolver → dashboards pool) lives in the workflows integration suite because it
// is the repo's only package with DB-integration test infra (env + DDL + server-only
// mock); the dashboards package vitest config is unit-only.
const orgAdmin: DashboardAuthzActor = { userId: "u-admin", orgId: ORG, organizationId: ORG, teamIds: [], orgRole: "org_admin" };

beforeAll(async () => {
  const c = await client();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DELETE FROM "${SCHEMA}"."dashboards" WHERE organization_id=$1`, [ORG]);
  userDash = await seedDashboard(c, { ownerLevel: "user", ownerId: "u-admin", projectId: null });
  orgDash = await seedDashboard(c, { ownerLevel: "organization", ownerId: ORG, projectId: null });
  projDash = await seedDashboard(c, { ownerLevel: "organization", ownerId: ORG, projectId: "proj-1" });
  await c.end();
}, 60_000);

async function allowed(actor: DashboardAuthzActor, id: string, mode: "read" | "write" | "admin"): Promise<boolean> {
  try {
    await requireDashboardAccess(actor, id, mode);
    return true;
  } catch (e) {
    if (e instanceof DashboardAccessError) return false;
    throw e;
  }
}

describe("requireDashboardAccess (DASH-04)", () => {
  it("non-project user-owned: owner reads+admins; a different user is denied", async () => {
    expect(await allowed(orgAdmin, userDash, "read")).toBe(true);
    expect(await allowed(orgAdmin, userDash, "admin")).toBe(true);
    expect(await allowed({ userId: "u-other", orgId: ORG, organizationId: ORG, teamIds: [], orgRole: "member" }, userDash, "read")).toBe(false);
  });

  it("non-project org-owned: an org admin reads+admins (no project gate runs)", async () => {
    expect(await allowed(orgAdmin, orgDash, "read")).toBe(true);
    expect(await allowed(orgAdmin, orgDash, "admin")).toBe(true);
  });

  it("project-scoped read requires any non-null grant", async () => {
    const reader = { ...orgAdmin, projectGrants: [{ projectId: "proj-1", effectiveRole: "read" as const }] };
    expect(await allowed(reader, projDash, "read")).toBe(true);
    expect(await allowed(reader, projDash, "write")).toBe(false); // read grant insufficient for write
  });

  it("project-scoped write requires write|admin|owner", async () => {
    const writer = { ...orgAdmin, projectGrants: [{ projectId: "proj-1", effectiveRole: "write" as const }] };
    expect(await allowed(writer, projDash, "write")).toBe(true);
    expect(await allowed(writer, projDash, "admin")).toBe(false);
  });

  it("project-scoped admin requires admin|owner", async () => {
    const admin = { ...orgAdmin, projectGrants: [{ projectId: "proj-1", effectiveRole: "admin" as const }] };
    expect(await allowed(admin, projDash, "admin")).toBe(true);
    expect(await allowed(admin, projDash, "write")).toBe(true);
  });

  it("project owner authorizes read+write+admin", async () => {
    const owner = { ...orgAdmin, projectGrants: [{ projectId: "proj-1", effectiveRole: "owner" as const }] };
    expect(await allowed(owner, projDash, "read")).toBe(true);
    expect(await allowed(owner, projDash, "write")).toBe(true);
    expect(await allowed(owner, projDash, "admin")).toBe(true);
  });

  it("NEGATIVE: a non-grant-holder is denied on a project dashboard EVEN past the owner gate", async () => {
    // orgAdmin passes the owner-level gate (org admin) but holds NO project grant.
    expect(await allowed(orgAdmin, projDash, "read")).toBe(false);
  });

  it("regression: org-scoped dashboard authorizes identically with or without grants", async () => {
    const withGrants = { ...orgAdmin, projectGrants: [{ projectId: "proj-other", effectiveRole: "owner" as const }] };
    expect(await allowed(withGrants, orgDash, "read")).toBe(true);
    expect(await allowed(orgAdmin, orgDash, "read")).toBe(true);
  });

  it("not-found dashboard id throws dashboard_not_found", async () => {
    const err = await requireDashboardAccess(orgAdmin, "missing-id", "read").catch((e) => e);
    expect(err).toBeInstanceOf(DashboardAccessError);
    expect((err as DashboardAccessError).code).toBe("dashboard_not_found");
  });
});
