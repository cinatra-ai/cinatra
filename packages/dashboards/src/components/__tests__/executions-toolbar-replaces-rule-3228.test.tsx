// @vitest-environment jsdom
/**
 * The Executions tab (`/agents/executions`) never stacks the etched paired
 * rule and a toolbar (cinatra#3228).
 *
 *   pnpm --filter @cinatra-ai/dashboards exec vitest run \
 *     src/components/__tests__/executions-toolbar-replaces-rule-3228.test.tsx
 *
 * The ratified drawing (the components reference, Toolbar): "The toolbar sits
 * directly below the page header and replaces the section rule for that view —
 * never stack a toolbar and the etched paired rule."; and again under the
 * section-break entry: "If a toolbar sits below the page header, the toolbar
 * replaces the section rule entirely; never stack both." No drawing gives this
 * tab a control row that is not a toolbar, and the view mounts a REAL
 * `<Toolbar data-slot="toolbar">` (Run agent · Create agent · Edit dashboard),
 * so the toolbar takes the rule's place here exactly as it does on All Agents.
 *
 * The first proof round read this cell as correct because the only coverage
 * rendered `<AgentsTabNav activeTab="executions" />` in ISOLATION — the strip
 * alone, never the composition that mounts the toolbar beneath it. These cases
 * therefore drive the REAL screen: `AgentsDashboardPage` → `AgentsTabNav` →
 * `PageContent` → `EmbeddedDrizzleCubeDashboardGrid` → the real client shell →
 * `ComposedDashboard` → the real `CinatraDashboardToolbar`. Only the session
 * and the dashboard row are mocked; every piece of chrome is the shipped one.
 *
 * Case 5 covers the pre-hydration (server) render, where the grid is still its
 * "Loading dashboard" placeholder and mounts no toolbar yet: a loading skeleton
 * rather than a view of the page, so it draws neither mark — but it must never
 * draw both, and that is what the case pins.
 *
 * Lives under `components/__tests__` with the other suites that mount the real
 * drizzle-cube composition (the import policy allows `drizzle-cube/client`
 * only inside `packages/dashboards/src/components/`).
 */
