/**
 * Regression: AgentApprovalDetailScreen surfaces ?error= decision failures (#391).
 *
 * On the agent approval detail page a failed approve/reject/retry redirects back
 * to `/configuration/agents/approvals/<id>?error=<msg>` (see the decision actions
 * in src/app/configuration/agents/approvals/[id]/actions.ts). The screen
 * previously took only `{ id }` and never read the `error` param, so a failure
 * (e.g. self-approval disallowed) looked like a silent reload — the bug in #391.
 *
 * The fix threads `error`/`status` into AgentApprovalDetailScreen and renders a
 * destructive Alert for `?error=` (and a success Alert for `?status=`), mirroring
 * the Instance-tab surfacing fix in #357.
 *
 * Strategy: file-grep assertions scoped to the AgentApprovalDetailScreen source
 * block, matching this package's render-test pattern (the async server component
 * can't be imported in isolation — its module graph transitively reaches the
 * generated extension wiring). A companion jsdom test
 * (agent-approval-detail-error-surface-render.test.tsx) renders the exact Alert
 * markup with the real Alert UI components and asserts the DOM/accessibility.
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

describe("AgentApprovalDetailScreen error/status surfacing (#391)", () => {
  it("accepts error and status search params", () => {
    const body = detailScreen();
    // Signature destructures error + status (not just id).
    expect(body).toMatch(/error\?:\s*string\s*\|\s*string\[\]\s*\|\s*undefined/);
    expect(body).toMatch(/status\?:\s*string\s*\|\s*string\[\]\s*\|\s*undefined/);
  });

  it("normalizes the params and renders the ?error= message in a destructive Alert", () => {
    const body = detailScreen();
    expect(body).toMatch(/pickSearchParam\(error\)/);
    expect(body).toMatch(/pickSearchParam\(status\)/);
    // A destructive Alert renders the error message (not swallowed).
    expect(body).toMatch(/<Alert\s+variant="destructive"/);
    expect(body).toMatch(/\{errorMessage\}/);
  });

  it("renders a success Alert for a successful ?status= decision", () => {
    const body = detailScreen();
    expect(body).toMatch(/<Alert\s+variant="success"/);
    expect(body).toMatch(/\{successMessage\}/);
  });
});

describe("the host route threads searchParams into the screen (#391)", () => {
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

  it("passes resolved error/status from the URL to AgentApprovalDetailScreen", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).toMatch(/searchParams\?:\s*Promise<Record<string,\s*string\s*\|\s*string\[\]\s*\|\s*undefined>>/);
    expect(src).toMatch(/error=\{resolvedSearchParams\.error\}/);
    expect(src).toMatch(/status=\{resolvedSearchParams\.status\}/);
  });
});
