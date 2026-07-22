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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/**
 * cinatra#1914 — every DC portlet defers its data fetch behind an on-screen
 * visibility check (`useInView`, `initialInView: false`). When that signal
 * never fires (page-load geometry), the card silently skips its `/load`
 * request forever and renders DC's bare `lazy-placeholder` — a blank body
 * with no spinner, no copy, no error. DC's supported escape hatch is the
 * config-level `eagerLoad` flag (`portlet.eagerLoad ?? config.eagerLoad ??
 * false`), so the grid mounts every dashboard eager UNLESS the stored config
 * explicitly carries an `eagerLoad` key (an authored `false` is a deliberate
 * lazy opt-out and is respected, as is a per-portlet `false`).
 *
 * The injection is render-only: DC echoes the mounted config back through
 * `onConfigChange`/`onSave`, so when the stored row had NO `eagerLoad` key
 * the sanitizer below drops the injected key from every outgoing config —
 * saves never mutate stored rows, and the autosave dirty-baseline (raw
 * initial config) stays comparable. Key PRESENCE decides, never truthiness.
 */
function injectEagerLoad(
  config: DashboardConfigV1_1,
  hadEagerLoad: boolean,
): DashboardConfigV1_1 {
  if (hadEagerLoad) return config;
  return { ...(config as Record<string, unknown>), eagerLoad: true } as DashboardConfigV1_1;
}

/** Inverse of `injectEagerLoad` for the save path: when the stored config had
 *  no `eagerLoad` key, strip the injected one from the DC-echoed config so
 *  persistence round-trips byte-stable. Authored values pass through. */
function stripInjectedEagerLoad(
  next: DashboardConfigV1_1,
  hadEagerLoad: boolean,
): DashboardConfigV1_1 {
  if (hadEagerLoad) return next;
  if (!next || typeof next !== "object" || !("eagerLoad" in next)) return next;
  const rest = { ...(next as Record<string, unknown>) };
  delete rest.eagerLoad;
  return rest as DashboardConfigV1_1;
}

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
  // cinatra#1914 — key PRESENCE on the stored config decides whether the
  // eager-load injection (and its save-path strip) applies; pinned once at
  // mount (lazy state init) so the two directions stay symmetric for the
  // row's lifetime.
  const [hadEagerLoad] = useState<boolean>(
    () =>
      typeof initialConfig === "object" &&
      initialConfig !== null &&
      "eagerLoad" in initialConfig,
  );
  const mountedConfig = useMemo(
    () => injectEagerLoad(config, hadEagerLoad),
    [config, hadEagerLoad],
  );

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
    coord.setPending(stripInjectedEagerLoad(next, hadEagerLoad));
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      void coord.flush();
    }, SAVE_DEBOUNCE_MS);
  }, [hadEagerLoad]);

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
        config={mountedConfig as unknown as ComposedDashboardProps["config"]}
        editable={false}
      />
    );
  }

  return (
    <ComposedDashboard
      config={mountedConfig as unknown as ComposedDashboardProps["config"]}
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
        coord.setPending(
          stripInjectedEagerLoad(
            next as unknown as DashboardConfigV1_1,
            hadEagerLoad,
          ),
        );
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
