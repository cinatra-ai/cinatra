"use client";
/**
 * EntityDashboardsShell — the reusable "Dashboards" tab content (cinatra#701).
 *
 * Renders the SELECTED entity dashboard and owns the list/selection state that
 * drives the dashboard-select dropdown + "+ New dashboard" control (which
 * `<CinatraDashboardToolbar>` paints from `EntityDashboardsContext`). Every
 * hosting surface (#703 personal, #704 team, #705 org, #706 project) drops this
 * component in with its own server-action bindings; the shell itself is
 * surface-agnostic.
 *
 * Boundaries this file deliberately holds:
 *   - It never touches the database or the entity ref: it only calls the
 *     `EntityDashboardsDataSource` thunks the surface bound (server-side,
 *     Next-encrypted ref; row/ref confinement + capability derivation live in
 *     `actions.ts`). The client can neither read nor forge the owner axis.
 *   - It does NOT ensure/seed the Overview — the surface does that (with the
 *     entity-summary seed once #702 lands) BEFORE listing, so #701 never
 *     pre-empts #702's Overview content. The shell renders whatever list it is
 *     given, Overview included.
 *   - Portlet CONTENT is #702's concern. The shell hands the selected config to
 *     `renderDashboard` (default: the analytics keystone grid,
 *     `EmbeddedDrizzleCubeDashboardGrid`); an Overview-aware renderer is a
 *     drop-in override at that seam — no shell edit needed.
 *
 * Correctness (codex round-0): config loads are sequence-guarded so a slow load
 * for a superseded selection can never replace a newer one; a switch keeps the
 * current dashboard mounted until the next config is ready (atomic swap), so the
 * toolbar/select never blink out mid-switch; mutations update the list only
 * AFTER the server confirms, so a failed create/rename/delete leaves state
 * consistent; and `editable` is gated on the server-derived per-dashboard
 * `canWrite`, never assumed.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import {
  ENTITY_DASHBOARD_REASON_COPY,
  type EntityDashboardSummary,
  type EntityDashboardsDataSource,
  type EntityDashboardsList,
  type SavedEntityDashboard,
} from "../entity-dashboards-contract";
import { EmbeddedDrizzleCubeDashboardGrid } from "./embedded-drizzle-cube-dashboard-grid";
import { EntityDashboardNameDialog } from "./entity-dashboard-name-dialog";
import {
  EntityDashboardsProvider,
  type EntityDashboardsContextValue,
  type EntityDashboardsToolbarOutcome,
} from "./entity-dashboards-context";
import type { DashboardMode } from "./dashboards-client-shell";
import type { DashboardPageAnchor } from "./dashboard-page-anchor";

/** Args handed to the pluggable dashboard renderer (the #702 seam). */
export type EntityDashboardRenderArgs = {
  readonly summary: EntityDashboardSummary;
  readonly config: DashboardConfigV1_1;
  /** Server-derived per-dashboard write capability. */
  readonly editable: boolean;
  /** Persist the edited config. Only wired when `editable`. Resolves the typed
   *  save result (cinatra#1913) — the grid container interprets failures. */
  readonly onSave: (
    next: DashboardConfigV1_1,
  ) => Promise<void | SavedEntityDashboard>;
  readonly pageAnchor: DashboardPageAnchor;
  readonly dashboardModes: readonly DashboardMode[];
};

/** Default renderer: the analytics keystone grid (#701 AC). */
function defaultRenderDashboard(args: EntityDashboardRenderArgs): ReactNode {
  return (
    <EmbeddedDrizzleCubeDashboardGrid
      dashboard={args.config}
      editable={args.editable}
      onSave={args.editable ? args.onSave : undefined}
      pageAnchor={args.pageAnchor}
      dashboardModes={args.dashboardModes}
    />
  );
}

