/**
 * Regression: AgentApprovalDetailScreen surfaces decision outcomes (#391), now
 * as a TOAST via the codes-only <SearchParamToast> island (cinatra#1109).
 *
 * A failed approve/reject/retry redirects to
 * `/configuration/agents/approvals/<id>?error=<code>` and a success to
 * `?status=<code>` (see the decision actions). The screen mounts
 * <SearchParamToast toasts={APPROVAL_DECISION_TOASTS}>, which maps each code to a
 * STATIC message and toasts it — no inline Alert, and the host route no longer
 * threads the params (the island reads them from the URL client-side).
 *
 * Strategy: file-grep assertions scoped to the AgentApprovalDetailScreen source
 * block, matching this package's render-test pattern (the async server component
 * can't be imported in isolation — its module graph transitively reaches the
 * generated extension wiring).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const screensPath = path.resolve(__dirname, "..", "screens.tsx");

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
  it("mounts the codes-only <SearchParamToast> island for decision outcomes", () => {
    const body = detailScreen();
    expect(body).toMatch(/<SearchParamToast\s+toasts=\{APPROVAL_DECISION_TOASTS\}/);
  });

  it("maps the success + error decision codes to STATIC messages", () => {
    const src = readScreens();
    // status success codes
    expect(src).toMatch(/value:\s*"approved"/);
    expect(src).toMatch(/value:\s*"rejected"/);
    expect(src).toMatch(/value:\s*"published"/);
    // error codes (the raw MCP error is logged server-side, never toasted)
    expect(src).toMatch(/value:\s*"decision-failed"/);
    expect(src).toMatch(/value:\s*"unauthorized"/);
    expect(src).toMatch(/value:\s*"reason-required"/);
  });

  it("no longer renders an inline decision Alert (the outcome is a toast)", () => {
    const body = detailScreen();
    expect(body).not.toMatch(/<Alert\s+variant="destructive"/);
    expect(body).not.toMatch(/errorMessage/);
    expect(body).not.toMatch(/successMessage/);
  });
});

describe("the host route no longer threads searchParams into the screen (#391 → toast)", () => {
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

  it("renders the screen with only the id (the island reads the URL params)", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).toMatch(/<AgentApprovalDetailScreen\s+id=\{id\}\s*\/>/);
    expect(src).not.toMatch(/error=\{resolvedSearchParams\.error\}/);
    expect(src).not.toMatch(/status=\{resolvedSearchParams\.status\}/);
  });
});
