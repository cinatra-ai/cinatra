import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// The REAL organization archive/unarchive transaction (cinatra#1942 V5,
// archive program S6) — built on guardOrgLifecycleMutation (its second
// consumer, after the guarded delete). A fake transactional executor renders
// every issued statement to real SQL text (PgDialect.sqlToQuery, the
// organization-delete.test.ts discipline), so these tests pin the EXACT wire
// shape: SET LOCAL lock_timeout FIRST (the owner-ruled bounded wait), the
// kernel's exclusive-fence queries (both advisory locks in epoch→write order
// + the locked lifecycle-state read), the FOR UPDATE row pin, the in-tx
// owner re-verify BEFORE the idempotent check (never leak success to a non-owner), the epoch bump,
// the verbatim kernel lease snapshot keyed to the NEW epoch (Decision 2b),
// the atomic session deactivation (org + team-by-ownership, Decision 2a),
// and — the Decision 11 owner ruling — ZERO run writes.
//
// Plus: the six-cell {gate off/on/error} × {active/archived} matrix (gate
// check FIRST — merging V5 pre-flip leaves production byte-identical), the
// ASYMMETRY pin (gate-off + archived → unarchive succeeds), unarchive's
// deliberate single-org-mode leniency, and the bounded lock-timeout retry
// (55P03 → backoff → ceiling, never an unbounded spin).
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

type Issued = { text: string; params: unknown[] };
type FakeRow = Record<string, unknown>;

const issued: Issued[] = [];
let orgRow: { id: string; slug: string | null } | null;
/** Drives BOTH the kernel's locked state read and the FOR UPDATE pin. */
let orgArchivedAt: Date | string | null;
let orgArchiveEpoch: number;
/** Overrides the FOR UPDATE pin's slug (in-tx re-check vs pre-tx eligibility). */
let pinnedSlug: string | null | undefined;
let actorIsOwner: boolean;
/** When > 0, the next N advisory-lock acquisitions throw SQLSTATE 55P03. */
let lockTimeoutsRemaining: number;
/** When set, the advisory-lock acquisition throws this (non-lock error cell). */
let lockError: Error | undefined;

function fakeExecute(query: unknown): Promise<{ rows: FakeRow[]; rowCount: number }> {
  const rendered = dialect.sqlToQuery(
    query as Parameters<PgDialect["sqlToQuery"]>[0],
  );
  const text = rendered.sql.replace(/\s+/g, " ").trim();
  issued.push({ text, params: rendered.params });
  // ---- kernel guard queries (guardOrgLifecycleMutation) ----
  if (text.includes("pg_advisory_xact_lock")) {
    if (lockError) throw lockError;
    if (lockTimeoutsRemaining > 0) {
      lockTimeoutsRemaining -= 1;
      const err = new Error("canceling statement due to lock timeout") as Error & {
        code: string;
      };
      err.code = "55P03";
      throw err;
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (text.includes('COALESCE("archiveEpoch"') && text.includes("FOR SHARE")) {
    return Promise.resolve({
      rows: [{ archivedAt: orgArchivedAt, archiveEpoch: orgArchiveEpoch }],
      rowCount: 1,
    });
  }
  // ---- writer queries (inside the fence) ----
  if (text.includes("FOR UPDATE")) {
    if (!orgRow) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [
        {
          id: orgRow.id,
          slug: pinnedSlug !== undefined ? pinnedSlug : orgRow.slug,
          archivedAt: orgArchivedAt,
          archiveEpoch: orgArchiveEpoch,
        },
      ],
      rowCount: 1,
    });
  }
  if (text.includes("AS is_owner")) {
    return Promise.resolve({
      rows: actorIsOwner ? [{ is_owner: 1 }] : [],
      rowCount: actorIsOwner ? 1 : 0,
    });
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
      transaction: async (cb: (tx: { execute: typeof fakeExecute }) => Promise<unknown>) =>
        cb({ execute: fakeExecute }),
    },
  };
});

import {
  archiveOrganization,
  unarchiveOrganization,
  isArchiveActivationEnabled,
} from "@/lib/organization-archive";

const ORG = "org_target";
const ACTOR = "user_owner";
const SCHEMA = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""');

