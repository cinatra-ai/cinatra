// Fixture tests for the app-native archived-org write bypass gate
// (cinatra#1942 archive V2 — Decision 5's "lockstep grep-gate style test,
// like the writer-manifest").
//
// The gate's value is two-directional: a NEW app-native write to
// member/invitation/teamMember/session.activeOrganizationId/activeTeamId
// that is not enumerated (and not gated via assertTargetOrgNotArchived) fails
// CI, and an allowlist row the scanner no longer finds fails too. These
// tests hold every half of that claim:
//
//   1. A synthetic unlisted write site FAILS — raw-SQL table form, Drizzle
//      symbol form, and the session-column form (both raw-SQL and Drizzle).
//   2. Legitimate non-write traffic does NOT trip the gate (SELECT, prose,
//      an unrelated session column, a bare unqualified table).
//   3. Two-directional drift: unlisted, stale row, and count drift each fail.
//   4. The gate is green on the real tree and its committed allowlist
//      matches the current surface (zero-baseline) — this also makes the
//      gate RUN in CI (scripts/audit/__tests__/** is in the root Vitest
//      include glob).
//   5. Every allowlist row carries a real (non-TODO) reason.
//
// The matcher is IMPORTED from the gate, so a fixture can never assert a
// rule that differs from what CI enforces.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BYPASS_SYMBOLS,
  BYPASS_TABLES,
  collectScanFiles,
  computeSurface,
  diffAllowlist,
  isScannable,
  loadAllowlist,
  scanSessionColumnWrites,
} from "../org-archive-bypass-scan.mjs";
import { scanSource } from "../system-writer-manifest-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE_REL = "scripts/audit/org-archive-bypass-scan.mjs";

// ---------------------------------------------------------------------------
// 1. A synthetic unlisted write site is caught — every form.
// ---------------------------------------------------------------------------

describe("a new app-native write site is caught — table forms (member/invitation/teamMember)", () => {
  it.each([
    ["raw SQL, bare-qualified (member-actions.ts's own style)", 'await q(`INSERT INTO public.member (id) VALUES ($1)`);', "member"],
    ["raw SQL, quoted table", 'await q(`DELETE FROM public."invitation" WHERE id=$1`);', "invitation"],
    ["raw SQL, quoted table (teamMember)", 'await q(`UPDATE public."teamMember" SET role=$1`);', "teamMember"],
    ["Drizzle builder on betterAuthMembers", "await db.insert(betterAuthMembers).values(row);", "betterAuthMembers"],
    ["Drizzle builder on betterAuthTeamMembers", "await db.delete(betterAuthTeamMembers).where(x);", "betterAuthTeamMembers"],
  ])("catches %s", (_label, code, target) => {
    const hits = scanSource(code, { tables: BYPASS_TABLES, symbols: BYPASS_SYMBOLS, writerNames: [] });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.target === target)).toBe(true);
  });
});

describe("a new app-native write site is caught — session lifecycle columns", () => {
  it.each([
    [
      "raw SQL UPDATE session SET activeOrganizationId",
      'await q(`UPDATE public."session" SET "activeOrganizationId"=NULL WHERE "activeOrganizationId"=$1`);',
      "activeOrganizationId",
    ],
    [
      "raw SQL UPDATE session SET activeTeamId",
      'await q(`UPDATE public."session" SET "activeTeamId"=NULL WHERE "activeTeamId" IN (SELECT id FROM team)`);',
      "activeTeamId",
    ],
    [
      "Drizzle .update(betterAuthSessions).set({activeOrganizationId})",
      "await db.update(betterAuthSessions).set({ activeOrganizationId: orgId }).where(x);",
      "activeOrganizationId",
    ],
    [
      "Drizzle .update(betterAuthSessions).set({activeTeamId})",
      "await db.update(betterAuthSessions).set({ activeTeamId: null }).where(x);",
      "activeTeamId",
    ],
  ])("catches %s", (_label, code, column) => {
    const hits = scanSessionColumnWrites(code);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ target: column, ref: `session-column:${column}` });
  });
});

// ---------------------------------------------------------------------------
// 2. Legitimate / non-write traffic is NOT flagged.
// ---------------------------------------------------------------------------

