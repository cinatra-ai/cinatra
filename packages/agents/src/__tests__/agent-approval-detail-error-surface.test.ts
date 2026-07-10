/**
 * Regression: AgentApprovalDetailScreen surfaces decision outcomes (#391), now
 * as a TOAST via the codes-only <SearchParamToast> island (cinatra#1109).
 *
 * A failed approve/reject/retry redirects to
 * `/configuration/agents/approvals/<id>?error=<code>` and a success to
 * `?status=<code>` (see the decision actions). The island is mounted at the HOST
 * PAGE (src/app/configuration/agents/approvals/[id]/page.tsx) with the co-located
 * APPROVAL_DECISION_TOASTS map (approval-decision-flash.ts), which maps each code
 * to a STATIC message and toasts it — no inline Alert.
 *
 * Crucially the island is mounted at the PAGE, NOT inside the @cinatra-ai/agents
 * screen: screens.tsx is reachable from the server API routes (/api/mcp,
 * /api/a2a, /api/llm-bridge) and /chat, so importing the client toast island
 * there leaks it onto those routes' first-party graph (the route-graph ratchet).
 * This test pins that invariant — the screen must NOT reference the island.
 *
 * Strategy: file-grep assertions scoped to the relevant source blocks, matching
 * this package's render-test pattern (the async server component can't be
 * imported in isolation — its module graph transitively reaches the generated
 * extension wiring).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const screensPath = path.resolve(__dirname, "..", "screens.tsx");

const appDir = path.resolve(
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
);
const pagePath = path.resolve(appDir, "page.tsx");
const flashPath = path.resolve(appDir, "approval-decision-flash.ts");

function readScreens(): string {
  return readFileSync(screensPath, "utf8");
}

/** Extract the AgentApprovalDetailScreen function body so assertions don't bleed
 *  into the sibling inbox / registry surfaces. */
function detailScreen(): string {
  const src = readScreens();
  const start = src.indexOf("export async function AgentApprovalDetailScreen");
  expect(start).toBeGreaterThanOrEqual(0);
  // The next top-level export after the detail screen is the registry-helpers
  // section comment; bound the slice at the next `export ` to stay scoped.
  const next = src.indexOf("export interface ResolveDetailReadConfigOptions", start);
  expect(next).toBeGreaterThan(start);
  return src.slice(start, next);
}

describe("AgentApprovalDetailScreen decision surfacing (#391 → toast)", () => {
  it("mounts the codes-only <SearchParamToast> island at the host PAGE (not the screen)", () => {
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/<SearchParamToast\s+toasts=\{APPROVAL_DECISION_TOASTS\}/);
    expect(page).toMatch(/from "\.\/approval-decision-flash"/);
  });

  it("keeps the client toast island OUT of the @cinatra-ai/agents screen graph (route-graph ratchet)", () => {
    // screens.tsx is reachable from the server API routes; importing/mounting the
    // client island here would leak +2 first-party modules onto /api/mcp,
    // /api/a2a, /api/llm-bridge and /chat.
    const src = readScreens();
    expect(src).not.toMatch(/SearchParamToast/);
    expect(src).not.toMatch(/search-param-toast/);
    expect(src).not.toMatch(/APPROVAL_DECISION_TOASTS/);
  });

  it("maps the success + error decision codes to STATIC messages (co-located flash map)", () => {
    const flash = readFileSync(flashPath, "utf8");
    // status success codes
    expect(flash).toMatch(/value:\s*"approved"/);
    expect(flash).toMatch(/value:\s*"rejected"/);
    expect(flash).toMatch(/value:\s*"published"/);
    // error codes (the raw MCP error is logged server-side, never toasted)
    expect(flash).toMatch(/value:\s*"decision-failed"/);
    expect(flash).toMatch(/value:\s*"unauthorized"/);
    expect(flash).toMatch(/value:\s*"reason-required"/);
  });

  it("no longer renders an inline decision Alert (the outcome is a toast)", () => {
    const body = detailScreen();
    expect(body).not.toMatch(/<Alert\s+variant="destructive"/);
    expect(body).not.toMatch(/errorMessage/);
    expect(body).not.toMatch(/successMessage/);
  });
});

describe("the host route no longer threads searchParams into the screen (#391 → toast)", () => {
  it("renders the screen with only the id (the island reads the URL params)", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).toMatch(/<AgentApprovalDetailScreen\s+id=\{id\}\s*\/>/);
    expect(src).not.toMatch(/error=\{resolvedSearchParams\.error\}/);
    expect(src).not.toMatch(/status=\{resolvedSearchParams\.status\}/);
  });
});
