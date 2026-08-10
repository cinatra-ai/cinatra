"use client";
/**
 * `CatalogAddOutcomeProvider` — the wire between the SERVER-rendered catalog
 * section and the CLIENT toolbar that hosts it (cinatra#2474 PR5).
 *
 * The catalog node is built during the landing's server render and handed to the
 * popup as an opaque slot (`ScopeAddSources.catalog`), so the section cannot be
 * given callbacks as props: nothing on the server knows the popup's open state or
 * the shell's dashboard list. But the slot RENDERS inside `<AddDashboardDialog>`,
 * which is a client component, so React context reaches it from that position.
 * This is that context, and it carries exactly two things:
 *
 *   - `canAdd` — may this actor create a dashboard in the destination at all?
 *     The catalog's Add IS a create into the acting user's own collection, so it
 *     is gated on the SAME server-derived `canCreate` the toolbar keys the popup
 *     on. Without it the section renders its rows and offers no control, rather
 *     than offering one the writer would refuse.
 *   - `onAdded` — a copy landed. The dialog closes and the shell adopts the new
 *     dashboard (appends it to the dropdown and selects it), exactly as it does
 *     for a "Create new" dashboard.
 *
 * Absent by default: a section rendered with no provider (a unit test, or a
 * future host) simply gets `canAdd:false` and a no-op, so it can never act into
 * nothing.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { EntityDashboardSummary } from "@cinatra-ai/dashboards/entity-dashboards-contract";

export type CatalogAddOutcome = {
  /** Server-derived create authority for the destination collection. */
  readonly canAdd: boolean;
  /** A copy landed — close the popup and adopt the row. */
  readonly onAdded: (dashboard: EntityDashboardSummary) => void;
};

const CatalogAddOutcomeContext = createContext<CatalogAddOutcome | null>(null);

export function CatalogAddOutcomeProvider({
  canAdd,
  onAdded,
  children,
}: {
  readonly canAdd: boolean;
  readonly onAdded: (dashboard: EntityDashboardSummary) => void;
  readonly children: ReactNode;
}) {
  const value = useMemo<CatalogAddOutcome>(
    () => ({ canAdd, onAdded }),
    [canAdd, onAdded],
  );
  return (
    <CatalogAddOutcomeContext.Provider value={value}>
      {children}
    </CatalogAddOutcomeContext.Provider>
  );
}

/** The hosting popup's add wiring; `null` where no provider is mounted. */
export function useCatalogAddOutcome(): CatalogAddOutcome | null {
  return useContext(CatalogAddOutcomeContext);
}
