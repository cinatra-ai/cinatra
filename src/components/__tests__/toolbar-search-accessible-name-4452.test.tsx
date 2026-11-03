// @vitest-environment jsdom
/**
 * Every toolbar search field carries an accessible name (cinatra#4452).
 *
 *   pnpm vitest run --config vitest.config.ts src/components/__tests__/toolbar-search-accessible-name-4452.test.tsx
 *
 * `ToolbarSearchInput` draws a search pill: a `<label>` holding a decorative
 * (aria-hidden) glass and an `<input type="search">`. The label has no text,
 * so the input's name comes only from an `aria-label` the caller passes; a
 * placeholder is a fallback some assistive technology drops. The marketplace,
 * model pricing and All Agents toolbars passed none, so a screen reader moving
 * focus into the field reported a search box with an empty name.
 *
 * The three callers are rendered through their real components and the field
 * is found by role AND name, the way assistive technology finds it. A second
 * guard reads every non-test caller of `<ToolbarSearchInput` in the source and
 * fails when one omits `aria-label`, so a future caller cannot regress this.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));
vi.mock("../../../packages/metric-cost-api/src/actions", () => ({
  upsertModelPricingAction: vi.fn(),
  triggerLiteLlmSyncAction: vi.fn(),
}));

// Imported by path, like the sibling suites: these screens are not published
// subpaths, and the suite must render the REAL components.
import { ExtensionsMarketplaceClient } from "../../../packages/extensions/src/screens/extensions-marketplace-client";
import { ModelPricingTable } from "../../../packages/metric-cost-api/src/components/model-pricing-table";
import { AgentRunClient } from "../../../packages/agents/src/agent-run-client";

afterEach(() => {
  cleanup();
});

describe("the toolbar search field is a named search box", () => {
  it("marketplace: role searchbox named for what it searches", () => {
    render(<ExtensionsMarketplaceClient cards={[]} />);
    expect(
      screen.getByRole("searchbox", {
        name: "Search by name, description, or package…",
      }),
    ).toBeTruthy();
  });

  it("model pricing: role searchbox named for what it searches", () => {
    render(<ModelPricingTable rows={[]} />);
    expect(
      screen.getByRole("searchbox", { name: "Search models, providers…" }),
    ).toBeTruthy();
  });

  it("All Agents: role searchbox named for what it searches", () => {
    render(<AgentRunClient rows={[]} />);
    expect(
      screen.getByRole("searchbox", { name: "Search agents…" }),
    ).toBeTruthy();
  });
});

const ROOT = path.resolve(__dirname, "../../..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", "__tests__"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("no non-test ToolbarSearchInput caller omits aria-label", () => {
  it("every <ToolbarSearchInput …/> element names itself", () => {
    const defining = path.join(ROOT, "src/components/ui/toolbar.tsx");
    const files = [
      ...sourceFiles(path.join(ROOT, "src")),
      ...sourceFiles(path.join(ROOT, "packages")),
    ].filter((f) => f !== defining);

    const callers: string[] = [];
    const unnamed: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("<ToolbarSearchInput");
      while (at !== -1) {
        const end = text.indexOf("/>", at);
        const tag = text.slice(at, end === -1 ? undefined : end);
        const rel = path.relative(ROOT, file);
        callers.push(rel);
        if (!/\baria-label=/.test(tag)) unnamed.push(rel);
        at = text.indexOf("<ToolbarSearchInput", at + 1);
      }
    }
    // The scan must find the known callers, or it is reading nothing.
    expect(callers.length).toBeGreaterThanOrEqual(7);
    expect(unnamed).toEqual([]);
  });
});
