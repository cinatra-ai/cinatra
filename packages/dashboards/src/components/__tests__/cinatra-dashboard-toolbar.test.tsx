// @vitest-environment jsdom
//
// Covers the host-owned dashboard toolbar (`cinatra-dashboard-toolbar.tsx`)
// THROUGH the public composable API: every assertion drives a real
// drizzle-cube `<DashboardProvider>` and observes the context state machine
// via `useDashboardContext()` — no drizzle-cube-internal DOM, no class
// signatures, no MutationObserver.
//
// Replaces the retired DOM-mutation tests at the new seam:
//   - owner-doctrine labels: "Edit dashboard" (view) / "Save dashboard"
//     (edit) render and the click round-trips the edit state machine
//     (formerly: text-node relabel of DC's "Edit" / "Finish Editing");
//   - route-scoped page actions: which actions render on which surface,
//     their href/label/order, and the negative cases (formerly: anchor
//     injection into DC's toolbar DOM).
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/cinatra-dashboard-toolbar.test.tsx

import "./jsdom-shims";
import React, { type ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DashboardProvider, useDashboardContext } from "drizzle-cube/client";

import { CinatraDashboardToolbar } from "../cinatra-dashboard-toolbar";
import {
  DashboardPageAnchorProvider,
  type DashboardPageAnchor,
} from "../dashboard-page-anchor";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ProviderProps = ComponentProps<typeof DashboardProvider>;

/** Minimal config — the toolbar itself never reads portlets. */
const EMPTY_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as ProviderProps["config"];

/**
 * Sibling probe that publishes the live context as data attributes, so the
 * tests assert against the composable state machine rather than any
 * drizzle-cube-internal DOM.
 */
function ContextProbe() {
  const ctx = useDashboardContext();
  return (
    <div
      data-testid="ctx-probe"
      data-edit-mode={String(ctx.isEditMode)}
      data-portlet-modal={String(ctx.isPortletModalOpen)}
      data-text-modal={String(ctx.isTextModalOpen)}
      data-layout-mode={ctx.layoutMode}
    />
  );
}

function renderToolbar({
  pageAnchor,
  editable = true,
  dashboardModes = ["grid"],
  onConfigChange,
}: {
  pageAnchor?: DashboardPageAnchor | string;
  editable?: boolean;
  dashboardModes?: ProviderProps["dashboardModes"];
  onConfigChange?: ProviderProps["onConfigChange"];
} = {}) {
  return render(
    <DashboardPageAnchorProvider
      pageAnchor={pageAnchor as DashboardPageAnchor | undefined}
    >
      <DashboardProvider
        config={EMPTY_CONFIG}
        editable={editable}
        dashboardModes={dashboardModes}
        onConfigChange={onConfigChange}
      >
        <CinatraDashboardToolbar />
        <ContextProbe />
      </DashboardProvider>
    </DashboardPageAnchorProvider>,
  );
}

function probe() {
  return screen.getByTestId("ctx-probe");
}

function toolbar() {
  return document.querySelector<HTMLElement>("[data-cinatra-dashboard-toolbar]");
}

function actionAnchors() {
  return [
    ...document.querySelectorAll<HTMLAnchorElement>("a[data-cinatra-page-action]"),
  ].map((a) => ({
    id: a.getAttribute("data-cinatra-page-action"),
    href: a.getAttribute("href"),
    text: a.textContent?.trim(),
  }));
}

// ---------------------------------------------------------------------------
// Owner-doctrine labels + edit/save flow (replaces toolbar-polish.test.ts)
// ---------------------------------------------------------------------------