import "./jsdom-shims";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("../../auth/security-context", () => ({
  buildSecurityContextFromSession: () => ({
    userId: "user-1",
    organizationId: "org-1",
  }),
}));
vi.mock("../../store/db", () => ({
  dashboards: { id: "id", organizationId: "orgId", ownerId: "ownerId", ownerLevel: "ownerLevel" },
  getDashboardsDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  }),
}));
vi.mock("../../v12-envelope", () => ({
  // An empty dashboard: the grid mounts with no portlet, so no cube query is
  // fired. The chrome under test (strip, rule, toolbar) is unaffected by the
  // portlet count.
  readDcConfigFromRow: () => ({
    portlets: [],
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  }),
}));
vi.mock("../../actions", () => ({ saveAgentsDashboardAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  usePathname: () => "/agents/executions",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { AgentsDashboardPage } from "../../screens/agents-dashboard";
import { CinatraDashboardToolbar } from "../cinatra-dashboard-toolbar";
import { DashboardPageAnchorProvider } from "../dashboard-page-anchor";
import { DashboardProvider } from "drizzle-cube/client";

afterEach(cleanup);

const RULE = '[data-slot="separator"][data-major]';
const TOOLBAR = '[data-slot="toolbar"]';
const STRIP = '[data-slot="agents-tab-nav"]';

/** Elements in document order, so "between" is a plain index range. */
function ordered(container: Element): Element[] {
  return Array.from(container.querySelectorAll("*"));
}

async function renderExecutions(): Promise<HTMLElement> {
  const element = await AgentsDashboardPage();
  return render(element).container;
}

describe("/agents/executions — the toolbar replaces the strip's rule (cinatra#3228)", () => {
  test("1. the view mounts a REAL toolbar for this anchor — its guard never returns null", () => {
    const { container } = render(
      <DashboardPageAnchorProvider pageAnchor="agents">
        <DashboardProvider
          config={
            {
              portlets: [],
              layoutMode: "grid",
              grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
            } as never
          }
          editable
          dashboardModes={["grid", "rows"]}
        >
          <CinatraDashboardToolbar />
        </DashboardProvider>
      </DashboardPageAnchorProvider>,
    );
    expect(container.querySelectorAll(TOOLBAR).length).toBe(1);
    expect(screen.getByText("Run agent")).toBeTruthy();
    expect(screen.getByText("Create agent")).toBeTruthy();
  });

  test("2. no etched paired rule is drawn between the page header and that toolbar", async () => {
    const container = await renderExecutions();
    const toolbar = container.querySelector(TOOLBAR);
    expect(toolbar, "the executions view mounts its toolbar").toBeTruthy();
    const all = ordered(container);
    const header = container.querySelector("header")!;
    const headerEnd = Math.max(
      ...Array.from(header.querySelectorAll("*")).map((el) => all.indexOf(el)),
      all.indexOf(header),
    );
    const toolbarAt = all.indexOf(toolbar!);
    const rulesBetween = Array.from(container.querySelectorAll(RULE)).filter((rule) => {
      const at = all.indexOf(rule);
      return at > headerEnd && at < toolbarAt;
    });
    expect(rulesBetween.length).toBe(0);
  });

  test("3. exactly one of {the strip's trailing rule, the toolbar} is drawn — never both", async () => {
    const container = await renderExecutions();
    const strip = container.querySelector(STRIP)!;
    expect(strip, "the executions view mounts the tab strip").toBeTruthy();
    const stripRules = strip.querySelectorAll(RULE).length;
    const toolbars = container.querySelectorAll(TOOLBAR).length;
    expect(stripRules + toolbars).toBe(1);
    expect(toolbars).toBe(1);
    expect(stripRules).toBe(0);
  });

  test("4. the toolbar is the first thing after the strip — no rule and no content between", async () => {
    const container = await renderExecutions();
    const strip = container.querySelector(STRIP)!;
    const toolbar = container.querySelector(TOOLBAR)!;
    const all = ordered(container);
    const stripEnd = Math.max(
      ...Array.from(strip.querySelectorAll("*")).map((el) => all.indexOf(el)),
      all.indexOf(strip),
    );
    const toolbarAt = all.indexOf(toolbar);
    expect(toolbarAt).toBeGreaterThan(stripEnd);
    // Everything between the two in document order is an ANCESTOR of the
    // toolbar (a layout wrapper opening around it) — no sibling content, and
    // no rule, stands between the strip and the toolbar.
    const between = all.slice(stripEnd + 1, toolbarAt);
    for (const el of between) {
      expect(
        el.contains(toolbar),
        `<${el.tagName.toLowerCase()} class="${el.className}"> sits between the strip and the toolbar`,
      ).toBe(true);
    }
    expect(between.some((el) => el.matches(RULE))).toBe(false);
  });

  // The converge round (cinatra#3237 fix leg 2) named the one window the four
  // cases above cannot see: the dashboard grid renders a "Loading dashboard"
  // placeholder until its mount effect flips `isHydrated`, and the toolbar is
  // mounted INSIDE that grid — so the server render and the first client paint
  // carry no toolbar while the strip already hands its rule away. Testing
  // Library's `render()` flushes that effect, so the window is only reachable
  // through a static (server) render. It is a loading skeleton, not a view of
  // this page, so it draws neither mark; what it must never do — and what this
  // case pins — is draw BOTH, which is the whole subject of cinatra#3228.
  test("5. the pre-hydration (server) render never stacks a rule and a toolbar either", async () => {
    const element = await AgentsDashboardPage();
    const holder = document.createElement("div");
    holder.innerHTML = renderToStaticMarkup(element);
    const strip = holder.querySelector(STRIP);
    expect(strip, "the strip server-renders").toBeTruthy();
    const stripRules = strip!.querySelectorAll(RULE).length;
    const toolbars = holder.querySelectorAll(TOOLBAR).length;
    // Never both — the prohibition holds in this state too.
    expect(stripRules === 0 || toolbars === 0).toBe(true);
    // And the state as it stands today: the grid is still its loading
    // placeholder, so no toolbar exists yet and the strip draws no rule.
    expect(toolbars).toBe(0);
    expect(stripRules).toBe(0);
    expect(holder.textContent).toContain("Loading dashboard");
  });
});
