// @vitest-environment jsdom
//
// cinatra#2807 (per-scope surfaces S1) — the entity-page tablist is the FIVE-tab
// strip `Dashboards | Assistants | Agents | Artifacts | Skills`, with `Settings`
// appended only on the scopes that have a settings pane (organization / team /
// project). Personal (#1904) and the workspace scope carry no Settings tab.
//
// This is the RENDERED half of the contract: order, labels, per-tab hrefs and
// which tab is active. The source half (every call site passes all five hrefs)
// lives in src/app/__tests__/scope-five-tab-strip-2807.test.ts.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The tablist renders each tab as a route link. Outside a Next app router the
// real `next/link` has no router to reach, so it is stood in for by the plain
// anchor it renders to — the href is what this suite asserts.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    // `createElement`, not JSX: the app forbids a raw anchor element in source,
    // and this stand-in is exactly that anchor — the element the real
    // `next/link` renders, kept plain so the tab href is directly readable.
    createElement("a", { href, ...rest }, children),
}));

import { EntityScopeTabs } from "@/components/entity-scope-tabs";

const BASE = "/teams/t1";

const SCOPE_HREFS = {
  dashboardsHref: BASE,
  assistantsHref: `${BASE}/assistants`,
  agentsHref: `${BASE}/agents`,
  artifactsHref: `${BASE}/artifacts`,
  skillsHref: `${BASE}/skills`,
} as const;

const FIVE_TABS = [
  "Dashboards",
  "Assistants",
  "Agents",
  "Artifacts",
  "Skills",
] as const;

const tabLabels = () =>
  screen.getAllByRole("tab").map((el) => el.textContent?.trim() ?? "");

const activeLabel = () =>
  screen
    .getAllByRole("tab")
    .find((el) => el.getAttribute("data-state") === "active")
    ?.textContent?.trim() ?? null;

afterEach(cleanup);

describe("EntityScopeTabs — the five-tab scope strip (#2807)", () => {
  it("renders Dashboards | Assistants | Agents | Artifacts | Skills in that exact order", () => {
    render(<EntityScopeTabs {...SCOPE_HREFS} active="dashboards" />);
    expect(tabLabels()).toEqual([...FIVE_TABS]);
  });

  it("appends Settings as the LAST tab when the scope has a settings pane", () => {
    render(
      <EntityScopeTabs
        {...SCOPE_HREFS}
        settingsHref={`${BASE}/settings`}
        active="settings"
      />,
    );
    expect(tabLabels()).toEqual([...FIVE_TABS, "Settings"]);
  });

  it("omits Settings entirely without a settingsHref (#1904 personal, and workspace)", () => {
    render(<EntityScopeTabs {...SCOPE_HREFS} active="dashboards" />);
    expect(tabLabels()).not.toContain("Settings");
  });

  it("points every tab at its own scope-based route", () => {
    render(
      <EntityScopeTabs
        {...SCOPE_HREFS}
        settingsHref={`${BASE}/settings`}
        active="dashboards"
      />,
    );
    const hrefs = Object.fromEntries(
      screen
        .getAllByRole("tab")
        .map((el) => [el.textContent?.trim() ?? "", el.getAttribute("href")]),
    );
    expect(hrefs).toEqual({
      Dashboards: BASE,
      Assistants: `${BASE}/assistants`,
      Agents: `${BASE}/agents`,
      Artifacts: `${BASE}/artifacts`,
      Skills: `${BASE}/skills`,
      Settings: `${BASE}/settings`,
    });
  });

  it("drives the active tab from the hosting route, one per value", () => {
    for (const [value, label] of [
      ["dashboards", "Dashboards"],
      ["assistants", "Assistants"],
      ["agents", "Agents"],
      ["artifacts", "Artifacts"],
      ["skills", "Skills"],
      ["settings", "Settings"],
    ] as const) {
      cleanup();
      render(
        <EntityScopeTabs
          {...SCOPE_HREFS}
          settingsHref={`${BASE}/settings`}
          active={value}
        />,
      );
      expect(activeLabel()).toBe(label);
    }
  });
});
