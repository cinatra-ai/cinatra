"use client";
/**
 * `DashboardGridContainer` — generic client-side wrapper around
 * `<ComposedDashboard>` used by the analytics portlet view and the
 * /projects, /teams, /organizations, and /artifacts dashboards. Provides
 * debounced auto-save through an `AutoSaveCoordinator` plus a local `config`
 * mirror so the visible grid doesn't snap back to the seed when DC re-derives
 * layout from `props.config`.
 *
 * Belt-and-suspenders save handling:
 *   - `onConfigChange` debounces by 350 ms (drag-stop / resize-stop / etc.).
 *   - `onSave` flushes immediately (cancels any pending debounce).
 *   - Pending changes flush on unmount via a no-op `mountedRef` guard.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "@/lib/cinatra-toast";

import {
  ENTITY_DASHBOARD_REASON_COPY,
  type SavedEntityDashboard,
} from "../entity-dashboards-contract";
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
   * Server Action — accepts a serializable config and resolves void (legacy)
   * or a typed `SavedEntityDashboard` (cinatra#1913). A `{ ok: false }` result
   * is surfaced HERE as an in-product toast (the validator's card-naming copy)
   * and the coordinator keeps the edit PENDING — never committed as persisted,
   * never escaped into the third-party grid as an unhandled rejection.
   * Optional: read-only mounts (`editable={false}`, e.g. the per-entity detail
   * surfaces) omit it; the autosave coordinator + save wiring are then skipped
   * entirely.
   */
  readonly onSave?: (
    next: DashboardConfigV1_1,
  ) => Promise<void | SavedEntityDashboard>;
};

/** Sentinel: the save failure was already reported (toasted) by the guard —
 *  callers must not report it again, and it must never escape into DC. */
class SaveAlreadyReportedError extends Error {}

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
      // cinatra#1913: interpret the action's typed result. A failed save
      // toasts the precise copy and THROWS a sentinel so the coordinator
      // never commits it as persisted (the edit stays pending for retry).
      onSave: async (next) => {
        const result = await onSaveRef.current?.(next);
        if (result && result.ok === false) {
          toast.error(
            `Not saved: ${result.message ?? ENTITY_DASHBOARD_REASON_COPY[result.reason]}`,
          );
          throw new SaveAlreadyReportedError();
        }
      },
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
        // cinatra#1913: every failure is surfaced in-product HERE — nothing
        // rejects into the third-party grid (an uncaught rejection there is
        // exactly the issue's error overlay). The coordinator did not commit,
        // so the edit stays pending; a later save retries it.
        try {
          await coord.flush({ rethrow: true });
        } catch (e) {
          if (!(e instanceof SaveAlreadyReportedError)) {
            toast.error("Not saved — something went wrong. Try again.");
          }
        }
      }}
    />
  );
}
