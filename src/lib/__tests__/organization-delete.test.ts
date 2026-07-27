import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { TERMINAL_RUN_STATUSES } from "@cinatra-ai/agents/run-status";

// ---------------------------------------------------------------------------
// Reference-guarded organization delete, rebuilt on the org-write kernel
// (cinatra#1510 / #1939 wave 3). A fake transactional executor renders every
// issued statement to real SQL text (PgDialect.sqlToQuery), so these tests pin
// the EXACT wire shape: the kernel's exclusive-fence queries (both advisory
// locks + the locked lifecycle-state read), the registry-DERIVED blocker
// re-count (incl. the #1939 tightenings), the furniture-only deletes (default
// dashboards + the kernel tables + BA rows), the session repoint, and the
// org-row delete with an exact affected-row assertion. Plus the Decision-1
// activation-coupled six-cell (gate × state) matrix and the archive-can't-
// delete permission invariant.
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

type Issued = { text: string; params: unknown[] };
type FakeRow = Record<string, unknown>;

const issued: Issued[] = [];
let orgRow: { id: string; slug: string | null } | null;
/** null = active org; a date = archived (drives the kernel's locked state read). */
let orgArchivedAt: Date | string | null;
let actorIsOwner: boolean;
let counts: FakeRow;
let orgDeleteRowCount: number;

function fakeExecute(query: unknown): Promise<{ rows: FakeRow[]; rowCount: number }> {
  const rendered = dialect.sqlToQuery(
    query as Parameters<PgDialect["sqlToQuery"]>[0],
  );
  const text = rendered.sql.replace(/\s+/g, " ").trim();
  issued.push({ text, params: rendered.params });
  // ---- kernel guard queries (guardOrgLifecycleMutation) ----
  if (text.includes("pg_advisory_xact_lock")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (text.includes('COALESCE("archiveEpoch"')) {
    // The locked lifecycle-state read — active vs archived.
    return Promise.resolve({
      rows: [{ archivedAt: orgArchivedAt, archiveEpoch: 0 }],
      rowCount: 1,
    });
  }
  // ---- writer queries (inside the fence) ----
  if (text.includes("FOR UPDATE")) {
    return Promise.resolve({ rows: orgRow ? [orgRow] : [], rowCount: orgRow ? 1 : 0 });
  }
  if (text.includes("AS is_owner")) {
    return Promise.resolve({
      rows: actorIsOwner ? [{ is_owner: 1 }] : [],
      rowCount: actorIsOwner ? 1 : 0,
    });
  }
  if (text.includes('AS "teams"')) {
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
  readSingleOrgModeStrict: (...a: unknown[]) => isSingleOrgMode(...a),
}));

const readConnectorConfigFromDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (...a: unknown[]) =>
    readConnectorConfigFromDatabase(...a),
}));

const resolveOrgRoleForUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

const roleHasPermission = vi.fn();
vi.mock("@/lib/authz/policies", () => ({
  roleHasPermission: (...a: unknown[]) => roleHasPermission(...a),
}));

vi.mock("@/lib/better-auth-db", async () => {
  const { pgTable, text } = await import("drizzle-orm/pg-core");
  return {
    betterAuthOrganizations: pgTable("organization", {
      id: text("id").primaryKey(),
      slug: text("slug"),
    }),
    betterAuthDb: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (orgRow ? [{ slug: orgRow.slug }] : []),
          }),
        }),
      }),
      execute: (q: unknown) => fakeExecute(q),
      // The kernel guard opens the transaction; the callback receives a tx that
      // answers BOTH the kernel's own queries and the writer's statements.
      transaction: async (cb: (tx: { execute: typeof fakeExecute }) => Promise<unknown>) =>
        cb({ execute: fakeExecute }),
    },
  };
});

import {
  countOrganizationDeleteBlockers,
  deleteOrganizationReferenceGuarded,
  hasOrganizationDeleteBlockers,
  type OrganizationDeleteBlockers,
} from "@/lib/organization-delete";

const ORG = "org_target";
const SCHEMA = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""');
const ACTOR = "user_owner";

const ZERO_COUNTS: FakeRow = {
  teams: "0",
  activeProjects: "0",
  installedExtensions: "0",
  dashboards: "0",
  agents: "0",
  liveAgentRuns: "0",
};

const ZERO_BLOCKERS: OrganizationDeleteBlockers = {
  teams: 0,
  activeProjects: 0,
  installedExtensions: 0,
  dashboards: 0,
  agents: 0,
  liveAgentRuns: 0,
};

