"use client";
/**
 * Shared visibility predicate for drizzle-cube's `<DashboardFilterBar>`.
 *
 * Mirrors the upstream gating in drizzle-cube `0.5.7`'s
 * `DashboardFilterPanel` (the only thing `DashboardFilterBar` renders
 * outside filter-selection mode, which itself requires edit mode):
 *
 *   - `if (!editable) return null`
 *   - `if (!isEditMode && dashboardFilters.length === 0) return null`
 *
 * Two host pieces need the SAME answer:
 *   - `<DashboardFilterBarSlot>` (composed-dashboard.tsx) — renders the
 *     child-toolbar wrapper only when the bar will actually paint, so the
 *     20px inset / 6px stack-gap geometry never floats around an empty bar;
 *   - `<CinatraDashboardToolbar>` — tightens its bottom margin to the
 *     6px nested-toolbar stack gap when a child bar follows (design spec
 *     §Nested toolbar), keeping the regular 16px gap otherwise.
 *
 * The duplication of upstream's two-line gating is deliberate and is
 * pinned against the installed bundle by
 * `__tests__/dc-filter-bar-contract.test.ts` — a drizzle-cube bump that
 * changes the gating fails that contract test, not silently this hook.
 */
import { useDashboardContext } from "drizzle-cube/client";

export function useDashboardFilterBarVisible(): boolean {
  const { editable, isEditMode, dashboardFilters } = useDashboardContext();
  return Boolean(editable && (isEditMode || (dashboardFilters?.length ?? 0) > 0));
}
