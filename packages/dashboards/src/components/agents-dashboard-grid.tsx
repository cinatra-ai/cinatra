"use client";
/**
 * AgentsDashboardGrid.
 *
 * Client-side wrapper around drizzle-cube's `<DashboardGrid>`. The save
 * handler wraps a Next Server Action so persistence runs server-side
 * through the mutation service's `upsertDashboardConfig`.
 *
 * Lives under `packages/dashboards/src/components/` so the package-local
 * client component boundary permits the `drizzle-cube/client` import.
 *
 * Belt-and-suspenders coverage of every DC edit action
 * ----------------------------------------------------
 * drizzle-cube's `useDirtyStateTracking` exposes two outer callbacks:
 *
 *   - `onConfigChange(next)`   — invoked on EVERY config mutation
 *                                (drag-stop, resize-stop, add/edit/delete/
 *                                 duplicate portlet, layout-mode switch,
 *                                 palette change, filter mutation, ...)
 *   - `onSave(next)`           — invoked when DC's internal dirty flag is
 *                                set and the auto-save path fires
 *
 * Both signals route through a single `AutoSaveCoordinator.flush()` (see
 * `auto-save-coordinator.ts` for dedup/serialization/latest-wins/
 * error-propagation semantics).
 *
 * `onConfigChange` debounces by ~350ms to coalesce rapid sequences. DC's
 * `onSave` flushes immediately (cancels any pending debounce) so the user
 * never sees auto-save lag at the natural commit moments.
 *
 * Why local React state for `config`
 * ----------------------------------
 * On edit-mode exit, DC's inner `Dr` re-derives the visible grid from
 * `props.config`. If we pass `initialConfig` straight through, that prop
 * never moves after first render and the visible layout snaps back to the
 * pre-edit baseline even though the DB already holds the new layout.
 * Holding a local mirror that we advance inside the coordinator's
 * `onCommit` keeps the prop in sync with persisted state across edit-mode
 * toggles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardGrid } from "drizzle-cube/client";
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import {
  createAutoSaveCoordinator,
  type AutoSaveCoordinator,
} from "./auto-save-coordinator";

/** Coalesce rapid auto-save signals into a single persistence round trip. */
const SAVE_DEBOUNCE_MS = 350;

export type AgentsDashboardGridProps = {
  readonly initialConfig: DashboardConfigV1_1;
  readonly editable?: boolean;
  /** Server Action — must accept a serializable config and return void/throw. */
  readonly onSave: (next: DashboardConfigV1_1) => Promise<void>;
};

export function AgentsDashboardGrid({
  initialConfig,
  editable = true,
  onSave,
}: AgentsDashboardGridProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [config, setConfig] = useState<DashboardConfigV1_1>(initialConfig);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const mountedRef = useRef<boolean>(true);

  // Coordinator instance is stable across renders. Built lazily inside
  // useRef so the initial JSON baseline matches the first config.
  const coordinatorRef = useRef<AutoSaveCoordinator<DashboardConfigV1_1> | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createAutoSaveCoordinator<DashboardConfigV1_1>({
      initialPersistedJson: JSON.stringify(initialConfig),
      onSave: (next) => onSaveRef.current(next),
      onCommit: (next) => {
        if (mountedRef.current) setConfig(next);
      },
    });
  }

  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    setIsHydrated(true);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const schedule = useCallback((next: DashboardConfigV1_1): void => {
    const coord = coordinatorRef.current;
    if (!coord) return;
    coord.setPending(next);
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      void coord.flush();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Flush any pending debounced save on unmount so a fast tab-switch
  // mid-debounce doesn't drop the change. We can't await here, but the
  // `mountedRef` guard inside `onCommit` keeps `setConfig` safe.
  useEffect(
    () => () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
        if (coordinatorRef.current?.getPending() !== null) {
          void coordinatorRef.current?.flush();
        }
      }
    },
    [],
  );

  if (!isHydrated) {
    return (
      <div
        className="flex min-h-[480px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Loading dashboard
      </div>
    );
  }

  return (
    <DashboardGrid
      config={config as unknown as React.ComponentProps<typeof DashboardGrid>["config"]}
      editable={editable}
      onConfigChange={
        ((next: unknown) => {
          schedule(next as DashboardConfigV1_1);
        }) as React.ComponentProps<typeof DashboardGrid>["onConfigChange"]
      }
      onSave={async (next) => {
        const coord = coordinatorRef.current;
        if (!coord) return;
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        coord.setPending(next as unknown as DashboardConfigV1_1);
        await coord.flush({ rethrow: true });
      }}
    />
  );
}
