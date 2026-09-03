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
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScopeDashboardsEmptyState } from "./scope-dashboards-empty";
import {
  SCOPE_LISTING_REASON_COPY,
  type ScopeListingRemovalSource,
  type ScopeDashboardsTabData,
  type ScopeDashboardTabRow,
} from "./scope-dashboards-contract";

/**
 * The tab body's own lede, exactly as the ratified drawing draws it: a MUTED
 * 13px line, never a bold heading, naming the ENTITY the tab belongs to.
 *
 *   - the three shared scopes and the workspace draw "The dashboards in
 *     <b>Team: Growth</b>." — the entity named in ink inside a muted line;
 *   - the personal scope draws "The dashboards you own." — the acting user's
 *     own dashboards, so there is no entity to name.
 *
 * The KIND-named bold h2 this row carried before (cinatra#2474 PR2) is gone: it
 * is not the treatment the drawing gives, and it named the kind where the
 * drawing names the entity.
 */
export type ScopeDashboardsCaption =
  | { readonly kind: "entity"; readonly entityLabel: string }
  | { readonly kind: "own" };

export function ScopeDashboardsTab({
  data,
  removal,
  caption,
  add,
}: {
  data: ScopeDashboardsTabData;
  /** Remove ALONE — the §IX.1 add actions are handed to the popup, and only to
   *  a manager, so a read-only member's browser never receives them. Absent on
   *  a scope that has no listings to remove (personal / workspace: "not
   *  add-to-scope targets"), where no row can ever carry Remove. */
  removal?: ScopeListingRemovalSource;
  /** The drawn muted lede — the hosting page owns the entity's name. */
  caption: ScopeDashboardsCaption;
  /** The drawn Add affordance, in the caption row where the drawing puts it.
   *  The hosting page passes it ONLY where the scope is an add-to-scope target
   *  AND the viewer may write the collection (§IX.2 suppression at the source);
   *  everywhere else it is absent, never disabled. */
  add?: ReactNode;
}) {
  const hasRows = data.rows.length > 0;

  return (
    <section
      data-conformance-id="scope-dashboards-tab"
      data-field="name=identity.displayName"
      data-state={hasRows ? "kind:artifact" : "empty"}
      className="flex flex-col gap-3"
    >
      {/* The tab body's lede + the drawn Add affordance, one row, exactly as
          the drawing draws it: a muted 13px line naming the entity, with
          "Add dashboard" at its right where the scope is an add-to-scope target
          and the viewer manages it. §IX.2 is suppression, not disabling — where
          the affordance does not apply, `add` is simply absent. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <p
          data-testid="scope-dashboards-caption"
          className="m-0 min-w-0 flex-1 text-scope-caption text-muted-foreground"
        >
          {caption.kind === "entity" ? (
            <>
              The dashboards in{" "}
              <b className="font-semibold text-foreground">
                {caption.entityLabel}
              </b>
              .
            </>
          ) : (
            <>The dashboards you own.</>
          )}
        </p>
        {add ?? null}
      </div>

      {/* The row list. Empty vs populated is the SSR state; loading / error
          surface on a client refresh (below). */}
      {hasRows ? (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
          {data.rows.map((row) => (
            <ScopeRow
              key={`${row.relation}:${row.dashboardId}`}
              row={row}
              removal={removal}
            />
          ))}
        </ul>
      ) : (
        /* The empty block's helper turns on whether the SCOPE offers an Add at
           all, not on this viewer's authority — see the module's own note. */
        <ScopeDashboardsEmptyState
          scopeKind={data.scopeKind}
          data-testid="scope-dashboards-empty"
        />
      )}
    </section>
  );
}

function ScopeRow({
  row,
  removal,
}: {
  row: ScopeDashboardTabRow;
  removal?: ScopeListingRemovalSource;
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

          scope-dashboards-write-access: Remove is a §IX.2 manage control —
          suppressed for a non-manager, never rendered disabled. */}
      {row.canRemove ? (
        <span
          data-conformance-id="scope-dashboards-write-access"
          data-field="manage-controls=collectionAdd.actorMayWriteScope"
          className="contents"
        >
          {/* A removable row only ever exists on a scope whose landing wired
              the removal action; the guard keeps the type honest. */}
          {removal ? (
            <RemoveListingButton dashboardId={row.dashboardId} removal={removal} />
          ) : null}
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

/**
 * The one control on this tab that navigates after a mutation, so it is the one
 * place that needs the router. Keeping it here — instead of at the tab's root —
 * means a scope with no removable row (a personal or workspace scope, or any
 * empty collection) renders the tab body with no router dependency at all.
 */
function RemoveListingButton({
  dashboardId,
  removal,
}: {
  dashboardId: string;
  removal: ScopeListingRemovalSource;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={removing}
      data-action="remove-listing -> listing-removed"
      onClick={() => {
        setRemoving(true);
        void removal
          .removeListing(dashboardId)
          .then((res) => {
            setRemoving(false);
            if (res.ok) {
              toast.success("Listing removed");
              startTransition(() => router.refresh());
            } else {
              toast.error(SCOPE_LISTING_REASON_COPY[res.reason]);
            }
          })
          // A rejected action must clear the busy state too, or Remove stays
          // "Removing…" with no way back.
          .catch(() => {
            setRemoving(false);
            toast.error("Couldn\u2019t remove that listing. Try again.");
          });
      }}
    >
      {removing ? "Removing\u2026" : "Remove"}
    </Button>
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
