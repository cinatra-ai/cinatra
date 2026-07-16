"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness mounts for the /notifications unified-surface
// conformance manifest (conformance/app-notifications.json, design@2bcc2c7e;
// cinatra#1549 E11-AC2). Nine surfaces:
//
//   notifications-list, notifications-filters, notification-row, approval-row,
//   notifications-filter-rail, notifications-bell, notifications-empty,
//   notifications-vendor-gate, notifications-degraded
//
// The real /notifications screen (src/app/notifications/**) resolves its rows
// through an authenticated session + the ApprovalSource registry + the E6 client
// store — none reachable on the standalone design harness (no session, no DB,
// no SSE). So, exactly like the Approvals + Scheduling surfaces
// (approvals-scheduling-fixtures.tsx, cinatra#1043), each surface below is
// modelled deterministically with the REAL design-system primitives the live
// feed is built from (the row shell anatomy of notifications-feed.tsx §II, the
// four filter chips §III, the badge-only bell §IV, the "No notifications" empty
// §V, the single degraded line §VI) and — for the loading state — the REAL
// shipped skeletons (notifications-skeletons.tsx, packages/notifications
// bell-skeleton.tsx). Each surface exercises its manifest action(s) to the
// specified outcome through local state, surfaced on the `data-outcome`
// harness-instrumentation attribute (same role as data-installed-version /
// data-cta-state on the sibling fixtures).
//
// Assertion-driven, DB-free, off the pixel-diffed /design-fixtures index (adds
// no screenshot baselines). Driven by tests/e2e/design/conformance/contract.ts.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  CircleCheck,
  Clock,
  Info,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { NotificationsBellSkeleton } from "@cinatra-ai/notifications/client";
import {
  FeedRowSkeleton,
  NotificationsFilterRailSkeleton,
} from "@/app/notifications/notifications-skeletons";

// A titled card whose body holds the surface's variant roots — purely
// presentational chrome matching the sibling conformance sections.
function SurfaceSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="flex flex-col gap-6 p-4">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

// ── Row shell (§II) — the same glyph + two-line body + trailing-slot anatomy
// the live feed renders. Two species: a notification carries the read-dot; an
// approval carries the eligibility pill + (when eligible) an inline decide.
type Tone = "info" | "success" | "warning" | "muted";
const GLYPH_TONE: Record<Tone, string> = {
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
  warning: "bg-warning/16 text-warning",
  muted: "bg-surface-muted text-muted-foreground",
};

function GlyphFrame({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[34px] flex-none place-items-center rounded-lg",
        GLYPH_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

function NotificationRow({
  title,
  meta,
  titleField = false,
  unread = true,
  isLast = false,
  sourceId,
}: {
  title: string;
  meta: string;
  /** Mark the title span as the manifest `title = item.title` binding. */
  titleField?: boolean;
  unread?: boolean;
  isLast?: boolean;
  sourceId?: string;
}) {
  return (
    <li
      {...(sourceId ? { "data-source-id": sourceId } : {})}
      className={cn(
        "flex items-start gap-3.5 px-3.5 py-3",
        isLast ? "" : "border-b border-line",
      )}
    >
      <GlyphFrame tone="info">
        <MessageSquare className="size-[17px]" />
      </GlyphFrame>
      <div className="min-w-0 flex-1">
        <span
          {...(titleField ? { "data-field": "item.title" } : {})}
          className="font-sans text-sm font-semibold text-foreground"
        >
          {title}
        </span>
        <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex-none pt-1">
        {unread ? (
          <span
            className="block size-2 rounded-full bg-primary"
            title="Unread"
            aria-label="Unread"
          />
        ) : null}
      </div>
    </li>
  );
}

function EligibilityPill({ actionable }: { actionable: boolean }) {
  if (actionable) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
        <span aria-hidden className="size-1.5 rounded-full bg-warning" />
        Awaiting you
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground" />
      Awaiting others
    </span>
  );
}

function ApprovalRow({
  title,
  meta,
  actionable,
  decided,
  onDecide,
  isLast = false,
  sourceId,
}: {
  title: string;
  meta: string;
  actionable: boolean;
  decided?: boolean;
  onDecide?: () => void;
  isLast?: boolean;
  sourceId?: string;
}) {
  return (
    <li
      {...(sourceId ? { "data-source-id": sourceId } : {})}
      className={cn(
        "flex items-start gap-3.5 px-3.5 py-3",
        isLast ? "" : "border-b border-line",
      )}
    >
      <GlyphFrame tone={actionable ? "warning" : "muted"}>
        {actionable ? (
          <CircleCheck className="size-[17px]" />
        ) : (
          <Clock className="size-[17px]" />
        )}
      </GlyphFrame>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-semibold text-foreground">
            {title}
          </span>
          <EligibilityPill actionable={actionable} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex-none">
        {decided ? (
          <span className="font-mono text-badge-xs text-muted-foreground">
            decided
          </span>
        ) : actionable ? (
          <Button size="sm" onClick={onDecide}>
            Review &amp; approve
          </Button>
        ) : (
          <span className="font-mono text-badge-xs text-muted-foreground">
            no action for you
          </span>
        )}
      </div>
    </li>
  );
}

// The single degraded line (§VI) — the exact copy + treatment the live feed
// renders for one-or-many failed approval sources.
function DegradedLine() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-warning">
      <TriangleAlert aria-hidden className="size-[15px] flex-none" />
      <span className="text-sm text-foreground">
        some approvals are currently unavailable
      </span>
    </div>
  );
}

