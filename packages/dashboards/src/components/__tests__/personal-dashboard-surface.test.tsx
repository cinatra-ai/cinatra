// @vitest-environment jsdom
//
// Covers the `/personal` integration of the reusable entity Dashboards surface
// (cinatra#703): the personal entity ref, the ref-binding of the generic #701
// actions into the shell's data source, and — driving the REAL
// `<EntityDashboardsShell>` + REAL `<CinatraDashboardToolbar>` — that the
// dashboard-select + "+ New dashboard" controls render for the `personal`
// anchor and that every data-source thunk confines to the personal ref.
//
// Lives under `components/__tests__` (not `screens/`) because it mounts the
// real toolbar via `drizzle-cube/client`'s `DashboardProvider`, which the
// import policy allows only inside `packages/dashboards/src/components/` — the
// same reason the #701 shell test lives here. The shell's own state machine is
// proven by that suite (`entity-dashboards-shell.test.tsx`); here we prove the
// PERSONAL wiring on top of it, with in-memory action spies (no session/DB).
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/personal-dashboard-surface.test.tsx

import "./jsdom-shims";
import React from "react";
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
import { CinatraDashboardToolbar } from "../cinatra-dashboard-toolbar";
import { DashboardPageAnchorProvider } from "../dashboard-page-anchor";
import { useEntityDashboards } from "../entity-dashboards-context";
import type { DashboardConfigV1_1 } from "../../store/dashboard-config";
import type {
  EntityDashboardSummary,
  EntityDashboardsList,
} from "../../entity-dashboards-contract";
import {
  bindPersonalDashboardsDataSource,
  buildPersonalEntityRef,
  type PersonalDashboardsActions,
} from "../../screens/personal-dashboard-data-source";

afterEach(cleanup);

// ── fixtures ────────────────────────────────────────────────────────────────

const ORG = "org-1";
const USER = "user-1";
const REF = buildPersonalEntityRef(ORG, USER);
// The personal Overview id is exactly the legacy single-id row (convergence).
const OVERVIEW_ID = `system-personal:${ORG}:${USER}`;

const OVERVIEW: EntityDashboardSummary = {
  id: OVERVIEW_ID,
  name: "Overview",
  isDefault: true,
  canWrite: true,
};

function emptyConfig(): DashboardConfigV1_1 {
  return {
    portlets: [],
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  } as unknown as DashboardConfigV1_1;
}

