/**
 * Access to the agent-creation request detail surface — the SCREEN's read rule
 * (Part of #1549; #1552) and the WEB ROUTE's gate (#2700).
 *
 * THE WEB ROUTE IS PLATFORM-ADMIN ONLY since cinatra#2700 (epic #2699). The page
 * stays at `/configuration/agents/approvals/[id]` and falls under the
 * `/configuration` gate like every other route in the segment. The epic states
 * the consequence plainly: a non-admin author loses the approval-status read
 * they had, and S2 removes the member-facing links that used to mint a path
 * here, so nothing dead-ends. The last describe block below pins that gate — it
 * asserts the gate's PRESENCE where it used to assert its absence.
 *
 * THE SCREEN KEEPS ITS OWN admin-or-author READ RULE, deliberately: it is the
 * layer that reads the request row (and thus its authorId), and the SAME rule
 * serves the token-gated MCP read predicate in
 * mcp/agent-creation-request-handlers.ts — parity is on the ACCESS RULE, and
 * that predicate is not reached through the web route at all. The screen
 * ADDITIONALLY 404-hides the non-author case (a missing id and an
 * existing-but-not-yours id are byte-identical), a stronger leak-hiding
 * guarantee the token-gated MCP surface does not currently make (see the handler
 * test's note on that current, out-of-#1552-scope divergence). Its author arm is
 * now unreachable THROUGH THE PAGE — the route gate refuses a non-admin first —
 * but the rule stays stated where the row is read, so no surface that mounts the
 * screen can widen it.
 *
 * Strategy: file-grep source-invariant assertions scoped to the
 * AgentApprovalDetailScreen body — matching this package's render-test pattern
 * (agent-approval-detail-error-surface.test.ts): the async server component
 * can't be imported in isolation (its module graph transitively reaches the
 * generated extension wiring), and extracting the predicate into its own module
 * would grow the locked route-graph baseline (screens.tsx is reachable from the
 * server API routes /api/mcp, /api/a2a, /api/llm-bridge and /chat). The
 * author-decide-DENY server-side guard is pinned behaviorally by the sibling
 * decide-actions test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const screensPath = path.resolve(__dirname, "..", "screens.tsx");
const pagePath = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "src",
  "app",
  "configuration",
  "agents",
  "approvals",
  "[id]",
  "page.tsx",
);

function readScreens(): string {
  return readFileSync(screensPath, "utf8");
}

/** Extract the AgentApprovalDetailScreen function body so assertions don't bleed
 *  into the sibling inbox / registry surfaces (bound at the next top-level
 *  export after the screen, mirroring the sibling error-surface test). */
function detailScreen(): string {
  const src = readScreens();
  const start = src.indexOf("export async function AgentApprovalDetailScreen");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("export interface ResolveDetailReadConfigOptions", start);
  expect(next).toBeGreaterThan(start);
  return src.slice(start, next);
}

describe("AgentApprovalDetailScreen author-scoped read access (#1552)", () => {
  it("author-read-allow: the SCREEN gates on an authenticated session and derives admin + author from the row", () => {
    const body = detailScreen();
    // The screen boundary requires only an authenticated session (it cannot
    // decide author-ness before it reads the row). The ROUTE that mounts it is
    // admin-only since #2700 — pinned in the last describe block below.
    expect(body).toMatch(/requireAuthSession\(\)/);
    expect(body).not.toMatch(/requireAdminSession\(/);
    // isAdmin from the session; isAuthor from the READ row's authorId vs the
    // session user id (admin OR author may read — mirrors the MCP predicate).
    expect(body).toMatch(/isPlatformAdmin\(session\)/);
    expect(body).toMatch(/req\.authorId === session\.user(\?\.|\.)id/);
  });

  it("non-author-404: a non-admin non-author is refused via the SAME not-found panel as a missing row (indistinguishable)", () => {
    const body = detailScreen();
    // A single shared not-found return, guarded so a non-existent id and an
    // existing-but-not-yours id produce byte-identical responses.
    expect(body).toMatch(/if \(!req \|\| \(!isAdmin && !isAuthor\)\)/);
    // Exactly one not-found panel in the screen — the unauthorized case reuses
    // the missing-row response rather than adding a distinguishable branch.
    const notFound = body.match(/Agent creation request not found\./g) ?? [];
    expect(notFound.length).toBe(1);
  });

  it("decide affordances render ONLY inside isAdmin-gated branches (a non-admin author's read view never shows them)", () => {
    const body = detailScreen();
    // Both decide-form branches are admin-gated. The leading `{` / `) :` anchors
    // are load-bearing: an UNANCHORED `isAdmin && …` substring still matches a
    // one-token `!isAdmin && …` negation — the single most likely privilege-
    // escalation regression (a non-admin author gaining the decide form) — so it
    // would slip through green. Anchoring on the literal char that immediately
    // precedes each guard makes a negated `{!isAdmin` / `) : !isAdmin` FAIL.
    expect(body).toMatch(/\{isAdmin && isPending \? \(\s*<ApprovalDecisionForm/);
    expect(body).toMatch(/\) : isAdmin && req\.status === "approved" \? \(/);
    // Belt-and-suspenders: assert the negated form is absent outright, so an
    // inverted admin check on either decide branch fails this test directly.
    expect(body).not.toMatch(/!isAdmin && isPending \? \(\s*<ApprovalDecisionForm/);
    expect(body).not.toMatch(/!isAdmin && req\.status === "approved" \? \(/);
    // The pre-#1552 UNGATED `{isPending ? (<ApprovalDecisionForm` branch is gone.
    expect(body).not.toMatch(/\{isPending \? \(\s*<ApprovalDecisionForm/);
    // Every ApprovalDecisionForm render is reached only through an admin gate:
    // there are exactly two forms, and the only two form-producing ternary
    // branches are the two isAdmin-gated ones asserted above.
    const forms = body.match(/<ApprovalDecisionForm/g) ?? [];
    expect(forms.length).toBe(2);
  });
});

describe("the host route gate (#1552 → #2700)", () => {
  it("requires the PLATFORM-ADMIN session — /configuration is the admin area throughout", () => {
    const page = readFileSync(pagePath, "utf8");
    // #2700 reversed the #1552 carve-out: the page no longer settles for an
    // authenticated session. An unauthenticated caller is still redirected to
    // /sign-in; a signed-in non-admin now lands on /not-authorized.
    expect(page).toMatch(/await requireAdminSession\(\)/);
    expect(page).not.toMatch(/requireAuthSession/);
  });

  it("states the consequence the epic decided: a non-admin author loses this read", () => {
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/cinatra#2700/);
    expect(page).toMatch(/non-admin author/);
  });
});
