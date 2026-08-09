"use client";
/**
 * The scope Dashboards tab (cinatra#1897 B4) — the content of the entity page's
 * first tablist entry on a team / project / organization page. Renders the
 * ratified design spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX
 * exactly:
 *
 *   - conformance id `scope-dashboards-tab` (field name=identity.displayName;
 *     actions open-dashboard, remove-listing here — the third tab action,
 *     open-add-picker, moved with the Add affordance to the Dashboards tab's
 *     TOOLBAR when cinatra#2474 PR3 consolidated every add path into the one
 *     `<AddDashboardDialog>`; the surface is unchanged, the trigger's component
 *     is not; the closed data-state set empty / error / loading / kind:artifact);
 *   - a plain row anatomy — a leading dashboard glyph, the name, the updated
 *     time, an Open affordance. NO per-row "Dashboards" type label (every row is
 *     a dashboard) and NO Home / Listed relation badge, no `home:` provenance —
 *     whether a row is homed or merely listed here is NOT surfaced. The single
 *     place the difference shows is the Remove control: it appears ONLY on a
 *     removable secondary listing (`row.canRemove`) and never on a homed row.
 *     Every row Opens the dashboard's CANONICAL surface (the tab points, never
 *     renders inline);
 *   - `scope-dashboards-write-access` (field manage-controls=
 *     collectionAdd.actorMayWriteScope): Add + Remove appear ONLY to a scope
 *     manager — a member without write authority sees the tab and every row and
 *     opens any of them, with no Add and no Remove (suppression, §IX.2). Remove
 *     carries that annotation HERE; Add carries it on the toolbar button that
 *     now launches the unified popup.
 *
 * The entity h1 + kind label + the underline tablist (Dashboards · Settings)
 * live on the hosting entity page; this component renders the Dashboards tab's
 * collection panel (heading + list). The §IX.1 add-to-scope picker is now one
 * section of `<AddDashboardDialog>` (`<ScopeReferenceSection>`), launched from
 * the tab's toolbar — cinatra#2474 PR3's consolidation, so a scope has exactly
 * ONE add-a-dashboard entry point instead of two competing ones.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";

import type { ListingScopeKind } from "@cinatra-ai/dashboards/entity-links";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SCOPE_LISTING_REASON_COPY,
  type ScopeListingRemovalSource,
  type ScopeDashboardsTabData,
  type ScopeDashboardTabRow,
} from "./scope-dashboards-contract";

/** The heading noun per scope kind (cinatra#2474 PR2 — the entity's own name is
 *  the hosting landing's h1, so the panel heading names the KIND). */
const SCOPE_NOUN: Record<ListingScopeKind, string> = {
  team: "team",
  organization: "organization",
  project: "project",
};

