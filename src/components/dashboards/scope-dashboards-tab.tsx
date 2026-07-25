"use client";
/**
 * The scope Dashboards tab (cinatra#1897 B4) — the content of the entity page's
 * first tablist entry on a team / project / organization page. Renders the
 * ratified design spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX
 * exactly:
 *
 *   - conformance id `scope-dashboards-tab` (field name=identity.displayName;
 *     actions open-add-picker, open-dashboard, remove-listing; the closed
 *     data-state set empty / error / loading / kind:artifact);
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
 *     opens any of them, with no Add and no Remove (suppression, §IX.2).
 *
 * The entity h1 + kind label + the underline tablist (Dashboards · Settings)
 * live on the hosting entity page; this component renders the Dashboards tab
 * CONTENT (subtitle + Add + list). The add-to-scope picker (§IX.1) lives in
 * `<AddToScopePicker>`.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard, Plus } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddToScopePicker } from "./add-to-scope-picker";
import {
  SCOPE_LISTING_REASON_COPY,
  type ScopeDashboardsDataSource,
  type ScopeDashboardsTabData,
  type ScopeDashboardTabRow,
} from "./scope-dashboards-contract";

export function ScopeDashboardsTab({
  data,
  dataSource,
}: {
  data: ScopeDashboardsTabData;
  dataSource: ScopeDashboardsDataSource;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onRemove = (dashboardId: string) => {
    setRemovingId(dashboardId);
    void dataSource.removeListing(dashboardId).then((res) => {
      setRemovingId(null);
      if (res.ok) {
        toast.success("Listing removed");
        startTransition(() => router.refresh());
      } else {
        toast.error(SCOPE_LISTING_REASON_COPY[res.reason]);
      }
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
      {/* Dashboards tab content: the scope subtitle + the manager-only Add
          affordance (§IX.2). On a narrow viewport this row STACKS (flex-col) so
          the Add affordance drops beneath the subtitle (spec §X responsive); at
          ≥sm it is an inline row with Add pushed to the right. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <p className="min-w-0 flex-1 text-sm leading-normal text-muted-foreground">
          The dashboards in{" "}
          <b className="font-semibold text-foreground">{data.scopeLabel}</b>.
        </p>
        {/* scope-dashboards-write-access: the Add affordance is rendered ONLY for
            a scope manager (actorMayWriteScope) — suppression, not a disabled
            control. */}
        {data.canManage ? (
          <div
            data-conformance-id="scope-dashboards-write-access"
            data-field="manage-controls=collectionAdd.actorMayWriteScope"
          >
            <Button
              type="button"
              size="sm"
              data-action="open-add-picker -> add-picker-open"
              onClick={() => setPickerOpen(true)}
            >
              <Plus data-icon="inline-start" aria-hidden />
              Add dashboard
            </Button>
          </div>
        ) : null}
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

      {pickerOpen ? (
        <AddToScopePicker
          scopeLabel={data.scopeLabel}
          dataSource={dataSource}
          onClose={() => setPickerOpen(false)}
          onAdded={() => startTransition(() => router.refresh())}
        />
      ) : null}
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
          listed AND manager) and never on a homed row. No Home / Listed badge. */}
      {row.canRemove ? (
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
