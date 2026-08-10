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
//      dashboard" render INSIDE the standard toolbar, and that the toolbar
//      carries NO three-dot overflow control in any selection state (owner
//      review on cinatra#2474 PR5, PR #2638 — the manage menu that used to hold
//      Rename / Delete is gone; the context callbacks it drove are still wired
//      and still exercised by layer 1).
//   3. EDIT-mode toolbar — pressing "Edit dashboard" raises Rename and Delete
//      as worded buttons in that same first toolbar (the owner's second review
//      on PR #2638), under the ORIGINAL gate `canWrite && !isDefault`, and they
//      drive the very same data-source calls the removed menu drove.
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
import {
  EntityDashboardsProvider,
  useEntityDashboards,
} from "../entity-dashboards-context";
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
/** A second writable, non-default row — used for the swap/fallback cases. */
const OTHER: EntityDashboardSummary = {
  id: "other",
  name: "Other",
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
    saveDashboard: vi.fn(async () => ({ ok: true as const })),
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

/**
 * The owner's first requested change on PR #2638: "remove the three dots inside
 * the toolbar". Encoded as a property rather than a selector for one icon —
 * EVERY control in the dashboard toolbar says what it is in words, so a wordless
 * overflow button cannot come back under a different icon or a different label.
 */
function expectNoOverflowControl(toolbar: HTMLElement) {
  expect(toolbar).not.toBeNull();
  // No manage/overflow menu by name…
  expect(within(toolbar).queryByRole("button", { name: /^Manage / })).toBeNull();
  // …no ellipsis glyph…
  expect(
    toolbar.querySelector(
      '[class*="ellipsis" i], [class*="more-horizontal" i], [class*="more-vertical" i]',
    ),
  ).toBeNull();
  // …and no wordless button at all, which is the shape a three-dot control has.
  for (const button of toolbar.querySelectorAll("button")) {
    expect(button.textContent?.trim() ?? "").not.toBe("");
  }
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

  test("the toolbar carries NO three-dot overflow control — Overview selected", async () => {
    renderShellWithToolbar(makeDataSource());
    await screen.findByTestId("rendered");

    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    ) as HTMLElement;
    expectNoOverflowControl(toolbar);
  });

  test("the toolbar carries NO three-dot overflow control — a writable non-default dashboard selected", async () => {
    // This is the case that USED to raise the overflow (Rename / Delete): a
    // list with no Overview default lands the initial selection on the writable
    // non-default row. The owner asked for the three dots to go from the
    // toolbar (review on PR #2638), so nothing renders here now — which also
    // means Rename and Delete have no UI entry point; the context callbacks
    // stay wired (exercised directly in layer 1 above) and the server actions
    // are untouched.
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

    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    ) as HTMLElement;
    expectNoOverflowControl(toolbar);
    // The controls that must SURVIVE the removal are still there.
    expect(
      within(toolbar).getByRole("button", { name: "Select dashboard" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: /New dashboard/ }),
    ).toBeTruthy();
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

// ── layer 3: the EDIT-mode toolbar carries Rename + Delete ───────────────────
//
// The owner's second review on PR #2638: "when clicking 'Edit dashboard' in the
// toolbar, new toolbars show up that include the editing options — in the first
// of these toolbars … add a button that allows to rename it and a button that
// allows to delete it". The FIRST of those bars is `<CinatraDashboardToolbar>`
// itself (the second is drizzle-cube's filter bar, mounted by
// `<DashboardFilterBarSlot>` and out of this render). So the assertions below
// look for the two controls in the same toolbar element as "Add portlet".

/** Enter edit mode the way a user does, and hand back the toolbar element. */
async function editModeToolbar(
  ds: EntityDashboardsDataSource,
  selectedId: string,
): Promise<HTMLElement> {
  renderShellWithToolbar(ds);
  await waitFor(() =>
    expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe(
      selectedId,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
  // The edit-controls group is the proof that edit mode is on.
  expect(screen.getByRole("button", { name: "Add portlet" })).toBeTruthy();
  return document.querySelector<HTMLElement>(
    "[data-cinatra-dashboard-toolbar]",
  ) as HTMLElement;
}

/** A list whose only row is the writable, non-default one — so the initial
 *  selection lands on it without driving the Radix select in jsdom. */
function salesOnly(overrides: Partial<EntityDashboardsDataSource> = {}) {
  return makeDataSource({
    listDashboards: vi.fn(async () => ({
      dashboards: [SALES],
      canCreate: true,
    })),
    ...overrides,
  });
}

describe("EntityDashboardsShell — Rename / Delete in the edit-mode toolbar", () => {
  test("a writable non-default dashboard raises Rename and Delete in the first toolbar", async () => {
    const toolbar = await editModeToolbar(salesOnly(), "sales");

    expect(
      within(toolbar).getByRole("button", { name: "Rename Sales" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "Delete Sales" }),
    ).toBeTruthy();
    // They sit in the SAME bar as the editing options the owner named.
    expect(within(toolbar).getByRole("button", { name: "Add portlet" })).toBeTruthy();
    // …and they are worded controls, not a re-grown overflow: the property the
    // first review's fix locked still holds in edit mode.
    expectNoOverflowControl(toolbar);
  });

  test("the default (Overview) dashboard raises neither — the original gate, unchanged", async () => {
    const toolbar = await editModeToolbar(makeDataSource(), "ov");

    expect(within(toolbar).queryByRole("button", { name: /^Rename / })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: /^Delete / })).toBeNull();
    // Edit mode really is on — the absence is the gate, not a missing toolbar.
    expect(within(toolbar).getByRole("button", { name: "Add portlet" })).toBeTruthy();
  });

  test("a read-only dashboard raises neither — it never reaches edit mode at all", async () => {
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [{ ...SALES, canWrite: false }],
        canCreate: false,
      })),
    });
    renderShellWithToolbar(ds);
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );

    // `editable` is the selected dashboard's own canWrite, so there is no edit
    // toggle to press and no edit-mode group to carry the two controls.
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  test("VIEW mode carries neither, on the very dashboard that offers both in edit mode", async () => {
    // Negative control for the placement: the two controls belong to the edit
    // toolbar only. (The first review's promise — a view-mode toolbar with no
    // rename/delete entry point and no overflow — is unchanged.)
    renderShellWithToolbar(salesOnly());
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("sales"),
    );

    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    ) as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "Edit dashboard" })).toBeTruthy();
    expect(within(toolbar).queryByRole("button", { name: /^Rename / })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: /^Delete / })).toBeNull();
    expectNoOverflowControl(toolbar);
  });

  test("Rename opens the name dialog and drives the surface's rename action", async () => {
    const renameDashboard = vi.fn(async (id: string, name: string) => ({
      ok: true as const,
      dashboard: { id, name, isDefault: false, canWrite: true },
    }));
    const toolbar = await editModeToolbar(salesOnly({ renameDashboard }), "sales");

    fireEvent.click(within(toolbar).getByRole("button", { name: "Rename Sales" }));

    // The dialog pre-fills the current name and renames through the shell.
    const field = await screen.findByLabelText("Dashboard name");
    expect((field as HTMLInputElement).value).toBe("Sales");
    fireEvent.change(field, { target: { value: "Revenue" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(renameDashboard).toHaveBeenCalledWith("sales", "Revenue"),
    );
    // The new name reaches the toolbar's select trigger.
    await waitFor(() =>
      expect(
        within(
          document.querySelector<HTMLElement>(
            "[data-cinatra-dashboard-toolbar]",
          ) as HTMLElement,
        ).getByText("Revenue"),
      ).toBeTruthy(),
    );
  });

  test("Delete asks for confirmation first, then drives the surface's delete action", async () => {
    const deleteDashboard = vi.fn(async () => ({ ok: true as const }));
    const toolbar = await editModeToolbar(salesOnly({ deleteDashboard }), "sales");

    fireEvent.click(within(toolbar).getByRole("button", { name: "Delete Sales" }));

    // Nothing is destroyed on the button press alone.
    expect(deleteDashboard).not.toHaveBeenCalled();
    expect(await screen.findByText("Delete “Sales”?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(deleteDashboard).toHaveBeenCalledWith("sales"));
  });

  test("while the post-delete swap is in flight the controls name the incoming dashboard but CANNOT act on it", async () => {
    // Codex convergence on this change. Deleting the selected dashboard leaves
    // the deleted view on screen while the replacement's config loads, and the
    // toolbar (select trigger AND these controls) falls back to the pending row
    // so the group does not blink out. That fallback must never become an
    // ACTION target: a press in this window would rename or delete a dashboard
    // the user has not selected yet.
    const gate = deferred<DashboardConfigV1_1>();
    const ds = makeDataSource({
      listDashboards: vi.fn(async () => ({
        dashboards: [SALES, OTHER],
        canCreate: true,
      })),
      loadConfig: vi.fn(async (id: string) =>
        id === "other" ? gate.promise : config(1),
      ),
    });
    const toolbar = await editModeToolbar(ds, "sales");

    fireEvent.click(within(toolbar).getByRole("button", { name: "Delete Sales" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

    const bar = () =>
      document.querySelector<HTMLElement>(
        "[data-cinatra-dashboard-toolbar]",
      ) as HTMLElement;
    const rename = (await within(bar()).findByRole("button", {
      name: "Rename Other",
    })) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    expect(
      (within(bar()).getByRole("button", {
        name: "Delete Other",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Once the swap commits, "Other" is genuinely the selection. The shell keys
    // the grid by dashboard id, so the replacement remounts in VIEW mode — the
    // controls leave with the edit toolbar and come back, live, on the next
    // "Edit dashboard".
    gate.resolve(config(1));
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe("other"),
    );
    expect(within(bar()).queryByRole("button", { name: "Rename Other" })).toBeNull();

    fireEvent.click(within(bar()).getByRole("button", { name: "Edit dashboard" }));
    expect(
      (within(bar()).getByRole("button", {
        name: "Rename Other",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("the fallback label is a LABEL, never a target — proven independently of the shell's `busy`", () => {
    // The test above rides the shell, where `busy` happens to be true for the
    // whole fallback window. This one hands the toolbar a context that is NOT
    // busy and whose `selectedId` is absent from the list, so the guard is
    // pinned on its own terms: a control may act only on the row that is
    // actually selected.
    render(
      <DashboardPageAnchorProvider pageAnchor="team-detail">
        <EntityDashboardsProvider
          value={{
            dashboards: [OTHER],
            selectedId: "gone",
            pendingId: "other",
            canCreate: true,
            busy: false,
            onSelect: () => {},
            onCreate: async () => ({ ok: true }),
            onAdopted: () => {},
            onRename: async () => ({ ok: true }),
            onDelete: async () => ({ ok: true }),
          }}
        >
          <DashboardProvider
            config={EMPTY_TOOLBAR_CONFIG}
            editable
            dashboardModes={["grid"]}
          >
            <CinatraDashboardToolbar />
          </DashboardProvider>
        </EntityDashboardsProvider>
      </DashboardPageAnchorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(
      (screen.getByRole("button", { name: "Rename Other" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Delete Other" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("a delete the server refuses keeps the confirmation open and says why", async () => {
    const deleteDashboard = vi.fn(async () => ({
      ok: false as const,
      reason: "denied" as const,
    }));
    const toolbar = await editModeToolbar(salesOnly({ deleteDashboard }), "sales");

    fireEvent.click(within(toolbar).getByRole("button", { name: "Delete Sales" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));

    // Still open, now carrying the shell's reduced copy instead of the warning.
    expect(
      await screen.findByText("You don’t have permission to do that."),
    ).toBeTruthy();
    expect(deleteDashboard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByText(/This can’t be undone/)).toBeNull();
    // The dashboard is still selectable — nothing was removed from the list.
    expect(
      within(
        document.querySelector<HTMLElement>(
          "[data-cinatra-dashboard-toolbar]",
        ) as HTMLElement,
      ).getByText("Sales"),
    ).toBeTruthy();
  });
});