describe("CinatraDashboardToolbar — owner-doctrine labels via useDashboardContext", () => {
  test("view mode renders 'Edit dashboard' (never drizzle-cube's bare 'Edit')", () => {
    renderToolbar();

    expect(
      screen.getByRole("button", { name: "Edit dashboard" }),
    ).toBeTruthy();
    expect(probe().getAttribute("data-edit-mode")).toBe("false");
    // The upstream labels must not leak through anywhere.
    expect(screen.queryByText("Edit", { exact: true })).toBeNull();
    expect(screen.queryByText("Finish Editing")).toBeNull();
  });

  test("clicking 'Edit dashboard' enters edit mode through the public state machine", () => {
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));

    expect(probe().getAttribute("data-edit-mode")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Save dashboard" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add portlet" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Edit dashboard" }),
    ).toBeNull();
  });

  test("clicking 'Save dashboard' exits edit mode (labels flip back)", () => {
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }));

    expect(probe().getAttribute("data-edit-mode")).toBe("false");
    expect(
      screen.getByRole("button", { name: "Edit dashboard" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save dashboard" }),
    ).toBeNull();
  });

  test("'Add portlet' and 'Add text' drive the context's modal openers", () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));

    expect(probe().getAttribute("data-portlet-modal")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Add portlet" }));
    expect(probe().getAttribute("data-portlet-modal")).toBe("true");

    expect(probe().getAttribute("data-text-modal")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    expect(probe().getAttribute("data-text-modal")).toBe("true");
  });

  test("Grid/Rows toggle renders only when more than one layout mode is allowed", () => {
    renderToolbar({ dashboardModes: ["grid", "rows"] });
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));

    const grid = screen.getByRole("button", { name: "Grid" });
    const rows = screen.getByRole("button", { name: "Rows" });
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    expect(rows.getAttribute("aria-pressed")).toBe("false");
    expect(probe().getAttribute("data-layout-mode")).toBe("grid");

    cleanup();

    // Single allowed mode: no toggle, even in edit mode.
    renderToolbar({ dashboardModes: ["grid"] });
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.queryByRole("button", { name: "Grid" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rows" })).toBeNull();
  });

  test("clicking 'Rows' drives the layout-mode change through onConfigChange", async () => {
    const onConfigChange = vi.fn();
    renderToolbar({ dashboardModes: ["grid", "rows"], onConfigChange });
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));

    fireEvent.click(screen.getByRole("button", { name: "Rows" }));

    await waitFor(() => {
      expect(onConfigChange).toHaveBeenCalled();
    });
    const nextConfig = onConfigChange.mock.calls.at(-1)?.[0] as {
      layoutMode?: string;
    };
    expect(nextConfig?.layoutMode).toBe("rows");
  });
});

// ---------------------------------------------------------------------------
// Route-scoped page actions (replaces toolbar-polish-page-actions.test.ts)
// ---------------------------------------------------------------------------

describe("CinatraDashboardToolbar — route-scoped page actions", () => {
  test("agents: renders Run agent then Create agent before the edit toggle", () => {
    renderToolbar({ pageAnchor: "agents" });

    expect(actionAnchors()).toEqual([
      { id: "run-agent", href: "/agents/run", text: "Run agent" },
      {
        id: "create-agent",
        href: "/chat?mode=create-agent",
        text: "Create agent",
      },
    ]);

    // Order: both anchors precede the Edit button in the toolbar's DOM.
    const tb = toolbar();
    expect(tb).not.toBeNull();
    const editButton = within(tb as HTMLElement).getByRole("button", {
      name: "Edit dashboard",
    });
    for (const anchor of (tb as HTMLElement).querySelectorAll(
      "a[data-cinatra-page-action]",
    )) {
      expect(
        anchor.compareDocumentPosition(editButton) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  test("projects: renders exactly one New project action", () => {
    renderToolbar({ pageAnchor: "projects" });
    expect(actionAnchors()).toEqual([
      { id: "new-project", href: "/projects/new", text: "New project" },
    ]);
  });

  test("teams: renders exactly one New team action", () => {
    renderToolbar({ pageAnchor: "teams" });
    expect(actionAnchors()).toEqual([
      { id: "new-team", href: "/teams/new", text: "New team" },
    ]);
  });

  test("no page anchor: renders no actions (guards against leaking into other dashboards)", () => {
    renderToolbar();
    expect(actionAnchors()).toEqual([]);
  });

  test("unknown page anchor: renders no actions", () => {
    renderToolbar({ pageAnchor: "nonexistent-surface" });
    expect(actionAnchors()).toEqual([]);
  });

  test("read-only surface with an anchor keeps the actions but shows no edit controls", () => {
    renderToolbar({ pageAnchor: "agents", editable: false });

    expect(actionAnchors().map((a) => a.id)).toEqual([
      "run-agent",
      "create-agent",
    ]);
    expect(
      screen.queryByRole("button", { name: "Edit dashboard" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save dashboard" }),
    ).toBeNull();
  });

  test("read-only surface without an anchor renders no toolbar at all", () => {
    renderToolbar({ editable: false });
    expect(toolbar()).toBeNull();
  });
});
