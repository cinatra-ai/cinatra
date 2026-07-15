// @vitest-environment jsdom
//
// Covers the reusable entity Dashboards-tab shell (cinatra#701) end-to-end at
// the component seam, with MOCKED server-action callbacks (the DB-backed
// service surface is proven by #700's integration suite). Two layers:
//
//   1. Shell logic — a light `renderDashboard` stub + a context probe drive the
//      list/select/create/rename/delete state machine and the loading / empty /
//      error states, including the codex round-0 correctness requirements:
//      create selects the new dashboard, save targets the SELECTED id, a stale
//      config load cannot replace a newer selection, and a failed mutation
//      leaves the list + selection consistent.
//   2. Toolbar render — the shell's context drives the REAL
//      `<CinatraDashboardToolbar>`, proving the dashboard-select + "+ New
//      dashboard" render INSIDE the standard toolbar and that the Overview
//      default is reflected as non-removable (no Rename/Delete).
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/entity-dashboards-shell.test.tsx

import "./jsdom-shims";
import React, { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DashboardProvider } from "drizzle-cube/client";

import { Button } from "@/components/ui/button";
import {
  EntityDashboardsShell,
  type EntityDashboardRenderArgs,
} from "../entity-dashboards-shell";
import { useEntityDashboards } from "../entity-dashboards-context";
import { CinatraDashboardToolbar } from "../cinatra-dashboard-toolbar";
import { DashboardPageAnchorProvider } from "../dashboard-page-anchor";
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";
import type {
  EntityDashboardSummary,
  EntityDashboardsDataSource,
  EntityDashboardsList,
} from "../../entity-dashboards-contract";

afterEach(cleanup);

// ── fixtures ────────────────────────────────────────────────────────────────

function config(portletCount: number): DashboardConfigV1_1 {
  return {
    portlets: Array.from({ length: portletCount }, (_, i) => ({
      id: `p${i}`,
      title: `P${i}`,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })),
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  } as unknown as DashboardConfigV1_1;
}

const OVERVIEW: EntityDashboardSummary = {
  id: "ov",
  name: "Overview",
  isDefault: true,
  canWrite: true,
};
const SALES: EntityDashboardSummary = {
  id: "sales",
  name: "Sales",
  isDefault: false,
  canWrite: true,
};