/** Deterministic, instant retry options for every test (no real sleeping). */
const sleeps: number[] = [];
const FAST_RETRY = {
  backoffBaseMs: 10,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
};

const gateOff = () => readConnectorConfigFromDatabase.mockReturnValue({ enabled: false });
const gateOn = () => readConnectorConfigFromDatabase.mockReturnValue({ enabled: true });
const gateError = () =>
  readConnectorConfigFromDatabase.mockImplementation(() => {
    throw new Error("config store down");
  });

beforeEach(() => {
  issued.length = 0;
  sleeps.length = 0;
  orgRow = { id: ORG, slug: "acme" };
  orgArchivedAt = null;
  orgArchiveEpoch = 0;
  pinnedSlug = undefined;
  actorIsOwner = true;
  lockTimeoutsRemaining = 0;
  lockError = undefined;
  isSingleOrgMode.mockReset();
  isSingleOrgMode.mockResolvedValue(false);
  resolveOrgRoleForUser.mockReset();
  resolveOrgRoleForUser.mockResolvedValue("org_owner");
  roleHasPermission.mockReset();
  roleHasPermission.mockReturnValue(true);
  readConnectorConfigFromDatabase.mockReset();
  readConnectorConfigFromDatabase.mockReturnValue(null); // gate OFF by default
});

describe("six-cell gate × state matrix (gate check FIRST — the stub's invariant)", () => {
  it("gate OFF + active → activation-gate-off, ZERO statements (pre-flip prod is byte-identical)", async () => {
    gateOff();
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "activation-gate-off",
    });
    expect(issued).toHaveLength(0);
    // The gate is the FIRST check: no role/eligibility read ran either.
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
    expect(isSingleOrgMode).not.toHaveBeenCalled();
  });

  it("gate OFF + archived → archive still refuses gate-off (state is irrelevant pre-gate)", async () => {
    gateOff();
    orgArchivedAt = new Date();
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "activation-gate-off",
    });
    expect(issued).toHaveLength(0);
  });

  it("gate READ-ERROR (either state) → activation-gate-off (fail-closed OFF, never activate on error)", async () => {
    gateError();
    for (const archivedAt of [null, new Date()]) {
      issued.length = 0;
      orgArchivedAt = archivedAt;
      await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
        ok: false,
        reason: "activation-gate-off",
      });
      expect(issued).toHaveLength(0);
    }
  });

  it("gate ON + active → archives (the full exclusive-fence statement set, in order)", async () => {
    gateOn();
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({ ok: true });

    const texts = issued.map((s) => s.text);
    // 0. Bounded wait (owner-ruled): lock_timeout is set BEFORE any lock wait.
    expect(texts[0]).toBe("SET LOCAL lock_timeout = '3000ms'");
    // 1. Kernel exclusive fence: epoch lock THEN write lock (both, ordered).
    expect(texts[1]).toContain("pg_advisory_xact_lock");
    expect(issued[1].params).toContain("cinatra-org-archive-epoch");
    expect(texts[2]).toContain("pg_advisory_xact_lock");
    expect(issued[2].params).toContain("cinatra-org-write");
    // 2. Locked lifecycle-state read (the kernel's FOR SHARE read).
    expect(texts[3]).toContain('COALESCE("archiveEpoch"');
    // 3. FOR UPDATE row pin AFTER the locks.
    const forUpdate = texts.find((t) => t.includes("FOR UPDATE"));
    expect(forUpdate).toContain('FROM public."organization"');
    // 4. Owner re-verify under the fence, BEFORE any write.
    const ownerIdx = texts.findIndex((t) => t.includes("AS is_owner"));
    const archiveWriteIdx = texts.findIndex((t) => t.includes('"archivedAt" = now()'));
    expect(ownerIdx).toBeGreaterThan(-1);
    expect(archiveWriteIdx).toBeGreaterThan(ownerIdx);
    // 5. The archive marker + epoch bump (bound to old+1 = 1).
    expect(texts[archiveWriteIdx]).toContain('UPDATE public."organization"');
    expect(issued[archiveWriteIdx].params).toContain(1);
    // 6. The VERBATIM kernel lease snapshot, in-fence, keyed to the NEW epoch.
    const snapshot = issued.find((s) => s.text.includes('"org_archive_lease"'));
    expect(snapshot).toBeDefined();
    expect(snapshot!.text).toContain(`INSERT INTO "${SCHEMA}"."org_archive_lease"`);
    expect(snapshot!.text).toContain("ON CONFLICT (org_id, archive_epoch, run_id) DO NOTHING");
    expect(snapshot!.params).toContain(1); // the NEW epoch
    expect(snapshot!.params).toContain(ORG);
    // 7. Atomic session deactivation: org sessions AND team-by-ownership.
    expect(
      texts.some((t) => t.includes('UPDATE public."session"') && t.includes('"activeOrganizationId" = NULL')),
    ).toBe(true);
    const teamClear = texts.find(
      (t) => t.includes('UPDATE public."session"') && t.includes('"activeTeamId" = NULL'),
    );
    expect(teamClear).toContain('SELECT id FROM public."team"');
    // 8. TOTAL FREEZE (owner-ruled): ZERO run writes — parked runs
    //    stay exactly as they are; the drain path is unarchive.
    for (const t of texts) {
      expect(t).not.toMatch(/UPDATE\s+"[^"]*"\."agent_runs"/);
      expect(t).not.toMatch(/UPDATE\s+agent_runs/);
    }
  });

  it("gate ON + archived → idempotent no-op success (owner-verified first), nothing written", async () => {
    gateOn();
    orgArchivedAt = new Date();
    orgArchiveEpoch = 1;
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: true,
      idempotent: true,
    });
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
    expect(issued.some((s) => s.text.startsWith("INSERT"))).toBe(false);
  });

  it("owner re-verify runs BEFORE the idempotent return: a demoted actor gets denied, never an idempotent success leak (owner-verify-first pin)", async () => {
    gateOn();
    orgArchivedAt = new Date();
    actorIsOwner = false;
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });
});