export function ScopeDashboardsTab({
  data,
  removal,
}: {
  data: ScopeDashboardsTabData;
  /** Remove ALONE — the §IX.1 add actions are handed to the popup, and only to
   *  a manager, so a read-only member's browser never receives them. */
  removal: ScopeListingRemovalSource;
}) {
  const router = useRouter();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onRemove = (dashboardId: string) => {
    setRemovingId(dashboardId);
    void removal
      .removeListing(dashboardId)
      .then((res) => {
        setRemovingId(null);
        if (res.ok) {
          toast.success("Listing removed");
          startTransition(() => router.refresh());
        } else {
          toast.error(SCOPE_LISTING_REASON_COPY[res.reason]);
        }
      })
      // A rejected action must clear the row's busy state too, or Remove stays
      // "Removing…" with no way back (codex convergence).
      .catch(() => {
        setRemovingId(null);
        toast.error("Couldn’t remove that listing. Try again.");
      });
  };

  const hasRows = data.rows.length > 0;

  return (
    <section
      data-conformance-id="scope-dashboards-tab"
      data-field="name=identity.displayName"
      data-state={hasRows ? "kind:artifact" : "empty"}
      className="flex flex-col gap-3"
    >
      {/* The collection panel's heading.

          cinatra#2474 PR2 — the scope lede is this panel's HEADING, and it
          names the scope KIND, not the entity. The collection used to own a
          whole route, where "The dashboards in Organization: ACME" was the only
          lede on the page; folded onto the entity landing it sits under a
          PageHeader that already carries the entity name as the h1 and its own
          description above the tablist, so repeating the entity name here was a
          second, near-identical lede (the placement observation recorded on the
          PR1 proof, #2547). Promoting it to a kind-named h2 gives the panel the
          title it needs to read as a distinct section beneath the per-user
          shell, and puts the scope lede BELOW the tablist where §IX's own
          illustration places it.

          cinatra#2474 PR3 — the Add affordance that used to sit at the right of
          this row has moved to the tab's TOOLBAR, where it launches the one
          unified `<AddDashboardDialog>` (Create · Reference-existing · the
          installed-catalog slot). A scope had two competing add entry points
          once the collection was folded onto the landing; it has one now. The
          row keeps its responsive shape so the heading behaves identically at
          every width. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <h2 className="min-w-0 flex-1 text-sm font-semibold leading-normal text-foreground">
          Dashboards in this {SCOPE_NOUN[data.scopeKind]}
        </h2>
      </div>

      {/* The row list. Empty vs populated is the SSR state; loading / error
          surface on a client refresh (below). */}
      {hasRows ? (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
          {data.rows.map((row) => (
            <ScopeRow
              key={`${row.relation}:${row.dashboardId}`}
              row={row}
              removing={removingId === row.dashboardId}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : (
        <EmptyState canManage={data.canManage} />
      )}
    </section>
  );
}

function ScopeRow({
  row,
  removing,
  onRemove,
}: {
  row: ScopeDashboardTabRow;
  removing: boolean;
  onRemove: (dashboardId: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <span
        aria-hidden
        className="grid size-[34px] flex-none place-items-center rounded-lg bg-primary/10 text-primary"
      >
        <LayoutDashboard className="size-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-semibold text-foreground">
          {row.name}
        </span>
        <p className="mt-0.5 text-xs text-muted-foreground">{row.metaLine}</p>
      </div>
      {/* Removability is read from the presence of Remove ALONE (spec §IX):
          it renders only on a removable secondary listing (`row.canRemove` —
          listed AND manager) and never on a homed row. No Home / Listed badge.

          scope-dashboards-write-access: Remove is the §IX.2 manage control this
          panel still owns (the Add half moved to the toolbar with PR3's unified
          popup) — suppressed for a non-manager, never rendered disabled. The
          `disabled` below is the in-flight busy guard, not the permission gate. */}
      {row.canRemove ? (
        <span
          data-conformance-id="scope-dashboards-write-access"
          data-field="manage-controls=collectionAdd.actorMayWriteScope"
          className="contents"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={removing}
            data-action="remove-listing -> listing-removed"
            onClick={() => onRemove(row.dashboardId)}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </span>
      ) : null}
      {/* Open navigates to the dashboard's CANONICAL surface (never inline). */}
      <Button asChild variant="outline" size="sm" className="flex-none">
        <Link
          href={row.canonicalHref}
          data-action="open-dashboard -> dashboard-canonical"
        >
          Open
        </Link>
      </Button>
    </li>
  );
}

function EmptyState({ canManage }: { canManage: boolean }) {
  return (
    <div
      data-state="empty"
      className="rounded-lg border border-dashed border-line px-3 py-[18px] text-center"
    >
      <p className="text-xs font-semibold text-foreground">
        No dashboards in this scope yet
      </p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {canManage ? (
          <>
            A manager can{" "}
            <b className="font-semibold text-foreground">Add</b> an existing
            dashboard, or create one that homes here.
          </>
        ) : (
          <>Dashboards homed or listed here will appear on this tab.</>
        )}
      </p>
    </div>
  );
}

/**
 * The tab's loading + error frames (§IX / §X data-state set: loading, error).
 * Rendered by the hosting page's Suspense/error boundary — exported so the
 * closed data-state set is covered by a real render path, not only prose.
 */
export function ScopeDashboardsTabLoading() {
  return (
    <div data-state="loading" className="grid gap-2" aria-busy>
      <Skeleton className="h-[38px] rounded-lg" />
      <Skeleton className="h-[38px] rounded-lg opacity-70" />
      <Skeleton className="h-[38px] rounded-lg opacity-45" />
    </div>
  );
}

export function ScopeDashboardsTabError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      data-state="error"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3.5 text-center"
    >
      <p className="text-xs font-semibold text-foreground">
        Couldn’t load this scope’s dashboards
      </p>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