export type EntityDashboardsShellProps = {
  readonly dataSource: EntityDashboardsDataSource;
  /** The surface anchor the toolbar keys its controls on. */
  readonly pageAnchor: DashboardPageAnchor;
  readonly dashboardModes?: readonly DashboardMode[];
  /**
   * SSR seed to skip the first client round-trip. When present the shell paints
   * the selected dashboard immediately; when absent it loads client-side
   * (showing the loading state). Either way the same states are reachable.
   */
  readonly initialData?: {
    readonly list: EntityDashboardsList;
    readonly selectedId: string;
    readonly config: DashboardConfigV1_1;
  };
  /** Override how a selected dashboard renders (the #702 Overview seam). */
  readonly renderDashboard?: (args: EntityDashboardRenderArgs) => ReactNode;
};

/** A self-contained snapshot of the rendered dashboard. It carries its OWN
 *  summary so what's on screen never depends on a lookup into the (mutating)
 *  list — this is what keeps the swap atomic even when the selected dashboard is
 *  deleted (its summary leaves the list but the view keeps rendering until the
 *  replacement config commits). */
type View = {
  readonly id: string;
  readonly config: DashboardConfigV1_1;
  readonly summary: EntityDashboardSummary;
};

function reason(message: keyof typeof ENTITY_DASHBOARD_REASON_COPY): string {
  return ENTITY_DASHBOARD_REASON_COPY[message];
}

/** Pick the selection to show after a (re)list: keep the current one if it
 *  survives, else the Overview default, else the first row. */
function pickSelection(
  list: EntityDashboardsList,
  current: string | null,
): string | null {
  if (current && list.dashboards.some((d) => d.id === current)) return current;
  const overview = list.dashboards.find((d) => d.isDefault);
  return overview?.id ?? list.dashboards[0]?.id ?? null;
}