describe("eligibility + authorization fences (archive)", () => {
  beforeEach(gateOn);

  it("single-org mode → refused before any statement", async () => {
    isSingleOrgMode.mockResolvedValue(true);
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "single-org-mode",
    });
    expect(issued).toHaveLength(0);
  });

  it("default org (pre-tx eligibility) → refused before any statement", async () => {
    orgRow = { id: ORG, slug: "default" };
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "default-org",
    });
    expect(issued).toHaveLength(0);
  });

  it("default org (in-tx FOR UPDATE re-check, hazard 1): refused even when the pre-tx read raced", async () => {
    pinnedSlug = "default"; // eligibility saw 'acme'; the pinned row is 'default'
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "default-org",
    });
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });

  it("org row missing → not-found, zero statements (pre-tx fence)", async () => {
    orgRow = null;
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(issued).toHaveLength(0);
  });

  it("eligibility mode read unavailable → typed error (fail-closed, never guesses)", async () => {
    isSingleOrgMode.mockRejectedValue(new Error("config store down"));
    const result = await archiveOrganization(ORG, ACTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.error).toContain("lifecycle eligibility unavailable");
    }
  });

  it("a non-member (no resolved role) is denied before any statement", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    await expect(archiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    expect(issued).toHaveLength(0);
  });

  it("a member without organization.archive mints a can()=false authority — the KERNEL refuses (denied), nothing written", async () => {
    roleHasPermission.mockReturnValue(false);
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    // The kernel refused after its locks + state read — but wrote nothing.
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
    expect(issued.some((s) => s.text.startsWith("INSERT"))).toBe(false);
    expect(roleHasPermission).toHaveBeenCalledWith("org_owner", "organization.archive");
  });

  it("in-tx owner demotion (active org) → denied, tx rolled back with zero writes", async () => {
    actorIsOwner = false;
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });
});