const INITIAL_LIST: EntityDashboardsList = {
  dashboards: [OVERVIEW, SALES],
  canCreate: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Builds a data source with sane defaults; override any thunk per test. */
function makeDataSource(
  overrides: Partial<EntityDashboardsDataSource> = {},
): EntityDashboardsDataSource {
  const configs: Record<string, DashboardConfigV1_1> = {
    ov: config(0),
    sales: config(2),
  };
  return {
    listDashboards: vi.fn(async () => INITIAL_LIST),
    loadConfig: vi.fn(async (id: string) => configs[id] ?? config(0)),
    createDashboard: vi.fn(async (name: string) => ({
      ok: true as const,
      dashboard: { id: `new-${name}`, name, isDefault: false, canWrite: true },
    })),
    renameDashboard: vi.fn(async (id: string, name: string) => ({
      ok: true as const,
      dashboard: { id, name, isDefault: false, canWrite: true },
    })),
    deleteDashboard: vi.fn(async () => ({ ok: true as const })),
    saveDashboard: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── layer 1: shell logic via a light stub renderer + context probe ───────────

/** Reads the entity-dashboards context and exposes it for assertions/driving. */
function Probe() {
  const ctx = useEntityDashboards();
  const [outcome, setOutcome] = useState("");
  if (!ctx) return null;
  return (
    <div
      data-testid="probe"
      data-selected={ctx.selectedId ?? ""}
      data-pending={ctx.pendingId ?? ""}
      data-cancreate={String(ctx.canCreate)}
      data-busy={String(ctx.busy)}
      data-names={ctx.dashboards.map((d) => d.name).join(",")}
      data-outcome={outcome}
    >
      {ctx.dashboards.map((d) => (
        <Button
          key={d.id}
          data-testid={`sel-${d.id}`}
          onClick={() => ctx.onSelect(d.id)}
        >
          {d.name}
        </Button>
      ))}
      <Button
        data-testid="create"
        onClick={async () => {
          const o = await ctx.onCreate("Fresh");
          setOutcome(o.ok ? "ok" : o.message);
        }}
      >
        create
      </Button>
      <Button
        data-testid="rename-sales"
        onClick={async () => {
          const o = await ctx.onRename?.("sales", "Renamed");
          setOutcome(o?.ok ? "ok" : (o?.message ?? "no-rename"));
        }}
      >
        rename
      </Button>
      <Button
        data-testid="delete-sales"
        onClick={async () => {
          const o = await ctx.onDelete?.("sales");
          setOutcome(o?.ok ? "ok" : (o?.message ?? "no-delete"));
        }}
      >
        delete
      </Button>
    </div>
  );
}

function lightRenderer(args: EntityDashboardRenderArgs) {
  return (
    <div>
      <div
        data-testid="rendered"
        data-id={args.summary.id}
        data-name={args.summary.name}
        data-editable={String(args.editable)}
        data-portlets={String((args.config.portlets ?? []).length)}
        data-anchor={args.pageAnchor}
      />
      <Button
        data-testid="do-save"
        onClick={() => void args.onSave(config(9))}
      >
        save
      </Button>
      <Probe />
    </div>
  );
}

function renderShell(dataSource: EntityDashboardsDataSource) {
  return render(
    <EntityDashboardsShell
      dataSource={dataSource}
      pageAnchor="team-detail"
      renderDashboard={lightRenderer}
    />,
  );
}

function probe() {
  return screen.getByTestId("probe");
}

describe("EntityDashboardsShell — load + select", () => {
  test("shows a loading state, then renders the Overview default selected", async () => {
    const ds = makeDataSource();
    renderShell(ds);

    expect(
      document.querySelector('[data-cinatra-entity-dashboards-state="loading"]'),
    ).not.toBeNull();

    const rendered = await screen.findByTestId("rendered");
    expect(rendered.getAttribute("data-id")).toBe("ov");
    expect(probe().getAttribute("data-selected")).toBe("ov");
    expect(probe().getAttribute("data-names")).toBe("Overview,Sales");
    expect(probe().getAttribute("data-cancreate")).toBe("true");
    // The pageAnchor threads through to the renderer.
    expect(rendered.getAttribute("data-anchor")).toBe("team-detail");
  });

  test("selecting another dashboard swaps to its config", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");

    fireEvent.click(screen.getByTestId("sel-sales"));

    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );
    expect(screen.getByTestId("rendered").getAttribute("data-portlets")).toBe("2");
    expect(probe().getAttribute("data-selected")).toBe("sales");
  });

  test("a stale config load cannot replace a newer selection (race guard)", async () => {
    const salesGate = deferred<DashboardConfigV1_1>();
    const ds = makeDataSource({
      loadConfig: vi.fn((id: string) => {
        if (id === "ov") return Promise.resolve(config(0));
        if (id === "sales") return salesGate.promise; // slow
        return Promise.resolve(config(0));
      }),
    });
    renderShell(ds);
    await screen.findByTestId("rendered"); // Overview shown

    // Select Sales (slow), then re-select Overview (fast) before Sales resolves.
    fireEvent.click(screen.getByTestId("sel-sales"));
    await waitFor(() => expect(probe().getAttribute("data-pending")).toBe("sales"));
    fireEvent.click(screen.getByTestId("sel-ov"));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("ov"),
    );

    // Now the superseded Sales load resolves — it must be ignored.
    salesGate.resolve(config(2));
    await Promise.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("ov"),
    );
    expect(probe().getAttribute("data-selected")).toBe("ov");
  });

  test("editable reflects the server-derived per-dashboard canWrite", async () => {
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [{ ...OVERVIEW, canWrite: false }],
        canCreate: false,
      })),
    });
    renderShell(ds);
    const rendered = await screen.findByTestId("rendered");
    expect(rendered.getAttribute("data-editable")).toBe("false");
    expect(probe().getAttribute("data-cancreate")).toBe("false");
  });
});

