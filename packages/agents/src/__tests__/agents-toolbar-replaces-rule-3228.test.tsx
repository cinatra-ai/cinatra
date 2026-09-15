// @vitest-environment jsdom
/**
 * The agents page's toolbar REPLACES the tab strip's trailing rule — never
 * stacks under it (cinatra#3228).
 *
 *   cd packages/agents && pnpm vitest run src/__tests__/agents-toolbar-replaces-rule-3228.test.tsx
 *
 * The ratified drawing (specs/app-components.html, Toolbar): "The toolbar sits
 * directly below the page header and replaces the section rule for that view —
 * never stack a toolbar and the etched paired rule." /agents stacks header →
 * tab strip (whose trailing rule stands in for the suppressed header divider)
 * → toolbar. The elected resolution: the strip keeps its tabs and stops
 * drawing its trailing rule when a toolbar is mounted beneath it; a view of the
 * same strip with no toolbar (the All Agents empty state, the Reviews tab)
 * keeps its rule exactly as today. Exactly one of {rule, toolbar} is drawn per
 * view.
 *
 * The Executions tab mounts a toolbar too (cinatra#3237 fix leg 2 — the first
 * proof round photographed the rule and that toolbar stacked there), so it is
 * the toolbar-replaces-rule reading as well; its own composition is driven in
 * `packages/dashboards/src/components/__tests__/executions-toolbar-replaces-rule-3228.test.tsx`,
 * and the Reviews tab's rule-keeping reading in
 * `src/app/agents/reviews/__tests__/reviews-tab-keeps-its-rule-3228.test.tsx`.
 *
 * Renders the REAL page composition (NewAgentPage → AgentsTabNav →
 * AgentRunClient → Toolbar) with the data reads mocked; the per-row card is
 * stubbed (its own drawing is cinatra#3227's subject).
 */
import React from "react";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const state = vi.hoisted(() => ({
  templates: [] as Array<Record<string, unknown>>,
}));

vi.mock("../store", () => ({
  readInstalledAgentTemplates: vi.fn(async () => state.templates),
}));
vi.mock("../screens", () => ({
  AgentBuilderRunScreen: () => null,
  AgentBuilderImportScreen: () => null,
}));
vi.mock("../runtime-install-gate", () => ({
  resolveAgentRunAvailabilityMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: () => false,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/agents",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/extensions/agent-all-card", () => ({
  AgentAllCard: ({ row }: { row: { name: string } }) => (
    <article data-testid="agent-card">{row.name}</article>
  ),
}));

import { NewAgentPage } from "../pages";
import { AgentsTabNav } from "@/components/agents-tab-nav";

afterEach(cleanup);

const RULE = '[data-slot="separator"][data-major]';
const TOOLBAR = '[data-slot="toolbar"]';
const STRIP = '[data-slot="agents-tab-nav"]';

function hitlTemplate(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} description`,
    sourceType: "internal",
    packageName: `@acme/${id}`,
    packageVersion: "1.0.0",
    hitlRequired: true,
    hitlScreens: [],
    gatedSteps: [],
    agentDependencies: null,
    ioSpec: null,
    connectorSlug: null,
    remoteAgentId: null,
  };
}

async function renderAllAgents(templates: Array<Record<string, unknown>>) {
  state.templates = templates;
  const element = await NewAgentPage();
  return render(element).container;
}

/** Elements in document order, so "between" is a plain index range. */
function ordered(container: Element): Element[] {
  return Array.from(container.querySelectorAll("*"));
}

describe("/agents — the toolbar replaces the strip's trailing rule (cinatra#3228)", () => {
  it("1. no etched paired rule is drawn between the page header and the toolbar", async () => {
    const container = await renderAllAgents([hitlTemplate("a1", "Alpha"), hitlTemplate("a2", "Beta")]);
    const toolbar = container.querySelector(TOOLBAR);
    expect(toolbar, "the list view mounts its toolbar").toBeTruthy();
    const all = ordered(container);
    const header = container.querySelector("header")!;
    const headerEnd = Math.max(...Array.from(header.querySelectorAll("*")).map((el) => all.indexOf(el)), all.indexOf(header));
    const toolbarAt = all.indexOf(toolbar!);
    const rulesBetween = Array.from(container.querySelectorAll(RULE)).filter((rule) => {
      const at = all.indexOf(rule);
      return at > headerEnd && at < toolbarAt;
    });
    expect(rulesBetween.length).toBe(0);
  });

  it("2. the toolbar is the first element after the tab strip — nothing drawn between them", async () => {
    const container = await renderAllAgents([hitlTemplate("a1", "Alpha")]);
    const strip = container.querySelector(STRIP)!;
    const toolbar = container.querySelector(TOOLBAR)!;
    expect(strip).toBeTruthy();
    const all = ordered(container);
    const stripEnd = Math.max(...Array.from(strip.querySelectorAll("*")).map((el) => all.indexOf(el)), all.indexOf(strip));
    const toolbarAt = all.indexOf(toolbar);
    expect(toolbarAt).toBeGreaterThan(stripEnd);
    // Every element between the strip and the toolbar in document order is an
    // ANCESTOR of the toolbar (a layout wrapper opening around it) — no sibling
    // content, and no rule, is drawn between the two.
    const between = all.slice(stripEnd + 1, toolbarAt);
    for (const el of between) {
      expect(el.contains(toolbar), `<${el.tagName.toLowerCase()} class="${el.className}"> sits between the strip and the toolbar`).toBe(true);
    }
    expect(between.some((el) => el.matches(RULE))).toBe(false);
  });

  it("3. the executions tab hands its rule over too — its view always mounts a toolbar", () => {
    // The executions view (agents-dashboard.tsx) mounts the dashboard toolbar
    // beneath this strip for every reader, so the strip must be told to give
    // its rule up there as well. Pin that mount, then render the strip as it
    // mounts it; the view's own composition — the toolbar really standing
    // where the rule was — is driven in the dashboards package's
    // executions-toolbar-replaces-rule-3228 suite.
    const dashboard = readFileSync(
      path.resolve(__dirname, "..", "..", "..", "dashboards", "src", "screens", "agents-dashboard.tsx"),
      "utf8",
    );
    expect(dashboard).toMatch(/<AgentsTabNav activeTab="executions" toolbarBelow \/>/);
    const { container } = render(<AgentsTabNav activeTab="executions" toolbarBelow />);
    expect(container.querySelectorAll(RULE).length).toBe(0);
  });

  it("3b. the All-Agents empty state (no toolbar) keeps the strip's rule too", async () => {
    const container = await renderAllAgents([]);
    expect(container.querySelectorAll(TOOLBAR).length).toBe(0);
    expect(container.querySelector(STRIP)!.querySelectorAll(RULE).length).toBe(1);
  });

  it("4. exactly one of {the strip's trailing rule, the toolbar} is drawn on any view", async () => {
    const list = await renderAllAgents([hitlTemplate("a1", "Alpha")]);
    const listRules = list.querySelector(STRIP)!.querySelectorAll(RULE).length;
    const listToolbars = list.querySelectorAll(TOOLBAR).length;
    expect(listRules + listToolbars).toBe(1);
    expect(listToolbars).toBe(1);
    cleanup();

    // The executions view mounts the strip WITH a toolbar beneath it, so the
    // strip draws no rule; the toolbar is that view's one mark (counted on the
    // real composition in the dashboards package's suite).
    const executions = render(<AgentsTabNav activeTab="executions" toolbarBelow />).container;
    expect(executions.querySelectorAll(RULE).length).toBe(0);
    expect(executions.querySelectorAll(TOOLBAR).length).toBe(0);
  });
});