describe("unarchive — the ASYMMETRIC direction (Decision 2)", () => {
  it("gate OFF + archived → unarchive SUCCEEDS (the rollback path depends on this pin)", async () => {
    gateOff();
    orgArchivedAt = new Date();
    orgArchiveEpoch = 1;
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({ ok: true });

    const texts = issued.map((s) => s.text);
    // The gate was never consulted — the config read mock stays gate-off and
    // the transition still ran (readConnectorConfig may be called by nothing).
    const clearIdx = texts.findIndex((t) => t.includes('"archivedAt" = NULL'));
    expect(clearIdx).toBeGreaterThan(-1);
    expect(issued[clearIdx].params).toContain(2); // epoch 1 → 2
    // Superseded-epoch lease invalidation (the verbatim kernel shape).
    const invalidate = issued.find((s) =>
      s.text.includes(`DELETE FROM "${SCHEMA}"."org_archive_lease"`),
    );
    expect(invalidate).toBeDefined();
    expect(invalidate!.text).toContain("archive_epoch <");
    expect(invalidate!.params).toContain(2);
    // Sessions deliberately untouched on unarchive.
    expect(texts.some((t) => t.includes('UPDATE public."session"'))).toBe(false);
  });

  it("single-org mode does NOT block unarchive (recovery leniency — deliberately no eligibility fence)", async () => {
    gateOff();
    isSingleOrgMode.mockResolvedValue(true);
    orgArchivedAt = new Date();
    orgArchiveEpoch = 3;
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({ ok: true });
  });

  it("already active → idempotent no-op success (owner-verified first)", async () => {
    orgArchivedAt = null;
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: true,
      idempotent: true,
    });
    expect(issued.some((s) => s.text.startsWith("UPDATE"))).toBe(false);
  });

  it("owner re-verify still binds: a demoted actor is denied even on the idempotent path", async () => {
    orgArchivedAt = null;
    actorIsOwner = false;
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("a non-member is denied; authorization is NOT relaxed by the recovery leniency", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    orgArchivedAt = new Date();
    await expect(unarchiveOrganization(ORG, ACTOR)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    expect(issued).toHaveLength(0);
  });

  it("org row missing → not-found (the in-tx pin is the fence — no pre-tx eligibility read)", async () => {
    orgRow = null;
    orgArchivedAt = new Date();
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("bounded lock wait (owner-ruled — lock_timeout + retry ceiling, never a spin)", () => {
  beforeEach(gateOn);

  it("a lock timeout (55P03) is retried with exponential backoff and eventually succeeds", async () => {
    lockTimeoutsRemaining = 2; // attempts 1 + 2 time out; attempt 3 wins
    await expect(archiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([10, 20]); // backoffBaseMs * 2^(attempt-1)
    // Every attempt re-set the transaction-local lock_timeout.
    expect(issued.filter((s) => s.text.startsWith("SET LOCAL lock_timeout")).length).toBe(3);
  });

  it("exhausting the retry ceiling yields a typed error result naming the bounded attempts", async () => {
    lockTimeoutsRemaining = 99;
    const result = await archiveOrganization(ORG, ACTOR, FAST_RETRY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.error).toContain("bounded attempts");
    }
    expect(sleeps).toEqual([10, 20]); // 3 attempts ⇒ 2 backoffs, then stop
  });

  it("a NON-lock error is not retried (single attempt, no backoff)", async () => {
    lockError = new Error("connection reset");
    const result = await archiveOrganization(ORG, ACTOR, FAST_RETRY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
    expect(sleeps).toEqual([]);
    expect(issued.filter((s) => s.text.startsWith("SET LOCAL lock_timeout")).length).toBe(1);
  });

  it("the lock_timeout value is transaction-local and overridable (test seam only)", async () => {
    await expect(
      archiveOrganization(ORG, ACTOR, { ...FAST_RETRY, lockTimeoutMs: 750 }),
    ).resolves.toEqual({ ok: true });
    expect(issued[0].text).toBe("SET LOCAL lock_timeout = '750ms'");
  });

  it("unarchive rides the same bounded wait", async () => {
    orgArchivedAt = new Date();
    lockTimeoutsRemaining = 1;
    await expect(unarchiveOrganization(ORG, ACTOR, FAST_RETRY)).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([10]);
  });
});

describe("isArchiveActivationEnabled — unchanged fail-closed gate (S1 semantics preserved)", () => {
  it("only a stored literal true enables; errors mean OFF", async () => {
    gateOn();
    await expect(isArchiveActivationEnabled()).resolves.toBe(true);
    gateError();
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
    readConnectorConfigFromDatabase.mockReturnValue({ enabled: "true" });
    await expect(isArchiveActivationEnabled()).resolves.toBe(false);
  });
});