// The single universal empty state (§V) — exactly "No notifications".
function NotificationsEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center">
      <span
        aria-hidden
        className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground"
      >
        <Info className="size-5" />
      </span>
      <p className="font-sans text-sm font-semibold text-foreground">
        No notifications
      </p>
    </div>
  );
}

function ListShell({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface-strong">
      {children}
    </ul>
  );
}

// ── The four filter chips (§III) — filters over the one list, never tabs. ────
type Chip = "all" | "needs-action" | "unread" | "in-progress";

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
        active
          ? "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary hover:text-primary-foreground"
          : "border-line-strong bg-surface-strong text-foreground hover:bg-surface",
      )}
    >
      {label}
      {typeof count === "number" && count > 0 ? (
        <span className="rounded-full bg-surface-muted px-1.5 py-px font-mono text-badge-xs leading-none text-muted-foreground">
          {count}
        </span>
      ) : null}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// notifications-list — field title=item.title; action decide-approval->decided;
//                      states empty, error, loading.
// ---------------------------------------------------------------------------

// The manifest binds `title = item.title`; the fixture item's title shares no
// token with its id, so a driver reading the id would not false-green.
const LIST_ITEM = {
  id: "notif-7f3a-import-done",
  title: "Prospect list finished — 240 rows",
} as const;

