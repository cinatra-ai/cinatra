import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Reference-guarded organization delete (cinatra#1510 remainder). A fake
// transactional executor renders every issued statement to real SQL text
// (PgDialect.sqlToQuery), so these tests pin the EXACT transactional statement
// set — the three hazards' handling is asserted on the wire shape, not on
// intent:
//   - blockers re-counted UNDER the org-row lock (pre-count is UX only),
//   - furniture-only deletes (default dashboards, invitations, members),
//   - the dangling active-org session UPDATE (hazard 2) inside the SAME tx,
//   - the org-row delete with an exact affected-row assertion,
//   - SERIALIZABLE isolation.
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

type Issued = { text: string; params: unknown[] };
type FakeRow = Record<string, unknown>;

const issued: Issued[] = [];
let orgRow: { id: string; slug: string | null } | null;
let actorIsOwner: boolean;
let counts: FakeRow;
let orgDeleteRowCount: number;
let capturedIsolation: string | undefined;

function fakeExecute(query: unknown): Promise<{ rows: FakeRow[]; rowCount: number }> {
  const rendered = dialect.sqlToQuery(
    query as Parameters<PgDialect["sqlToQuery"]>[0],
  );
  // Normalize whitespace so assertions are stable across template formatting.
  const text = rendered.sql.replace(/\s+/g, " ").trim();
  const params = rendered.params;
  issued.push({ text, params });
  if (text.includes("FOR UPDATE")) {
    return Promise.resolve({ rows: orgRow ? [orgRow] : [], rowCount: orgRow ? 1 : 0 });
  }
  if (text.includes("AS is_owner")) {
    return Promise.resolve({
      rows: actorIsOwner ? [{ is_owner: 1 }] : [],
      rowCount: actorIsOwner ? 1 : 0,
    });
  }
  if (text.includes('AS "teams"') || text.includes("AS teams")) {
    return Promise.resolve({ rows: [counts], rowCount: 1 });
  }
  if (text.includes('DELETE FROM public."organization"')) {
    return Promise.resolve({ rows: [], rowCount: orgDeleteRowCount });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

const isSingleOrgMode = vi.fn();
vi.mock("@/lib/authz/instance-mode", () => ({
  isSingleOrgMode: (...a: unknown[]) => isSingleOrgMode(...a),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    execute: (q: unknown) => fakeExecute(q),
    transaction: async (
      cb: (tx: { execute: typeof fakeExecute }) => Promise<void>,
      config?: { isolationLevel?: string },
    ) => {
      capturedIsolation = config?.isolationLevel;
      return cb({ execute: fakeExecute });
    },
  },
}));

import {
  countOrganizationDeleteBlockers,
  deleteOrganizationReferenceGuarded,
  hasOrganizationDeleteBlockers,
} from "@/lib/organization-delete";

const ORG = "org_target";
const SCHEMA = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""');

const ZERO_COUNTS: FakeRow = {
  teams: "0",
  active_projects: "0",
  connectors: "0",
  dashboards: "0",
  agents: "0",
};

const ACTOR = "user_owner";

beforeEach(() => {
  issued.length = 0;
  orgRow = { id: ORG, slug: "acme" };
  actorIsOwner = true;
  counts = { ...ZERO_COUNTS };
  orgDeleteRowCount = 1;
  capturedIsolation = undefined;
  isSingleOrgMode.mockReset();
  isSingleOrgMode.mockResolvedValue(false);
});

describe("countOrganizationDeleteBlockers — the five own-lifecycle kinds", () => {
  it("maps bigint-string counts to numbers per kind", async () => {
    counts = {
      teams: "2",
      active_projects: "1",
      connectors: "3",
      dashboards: "4",
      agents: "5",
    };
    const blockers = await countOrganizationDeleteBlockers(ORG);
    expect(blockers).toEqual({
      teams: 2,
      activeProjects: 1,
      connectors: 3,
      dashboards: 4,
      agents: 5,
    });
    expect(hasOrganizationDeleteBlockers(blockers)).toBe(true);
    expect(hasOrganizationDeleteBlockers({
      teams: 0, activeProjects: 0, connectors: 0, dashboards: 0, agents: 0,
    })).toBe(false);
  });

  it("counts ONLY own-lifecycle records: active projects (archived are inert), connector-kind installs, NON-default dashboards, org-bound agents", async () => {
    await countOrganizationDeleteBlockers(ORG);
    const text = issued[0].text;
    expect(text).toContain('FROM public."team"');
    expect(text).toContain(`FROM "${SCHEMA}"."projects"`);
    expect(text).toContain("archived_at IS NULL");
    expect(text).toContain(`FROM "${SCHEMA}"."installed_extension"`);
    expect(text).toContain("kind = 'connector'");
    expect(text).toContain(`FROM "${SCHEMA}"."dashboards"`);
    expect(text).toContain("is_default = false");
    expect(text).toContain(`FROM "${SCHEMA}"."agent_templates"`);
    expect(text).toContain("'org:'");
  });
});

describe("deleteOrganizationReferenceGuarded — the transactional statement set", () => {
  it("clean delete: lock → in-tx recount → furniture + session + org row, all in ONE serializable tx", async () => {
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: true });
    expect(capturedIsolation).toBe("serializable");

    const texts = issued.map((s) => s.text);
    // 1. Org-row lock first (also the in-tx default-org re-check source).
    expect(texts[0]).toContain('FROM public."organization"');
    expect(texts[0]).toContain("FOR UPDATE");
    // 2. Actor's owner membership re-verified UNDER the lock.
    expect(texts[1]).toContain("AS is_owner");
    expect(texts[1]).toContain("role = 'owner'");
    expect(issued[1].params).toContain(ACTOR);
    // 3. Blockers re-counted UNDER the lock.
    expect(texts[2]).toContain('FROM public."team"');
    // 4. Furniture: ONLY the default (entity-anchored Overview) dashboard rows.
    const dashboardsDelete = texts.find((t) =>
      t.includes(`DELETE FROM "${SCHEMA}"."dashboards"`),
    );
    expect(dashboardsDelete).toContain("is_default = true");
    // 5. Better-Auth furniture rows.
    expect(texts.some((t) => t.includes('DELETE FROM public."invitation"'))).toBe(true);
    expect(texts.some((t) => t.includes('DELETE FROM public."member"'))).toBe(true);
    // 6. Hazard 2: dangling active-org sessions cleared IN the same tx.
    const sessionUpdate = texts.find((t) => t.includes('UPDATE public."session"'));
    expect(sessionUpdate).toContain('"activeOrganizationId" = NULL');
    // 7. The org row goes LAST (its FK cascades clean role_grant /
    //    connector_access_policy / project_access).
    expect(texts[texts.length - 1]).toContain('DELETE FROM public."organization"');
    // Every statement is bound to the target org.
    for (const s of issued) expect(s.params).toContain(ORG);
    // NEVER any delete against teams / projects / installed_extension /
    // agent_templates — nothing with its own lifecycle is cascaded.
    for (const t of texts) {
      expect(t).not.toMatch(/DELETE FROM .*"team"/);
      expect(t).not.toMatch(/DELETE FROM .*"projects"/);
      expect(t).not.toMatch(/DELETE FROM .*"installed_extension"/);
      expect(t).not.toMatch(/DELETE FROM .*"agent_templates"/);
    }
  });

  it("in-tx blocker hit: rolls back with per-kind counts — NO write statement issues", async () => {
    counts = { ...ZERO_COUNTS, teams: "1", dashboards: "2" };
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({
      ok: false,
      reason: "blocked",
      blockers: { teams: 1, activeProjects: 0, connectors: 0, dashboards: 2, agents: 0 },
    });
    expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });

  it("org row missing: not-found, nothing written", async () => {
    orgRow = null;
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(issued).toHaveLength(1);
  });

  it("default org (in-tx re-check, hazard 1): refused even if the caller's gate raced", async () => {
    orgRow = { id: ORG, slug: "default" };
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: false, reason: "default-org" });
    expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
  });

  it("single-org mode re-checked at delete time (hazard 3): refused BEFORE any statement", async () => {
    isSingleOrgMode.mockResolvedValue(true);
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: false, reason: "single-org-mode" });
    expect(issued).toHaveLength(0);
  });

  it("actor no longer an owner (demoted/removed mid-flight): denied under the lock, nothing written", async () => {
    actorIsOwner = false;
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });

  it("org-row delete affecting != 1 rows: assertion failure → error result (tx rolled back)", async () => {
    orgDeleteRowCount = 0;
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({
      ok: false,
      reason: "error",
      error: "organization delete affected 0 rows (expected 1)",
    });
  });
});