describe("legitimate traffic is not flagged", () => {
  it.each([
    ["a SELECT against member", 'await q(`SELECT id FROM public.member WHERE "userId"=$1`);'],
    ["a SELECT against session (read, not a lifecycle-column write)", 'await q(`SELECT "activeOrganizationId" FROM public."session" WHERE id=$1`);'],
    ["a Drizzle SELECT on betterAuthMembers", "await db.select().from(betterAuthMembers).where(x);"],
    ["prose mentioning member/invitation writes (comments are stripped)", "// we INSERT INTO public.member here\n/* UPDATE public.invitation is the cancel path */\nawait store.doThing();"],
    ["a session UPDATE that does NOT touch the two lifecycle columns", 'await q(`UPDATE public."session" SET "impersonatedBy"=$1 WHERE id=$2`);'],
    ["Drizzle .update on an unrelated session field", "await db.update(betterAuthSessions).set({ impersonatedBy: adminId }).where(x);"],
  ])("does not flag %s", (_label, code) => {
    const tableHits = scanSource(code, { tables: BYPASS_TABLES, symbols: BYPASS_SYMBOLS, writerNames: [] });
    const sessionHits = scanSessionColumnWrites(code);
    expect([...tableHits, ...sessionHits]).toEqual([]);
  });

  it("deliberately does NOT match a totally-bare, unqualified member (the org-write-table-sweep lesson)", () => {
    expect(
      scanSource("await q(`INSERT INTO member (id) VALUES ($1)`);", {
        tables: BYPASS_TABLES,
        symbols: BYPASS_SYMBOLS,
        writerNames: [],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Two-directional drift.
// ---------------------------------------------------------------------------

describe("two-directional drift", () => {
  it("computeSurface reports file, ref, and count for a synthetic tree", () => {
    const surface = computeSurface({
      files: ["src/app/rogue/actions.ts"],
      repoRoot: REPO_ROOT,
      readFileImpl: () =>
        'await q(`INSERT INTO public."teamMember" (id) VALUES ($1)`);\n' +
        "await db.update(betterAuthSessions).set({ activeOrganizationId: orgId }).where(x);\n",
    });
    expect(surface).toEqual([
      { file: "src/app/rogue/actions.ts", ref: "raw-sql:teamMember", count: 1 },
      { file: "src/app/rogue/actions.ts", ref: "session-column:activeOrganizationId", count: 1 },
    ]);
  });

  it("flags an UNLISTED write site (in the tree, absent from the allowlist)", () => {
    const surface = [{ file: "src/app/x.ts", ref: "raw-sql:member", count: 1 }];
    const { unlisted, stale, drifted } = diffAllowlist(surface, []);
    expect(unlisted).toHaveLength(1);
    expect(stale).toEqual([]);
    expect(drifted).toEqual([]);
  });

  it("flags a STALE allowlist row (in the allowlist, gone from the tree)", () => {
    const allowlist = [{ file: "src/app/gone.ts", ref: "raw-sql:member", count: 1 }];
    const { unlisted, stale, drifted } = diffAllowlist([], allowlist);
    expect(stale).toHaveLength(1);
    expect(unlisted).toEqual([]);
    expect(drifted).toEqual([]);
  });

  it("flags COUNT DRIFT in either direction", () => {
    const allowlist = [{ file: "src/app/x.ts", ref: "raw-sql:member", count: 3 }];
    const up = diffAllowlist([{ file: "src/app/x.ts", ref: "raw-sql:member", count: 5 }], allowlist);
    const down = diffAllowlist([{ file: "src/app/x.ts", ref: "raw-sql:member", count: 1 }], allowlist);
    expect(up.drifted).toEqual([{ file: "src/app/x.ts", ref: "raw-sql:member", found: 5, allowlist: 3 }]);
    expect(down.drifted).toEqual([{ file: "src/app/x.ts", ref: "raw-sql:member", found: 1, allowlist: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Green on the real tree (zero-baseline), and thereby runs in CI.
// ---------------------------------------------------------------------------

describe("the gate on the current tree", () => {
  it("scan roots are enumerable and exclude the gate corpus + tests + scripts/**", () => {
    const files = collectScanFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.startsWith("src/app/teams/"))).toBe(true);
    expect(files.some((f) => f === "src/lib/organization-delete.ts")).toBe(true);
    expect(files.every(isScannable)).toBe(true);
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(false);
    expect(files.some((f) => f.includes("__tests__"))).toBe(false);
  });

  it("the committed allowlist matches the current surface (zero-baseline)", () => {
    const surface = computeSurface({ repoRoot: REPO_ROOT });
    const allowlist = loadAllowlist(REPO_ROOT);
    const { unlisted, stale, drifted } = diffAllowlist(surface, allowlist.writers ?? []);
    expect({ unlisted, stale, drifted }).toEqual({ unlisted: [], stale: [], drifted: [] });
  });

  it("every allowlist row carries a real (non-TODO) reason", () => {
    const allowlist = loadAllowlist(REPO_ROOT);
    const missing = (allowlist.writers ?? []).filter((r) => !r.reason || /^TODO/i.test(r.reason));
    expect(missing).toEqual([]);
  });

  it("member-actions.ts's guarded teamMember writes are on the allowlist with the guard reason", () => {
    const allowlist = loadAllowlist(REPO_ROOT);
    const row = (allowlist.writers ?? []).find(
      (r) => r.file === "src/app/teams/[teamId]/settings/member-actions.ts",
    );
    expect(row).toBeTruthy();
    expect(row.reason).toMatch(/assertTargetOrgNotArchived/);
  });

  it("exits 0 against the repo as checked out", () => {
    const result = spawnSync("node", [GATE_REL], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.stderr ?? "").toBe("");
    expect(result.status).toBe(0);
  });
});
