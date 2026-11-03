// @vitest-environment jsdom
/**
 * The toolbar search field is a named search box (cinatra#4452).
 *
 *   pnpm vitest run --config vitest.config.ts src/components/__tests__/toolbar-search-accessible-name-4452.test.tsx
 *
 * `ToolbarSearchInput` draws a search pill: a `<label>` holding a decorative
 * (aria-hidden) glass and an `<input type="search">`. The label has no text,
 * so the input takes no name from it, and a placeholder is a fallback some
 * assistive technology drops. The marketplace, model pricing and All Agents
 * fields passed no `aria-label`, so a screen reader moving focus into one of
 * them reported a search box with an empty name.
 *
 * Two readings:
 *   1. The three fields are rendered through their real components and found
 *      by role AND name, the way assistive technology finds them.
 *   2. The name is a TYPE-LEVEL requirement of `ToolbarSearchInput` — an
 *      `aria-label` or an `aria-labelledby`. `pnpm typecheck` checks every
 *      caller in the files its tsconfig includes (.ts, .tsx and .mts, not
 *      the `__tests__/fixtures` folders and not the tests folders under
 *      `extensions`), whether the caller is
 *      written as JSX, as a `createElement` call, through an alias, with a
 *      conditional label or with a spread of a typed props object; the
 *      `@ts-expect-error` cases below fail the typecheck as an UNUSED directive
 *      the day the requirement is dropped. The type does not see an empty or
 *      whitespace-only string, an `any`-typed spread, an `aria-labelledby` that
 *      points to no element, or a file outside that include.
 */
import * as React from "react";
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
import { ToolbarSearchInput } from "../ui/toolbar";

afterEach(() => {
  cleanup();
});

describe("the application toolbar search fields are named search boxes", () => {
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

describe("ToolbarSearchInput requires a name at compile time", () => {
  it("an unnamed caller does not compile, in each form pinned here", () => {
    // @ts-expect-error — neither aria-label nor aria-labelledby
    const jsx = <ToolbarSearchInput placeholder="Search" />;
    // @ts-expect-error — createElement goes through the same props type
    const created = React.createElement(ToolbarSearchInput, { placeholder: "Search" });
    const Alias = ToolbarSearchInput;
    // @ts-expect-error — an alias is the same component
    const aliased = <Alias placeholder="Search" />;
    const enabled = Math.random() > 2;
    // @ts-expect-error — a conditional label can be undefined, so it names nothing on one branch
    const conditional = <ToolbarSearchInput aria-label={enabled ? "Search" : undefined} placeholder="Search" />;
    const rest: React.InputHTMLAttributes<HTMLInputElement> = {};
    // @ts-expect-error — a spread of a typed props object carries no required name
    const spread = <ToolbarSearchInput {...rest} />;
    expect([jsx, created, aliased, conditional, spread].every((el) => el !== null)).toBe(true);
  });

  it("an aria-label or an aria-labelledby is accepted and names the field", () => {
    render(
      <>
        <span id="search-name-4452">Find things</span>
        <ToolbarSearchInput aria-label="Search by label" placeholder="Search" />
        <ToolbarSearchInput aria-labelledby="search-name-4452" placeholder="Search" />
      </>,
    );
    expect(screen.getByRole("searchbox", { name: "Search by label" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Find things" })).toBeTruthy();
  });
});