describe("EntityDashboardsShell — create / save / rename / delete", () => {
  test("create adds the dashboard to the dropdown AND selects it (empty)", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");

    fireEvent.click(screen.getByTestId("create"));

    await waitFor(() =>
      expect(ds.createDashboard).toHaveBeenCalledWith("Fresh"),
    );
    // New name appears in the dropdown…
    await waitFor(() =>
      expect(probe().getAttribute("data-names")).toBe("Overview,Sales,Fresh"),
    );
    // …and is selected + rendered (empty, ready for portlets).
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe(
        "new-Fresh",
      ),
    );
    expect(screen.getByTestId("rendered").getAttribute("data-portlets")).toBe("0");
  });

  test("save targets the SELECTED dashboard id", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");
    fireEvent.click(screen.getByTestId("sel-sales"));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );

    fireEvent.click(screen.getByTestId("do-save"));

    await waitFor(() => expect(ds.saveDashboard).toHaveBeenCalled());
    expect((ds.saveDashboard as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "sales",
    );
  });

  test("a failed create leaves the list and selection unchanged", async () => {
    const ds = makeDataSource({
      createDashboard: vi.fn(async () => ({
        ok: false as const,
        reason: "name-conflict" as const,
      })),
    });
    renderShell(ds);
    await screen.findByTestId("rendered");

    fireEvent.click(screen.getByTestId("create"));

    await waitFor(() =>
      expect(probe().getAttribute("data-outcome")).toMatch(/already exists/i),
    );
    // List untouched, still on Overview.
    expect(probe().getAttribute("data-names")).toBe("Overview,Sales");
    expect(probe().getAttribute("data-selected")).toBe("ov");
  });

  test("rename updates the name in the dropdown", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");

    fireEvent.click(screen.getByTestId("rename-sales"));

    await waitFor(() =>
      expect(ds.renameDashboard).toHaveBeenCalledWith("sales", "Renamed"),
    );
    await waitFor(() =>
      expect(probe().getAttribute("data-names")).toBe("Overview,Renamed"),
    );
  });

  test("renaming the CURRENTLY rendered dashboard updates its rendered summary", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");
    // Make Sales the rendered dashboard, then rename it.
    fireEvent.click(screen.getByTestId("sel-sales"));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );
    expect(screen.getByTestId("rendered").getAttribute("data-name")).toBe("Sales");

    fireEvent.click(screen.getByTestId("rename-sales"));

    await waitFor(() =>
      expect(ds.renameDashboard).toHaveBeenCalledWith("sales", "Renamed"),
    );
    // The self-contained rendered snapshot reflects the new name (not just the list).
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-name")).toBe(
        "Renamed",
      ),
    );
  });

  test("deleting the selected dashboard falls back to the Overview default", async () => {
    const ds = makeDataSource();
    renderShell(ds);
    await screen.findByTestId("rendered");
    fireEvent.click(screen.getByTestId("sel-sales"));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );

    fireEvent.click(screen.getByTestId("delete-sales"));

    await waitFor(() => expect(ds.deleteDashboard).toHaveBeenCalledWith("sales"));
    await waitFor(() =>
      expect(probe().getAttribute("data-names")).toBe("Overview"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("ov"),
    );
  });

  test("deleting the selected dashboard keeps a dashboard rendered throughout (atomic swap)", async () => {
    // A list with no Overview default lands the initial selection on the first
    // row; deleting it falls back to a sibling whose config load we gate, so we
    // can observe that a dashboard stays on screen during the deferred reload.
    const other = { id: "other", name: "Other", isDefault: false, canWrite: true };
    const otherGate = deferred<DashboardConfigV1_1>();
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [SALES, other],
        canCreate: true,
      })),
      loadConfig: vi.fn((id: string) => {
        if (id === "sales") return Promise.resolve(config(2));
        if (id === "other") return otherGate.promise; // gated
        return Promise.resolve(config(0));
      }),
    });
    renderShell(ds);
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );

    fireEvent.click(screen.getByTestId("delete-sales"));
    await waitFor(() => expect(ds.deleteDashboard).toHaveBeenCalledWith("sales"));

    // The replacement config is still loading…
    await waitFor(() => expect(probe().getAttribute("data-pending")).toBe("other"));
    // …and a dashboard is STILL rendered (the outgoing view) — never blank.
    expect(screen.queryByTestId("rendered")).not.toBeNull();
    expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales");

    // Now the replacement commits and the swap completes.
    otherGate.resolve(config(1));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("other"),
    );
  });
});

