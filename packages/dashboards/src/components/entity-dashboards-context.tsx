"use client";
/**
 * EntityDashboardsContext — the seam by which the reusable Dashboards-tab shell
 * (`entity-dashboards-shell.tsx`) publishes its dashboard list + selection +
 * mutation handlers so that `<CinatraDashboardToolbar>`, mounted DEEP inside the
 * drizzle-cube grid (`ComposedDashboard`), can render the dashboard-select
 * dropdown and the "+ New dashboard" control INSIDE the standard toolbar — the
 * placement the epic asks for — without the shell reaching into the grid.
 *
 * Absent by default: `useEntityDashboards()` returns `null` everywhere the
 * provider is not mounted (every existing single-dashboard surface), so the
 * toolbar renders exactly as before. Only a screen that mounts
 * `<EntityDashboardsShell>` lights the controls up.
 *
 * The handlers here are the shell's OWN wrappers (they mutate shell state and
 * normalize failures to friendly copy), not the raw server actions — so the
 * toolbar controls stay dumb and testable.
 */
import { createContext, useContext, type ReactNode } from "react";

import type { EntityDashboardSummary } from "../entity-dashboards-contract";

/** A mutation outcome already reduced to display copy by the shell. */
export type EntityDashboardsToolbarOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type EntityDashboardsContextValue = {
  readonly dashboards: readonly EntityDashboardSummary[];
  /** The dashboard whose config is currently rendered. `null` before first load. */
  readonly selectedId: string | null;
  /** A selection whose config is still loading — drives the optimistic
   *  highlight + spinner so switching feels instant while the swap is atomic. */
  readonly pendingId: string | null;
  /** Server-derived: may the actor create a new dashboard for this entity? */
  readonly canCreate: boolean;
  /** Any list/config load or mutation is in flight. */
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onCreate: (name: string) => Promise<EntityDashboardsToolbarOutcome>;
  /** `null` when the surface wired no rename action. Never called for Overview. */
  readonly onRename:
    | ((id: string, name: string) => Promise<EntityDashboardsToolbarOutcome>)
    | null;
  /** `null` when the surface wired no delete action. Never called for Overview. */
  readonly onDelete: ((id: string) => Promise<EntityDashboardsToolbarOutcome>) | null;
};

const EntityDashboardsContext = createContext<EntityDashboardsContextValue | null>(
  null,
);

export function EntityDashboardsProvider({
  value,
  children,
}: {
  readonly value: EntityDashboardsContextValue;
  readonly children: ReactNode;
}) {
  return (
    <EntityDashboardsContext.Provider value={value}>
      {children}
    </EntityDashboardsContext.Provider>
  );
}

/** Read the entity-dashboards controls state; `null` when no shell is mounted. */
export function useEntityDashboards(): EntityDashboardsContextValue | null {
  return useContext(EntityDashboardsContext);
}
