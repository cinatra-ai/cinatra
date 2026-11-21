// @vitest-environment jsdom
//
// THE KPI VALUE FALLBACK, HOST BY HOST (cinatra#4311).
//
// drizzle-cube paints a KPI value with the first colour of the palette its
// provider is given, or, with no palette colour, with the literal `#1f2937`.
// A host marks the grid `data-cinatra-kpi-fallback="foreground"` exactly when
// it gives the provider no palette colour, and `dashboard-theme.css` repaints
// the fallback with the foreground token only under that marker.
//
// Each host is rendered with the REAL `DashboardProvider`; the grid surface is
// substituted by a stub that draws a KPI value element with the exact style
// string drizzle-cube's fallback serialises to in a browser. The theme's real
// selector is then run against it: repainted with no palette, left alone with a
// palette, even one whose first colour IS `#1f2937`.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/kpi-value-fallback-hosts.test.tsx

import "./jsdom-shims";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { parseItems } from "../../../../sdk-dashboard/scripts/scope-drizzle-cube-styles.mjs";

/** The style string of drizzle-cube's KPI fallback after a client-side write. */
const FALLBACK_STYLE = "font-size: 48px; color: rgb(31, 41, 55);";

vi.mock("drizzle-cube/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-cube/client")>();
  return {
    ...actual,
    DashboardGridSurface: () => (
      <div
        data-testid="grid-surface"
        dangerouslySetInnerHTML={{
          __html: `<div data-testid="kpi-value" class="dc:font-bold dc:leading-none" style="${FALLBACK_STYLE}">1</div>`,
        }}
      />
    ),
    DashboardModals: () => <div data-testid="modals" />,
    DashboardFilterBar: () => <div data-testid="filter-bar" />,
  };
});

import {
  KPI_VALUE_FALLBACK_ATTRIBUTE,
  kpiValueFallbackAttributes,
  ReadOnlyComposedDashboard,
  ReadOnlySinglePortlet,
} from "@cinatra-ai/sdk-dashboard/components";
import { ComposedDashboard } from "../composed-dashboard";

afterEach(cleanup);

afterAll(() => {
  vi.doUnmock("drizzle-cube/client");
  vi.resetModules();
});

const THEME_CSS = readFileSync(
  join(__dirname, "..", "..", "..", "..", "sdk-dashboard", "src", "components", "dashboard-theme.css"),
  "utf-8",
);
const KPI_SELECTOR = (parseItems(THEME_CSS) as Array<{ kind: string; prelude?: string }>).find(
  (item) => item.kind === "block" && item.prelude?.includes(KPI_VALUE_FALLBACK_ATTRIBUTE),
)?.prelude;

const CONFIG = {
  portlets: [
    {
      id: "p1",
      title: "Organizations",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      chartType: "kpiNumber",
      query: "{}",
      chartConfig: {},
      displayConfig: {},
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as never;

const palette = (colors: string[]) => ({ name: "custom", label: "Custom", colors, gradient: [] });

type Host = (props: Record<string, unknown>) => React.JSX.Element;
const HOSTS: Array<[string, Host, Record<string, unknown>]> = [
  ["the read-only dashboard composition", ReadOnlyComposedDashboard as unknown as Host, {}],
  ["the read-only single-portlet composition", ReadOnlySinglePortlet as unknown as Host, { portletId: "p1" }],
  ["the editable dashboard home", ComposedDashboard as unknown as Host, { editable: true }],
];

function kpiValue(): Element {
  const el = document.querySelector('[data-testid="kpi-value"]');
  expect(el, "the stub KPI value did not render").not.toBeNull();
  return el!;
}

describe("the theme rule exists", () => {
  test("dashboard-theme.css carries the KPI fallback rule", () => {
    expect(KPI_SELECTOR).toBeTruthy();
  });
});

describe.each(HOSTS)("%s", (_name, Host, extra) => {
  test("with no palette: marks the grid, and the fallback value is repainted", () => {
    render(<Host config={CONFIG} {...extra} />);
    expect(document.querySelectorAll(`[${KPI_VALUE_FALLBACK_ATTRIBUTE}="foreground"]`)).toHaveLength(1);
    expect(kpiValue().matches(KPI_SELECTOR!)).toBe(true);
  });

  test("with a palette that has no colours: still drizzle-cube's fallback, still repainted", () => {
    render(<Host config={CONFIG} colorPalette={palette([])} {...extra} />);
    expect(kpiValue().matches(KPI_SELECTOR!)).toBe(true);
  });

  test("with a palette whose first colour is empty: drizzle-cube falls back, so it is marked and repainted", () => {
    render(<Host config={CONFIG} colorPalette={palette(["", "#10b981"])} {...extra} />);
    expect(document.querySelectorAll(`[${KPI_VALUE_FALLBACK_ATTRIBUTE}="foreground"]`)).toHaveLength(1);
    expect(kpiValue().matches(KPI_SELECTOR!)).toBe(true);
  });

  test("with a palette whose first colour is #1f2937: no marker, the chosen colour stays", () => {
    render(<Host config={CONFIG} colorPalette={palette(["#1f2937", "#10b981"])} {...extra} />);
    expect(document.querySelector(`[${KPI_VALUE_FALLBACK_ATTRIBUTE}]`)).toBeNull();
    expect(kpiValue().matches(KPI_SELECTOR!)).toBe(false);
  });

  test("with any other palette: no marker", () => {
    render(<Host config={CONFIG} colorPalette={palette(["#3b82f6"])} {...extra} />);
    expect(document.querySelector(`[${KPI_VALUE_FALLBACK_ATTRIBUTE}]`)).toBeNull();
  });
});

// drizzle-cube picks the KPI value colour with `colors?.[0] || '#1f2937'`
// (kpiText's helper and KpiNumber's resolveValueColor, without a
// valueColorIndex): the first entry's TRUTHINESS, not the array's length.
const sparseFirst = (() => {
  const colors = new Array<string>(2);
  colors[1] = "#3b82f6";
  return colors;
})();
const MARKED = { [KPI_VALUE_FALLBACK_ATTRIBUTE]: "foreground" };

describe("the marker follows drizzle-cube's first-entry fallback predicate", () => {
  test.each([
    ["no palette", undefined, MARKED],
    ["a null palette", null, MARKED],
    ["a palette with no colours field", {}, MARKED],
    ["null colours", { colors: null }, MARKED],
    ["no colours", { colors: [] }, MARKED],
    ["an empty first colour", { colors: [""] }, MARKED],
    ["an empty first colour before a real one", { colors: ["", "#3b82f6"] }, MARKED],
    ["a sparse first entry", { colors: sparseFirst }, MARKED],
    ["an undefined first entry", { colors: [undefined] }, MARKED],
    ["a null first entry", { colors: [null, "#3b82f6"] }, MARKED],
    ["a first colour that is #1f2937", { colors: ["#1f2937"] }, {}],
    ["any other first colour", { colors: ["#3b82f6", ""] }, {}],
  ])("%s", (_name, colorPalette, expected) => {
    expect(kpiValueFallbackAttributes(colorPalette as never)).toEqual(expected);
  });
});

describe("the editable home's marker draws no box of its own", () => {
  test("the wrapper around the grid is display: contents", () => {
    render(<ComposedDashboard config={CONFIG} editable />);
    const marker = document.querySelector(`[${KPI_VALUE_FALLBACK_ATTRIBUTE}]`) as HTMLElement | null;
    expect(marker).not.toBeNull();
    expect(marker!.style.display).toBe("contents");
    expect(marker!.querySelector('[data-testid="grid-surface"]')).not.toBeNull();
  });
});