describe("EntityDashboardsShell — empty / error states", () => {
  test("an empty list renders the empty state", async () => {
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({ dashboards: [], canCreate: false })),
    });
    renderShell(ds);
    await waitFor(() =>
      expect(
        document.querySelector('[data-cinatra-entity-dashboards-state="empty"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("No dashboards yet.")).toBeTruthy();
  });

  test("a list failure renders the error state, and Retry re-lists", async () => {
    const listDashboards = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(INITIAL_LIST);
    const ds = makeDataSource({ listDashboards });
    renderShell(ds);

    await waitFor(() =>
      expect(
        document.querySelector('[data-cinatra-entity-dashboards-state="error"]'),
      ).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    const rendered = await screen.findByTestId("rendered");
    expect(rendered.getAttribute("data-id")).toBe("ov");
    expect(listDashboards).toHaveBeenCalledTimes(2);
  });
});

// ── layer 2: controls render INSIDE the real toolbar + Overview reflect ──────

const EMPTY_TOOLBAR_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as React.ComponentProps<typeof DashboardProvider>["config"];

function toolbarRenderer(args: EntityDashboardRenderArgs) {
  return (
    <DashboardPageAnchorProvider pageAnchor={args.pageAnchor}>
      <DashboardProvider
        config={EMPTY_TOOLBAR_CONFIG}
        editable={args.editable}
        dashboardModes={["grid"]}
      >
        <CinatraDashboardToolbar />
        <div data-testid="rendered" data-id={args.summary.id} />
      </DashboardProvider>
    </DashboardPageAnchorProvider>
  );
}

function renderShellWithToolbar(ds: EntityDashboardsDataSource) {
  return render(
    <EntityDashboardsShell
      dataSource={ds}
      pageAnchor="team-detail"
      renderDashboard={toolbarRenderer}
    />,
  );
}

describe("EntityDashboardsShell — controls render in the toolbar", () => {
  test("renders the select + New dashboard inside the standard toolbar", async () => {
    renderShellWithToolbar(makeDataSource());
    await screen.findByTestId("rendered");

    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar).not.toBeNull();
    expect(
      within(toolbar as HTMLElement).getByRole("button", {
        name: "Select dashboard",
      }),
    ).toBeTruthy();
    // The select trigger shows the current dashboard name.
    expect(within(toolbar as HTMLElement).getByText("Overview")).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: /New dashboard/ }),
    ).toBeTruthy();
    // Standard toolbar affordance still present.
    expect(
      within(toolbar as HTMLElement).getByRole("button", {
        name: "Edit dashboard",
      }),
    ).toBeTruthy();
  });

  test("Overview is reflected as non-removable: no manage (rename/delete) affordance", async () => {
    renderShellWithToolbar(makeDataSource());
    await screen.findByTestId("rendered");
    // Selected = Overview (isDefault) ⇒ no manage menu.
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
  });

  test("a writable non-default dashboard exposes the manage (rename/delete) menu", async () => {
    // A list with no Overview default lands the initial selection on the
    // writable non-default row, so the manage affordance shows without driving
    // the Radix menu (kept out of jsdom for determinism).
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [SALES],
        canCreate: true,
      })),
    });
    renderShellWithToolbar(ds);
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );
    expect(screen.getByRole("button", { name: /^Manage Sales/ })).toBeTruthy();
  });

  test("no New dashboard control when the actor cannot create", async () => {
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [{ ...OVERVIEW, canWrite: false }],
        canCreate: false,
      })),
    });
    renderShellWithToolbar(ds);
    await screen.findByTestId("rendered");
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();
  });
});
