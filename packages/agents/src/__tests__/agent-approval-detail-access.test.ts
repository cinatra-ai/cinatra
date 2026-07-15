/**
 * Author-scoped READ-ONLY access to the agent-creation request detail surface
 * (Part of #1549; #1552). The request's own author (a non-admin) may VIEW their
 * request's detail read-only; a non-admin non-author is refused with the SAME
 * response as a non-existent id (404-hide); the decide affordances render only
 * for an admin. The WEB route now applies the same admin-or-author READ RULE as
 * the MCP read predicate in mcp/agent-creation-request-handlers.ts — parity is
 * on the ACCESS RULE. The web route ADDITIONALLY 404-hides the non-author case
 * (a missing id and an existing-but-not-yours id are byte-identical), a stronger
 * leak-hiding guarantee the token-gated MCP surface does not currently make
 * (see the handler test's note on that current, out-of-#1552-scope
 * divergence).
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
  it("author-read-allow: gates on an authenticated session (not the admin-only gate) and derives admin + author from the row", () => {
    const body = detailScreen();
    // The blanket admin gate is gone; only an authenticated session is required
    // at the screen boundary (the outer page gate can't know the authorId).
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

describe("the host route gate (#1552)", () => {
  it("requires only an authenticated session — the author-or-admin decision lives in the screen where the row is read", () => {
    const page = readFileSync(pagePath, "utf8");
    // Unauthenticated callers are still redirected to /sign-in by
    // requireAuthSession(); the admin-only gate is loosened to auth-only.
    expect(page).toMatch(/requireAuthSession\(\)/);
    expect(page).not.toMatch(/requireAdminSession/);
  });
});
