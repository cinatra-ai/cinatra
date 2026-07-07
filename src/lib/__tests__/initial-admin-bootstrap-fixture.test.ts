// Regression test for cinatra#1135: the dev-boot UAT fixture user
// (cinatra-uat@example.com, seeded by dev-auto-setup's ensureDevConnectActor)
// must NEVER consume the one-shot initial-admin bootstrap. Before this fix the
// fixture signed up as a regular `userType='human'` row and was routed through
// `ensureInitialAdminBootstrap`, so on every fresh dev install it was the
// "exactly 1 user" at boot: it took platform admin + Default-org ownership,
// and the first real registrant landed with role=user — every admin-gated
// setup-wizard save then redirected to /not-authorized. (Regression from
// #1002, which repaired the fixture email so the seed started succeeding.)
//
// Two layers, matching the house pattern for auth-bootstrap invariants
// (member-race-arbitration.test.ts, default-organization-bootstrap.test.ts):
//   1. BEHAVIOR of the pure decision core (`initial-admin-bootstrap-policy`):
//      replay the fresh-dev-install sequence and assert the slot survives the
//      seed and goes to the first human — this is the test that would have
//      caught the defect (the old semantics counted the fixture as human).
//   2. SOURCE WIRING pins: auth.ts must route every first-human count through
//      the humans-only predicate and refuse non-human candidates;
//      dev-auto-setup.ts must not call ensureInitialAdminBootstrap at all and
//      must mark + member-wire the fixture instead.

import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEV_UAT_FIXTURE_USER_TYPE,
  HUMAN_USER_TYPE,
  isHumanUserRowType,
  isInitialAdminBootstrapEligible,
} from "@/lib/initial-admin-bootstrap-policy";

// ---------------------------------------------------------------------------
// 1. Decision-core behavior — replay the fresh-install sequence.
// ---------------------------------------------------------------------------

type UserRow = { id: string; userType: string | null; role: string | null };

/** SQL-twin of countHumanUsersSql: userType 'human' or NULL counts as human. */
function countHumans(rows: UserRow[]): number {
  return rows.filter((r) => isHumanUserRowType(r.userType)).length;
}

/** The promotion path of ensureInitialAdminBootstrap, at the decision level. */
function runBootstrapFor(rows: UserRow[], id: string): void {
  const target = rows.find((r) => r.id === id);
  if (!target) return;
  if (
    isInitialAdminBootstrapEligible({
      targetUserType: target.userType,
      humanUserCount: countHumans(rows),
    })
  ) {
    target.role = "admin";
  }
}