function NotificationsListFixture() {
  const [decided, setDecided] = useState(false);

  return (
    <SurfaceSection title="Unified list (surface: notifications-list)">
      <div
        data-surface-id="notifications-list"
        data-variant="populated"
        data-outcome={decided ? "decided" : "idle"}
      >
        <ListShell>
          <ApprovalRow
            title="Approve access scope for Outreach agent"
            meta="Agent approval · requested by a teammate · 4 minutes ago"
            actionable
            decided={decided}
            onDecide={() => setDecided(true)}
          />
          <NotificationRow
            title={LIST_ITEM.title}
            meta="Prospect Lists · 22 minutes ago"
            titleField
            isLast
          />
        </ListShell>
      </div>

      <div data-surface-id="notifications-list" data-variant="empty">
        <NotificationsEmpty />
      </div>

      <div data-surface-id="notifications-list" data-variant="error">
        <div className="flex flex-col gap-4">
          <DegradedLine />
          <ListShell>
            <NotificationRow
              title="Deploy to production succeeded"
              meta="Workflows · yesterday"
              unread={false}
              isLast
            />
          </ListShell>
        </div>
      </div>

      <div data-surface-id="notifications-list" data-variant="loading">
        <ListShell>
          <li>
            <FeedRowSkeleton />
          </li>
          <li>
            <FeedRowSkeleton isLast />
          </li>
        </ListShell>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-filters — action filter->filtered (chips narrow the one list).
// ---------------------------------------------------------------------------
const FILTER_ROWS = [
  { key: "a", kind: "approval" as const, title: "Approve connector install", unread: false, actionable: true },
  { key: "n1", kind: "notification" as const, title: "Import finished", unread: true, actionable: false },
  { key: "n2", kind: "notification" as const, title: "Weekly digest ready", unread: false, actionable: false },
];

function NotificationsFiltersFixture() {
  const [chip, setChip] = useState<Chip>("all");
  const [filtered, setFiltered] = useState(false);

  const visible = useMemo(() => {
    switch (chip) {
      case "needs-action":
        return FILTER_ROWS.filter((r) => r.actionable);
      case "unread":
        return FILTER_ROWS.filter((r) => r.kind === "notification" && r.unread);
      case "in-progress":
        return [];
      default:
        return FILTER_ROWS;
    }
  }, [chip]);

  function select(next: Chip) {
    setChip(next);
    if (next !== "all") setFiltered(true);
  }

  const unreadCount = FILTER_ROWS.filter((r) => r.kind === "notification" && r.unread).length;
  const needsActionCount = FILTER_ROWS.filter((r) => r.actionable).length;

  return (
    <SurfaceSection title="Filter chips (surface: notifications-filters)">
      <div
        data-surface-id="notifications-filters"
        data-variant="populated"
        data-outcome={filtered ? "filtered" : "idle"}
      >
        <div
          role="group"
          aria-label="Filter notifications"
          className="flex flex-wrap gap-2"
        >
          <FilterChip label="All" active={chip === "all"} onClick={() => select("all")} />
          <FilterChip
            label="Needs action"
            count={needsActionCount}
            active={chip === "needs-action"}
            onClick={() => select("needs-action")}
          />
          <FilterChip
            label="Unread"
            count={unreadCount}
            active={chip === "unread"}
            onClick={() => select("unread")}
          />
          <FilterChip
            label="In progress"
            active={chip === "in-progress"}
            onClick={() => select("in-progress")}
          />
        </div>
        <ul className="mt-3 flex flex-col gap-1" data-slot="filtered-rows">
          {visible.map((r) => (
            <li key={r.key} data-row-kind={r.kind} className="text-sm text-foreground">
              {r.title}
            </li>
          ))}
        </ul>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notification-row — state loading (plus a resting row so the surface renders).
// ---------------------------------------------------------------------------
function NotificationRowFixture() {
  return (
    <SurfaceSection title="Notification row (surface: notification-row)">
      <div data-surface-id="notification-row" data-variant="populated">
        <ListShell>
          <NotificationRow title="Import finished" meta="Data · 5 min ago" isLast />
        </ListShell>
      </div>
      <div data-surface-id="notification-row" data-variant="loading">
        <ListShell>
          <li>
            <FeedRowSkeleton isLast />
          </li>
        </ListShell>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// approval-row — action decide-approval->decided; state loading.
// ---------------------------------------------------------------------------
function ApprovalRowFixture() {
  const [decided, setDecided] = useState(false);
  return (
    <SurfaceSection title="Approval row (surface: approval-row)">
      <div
        data-surface-id="approval-row"
        data-variant="populated"
        data-outcome={decided ? "decided" : "idle"}
      >
        <ListShell>
          <ApprovalRow
            title="Approve connector install"
            meta="Marketplace · 12 min ago"
            actionable
            decided={decided}
            onDecide={() => setDecided(true)}
            isLast
          />
        </ListShell>
      </div>
      <div data-surface-id="approval-row" data-variant="loading">
        <ListShell>
          <li>
            <FeedRowSkeleton isLast />
          </li>
        </ListShell>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-filter-rail — state loading (the real rail skeleton).
// ---------------------------------------------------------------------------
function NotificationsFilterRailFixture() {
  return (
    <SurfaceSection title="Filter rail — loading (surface: notifications-filter-rail)">
      <div data-surface-id="notifications-filter-rail" data-variant="loading">
        <NotificationsFilterRailSkeleton />
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-bell — action open->navigated; state loading.
//   The bell is badge + link: the manifest `open -> navigated` outcome is the
//   link destination (/notifications), proven by the resolved href exactly as
//   the spec depicts it (§IV; same pattern as install-config configure ->
//   connector-setup). Loading = the REAL exported NotificationsBellSkeleton.
// ---------------------------------------------------------------------------
function NotificationsBellFixture() {
  return (
    <SurfaceSection title="Bell — badge + link (surface: notifications-bell)">
      <div
        data-surface-id="notifications-bell"
        data-variant="populated"
        className="flex items-center gap-6"
      >
        <Link
          href="/notifications"
          aria-label="Notifications, 2 need your attention"
          className="relative inline-grid size-9 place-items-center rounded-full border border-line bg-surface-strong text-foreground"
        >
          <Bell className="h-5 w-5" aria-hidden />
          <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 font-mono text-badge-xs text-white">
            2
          </span>
        </Link>
      </div>

      <div data-surface-id="notifications-bell" data-variant="loading">
        <NotificationsBellSkeleton />
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-empty — state empty (the one universal "No notifications").
// ---------------------------------------------------------------------------
function NotificationsEmptyFixture() {
  return (
    <SurfaceSection title="Empty state (surface: notifications-empty)">
      <div data-surface-id="notifications-empty" data-variant="empty">
        <NotificationsEmpty />
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-vendor-gate — state empty = the ABSENCE contract (§V):
//   on a non-vendor instance ZERO vendor rows / vendor copy render. No vendor
//   presentation is invented — the fixture renders the exact non-vendor row set
//   an unregistered instance produces, each tagged with its real source id, and
//   the driver asserts the rendered source-id set is EXACTLY the non-vendor set
//   (the two vendor-gated source ids — marketplace-vendor-app-status /
//   -moderation — never appear). A leaked vendor row would carry one of those
//   ids and break the exact-set assertion, so the check is not vacuous.
// ---------------------------------------------------------------------------
const NON_VENDOR_ROWS = [
  { sourceId: "agent-creation-requests", title: "Approve access scope for Outreach agent", actionable: true },
  { sourceId: "notification", title: "Prospect list finished — 240 rows", actionable: false },
] as const;

// The source ids gated behind the registered-vendor predicate (§V / E1) — never
// present on a non-vendor instance.
const VENDOR_GATED_SOURCE_IDS = [
  "marketplace-vendor-app-status",
  "marketplace-vendor-app-moderation",
] as const;

function NotificationsVendorGateFixture() {
  return (
    <SurfaceSection title="Vendor gating — non-vendor instance (surface: notifications-vendor-gate)">
      <div
        data-surface-id="notifications-vendor-gate"
        data-variant="empty"
        data-vendor-gated-source-ids={VENDOR_GATED_SOURCE_IDS.join(" ")}
      >
        <ListShell>
          {NON_VENDOR_ROWS.map((r, i) =>
            r.actionable ? (
              <ApprovalRow
                key={r.sourceId}
                sourceId={r.sourceId}
                title={r.title}
                meta="Agent approval · 4 minutes ago"
                actionable
                isLast={i === NON_VENDOR_ROWS.length - 1}
              />
            ) : (
              <NotificationRow
                key={r.sourceId}
                sourceId={r.sourceId}
                title={r.title}
                meta="Prospect Lists · 22 minutes ago"
                isLast={i === NON_VENDOR_ROWS.length - 1}
              />
            ),
          )}
        </ListShell>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// notifications-degraded — state error (the single inline line, §VI).
// ---------------------------------------------------------------------------
function NotificationsDegradedFixture() {
  return (
    <SurfaceSection title="Degraded source (surface: notifications-degraded)">
      <div data-surface-id="notifications-degraded" data-variant="error">
        <DegradedLine />
      </div>
    </SurfaceSection>
  );
}

/**
 * All nine /notifications unified-surface conformance surfaces, mounted for the
 * manifest-driven functional-acceptance gate (cinatra#1549 E11-AC2). Rendered by
 * the base conformance harness page (./page.tsx).
 */
export function NotificationsConformanceFixtures() {
  return (
    <>
      <NotificationsListFixture />
      <NotificationsFiltersFixture />
      <NotificationRowFixture />
      <ApprovalRowFixture />
      <NotificationsFilterRailFixture />
      <NotificationsBellFixture />
      <NotificationsEmptyFixture />
      <NotificationsVendorGateFixture />
      <NotificationsDegradedFixture />
    </>
  );
}