beforeEach(() => {
  issued.length = 0;
  orgRow = { id: ORG, slug: "acme" };
  orgArchivedAt = null; // active by default
  actorIsOwner = true;
  counts = { ...ZERO_COUNTS };
  orgDeleteRowCount = 1;
  isSingleOrgMode.mockReset();
  isSingleOrgMode.mockResolvedValue(false);
  resolveOrgRoleForUser.mockReset();
  resolveOrgRoleForUser.mockResolvedValue("org_owner");
  roleHasPermission.mockReset();
  roleHasPermission.mockReturnValue(true); // owner holds every permission
  readConnectorConfigFromDatabase.mockReset();
  readConnectorConfigFromDatabase.mockReturnValue(null); // activation gate OFF
});

describe("countOrganizationDeleteBlockers — registry-derived inventory", () => {
  it("maps bigint-string counts to numbers per kind (six kinds now)", async () => {
    counts = {
      teams: "2",
      activeProjects: "1",
      installedExtensions: "3",
      dashboards: "4",
      agents: "5",
      liveAgentRuns: "6",
    };
    const blockers = await countOrganizationDeleteBlockers(ORG);
    expect(blockers).toEqual({
      teams: 2,
      activeProjects: 1,
      installedExtensions: 3,
      dashboards: 4,
      agents: 5,
      liveAgentRuns: 6,
    });
    expect(hasOrganizationDeleteBlockers(blockers)).toBe(true);
    expect(hasOrganizationDeleteBlockers(ZERO_BLOCKERS)).toBe(false);
  });

  it("derives the blocker SQL from the registry incl. the two #1939 tightenings", async () => {
    await countOrganizationDeleteBlockers(ORG);
    const text = issued[0].text;
    expect(text).toContain('FROM public."team"');
    expect(text).toContain(`FROM "${SCHEMA}"."projects"`);
    expect(text).toContain("archived_at IS NULL");
    expect(text).toContain(`FROM "${SCHEMA}"."installed_extension"`);
    // Tightening 1: ALL installed-extension kinds block — NO connector filter.
    expect(text).not.toContain("kind = 'connector'");
    expect(text).toContain(`FROM "${SCHEMA}"."dashboards"`);
    expect(text).toContain("is_default = false");
    expect(text).toContain(`FROM "${SCHEMA}"."agent_templates"`);
    expect(text).toContain("origin->>'scope'");
    // Tightening 2: NON-TERMINAL agent runs block, via the run-status source.
    expect(text).toContain(`FROM "${SCHEMA}"."agent_runs"`);
    expect(text).toContain("status NOT IN");
  });

  it("the non-terminal-run predicate is pinned to TERMINAL_RUN_STATUSES (single source)", async () => {
    await countOrganizationDeleteBlockers(ORG);
    // Every terminal status the agents module declares must appear as a bound
    // param of the agent_runs blocker — so #1940's terminal unification stays
    // one source of truth.
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(issued[0].params).toContain(status);
    }
  });
});

