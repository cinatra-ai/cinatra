// @vitest-environment jsdom
//
// Behavioural proof for the unified Add-dashboard popup (cinatra#2474 PR3,
// design spec `specs/app-artifacts.html` §IX.1/§IX.2).
//
// Renders the REAL toolbar controls over the REAL entity-dashboards context and
// the REAL `ScopeAddSourcesProvider` — the same composition the entity landings
// mount — and drives them with real clicks. What this locks that a source-text
// assertion cannot:
//
//   - a scope MANAGER (the landing handed down a reference source) gets the
//     "Add dashboard" trigger and the popup's Reference section;
//   - a member WITHOUT write authority gets neither — no "Add dashboard"
//     anywhere and no reference section: SUPPRESSION, not a disabled control
//     (§IX.2), while keeping the plain per-user "New dashboard" create;
//   - the Create hand-off closes the popup and opens the preserved
//     `EntityDashboardNameDialog`, which really creates;
//   - a successful Add closes the popup (the candidate pool it showed is stale);
//   - a REJECTED add clears the row's busy state instead of stranding "Adding…".
//
//   pnpm exec vitest run src/components/dashboards/__tests__/add-dashboard-dialog.test.tsx
import "../../__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import {
  EntityDashboardsProvider,
  type EntityDashboardsContextValue,
} from "../../../../packages/dashboards/src/components/entity-dashboards-context";
import { EntityDashboardsToolbarControls } from "@cinatra-ai/dashboards/entity-dashboard-toolbar-controls";

import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import type {
  AddPickerCandidateView,
  ScopeReferenceSource,
} from "@/components/dashboards/scope-dashboards-contract";

const OVERVIEW = {
  id: "d-overview",
  name: "Overview",
  isDefault: true,
  canWrite: true,
} as const;

function ctx(
  over: Partial<EntityDashboardsContextValue> = {},
): EntityDashboardsContextValue {
  return {
    dashboards: [OVERVIEW as never],
    selectedId: OVERVIEW.id,
    pendingId: null,
    canCreate: true,
    busy: false,
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => ({ ok: true as const })),
    onRename: null,
    onDelete: null,
    ...over,
  };
}

const CANDIDATE: AddPickerCandidateView = {
  dashboardId: "d-1",
  name: "Pipeline health",
  homeNote: "the team can already see this",
  disposition: "addable",
};

const PROMOTION_CANDIDATE: AddPickerCandidateView = {
  dashboardId: "d-2",
  name: "Personal experiments",
  homeNote: "private — the team can\u2019t see it yet",
  disposition: "promotion",
  promotionLabel: "Request team visibility…",
};