describe("cinatra#1135 — dev fixture must not consume the initial-admin bootstrap", () => {
  it("fresh dev install: assistant + fixture seeds leave the slot open; the first human registrant becomes platform admin", () => {
    const rows: UserRow[] = [];
    // Boot order on a fresh dev install (per the cinatra#1135 repro):
    rows.push({ id: "assistant", userType: "assistant", role: null });
    rows.push({ id: "uat-fixture", userType: DEV_UAT_FIXTURE_USER_TYPE, role: null });

    // The seed path no longer routes the fixture through the bootstrap at all
    // (pinned in the source tests below) — but even if it DID, the decision
    // core must refuse it: the bootstrap slot stays available.
    runBootstrapFor(rows, "uat-fixture");
    expect(rows.find((r) => r.id === "uat-fixture")?.role).toBeNull();

    // First real person registers (better-auth default userType 'human') and
    // their session runs the bootstrap: they get the one-shot.
    rows.push({ id: "human-1", userType: HUMAN_USER_TYPE, role: null });
    runBootstrapFor(rows, "human-1");
    expect(rows.find((r) => r.id === "human-1")?.role).toBe("admin");

    // Second human never gets it (one-shot).
    rows.push({ id: "human-2", userType: HUMAN_USER_TYPE, role: null });
    runBootstrapFor(rows, "human-2");
    expect(rows.find((r) => r.id === "human-2")?.role).toBeNull();
  });

  it("the fixture signing in role-less while exactly one human exists is NOT promoted (candidate arm)", () => {
    const rows: UserRow[] = [
      { id: "uat-fixture", userType: DEV_UAT_FIXTURE_USER_TYPE, role: null },
      { id: "human-1", userType: null, role: null }, // NULL userType = legacy human
    ];
    // humanUserCount === 1 here — only the candidate arm blocks the fixture.
    expect(countHumans(rows)).toBe(1);
    runBootstrapFor(rows, "uat-fixture");
    expect(rows.find((r) => r.id === "uat-fixture")?.role).toBeNull();
    // The human still gets the slot afterwards.
    runBootstrapFor(rows, "human-1");
    expect(rows.find((r) => r.id === "human-1")?.role).toBe("admin");
  });

  it("regression shape: under the PRE-FIX semantics (fixture counted as human) the first human would have been locked out", () => {
    // This documents exactly what broke: with the fixture counted, the human
    // registrant sees count=2 and is never eligible.
    const preFixCount = 2; // fixture + human, as `is distinct from 'assistant'` counted them
    expect(
      isInitialAdminBootstrapEligible({ targetUserType: "human", humanUserCount: preFixCount }),
    ).toBe(false);
    // The fix: the fixture type is excluded from the human count…
    expect(isHumanUserRowType(DEV_UAT_FIXTURE_USER_TYPE)).toBe(false);
    // …and the fixture type itself must never drift back to 'human'.
    expect(DEV_UAT_FIXTURE_USER_TYPE).not.toBe(HUMAN_USER_TYPE);
  });

  it("humanness contract: 'human' and NULL/undefined are human; machine types are not", () => {
    expect(isHumanUserRowType("human")).toBe(true);
    expect(isHumanUserRowType(null)).toBe(true);
    expect(isHumanUserRowType(undefined)).toBe(true);
    expect(isHumanUserRowType("assistant")).toBe(false);
    expect(isHumanUserRowType(DEV_UAT_FIXTURE_USER_TYPE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Source-wiring pins (auth.ts + dev-auto-setup.ts).
// ---------------------------------------------------------------------------

const AUTH_TS_PATH = path.join(__dirname, "..", "auth.ts");
const DEV_AUTO_SETUP_PATH = path.join(__dirname, "..", "dev-auto-setup.ts");

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function extractFunctionBody(source: string, fnName: string): string {
  const decl = `export async function ${fnName}(`;
  const startIdx = source.indexOf(decl);
  if (startIdx < 0) throw new Error(`extractFunctionBody: '${fnName}' not found`);
  const openBrace = source.indexOf("{", startIdx);
  if (openBrace < 0) throw new Error(`extractFunctionBody: '${fnName}' has no opening brace`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`extractFunctionBody: '${fnName}' has unbalanced braces`);
}

describe("src/lib/auth.ts first-human count wiring", () => {
  it("no bootstrap count uses the assistant-only exclusion anymore (the predicate that let the fixture count as human)", () => {
    const src = stripComments(readSource(AUTH_TS_PATH));
    expect(src).not.toMatch(/is distinct from 'assistant'/);
  });

  it("the shared humans-only count exists and is the NULL-is-human coalesce form", () => {
    const src = stripComments(readSource(AUTH_TS_PATH));
    expect(src).toMatch(
      /countHumanUsersSql = sql`select count\(\*\)::text as count from public\."user" where coalesce\("userType", 'human'\) = 'human'`/,
    );
  });

  it("hasAnyBetterAuthUsers, countHumanUsersLocked and ensureInitialAdminBootstrap all count via the shared humans-only query", () => {
    const src = stripComments(readSource(AUTH_TS_PATH));
    for (const fn of ["hasAnyBetterAuthUsers", "ensureInitialAdminBootstrap"]) {
      expect(extractFunctionBody(src, fn)).toMatch(/countHumanUsersSql/);
    }
    // countHumanUsersLocked is not exported; pin its body via the source.
    const lockedIdx = src.indexOf("async function countHumanUsersLocked(");
    expect(lockedIdx).toBeGreaterThan(-1);
    const lockedSlice = src.slice(lockedIdx, src.indexOf("}\n", src.indexOf("return parsed", lockedIdx)));
    expect(lockedSlice).toMatch(/countHumanUsersSql/);
  });

  it("ensureInitialAdminBootstrap gates the CANDIDATE through the policy (a non-human user is never promoted)", () => {
    const body = stripComments(extractFunctionBody(readSource(AUTH_TS_PATH), "ensureInitialAdminBootstrap"));
    // The eligibility call must see the candidate's userType AND the humans-only count…
    expect(body).toMatch(/isInitialAdminBootstrapEligible\(\{[\s\S]*targetUserType[\s\S]*humanUserCount[\s\S]*\}\)/);
    // …and it must run BEFORE the promote UPDATE.
    const eligibilityIdx = body.indexOf("isInitialAdminBootstrapEligible");
    const promoteIdx = body.indexOf('set({ role: "admin" })');
    expect(eligibilityIdx).toBeGreaterThan(-1);
    expect(promoteIdx).toBeGreaterThan(eligibilityIdx);
  });
});

describe("src/lib/dev-auto-setup.ts fixture seed wiring", () => {
  it("never calls (or imports) ensureInitialAdminBootstrap", () => {
    const src = stripComments(readSource(DEV_AUTO_SETUP_PATH));
    expect(src).not.toMatch(/\bensureInitialAdminBootstrap\b/);
  });

  it("marks the fixture row with the machine userType from the policy module", () => {
    const src = stripComments(readSource(DEV_AUTO_SETUP_PATH));
    expect(src).toMatch(/DEV_UAT_FIXTURE_USER_TYPE/);
    expect(src).toMatch(/UPDATE public\."user" SET "userType" = \$2/);
  });

  it("wires the fixture's Default-org membership as a plain member (insertRole='member', promoteToOwner=false)", () => {
    const body = stripComments(extractFunctionBody(readSource(DEV_AUTO_SETUP_PATH), "ensureDevConnectActor"));
    expect(body).toMatch(/ensureBetterAuthMembershipRow\(\s*userId,\s*orgId,\s*"member",\s*false\s*,?\s*\)/);
  });
});
