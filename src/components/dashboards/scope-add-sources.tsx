"use client";
/**
 * `ScopeAddSourcesProvider` — the seam by which an entity landing hands the
 * unified Add-dashboard popup its scope-level sources (cinatra#2474 PR3).
 *
 * The popup is launched from the dashboards toolbar, which is painted DEEP
 * inside the per-user shell (`EntityDashboardsToolbarControls`, rendered by
 * `CinatraDashboardToolbar` inside the grid). The sources, by contrast, are
 * server-derived on the landing. This provider is the wire between them: the
 * landing wraps its shell mount in it, and the toolbar reads it with
 * `useScopeAddSources()`.
 *
 * WHAT CROSSES. `reference` is a bundle of Next server actions the landing has
 * already `.bind`-ed to its server-derived scope, and `catalog` is a slot node —
 * both valid across the RSC boundary, neither carrying the actor or the scope's
 * owner axis. The client can therefore neither read nor forge the scope.
 *
 * WHO GETS `reference`. The landing passes it ONLY when
 * `actorMayWriteScope(actor, scope)` holds — §IX.2's "suppression, not a disabled
 * control", applied at the source: a member without write authority never
 * receives a handle to the add actions at all. `catalog` is deliberately NOT
 * part of that gate and must never widen it — a non-manager gaining a catalog
 * section (cinatra#2474 PR4) must still not gain the scope-level Add.
 *
 * Absent by default: `useScopeAddSources()` returns `null` on every surface that
 * mounts no provider (personal, and every non-entity dashboard surface), so the
 * toolbar keeps its plain "+ New dashboard" behaviour there.
 */
import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";

import type { ScopeReferenceSource } from "./scope-dashboards-contract";

export type ScopeAddSources = {
  /** The scope's entity-named label — titles the popup (§IX.1). */
  readonly scopeLabel: string;
  /** §IX.1 add-to-scope actions, or `null` for a non-manager (suppression). */
  readonly reference: ScopeReferenceSource | null;
  /** Concept B's section node (cinatra#2474 PR4); `null` until then.
   *
   *  Deliberately `ReactElement | null`, not `ReactNode`: `ReactNode` admits
   *  `false` / `""` / `0`, which render NOTHING while still reading as "a
   *  catalog is available" to a `!= null` test — a slot that is present and
   *  empty at the same time (codex convergence). */
  readonly catalog: ReactElement | null;
};

const ScopeAddSourcesContext = createContext<ScopeAddSources | null>(null);

export function ScopeAddSourcesProvider({
  scopeLabel,
  reference,
  catalog = null,
  children,
}: {
  readonly scopeLabel: string;
  readonly reference: ScopeReferenceSource | null;
  readonly catalog?: ReactElement | null;
  readonly children: ReactNode;
}) {
  const value = useMemo<ScopeAddSources>(
    () => ({ scopeLabel, reference, catalog }),
    [scopeLabel, reference, catalog],
  );
  return (
    <ScopeAddSourcesContext.Provider value={value}>
      {children}
    </ScopeAddSourcesContext.Provider>
  );
}

/** The hosting scope's add sources; `null` where no landing provided them. */
export function useScopeAddSources(): ScopeAddSources | null {
  return useContext(ScopeAddSourcesContext);
}