function referenceSource(
  over: Partial<ScopeReferenceSource> = {},
): ScopeReferenceSource {
  return {
    listCandidates: vi.fn(async () => [CANDIDATE]),
    addListing: vi.fn(async () => ({ ok: true as const })),
    requestPromotion: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function mount({
  value = ctx(),
  reference,
  catalog = null,
}: {
  value?: EntityDashboardsContextValue;
  reference: ScopeReferenceSource | null;
  /** Stands in for cinatra#2474 PR4's installed-catalog section. */
  catalog?: React.ReactElement | null;
}) {
  return render(
    <ScopeAddSourcesProvider
      scopeLabel="Team: Growth"
      reference={reference}
      catalog={catalog}
    >
      <EntityDashboardsProvider value={value}>
        <EntityDashboardsToolbarControls />
      </EntityDashboardsProvider>
    </ScopeAddSourcesProvider>,
  );
}

/** A stand-in for PR4's catalog node — PR3 ships the slot, not the section. */
const CATALOG_SLOT = <section aria-label="Add from the installed catalog" />;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("§IX.2 — who sees the scope-level Add (suppression, not a disabled control)", () => {
  it("a scope MANAGER gets 'Add dashboard', which opens the popup titled for the scope", async () => {
    const reference = referenceSource();
    mount({ reference });

    const trigger = screen.getByRole("button", {
      name: /Add dashboard/,
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    // The plain per-user create button is replaced by the unified one, not doubled.
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();

    fireEvent.click(trigger);

    expect(
      await screen.findByText("Add a dashboard to Team: Growth"),
    ).toBeTruthy();
    // Both sections are offered.
    expect(screen.getByText("Create new")).toBeTruthy();
    expect(screen.getByText("Reference an existing dashboard")).toBeTruthy();
    // …and the §IX.1 pool really loads through the bound action.
    expect(await screen.findByText("Pipeline health")).toBeTruthy();
    expect(reference.listCandidates).toHaveBeenCalledTimes(1);
  });

  it("a member WITHOUT write authority gets no Add affordance at all — and no disabled one", () => {
    mount({ reference: null });

    expect(screen.queryByRole("button", { name: /Add dashboard/ })).toBeNull();
    // The per-user create survives: it curates nothing in the scope's collection.
    const create = screen.getByRole("button", {
      name: /New dashboard/,
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    // Nothing anywhere is a disabled management control.
    for (const button of screen.queryAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("a member who cannot even create gets no add button at all", () => {
    mount({ value: ctx({ canCreate: false }), reference: null });
    expect(screen.queryByRole("button", { name: /Add dashboard/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New dashboard/ })).toBeNull();
  });

  it("a catalog (PR4) never promotes a non-manager to the scope-level Add", async () => {
    // The regression this locks: deriving the trigger from "any scope source"
    // hands a member the exact management affordance §IX.2 suppresses the moment
    // concept B supplies a catalog. The catalog may only make the popup exist.
    const { container } = mount({ reference: null, catalog: CATALOG_SLOT });

    expect(screen.queryByRole("button", { name: /Add dashboard/ })).toBeNull();
    expect(
      container.querySelector(
        '[data-conformance-id="scope-dashboards-write-access"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-action="open-add-picker -> add-picker-open"]',
      ),
    ).toBeNull();

    // …and the catalog is still reachable, through the plain create trigger.
    fireEvent.click(screen.getByRole("button", { name: /New dashboard/ }));
    expect(
      await screen.findByText("Add a dashboard to Team: Growth"),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Add from the installed catalog" }),
    ).toBeTruthy();
    // No reference section for a non-manager, in the popup either.
    expect(screen.queryByText("Reference an existing dashboard")).toBeNull();
  });

  it("a scope manager's Add carries the §IX.2 annotation and the open-add-picker action", () => {
    const { container } = mount({ reference: referenceSource() });
    const annotated = container.querySelector(
      '[data-conformance-id="scope-dashboards-write-access"][data-field="manage-controls=collectionAdd.actorMayWriteScope"]',
    );
    expect(annotated).not.toBeNull();
    expect(
      annotated!.querySelector(
        '[data-action="open-add-picker -> add-picker-open"]',
      ),
    ).not.toBeNull();
  });

  it("a manager who cannot create still gets the popup — with the Reference section only", async () => {
    mount({ value: ctx({ canCreate: false }), reference: referenceSource() });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));

    expect(
      await screen.findByText("Reference an existing dashboard"),
    ).toBeTruthy();
    expect(screen.queryByText("Create new")).toBeNull();
  });
});

describe("the Create hand-off keeps EntityDashboardNameDialog as the one name prompt", () => {
  it("choosing Create closes the popup, opens the name prompt, and really creates", async () => {
    const onCreate = vi.fn(async () => ({ ok: true as const }));
    mount({ value: ctx({ onCreate }), reference: referenceSource() });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Create…/ }));

    // The popup is gone, the name prompt is up — a hand-off, not a nested dialog.
    await waitFor(() => {
      expect(screen.queryByText("Add a dashboard to Team: Growth")).toBeNull();
    });
    expect(await screen.findByText("New dashboard")).toBeTruthy();

    // The hand-off must not lose focus to the closing popup's trigger restore.
    const field = screen.getByLabelText("Dashboard name");
    await waitFor(() => expect(document.activeElement).toBe(field));

    fireEvent.change(field, {
      target: { value: "Q3 pipeline" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Q3 pipeline"));
  });
});

describe("§IX.1 — adding a reference listing", () => {
  it("a successful Add closes the popup and refreshes the collection panel", async () => {
    const reference = referenceSource();
    mount({ reference });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(reference.addListing).toHaveBeenCalledWith("d-1"),
    );
    await waitFor(() => {
      expect(screen.queryByText("Add a dashboard to Team: Growth")).toBeNull();
    });
    expect(toastSuccess).toHaveBeenCalledWith("Dashboard listed in this scope");
    expect(refresh).toHaveBeenCalled();
  });

  it("a DENIED add keeps the popup open and states the reason", async () => {
    const reference = referenceSource({
      addListing: vi.fn(async () => ({ ok: false as const, reason: "denied" as const })),
    });
    mount({ reference });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "You don’t have permission to manage this scope’s dashboards.",
      ),
    );
    expect(screen.getByText("Add a dashboard to Team: Growth")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a REJECTED add clears the row's busy state instead of stranding 'Adding…'", async () => {
    const reference = referenceSource({
      addListing: vi.fn(async () => {
        throw new Error("transport fault");
      }),
    });
    mount({ reference });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Back to an actionable Add — not a permanently disabled "Adding…".
    const add = (await screen.findByRole("button", {
      name: "Add",
    })) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
  });

  it("a REJECTED promotion request clears the row's busy state too", async () => {
    const reference = referenceSource({
      listCandidates: vi.fn(async () => [PROMOTION_CANDIDATE]),
      requestPromotion: vi.fn(async () => {
        throw new Error("transport fault");
      }),
    });
    mount({ reference });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Request team visibility…" }),
    );

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const promote = (await screen.findByRole("button", {
      name: "Request team visibility…",
    })) as HTMLButtonElement;
    expect(promote.disabled).toBe(false);
  });

  it("a candidate the scope cannot see offers the promotion request, never an in-place Add", async () => {
    const reference = referenceSource({
      listCandidates: vi.fn(async () => [
        {
          dashboardId: "d-2",
          name: "Personal experiments",
          homeNote: "private — the team can’t see it yet",
          disposition: "promotion" as const,
          promotionLabel: "Request team visibility…",
        },
      ]),
    });
    mount({ reference });

    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));

    expect(
      await screen.findByRole("button", { name: "Request team visibility…" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});