/** In-memory personal action spies; override any thunk per test. */
function makeActions(
  overrides: Partial<PersonalDashboardsActions> = {},
): PersonalDashboardsActions {
  return {
    listEntityDashboardsAction: vi.fn(
      async (): Promise<EntityDashboardsList> => ({
        dashboards: [OVERVIEW],
        canCreate: true,
      }),
    ),
    getEntityDashboardConfigAction: vi.fn(async () => emptyConfig()),
    createEntityDashboardAction: vi.fn(async (_ref, name: string) => ({
      ok: true as const,
      dashboard: {
        id: `dash:personal:${name}`,
        name,
        isDefault: false,
        canWrite: true,
      },
    })),
    renameEntityDashboardAction: vi.fn(async (_ref, id: string, name: string) => ({
      ok: true as const,
      dashboard: { id, name, isDefault: false, canWrite: true },
    })),
    deleteEntityDashboardAction: vi.fn(async () => ({ ok: true as const })),
    saveEntityDashboardConfigAction: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── layer 1: the personal ref + data-source binding (pure) ───────────────────

describe("buildPersonalEntityRef", () => {
  test("maps (org, user) onto a user-owned personal ref", () => {
    expect(buildPersonalEntityRef(ORG, USER)).toEqual({
      entityType: "personal",
      entityId: ORG,
      ownerLevel: "user",
      ownerId: USER,
    });
  });
});

describe("bindPersonalDashboardsDataSource", () => {
  test("prepends the personal ref to every action and returns its result", async () => {
    const actions = makeActions();
    const ds = bindPersonalDashboardsDataSource(REF, actions);
    const cfg = emptyConfig();

    await ds.listDashboards();
    await ds.loadConfig("d1");
    await ds.createDashboard("Sales");
    await ds.renameDashboard?.("d1", "Renamed");
    await ds.deleteDashboard?.("d1");
    await ds.saveDashboard("d1", cfg);

    expect(actions.listEntityDashboardsAction).toHaveBeenCalledWith(REF);
    expect(actions.getEntityDashboardConfigAction).toHaveBeenCalledWith(REF, "d1");
    expect(actions.createEntityDashboardAction).toHaveBeenCalledWith(REF, "Sales");
    expect(actions.renameEntityDashboardAction).toHaveBeenCalledWith(
      REF,
      "d1",
      "Renamed",
    );
    expect(actions.deleteEntityDashboardAction).toHaveBeenCalledWith(REF, "d1");
    expect(actions.saveEntityDashboardConfigAction).toHaveBeenCalledWith(
      REF,
      "d1",
      cfg,
    );
  });

  test("create returns the newly-created dashboard summary through the shell contract", async () => {
    const ds = bindPersonalDashboardsDataSource(REF, makeActions());
    const result = await ds.createDashboard("Sales");
    expect(result).toEqual({
      ok: true,
      dashboard: {
        id: "dash:personal:Sales",
        name: "Sales",
        isDefault: false,
        canWrite: true,
      },
    });
  });
});

// ── layer 2: real shell + real toolbar for the `personal` anchor ─────────────

const EMPTY_TOOLBAR_CONFIG = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as React.ComponentProps<typeof DashboardProvider>["config"];

/** A context probe that drives create deterministically (the New-dashboard
 *  DIALOG is Radix — kept out of jsdom for determinism, as in the #701 suite;
 *  the dialog→onCreate leg is proven there, the ref-forwarding in layer 1). */
function CreateProbe() {
  const ctx = useEntityDashboards();
  if (!ctx) return null;
  return (
    <div data-testid="probe" data-names={ctx.dashboards.map((d) => d.name).join(",")}>
      <Button data-testid="probe-create" onClick={() => void ctx.onCreate("Sales")}>
        create
      </Button>
    </div>
  );
}

/** Mounts the REAL toolbar (the epic-placed select + New controls live inside
 *  it) so we assert against the same DOM the app renders. */
function toolbarRenderer(args: EntityDashboardRenderArgs) {
  return (
    <DashboardPageAnchorProvider pageAnchor={args.pageAnchor}>
      <DashboardProvider
        config={EMPTY_TOOLBAR_CONFIG}
        editable={args.editable}
        dashboardModes={["grid"]}
      >
        <CinatraDashboardToolbar />
        <div
          data-testid="rendered"
          data-id={args.summary.id}
          data-anchor={args.pageAnchor}
        />
        <CreateProbe />
      </DashboardProvider>
    </DashboardPageAnchorProvider>
  );
}

function renderPersonalSurface(actions: PersonalDashboardsActions) {
  const ds = bindPersonalDashboardsDataSource(REF, actions);
  return render(
    <EntityDashboardsShell
      dataSource={ds}
      pageAnchor="personal"
      renderDashboard={toolbarRenderer}
    />,
  );
}

describe("/personal Dashboards surface", () => {
  test("renders the select + '+ New dashboard' inside the toolbar for the personal anchor", async () => {
    const actions = makeActions();
    renderPersonalSurface(actions);

    // The client-load path exercises the bound list thunk with the personal ref.
    const rendered = await screen.findByTestId("rendered");
    expect(rendered.getAttribute("data-anchor")).toBe("personal");
    expect(rendered.getAttribute("data-id")).toBe(OVERVIEW_ID);
    expect(actions.listEntityDashboardsAction).toHaveBeenCalledWith(REF);

    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    );
    expect(toolbar).not.toBeNull();
    expect(
      within(toolbar as HTMLElement).getByRole("button", {
        name: "Select dashboard",
      }),
    ).toBeTruthy();
    expect(within(toolbar as HTMLElement).getByText("Overview")).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", {
        name: /New dashboard/,
      }),
    ).toBeTruthy();
    // The single-dashboard Edit/Save affordance is preserved.
    expect(
      within(toolbar as HTMLElement).getByRole("button", {
        name: "Edit dashboard",
      }),
    ).toBeTruthy();
  });

  test("the loaded Overview config is fetched through the ref-bound loadConfig", async () => {
    const actions = makeActions();
    renderPersonalSurface(actions);
    await screen.findByTestId("rendered");
    expect(actions.getEntityDashboardConfigAction).toHaveBeenCalledWith(
      REF,
      OVERVIEW_ID,
    );
  });

  test("creating a named dashboard persists via the personal ref, then appears + is selected", async () => {
    const actions = makeActions();
    renderPersonalSurface(actions);
    await screen.findByTestId("rendered");

    fireEvent.click(screen.getByTestId("probe-create"));

    // Persisted through the personal-ref-bound create action…
    await waitFor(() =>
      expect(actions.createEntityDashboardAction).toHaveBeenCalledWith(
        REF,
        "Sales",
      ),
    );
    // …appears in the dropdown (the AC)…
    await waitFor(() =>
      expect(screen.getByTestId("probe").getAttribute("data-names")).toBe(
        "Overview,Sales",
      ),
    );
    // …and the new (empty) dashboard becomes the rendered selection so the user
    // can add portlets to it, with its name in the select trigger.
    await waitFor(() =>
      expect(screen.getByTestId("rendered").getAttribute("data-id")).toBe(
        "dash:personal:Sales",
      ),
    );
    const toolbar = document.querySelector<HTMLElement>(
      "[data-cinatra-dashboard-toolbar]",
    ) as HTMLElement;
    await waitFor(() => expect(within(toolbar).getByText("Sales")).toBeTruthy());
  });

  test("the Overview default is reflected non-removable (no rename/delete affordance)", async () => {
    renderPersonalSurface(makeActions());
    await screen.findByTestId("rendered");
    // Selected = Overview (isDefault) ⇒ no manage menu.
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull();
  });
});