describe("deleteOrganizationReferenceGuarded — the exclusive-fence statement set", () => {
  it("clean delete: BOTH locks → locked state read → recount → furniture + kernel tables + org row", async () => {
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: true });

    const texts = issued.map((s) => s.text);
    // 1. Kernel exclusive fence: epoch lock THEN write lock (both, ordered).
    expect(texts[0]).toContain("pg_advisory_xact_lock");
    expect(issued[0].params).toContain("cinatra-org-archive-epoch");
    expect(texts[1]).toContain("pg_advisory_xact_lock");
    expect(issued[1].params).toContain("cinatra-org-write");
    // 2. Locked lifecycle-state read (the kernel's FOR SHARE state read).
    expect(texts[2]).toContain('COALESCE("archiveEpoch"');
    // 3. FOR UPDATE row pin AFTER the locks.
    const forUpdate = texts.find((t) => t.includes("FOR UPDATE"));
    expect(forUpdate).toContain('FROM public."organization"');
    // 4. Owner re-verify + recount under the fence.
    expect(texts.some((t) => t.includes("AS is_owner") && t.includes("role = 'owner'"))).toBe(true);
    expect(texts.some((t) => t.includes('AS "teams"'))).toBe(true);
    // 5. Furniture: default dashboards + the two kernel tables + BA rows.
    expect(texts.some((t) => t.includes(`DELETE FROM "${SCHEMA}"."dashboards"`) && t.includes("is_default = true"))).toBe(true);
    expect(texts.some((t) => t.includes(`DELETE FROM "${SCHEMA}"."org_archive_lease"`))).toBe(true);
    expect(texts.some((t) => t.includes(`DELETE FROM "${SCHEMA}"."org_write_completion_ticket"`))).toBe(true);
    expect(texts.some((t) => t.includes('DELETE FROM public."invitation"'))).toBe(true);
    expect(texts.some((t) => t.includes('DELETE FROM public."member"'))).toBe(true);
    expect(texts.some((t) => t.includes('UPDATE public."session"') && t.includes('"activeOrganizationId" = NULL'))).toBe(true);
    // 6. The org row goes LAST (its FK cascades clean role_grant / etc.).
    expect(texts[texts.length - 1]).toContain('DELETE FROM public."organization"');
    // NEVER a delete against anything with its own lifecycle.
    for (const t of texts) {
      expect(t).not.toMatch(/DELETE FROM .*"team"/);
      expect(t).not.toMatch(/DELETE FROM .*"projects"/);
      expect(t).not.toMatch(/DELETE FROM .*"installed_extension"/);
      expect(t).not.toMatch(/DELETE FROM .*"agent_templates"/);
      expect(t).not.toMatch(/DELETE FROM .*"agent_runs"/);
    }
  });

  it("table-driven: one planted row per block-ruling → refusal with the exact per-kind count", async () => {
    const kinds: (keyof OrganizationDeleteBlockers)[] = [
      "teams",
      "activeProjects",
      "installedExtensions",
      "dashboards",
      "agents",
      "liveAgentRuns",
    ];
    for (const kind of kinds) {
      issued.length = 0;
      counts = { ...ZERO_COUNTS, [kind]: "1" };
      const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
      expect(result).toEqual({
        ok: false,
        reason: "blocked",
        blockers: { ...ZERO_BLOCKERS, [kind]: 1 },
      });
      // A blocked delete writes NOTHING.
      expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
      expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
    }
  });

  it("org row missing: not-found, nothing written (pre-tx fence catches it)", async () => {
    orgRow = null;
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(issued).toHaveLength(0);
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

  it("actor no longer an owner (demoted/removed mid-flight): denied under the fence, nothing written", async () => {
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

describe("Decision 1 — activation-coupled archived-only flip (six-cell gate × state matrix)", () => {
  const gateOff = () => readConnectorConfigFromDatabase.mockReturnValue({ enabled: false });
  const gateOn = () => readConnectorConfigFromDatabase.mockReturnValue({ enabled: true });
  const gateError = () =>
    readConnectorConfigFromDatabase.mockImplementation(() => {
      throw new Error("config store down");
    });

  it("gate OFF + active → legacy allow (delete works today, byte-identical UX)", async () => {
    gateOff();
    orgArchivedAt = null;
    expect(await deleteOrganizationReferenceGuarded(ORG, ACTOR)).toEqual({ ok: true });
    // Transitional demand is org.lifecycle → checked via organization.archive.
    expect(roleHasPermission).toHaveBeenCalledWith("org_owner", "organization.archive");
  });

  it("gate OFF + archived → allow (archived delete is always legal)", async () => {
    gateOff();
    orgArchivedAt = new Date();
    expect(await deleteOrganizationReferenceGuarded(ORG, ACTOR)).toEqual({ ok: true });
  });

  it("gate ON + active → typed not-archived refusal (archive first)", async () => {
    gateOn();
    orgArchivedAt = null;
    expect(await deleteOrganizationReferenceGuarded(ORG, ACTOR)).toEqual({
      ok: false,
      reason: "not-archived",
    });
    // Nothing was written — the kernel refused before the writer body ran.
    expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
  });

  it("gate ON + archived → allow via org.delete", async () => {
    gateOn();
    orgArchivedAt = new Date();
    expect(await deleteOrganizationReferenceGuarded(ORG, ACTOR)).toEqual({ ok: true });
    expect(roleHasPermission).toHaveBeenCalledWith("org_owner", "organization.delete");
  });

  it("gate READ-ERROR + active → error result (fail-closed, names the activation config)", async () => {
    gateError();
    orgArchivedAt = null;
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      if (result.reason === "error") {
        expect(result.error).toContain("org_archive_activation");
      }
    }
    expect(issued.some((s) => s.text.startsWith("DELETE"))).toBe(false);
  });

  it("gate READ-ERROR + archived → error result too (never fail-open in either direction)", async () => {
    gateError();
    orgArchivedAt = new Date();
    const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
  });
});

describe("Decision 1 — permission invariant: organization.archive can NEVER delete", () => {
  it("an actor holding organization.archive but NOT organization.delete is refused in BOTH gate states", async () => {
    // The hypothetical archive-only role: has archive, lacks delete.
    roleHasPermission.mockImplementation(
      (_role: unknown, perm: unknown) => perm !== "organization.delete",
    );
    for (const gate of [{ enabled: false }, { enabled: true }]) {
      issued.length = 0;
      readConnectorConfigFromDatabase.mockReturnValue(gate);
      const result = await deleteOrganizationReferenceGuarded(ORG, ACTOR);
      expect(result).toEqual({ ok: false, reason: "denied" });
      // Refused app-side BEFORE minting/using any authority — zero statements.
      expect(issued).toHaveLength(0);
    }
  });

  it("a non-member (no resolved role) is denied", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    expect(await deleteOrganizationReferenceGuarded(ORG, ACTOR)).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(issued).toHaveLength(0);
  });
});
