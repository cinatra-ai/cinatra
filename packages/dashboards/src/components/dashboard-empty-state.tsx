"use client";
/**
 * DashboardEmptyState — the app-consistent zero-portlet empty state for the
 * embedded drizzle-cube grid.
 *
 * drizzle-cube `0.5.7`'s `<DashboardGridSurface>` renders its OWN built-in
 * empty screen when a dashboard has no portlets ("No Portlets" + an
 * off-column, library-styled pair of Add buttons floating in the grid area).
 * Every SEEDED entity dashboard (projects / teams / organizations / agents /
 * artifacts) ships >= 1 portlet, so it never reaches that state — but
 * `/personal` seeds empty on purpose ("built from the cards you add"), so it
 * was the ONE surface that fell through to the raw library empty state,
 * diverging in visual language and losing the toolbar/card chrome its peers
 * show (cinatra#1119).
 *
 * This renders the app design-system `<Empty>` primitive
 * (`@/components/ui/empty` — the empty-state source of truth, app design spec
 * "Empty state") instead, so an empty dashboard reads as the SAME surface type
 * as its populated peers: `<composed-dashboard.tsx>` keeps the grey toolbar
 * frame mounted above it (Edit / Save + the edit-mode Add affordances) and
 * swaps ONLY the raw library placeholder for this centred, card-framed state.
 *
 * The single primary action ("Add card") drives the SAME `handleAddPortlet`
 * the toolbar and the library empty state used — it opens the add-portlet
 * modal, so adding the first card flips the live `config.portlets` count and
 * `<composed-dashboard.tsx>` hands rendering back to `<DashboardGridSurface>`.
 * Shown only when the surface is `editable`; a read-only empty dashboard has
 * no add affordance and shows the message alone.
 *
 * Mount INSIDE `<DashboardProvider>` — it reads `useDashboardContext()`.
 */
import { LayoutDashboard, Plus } from "lucide-react";
import { useDashboardContext } from "drizzle-cube/client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function DashboardEmptyState() {
  const { editable, handleAddPortlet } = useDashboardContext();

  return (
    <Empty
      data-cinatra-dashboard-empty="true"
      data-testid="dashboard-empty-state"
      className="rounded-card border border-line bg-surface py-16"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboard aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No cards yet</EmptyTitle>
        <EmptyDescription>
          Build this dashboard by adding cards — charts, tables, and text you
          arrange and resize.
        </EmptyDescription>
      </EmptyHeader>
      {editable && (
        <EmptyContent>
          <Button onClick={() => handleAddPortlet()}>
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            Add card
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
