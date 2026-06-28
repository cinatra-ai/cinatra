"use client";
/**
 * CinatraDashboardToolbar — the host-owned dashboard toolbar.
 *
 * Replaces drizzle-cube's bundled `<DashboardToolbar>` (and the retired
 * MutationObserver relabel/injection workaround) with a toolbar rendered
 * entirely by Cinatra through the public composable seam: it reads the
 * dashboard state machine from `useDashboardContext()` (drizzle-cube
 * `0.5.7`) and drives it through the documented handlers — no DOM
 * mutation, no DC-internal class selectors.
 *
 * What it renders:
 *   - Route-scoped primary actions (left) — anchors from the
 *     `DASHBOARD_PAGE_ACTIONS` registry, keyed by the shell's page anchor.
 *     Rendered through `next/link` (`<ToolbarButton asChild><Link/>`), which
 *     emits a real `<a href>` — preserving middle-click/right-click and the
 *     previous navigation behavior while satisfying the shadcn link pattern.
 *   - Owner-doctrine edit toggle (right) — "Edit dashboard" in view mode,
 *     "Save dashboard" in edit mode, via `actions.toggleEditMode()`. Saving
 *     itself rides the same dirty-state path the bundled toolbar used
 *     (`onSave` fires on edit-mode exit when the config changed).
 *   - Edit-mode controls — Grid/Rows layout toggle (only when more than one
 *     mode is allowed), "Add text" and "Add portlet" via the context's
 *     `handleAddText` / `handleAddPortlet`.
 *
 * Deliberately NOT reproduced from the bundled toolbar:
 *   - The colour-palette dropdown: drizzle-cube `0.5.7` does not export
 *     `ColorPaletteSelector` or its palette registry from any public
 *     entrypoint, and rebuilding it would mean hardcoding DC-internal
 *     palette names — the same fragile coupling this toolbar retires.
 *     `config.colorPalette` is still honored at chart render time.
 *   - The floating edit toolbar overlay (scroll-following duplicate of the
 *     top bar) — this toolbar is sticky instead.
 *
 * Styling comes from the design-system `<Toolbar>` primitives, so the CSS
 * that restyled DC's internal toolbar DOM is gone with the old toolbar.
 */
import { useDashboardContext } from "drizzle-cube/client";
import Link from "next/link";
import {
  LayoutGrid,
  Pencil,
  Play,
  Plus,
  Rows3,
  Save,
  Type,
} from "lucide-react";

import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/ui/toolbar";

import { useDashboardFilterBarVisible } from "./dashboard-filter-bar-visibility";
import {
  useDashboardPageAnchor,
  type DashboardPageAnchor,
} from "./dashboard-page-anchor";

export type DashboardPageAction = {
  /** Stable id — also the `data-cinatra-page-action` hook the scoped CSS
   *  uses to hide the server-rendered PageHeader fallback while the live
   *  toolbar action is in the DOM. */
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: typeof Play;
};

/**
 * Route-scoped primary actions, keyed by the shell's page anchor. The owner
 * asked for these inside the dashboard toolbar (where "Edit dashboard"
 * lives), NOT in the PageHeader actions slot.
 */
export const DASHBOARD_PAGE_ACTIONS: Readonly<
  Record<DashboardPageAnchor, readonly DashboardPageAction[]>
> = {
  agents: [
    { id: "run-agent", href: "/agents/run", label: "Run agent", icon: Play },
    {
      id: "create-agent",
      href: "/chat?mode=create-agent",
      label: "Create agent",
      icon: Plus,
    },
  ],
  projects: [
    { id: "new-project", href: "/projects/new", label: "New project", icon: Plus },
  ],
  teams: [{ id: "new-team", href: "/teams/new", label: "New team", icon: Plus }],
};

export function CinatraDashboardToolbar() {
  const pageAnchor = useDashboardPageAnchor();
  const {
    editable,
    isEditMode,
    isResponsiveEditable,
    layoutMode,
    allowedModes,
    canChangeLayoutMode,
    actions,
    handleAddText,
    handleAddPortlet,
  } = useDashboardContext();

  // When the dashboard filter bar renders beneath this toolbar it does so
  // as a CHILD TOOLBAR (design spec §Nested toolbar — see
  // `<DashboardFilterBarSlot>` in composed-dashboard.tsx), so the gap
  // tightens to the 6px stack gap; otherwise keep the regular 16px space
  // before the grid.
  const filterBarFollows = useDashboardFilterBarVisible();

  const pageActions: readonly DashboardPageAction[] =
    (pageAnchor && DASHBOARD_PAGE_ACTIONS[pageAnchor]) || [];

  const showLayoutToggle = editable && isEditMode && allowedModes.length > 1;
  const showEditControls = editable && isEditMode;

  // Read-only surface with no route actions: nothing to show.
  if (!editable && pageActions.length === 0) return null;

  return (
    <Toolbar
      aria-label="Dashboard"
      data-cinatra-dashboard-toolbar="true"
      className={`sticky top-0 z-10 ${filterBarFollows ? "mb-1.5" : "mb-4"}`}
    >
      {pageActions.length > 0 && (
        <ToolbarGroup>
          {pageActions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <ToolbarButton key={action.id} asChild>
                <Link
                  href={action.href}
                  data-cinatra-page-action={action.id}
                  className="font-semibold text-foreground"
                >
                  <ActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {action.label}
                </Link>
              </ToolbarButton>
            );
          })}
        </ToolbarGroup>
      )}

      {showLayoutToggle && (
        <>
          {pageActions.length > 0 && <ToolbarSeparator />}
          <ToolbarGroup role="group" aria-label="Layout mode">
            <ToolbarButton
              active={layoutMode === "grid"}
              disabled={!canChangeLayoutMode}
              onClick={() => actions.handleLayoutModeChange("grid")}
            >
              <LayoutGrid aria-hidden="true" className="size-3.5 shrink-0" />
              Grid
            </ToolbarButton>
            <ToolbarButton
              active={layoutMode === "rows"}
              disabled={!canChangeLayoutMode}
              onClick={() => actions.handleLayoutModeChange("rows")}
            >
              <Rows3 aria-hidden="true" className="size-3.5 shrink-0" />
              Rows
            </ToolbarButton>
          </ToolbarGroup>
        </>
      )}

      {showEditControls && (
        <>
          {(pageActions.length > 0 || showLayoutToggle) && <ToolbarSeparator />}
          <ToolbarGroup>
            <ToolbarButton onClick={handleAddText}>
              <Type aria-hidden="true" className="size-3.5 shrink-0" />
              Add text
            </ToolbarButton>
            <ToolbarButton onClick={handleAddPortlet}>
              <Plus aria-hidden="true" className="size-3.5 shrink-0" />
              Add portlet
            </ToolbarButton>
          </ToolbarGroup>
        </>
      )}

      {editable && (
        <ToolbarGroup className="ml-auto">
          <ToolbarButton
            onClick={() => isResponsiveEditable && actions.toggleEditMode()}
            disabled={!isResponsiveEditable}
            title={
              isResponsiveEditable
                ? undefined
                : "Desktop view required for editing"
            }
            className="text-foreground"
          >
            {isEditMode ? (
              <Save aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            {isEditMode ? "Save dashboard" : "Edit dashboard"}
          </ToolbarButton>
        </ToolbarGroup>
      )}
    </Toolbar>
  );
}