export function EntityDashboardsShell({
  dataSource,
  pageAnchor,
  dashboardModes = ["grid"],
  initialData,
  renderDashboard = defaultRenderDashboard,
}: EntityDashboardsShellProps) {
  const [list, setList] = useState<EntityDashboardsList | null>(
    initialData?.list ?? null,
  );
  const [view, setView] = useState<View | null>(() => {
    if (!initialData) return null;
    const summary = initialData.list.dashboards.find(
      (d) => d.id === initialData.selectedId,
    );
    return summary
      ? { id: initialData.selectedId, config: initialData.config, summary }
      : null;
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [listError, setListError] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [emptyCreateOpen, setEmptyCreateOpen] = useState(false);

  // Monotonic token: only the latest config load may commit a view, so a slow
  // load for a superseded selection is dropped instead of clobbering a newer one.
  const loadSeq = useRef(0);
  // Guard the initial auto-load effect from double-running.
  const bootstrapped = useRef(initialData != null);

  const { listDashboards, loadConfig, createDashboard, renameDashboard, deleteDashboard, saveDashboard } =
    dataSource;

  const loadConfigInto = useCallback(
    (summary: EntityDashboardSummary) => {
      const seq = ++loadSeq.current;
      setPendingId(summary.id);
      setSwitchError(null);
      loadConfig(summary.id)
        .then((config) => {
          if (seq !== loadSeq.current) return; // superseded
          // Commit the id, config AND summary together — a self-contained view.
          setView({ id: summary.id, config, summary });
          setPendingId(null);
        })
        .catch(() => {
          if (seq !== loadSeq.current) return;
          setPendingId(null);
          // A failed switch keeps the current dashboard on screen; a failed
          // FIRST load surfaces as the top-level error instead.
          setSwitchError("Couldn’t load that dashboard. Try again.");
          setView((current) => {
            if (current == null) setListError(true);
            return current;
          });
        });
    },
    [loadConfig],
  );

  // Called only when no dashboard is established (initial mount + Retry), so it
  // resolves the selection from scratch — no `view` closure to go stale.
  const loadList = useCallback(() => {
    setListError(false);
    return listDashboards()
      .then((next) => {
        setList(next);
        const selection = pickSelection(next, null);
        const summary = selection
          ? next.dashboards.find((d) => d.id === selection)
          : undefined;
        if (summary) {
          loadConfigInto(summary);
        } else {
          // Empty list — nothing to render.
          loadSeq.current++;
          setPendingId(null);
          setView(null);
        }
        return next;
      })
      .catch(() => {
        // Only escalate to the top-level error when there is nothing on screen;
        // a failed refresh while a dashboard is shown is non-destructive.
        setView((current) => {
          if (current == null) setListError(true);
          return current;
        });
      });
  }, [listDashboards, loadConfigInto]);

  // Initial client-side load when the surface provided no SSR seed.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void loadList();
  }, [loadList]);

  // ── selection ──────────────────────────────────────────────────────────
  const onSelect = useCallback(
    (id: string) => {
      if (id === view?.id && pendingId == null) return;
      const summary = list?.dashboards.find((d) => d.id === id);
      if (summary) loadConfigInto(summary);
    },
    [view, pendingId, list, loadConfigInto],
  );

  // ── create ─────────────────────────────────────────────────────────────
  const onCreate = useCallback(
    async (name: string): Promise<EntityDashboardsToolbarOutcome> => {
      setMutating(true);
      try {
        const result = await createDashboard(name);
        if (!result.ok) return { ok: false, message: reason(result.reason) };
        setList((prev) =>
          prev
            ? { ...prev, dashboards: [...prev.dashboards, result.dashboard] }
            : { dashboards: [result.dashboard], canCreate: true },
        );
        // Select + render the new (empty) dashboard so the user can add portlets.
        loadConfigInto(result.dashboard);
        return { ok: true };
      } catch {
        return { ok: false, message: "Couldn’t create the dashboard. Try again." };
      } finally {
        setMutating(false);
      }
    },
    [createDashboard, loadConfigInto],
  );

  // ── rename ─────────────────────────────────────────────────────────────
  const onRename = useCallback(
    async (id: string, name: string): Promise<EntityDashboardsToolbarOutcome> => {
      if (!renameDashboard) return { ok: false, message: "Rename is unavailable." };
      setMutating(true);
      try {
        const result = await renameDashboard(id, name);
        if (!result.ok) return { ok: false, message: reason(result.reason) };
        setList((prev) =>
          prev
            ? {
                ...prev,
                dashboards: prev.dashboards.map((d) =>
                  d.id === id ? result.dashboard : d,
                ),
              }
            : prev,
        );
        // Keep the rendered snapshot in sync when the renamed dashboard IS the
        // one on screen — the view carries its own summary, so a list-only
        // update would leave the rendered name stale until reselection.
        setView((current) =>
          current && current.id === id
            ? { ...current, summary: result.dashboard }
            : current,
        );
        return { ok: true };
      } catch {
        return { ok: false, message: "Couldn’t rename the dashboard. Try again." };
      } finally {
        setMutating(false);
      }
    },
    [renameDashboard],
  );

  // ── delete ─────────────────────────────────────────────────────────────
  const onDelete = useCallback(
    async (id: string): Promise<EntityDashboardsToolbarOutcome> => {
      if (!deleteDashboard) return { ok: false, message: "Delete is unavailable." };
      setMutating(true);
      try {
        const result = await deleteDashboard(id);
        if (!result.ok) return { ok: false, message: reason(result.reason) };
        const dashboards = (list?.dashboards ?? []).filter((d) => d.id !== id);
        const nextList: EntityDashboardsList = list
          ? { ...list, dashboards }
          : { dashboards, canCreate: false };
        setList(nextList);
        if (id === view?.id) {
          const nextSelection = pickSelection(nextList, null);
          const summary = nextSelection
            ? nextList.dashboards.find((d) => d.id === nextSelection)
            : undefined;
          // The current (deleted) view keeps rendering — its summary is
          // self-contained — until the replacement config commits (atomic).
          if (summary) loadConfigInto(summary);
          else {
            loadSeq.current++;
            setPendingId(null);
            setView(null);
          }
        }
        return { ok: true };
      } catch {
        return { ok: false, message: "Couldn’t delete the dashboard. Try again." };
      } finally {
        setMutating(false);
      }
    },
    [deleteDashboard, list, view, loadConfigInto],
  );

  // cinatra#1913: the typed save result flows through to the grid container,
  // which interprets it at the single third-party seam (toast + no commit on
  // failure). This callback stays a pass-through.
  const onSaveSelected = useCallback(
    (next: DashboardConfigV1_1): Promise<void | SavedEntityDashboard> => {
      if (!view) return Promise.resolve();
      return saveDashboard(view.id, next);
    },
    [saveDashboard, view],
  );

  // ── context for the toolbar controls ────────────────────────────────────
  const ctxValue: EntityDashboardsContextValue = {
    dashboards: list?.dashboards ?? [],
    selectedId: view?.id ?? null,
    pendingId,
    canCreate: list?.canCreate ?? false,
    busy: pendingId != null || mutating,
    onSelect,
    onCreate,
    onRename: renameDashboard ? onRename : null,
    onDelete: deleteDashboard ? onDelete : null,
  };

  // The rendered summary rides WITH the view, so it survives the selected row
  // leaving the list (delete) until the replacement config commits.
  const selectedSummary = view?.summary ?? null;

  return (
    <EntityDashboardsProvider value={ctxValue}>
      {renderBody()}
    </EntityDashboardsProvider>
  );

  function renderBody(): ReactNode {
    // Top-level error: the very first load failed and there is nothing to show.
    if (listError && view == null) {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-8 text-center"
          data-cinatra-entity-dashboards-state="error"
        >
          <AlertTriangle aria-hidden="true" className="size-5 text-destructive" />
          <p className="text-sm text-muted-foreground">
            Couldn’t load dashboards.
          </p>
          <Button variant="outline" onClick={() => void loadList()}>
            Retry
          </Button>
        </div>
      );
    }

    // Initial loading: no view yet and a load is in flight.
    if (view == null && (list == null || pendingId != null)) {
      return (
        <div
          role="status"
          className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
          data-cinatra-entity-dashboards-state="loading"
        >
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Loading dashboards…
        </div>
      );
    }

    // Empty: the list resolved with no readable dashboards.
    if (view == null && list != null && list.dashboards.length === 0) {
      return (
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center"
          data-cinatra-entity-dashboards-state="empty"
        >
          <p className="text-sm text-muted-foreground">No dashboards yet.</p>
          {list.canCreate ? (
            <>
              <Button onClick={() => setEmptyCreateOpen(true)}>
                <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                New dashboard
              </Button>
              <EntityDashboardNameDialog
                open={emptyCreateOpen}
                onOpenChange={setEmptyCreateOpen}
                title="New dashboard"
                description="Create an empty dashboard, then add portlets to it."
                submitLabel="Create"
                onSubmit={onCreate}
              />
            </>
          ) : null}
        </div>
      );
    }

    // Ready: render the selected dashboard. The grid is keyed by id so a switch
    // remounts it with the new config; the previous one stays until the swap.
    if (view && selectedSummary) {
      return (
        <>
          {switchError ? (
            <p
              role="alert"
              className="mb-2 text-sm text-destructive"
              data-cinatra-entity-dashboards-state="switch-error"
            >
              {switchError}
            </p>
          ) : null}
          <div key={view.id}>
            {renderDashboard({
              summary: selectedSummary,
              config: view.config,
              editable: selectedSummary.canWrite,
              onSave: onSaveSelected,
              pageAnchor,
              dashboardModes,
            })}
          </div>
        </>
      );
    }

    return null;
  }
}
