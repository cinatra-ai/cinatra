"use client";
/**
 * `DashboardGridContainer` — generic client-side wrapper around
 * `<ComposedDashboard>` used by the
 * /projects, /teams, /organizations, and /artifacts dashboards. Identical
 * state-management shape to `AgentsDashboardGrid` — debounced auto-save
 * through an `AutoSaveCoordinator` plus a local `config` mirror so the
 * visible grid doesn't snap back to the seed when DC re-derives layout
 * from `props.config`. Kept as a separate component (not a refactor
 * of agents) so the agents surface stays untouched.
 *
 * Belt-and-suspenders save handling matches agents:
 *   - `onConfigChange` debounces by 350 ms (drag-stop / resize-stop / etc.).
 *   - `onSave` flushes immediately (cancels any pending debounce).
 *   - Pending changes flush on unmount via a no-op `mountedRef` guard.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import {
  ComposedDashboard,
  type ComposedDashboardProps,
} from "./composed-dashboard";
import {
  createAutoSaveCoordinator,
  type AutoSaveCoordinator,
} from "./auto-save-coordinator";

const SAVE_DEBOUNCE_MS = 350;

export type DashboardGridContainerProps = {
  readonly initialConfig: DashboardConfigV1_1;
  readonly editable?: boolean;
  /**
   * Server Action — must accept a serializable config and return void/throw.
   * Optional: read-only mounts (`editable={false}`, e.g. the per-entity detail
   * surfaces) omit it; the autosave coordinator + save wiring are then skipped
   * entirely.
   */
  readonly onSave?: (next: DashboardConfigV1_1) => Promise<void>;
};

export function DashboardGridContainer({
  initialConfig,
  editable = true,
  onSave,
}: DashboardGridContainerProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [config, setConfig] = useState<DashboardConfigV1_1>(initialConfig);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const mountedRef = useRef<boolean>(true);

  const coordinatorRef = useRef<AutoSaveCoordinator<DashboardConfigV1_1> | null>(null);
  // Only the editable path needs the autosave coordinator. Read-only mounts
  // (no `onSave`) skip it entirely — no save wiring at all.
  if (editable && onSave && coordinatorRef.current === null) {
    coordinatorRef.current = createAutoSaveCoordinator<DashboardConfigV1_1>({
      initialPersistedJson: JSON.stringify(initialConfig),
      onSave: (next) => onSaveRef.current?.(next) ?? Promise.resolve(),
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

  // Read-only mount (per-entity detail dashboards): render the grid with no
  // edit affordances and no save wiring.
  if (!editable || !onSave) {
    return (
      <ComposedDashboard
        config={config as unknown as ComposedDashboardProps["config"]}
        editable={false}
      />
    );
  }

  return (
    <ComposedDashboard
      config={config as unknown as ComposedDashboardProps["config"]}
      editable={editable}
      onConfigChange={
        ((next: unknown) => {
          schedule(next as DashboardConfigV1_1);
        }) as ComposedDashboardProps["onConfigChange"]
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
