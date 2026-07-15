"use client";

// ---------------------------------------------------------------------------
// /notifications v2 — the single chronological feed (cinatra#1557, E7).
//
// ONE interleaved, time-ordered list of notifications + pending approvals, per
// the ratified notifications design spec (application-design-notifications; the
// exact pinned contract is recorded on the PR / commit):
//   §I  one list, newest first, no clusters / no section headers;
//   §II one uniform row shell, two species — a notification carries read-state
//       (read-dot); an approval carries an eligibility-driven status pill and,
//       only when the VIEWER can decide it, an inline decide affordance;
//   §III four filter CHIPS (All · Needs action · Unread · In progress) that
//       filter the one list IN PLACE — never tabs, never a second list;
//   §V  one universal "No notifications" empty state; sources that are quiet /
//       not-connected / not-a-registered-vendor contribute zero rows (the E5
//       data layer + E1 predicate already gate this — the page renders whatever
//       the feed returns);
//   §VI a single inline "some approvals are currently unavailable" line when a
//       source degrades, with a retry that re-requests the SAME cursor.
//
// Data: E5's `loadUnifiedFeedPage` (server) → serializable VM (`feed-view-model`)
// → this client body. Pagination is E5's union keyset: `loadMoreUnifiedFeed`
// appends a page; a `degraded` page yields NO cursor, so the retry REPLACES that
// partial tail segment rather than paging forward past an incomplete approval
// half. Mark-read PATCHes the same `/api/notifications` endpoint the E6 store
// owns; a successful inline decision drops the row optimistically (it is also
// gone on the next fetch via E5's pending-only predicate).
// ---------------------------------------------------------------------------

import Link from "next/link";
import {
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  CheckCheck,
  CircleCheck,
  Clock,
  Info,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import { isRunningProgressNotification } from "@cinatra-ai/notifications/client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import {
  deriveFeed,
  keysForChip,
  notificationIsUnread,
  type ApprovalRowVM,
  type FeedRowVM,
  type FilterChip,
} from "./feed-view-model";
import { loadMoreUnifiedFeed } from "./feed-actions";
import { ApprovalInlineActions } from "./approval-inline-actions";

const NOTIFICATIONS_ENDPOINT = "/api/notifications";
const CURRENT_PATHNAME = "/notifications";

interface PageSlice {
  items: FeedRowVM[];
  nextCursor: string | null;
  degraded: boolean;
}
interface Segment {
  /** The cursor token that PRODUCED this segment (null = first page). Re-issued
   *  verbatim to REPLACE the segment when it is degraded. */
  requestCursor: string | null;
  page: PageSlice;
}

/** Optimistic-decision identity: the row key plus its concurrency `version`, so
 *  a rejected-then-resubmitted approval (same id, NEW version) is a distinct
 *  incarnation the earlier decision does not hide. */
function decideIdentity(key: string, version?: string): string {
  return `${key}::${version ?? ""}`;
}

// ---------------------------------------------------------------------------
// Hydration-stable timestamp (carried over verbatim from the v1 archive so the
// server label is locale-independent and the client upgrades to the local label
// after mount — no hydration mismatch; guarded by the feed hydration test).
// ---------------------------------------------------------------------------
const subscribeToHydration = () => () => {};

function formatStableTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
function formatLocalTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}
function FeedTimestamp({ value }: { value: string }): React.ReactElement | null {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const label = hydrated ? formatLocalTimestamp(value) : formatStableTimestamp(value);
  if (!label) return null;
  return <time dateTime={value}>{label}</time>;
}

// ---------------------------------------------------------------------------
// Root feed
// ---------------------------------------------------------------------------
export function NotificationsFeed({
  initialItems,
  initialNextCursor,
  initialDegraded,
}: {
  initialItems: FeedRowVM[];
  initialNextCursor: string | null;
  initialDegraded: boolean;
}): React.ReactElement {
  const [segments, setSegments] = useState<Segment[]>([
    {
      requestCursor: null,
      page: {
        items: initialItems,
        nextCursor: initialNextCursor,
        degraded: initialDegraded,
      },
    },
  ]);
  const [chip, setChip] = useState<FilterChip>("all");
  const [loadError, setLoadError] = useState(false);
  const [pending, startTransition] = useTransition();

  // Client mutation OVERLAYS, held separately from the raw server segments and
  // reapplied on every render. Keeping them out of the segments means a segment
  // REPLACEMENT (the degraded-retry) cannot resurrect a decided or read row: the
  // retry refreshes the raw page, and the overlays re-hide the decided rows /
  // re-apply read-state on top.
  //   • `decidedKeys` — optimistically-removed approval INCARNATIONS, keyed by
  //     `key + version` ({@link decideIdentity}) so a request that is rejected
  //     and RESUBMITTED under the same id with a NEW version is a distinct
  //     incarnation and is NOT hidden by the earlier decision.
  //   • `readOverrides` — a per-notification mark-read timestamp (single opens).
  //   • `markAllReadAt` — a mark-all-read WATERMARK (a server `createdAt`): PATCH
  //     `{beforeId}` marks read only the unread rows THROUGH the newest-loaded
  //     notification server-side, so any notification created at/before the
  //     watermark (including older rows loaded LATER via load-more) is read even
  //     before the PATCH is observable, while a row created AFTER the boundary
  //     (e.g. inserted concurrently before the PATCH lands) is NOT marked read
  //     server-side (cinatra#1557). The overlay compares this ms-precision string
  //     inclusively; the SERVER bound is resolved at microsecond precision from
  //     `beforeId`, so a same-millisecond concurrent insert can't slip in.
  const [decidedKeys, setDecidedKeys] = useState<Set<string>>(() => new Set());
  const [readOverrides, setReadOverrides] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [markAllReadAt, setMarkAllReadAt] = useState<string | null>(null);

  const items = useMemo(() => {
    const raw = segments.flatMap((s) => s.page.items);
    return raw
      .filter(
        (v) =>
          v.kind !== "approval" ||
          !decidedKeys.has(decideIdentity(v.key, v.approval.version)),
      )
      .map((v) => {
        if (v.kind === "notification" && !v.notification.readAt) {
          const override = readOverrides.get(v.notification.id);
          const watermark =
            markAllReadAt && v.createdAt <= markAllReadAt ? markAllReadAt : undefined;
          const readAt = override ?? watermark;
          if (readAt) {
            return { ...v, notification: { ...v.notification, readAt } };
          }
        }
        return v;
      });
  }, [segments, decidedKeys, readOverrides, markAllReadAt]);

  const lastSegment = segments[segments.length - 1]!;
  const nextCursor = lastSegment.page.nextCursor;
  // Only the tail can be degraded — a degraded page carries no cursor, so you
  // can never page PAST it (§VI); earlier segments are always complete.
  const degraded = lastSegment.page.degraded;

  const derivation = useMemo(
    () => deriveFeed(items, CURRENT_PATHNAME),
    [items],
  );
  const visibleKeys = keysForChip(derivation, chip);
  const visible = useMemo(
    () => items.filter((v) => visibleKeys.has(v.key)),
    [items, visibleKeys],
  );

  function patchNotifications(body: Record<string, unknown>): void {
    void fetch(NOTIFICATIONS_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {
      // Best-effort — a page refresh realigns with the server.
    });
  }

  function handleOpenNotification(id: string): void {
    const now = new Date().toISOString();
    setReadOverrides((m) => {
      if (m.has(id)) return m;
      const next = new Map(m);
      next.set(id, now);
      return next;
    });
    patchNotifications({ id });
  }

  function handleMarkAllRead(): void {
    if (derivation.unreadCount === 0) return;
    // A watermark, not a per-id snapshot, and NOT a blanket `{all:true}`: PATCH
    // `{beforeId}` marks read only the unread rows THROUGH the newest-LOADED
    // notification server-side, so a later load-more of older-but-unread rows
    // shows read too. The boundary is the newest LOADED notification (items are
    // newest-first); its `createdAt` (a SERVER timestamp, not the browser clock)
    // drives the optimistic overlay, while its `id` is what the SERVER resolves to
    // a microsecond-precision `(created_at, id)` bound — so a notification created
    // AFTER the loaded boundary but before the PATCH lands (even within the same
    // millisecond) is never marked read despite never being loaded; it re-syncs as
    // unread on reload from the server's authoritative `readAt` (cinatra#1557).
    // Every row the feed can reach is <= this boundary (load-more only fetches
    // OLDER rows). `max` keeps the latest overlay boundary across repeats.
    const newestNotif = items.find((v) => v.kind === "notification");
    if (!newestNotif || newestNotif.kind !== "notification") return;
    const boundary = newestNotif.createdAt;
    setMarkAllReadAt((prev) => (prev && prev > boundary ? prev : boundary));
    patchNotifications({ beforeId: newestNotif.notification.id });
  }

  function handleDecided(key: string, version?: string): void {
    // §II decided-row-disappears — drop the decided approval INCARNATION
    // optimistically (keyed by key+version so a resubmit under the same id
    // shows again).
    const identity = decideIdentity(key, version);
    setDecidedKeys((s) => {
      if (s.has(identity)) return s;
      const next = new Set(s);
      next.add(identity);
      return next;
    });
  }

  function handleLoadMore(): void {
    if (!nextCursor || pending) return;
    setLoadError(false);
    const cursor = nextCursor;
    startTransition(async () => {
      try {
        const page = await loadMoreUnifiedFeed(cursor);
        setSegments((segs) => [...segs, { requestCursor: cursor, page }]);
      } catch {
        setLoadError(true);
      }
    });
  }

  function handleRetryDegraded(): void {
    if (pending) return;
    setLoadError(false);
    const seg = lastSegment;
    startTransition(async () => {
      try {
        const page = await loadMoreUnifiedFeed(seg.requestCursor);
        // REPLACE the partial tail with the retry's result (never page forward).
        setSegments((segs) => [
          ...segs.slice(0, -1),
          { requestCursor: seg.requestCursor, page },
        ]);
      } catch {
        setLoadError(true);
      }
    });
  }

  const feedIsEmpty = items.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* §III — filter chip rail + mark-all-read */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter notifications"
          data-conformance-id="notifications-filters"
          data-action="filter -> filtered"
          className="flex flex-wrap gap-2"
        >
          <FilterChipButton
            label="All"
            active={chip === "all"}
            onClick={() => setChip("all")}
          />
          <FilterChipButton
            label="Needs action"
            count={derivation.needsActionCount}
            active={chip === "needs-action"}
            onClick={() => setChip("needs-action")}
          />
          <FilterChipButton
            label="Unread"
            count={derivation.unreadCount}
            active={chip === "unread"}
            onClick={() => setChip("unread")}
          />
          <FilterChipButton
            label="In progress"
            count={derivation.inProgressCount}
            active={chip === "in-progress"}
            onClick={() => setChip("in-progress")}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleMarkAllRead}
          disabled={derivation.unreadCount === 0}
          className="text-xs text-muted-foreground"
        >
          <CheckCheck aria-hidden className="size-[15px]" />
          Mark all read
        </Button>
      </div>

      {/* §VI — one inline degraded line for any number of failed sources */}
      {degraded ? (
        <div
          data-conformance-id="notifications-degraded"
          className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-warning"
        >
          <TriangleAlert aria-hidden className="size-[15px] flex-none" />
          <span className="text-sm text-foreground">
            some approvals are currently unavailable
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={handleRetryDegraded}
            disabled={pending}
            className="ml-1 h-auto p-0 text-xs"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {/* §I / §V — the single interleaved list, or the universal empty state */}
      {visible.length === 0 ? (
        <FeedEmptyState feedIsEmpty={feedIsEmpty} chip={chip} />
      ) : (
        <ul
          data-conformance-id="notifications-list"
          className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface-strong"
        >
          {visible.map((row, index) => (
            <FeedRow
              key={row.key}
              row={row}
              isLast={index === visible.length - 1}
              onOpen={handleOpenNotification}
              onDecided={() =>
                handleDecided(
                  row.key,
                  row.kind === "approval" ? row.approval.version : undefined,
                )
              }
            />
          ))}
        </ul>
      )}

      {/* Load more */}
      {nextCursor ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleLoadMore}
            disabled={pending}
          >
            {pending ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {loadError ? (
        <p className="text-center text-xs text-destructive">
          Could not load more.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={handleLoadMore}
            className="h-auto p-0 align-baseline text-xs underline underline-offset-2"
          >
            Try again
          </Button>
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter chip (§III)
// ---------------------------------------------------------------------------
function FilterChipButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary hover:text-primary-foreground"
          : "border-line-strong bg-surface-strong text-foreground hover:bg-surface",
      )}
    >
      {label}
      {typeof count === "number" && count > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-px font-mono text-badge-xs leading-none",
            active
              ? "bg-white/20 text-primary-foreground"
              : "bg-surface-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// One row shell, two species (§II)
// ---------------------------------------------------------------------------
function FeedRow({
  row,
  isLast,
  onOpen,
  onDecided,
}: {
  row: FeedRowVM;
  isLast: boolean;
  onOpen: (id: string) => void;
  onDecided: () => void;
}): React.ReactElement {
  const divider = isLast ? "" : "border-b border-line";
  if (row.kind === "notification") {
    return (
      <NotificationRow
        notification={row.notification}
        createdAt={row.createdAt}
        divider={divider}
        onOpen={onOpen}
      />
    );
  }
  return (
    <ApprovalRow
      approval={row.approval}
      createdAt={row.createdAt}
      divider={divider}
      onDecided={onDecided}
    />
  );
}

type Tone = "info" | "success" | "warning" | "destructive" | "muted";

const GLYPH_TONE: Record<Tone, string> = {
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
  warning: "bg-warning/16 text-warning",
  destructive: "bg-destructive/12 text-destructive",
  muted: "bg-surface-muted text-muted-foreground",
};

function GlyphFrame({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}): React.ReactElement {
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

function notificationTone(n: AppNotification): Tone {
  if (isRunningProgressNotification(n)) return "info";
  switch (n.kind) {
    case "success":
      return "success";
    case "error":
      return "destructive";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

function NotificationRow({
  notification,
  createdAt,
  divider,
  onOpen,
}: {
  notification: AppNotification;
  createdAt: string;
  divider: string;
  onOpen: (id: string) => void;
}): React.ReactElement {
  const running = isRunningProgressNotification(notification);
  const unread = notificationIsUnread(notification);
  const tone = notificationTone(notification);
  const iconClass = "size-[17px]";

  return (
    <li
      data-conformance-id="notification-row"
      className={cn("flex items-start gap-3.5 px-3.5 py-3", divider)}
    >
      <GlyphFrame tone={tone}>
        {running ? (
          <Spinner className={iconClass} />
        ) : tone === "success" ? (
          <CircleCheck className={iconClass} />
        ) : tone === "destructive" || tone === "warning" ? (
          <TriangleAlert className={iconClass} />
        ) : (
          <MessageSquare className={iconClass} />
        )}
      </GlyphFrame>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {notification.href ? (
            <Link
              href={notification.href}
              onClick={() => onOpen(notification.id)}
              data-action="open -> navigated"
              className="font-sans text-sm font-semibold text-foreground hover:underline"
            >
              {notification.title}
            </Link>
          ) : (
            <span className="font-sans text-sm font-semibold text-foreground">
              {notification.title}
            </span>
          )}
        </div>
        {notification.body ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {notification.body}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {notification.sourceJobName ? `${notification.sourceJobName} · ` : ""}
          <FeedTimestamp value={createdAt} />
        </p>
      </div>

      {/* Trailing slot (§II): the notification read-dot, or nothing (still a
          filled slot). Approvals never render a read-dot. */}
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

function EligibilityPill({
  actionable,
}: {
  actionable: boolean;
}): React.ReactElement {
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
  approval,
  createdAt,
  divider,
  onDecided,
}: {
  approval: ApprovalRowVM;
  createdAt: string;
  divider: string;
  onDecided: () => void;
}): React.ReactElement {
  const iconClass = "size-[17px]";
  return (
    <li
      data-conformance-id="approval-row"
      className={cn("flex items-start gap-3.5 px-3.5 py-3", divider)}
    >
      <GlyphFrame tone={approval.actionable ? "warning" : "muted"}>
        {approval.actionable ? (
          <CircleCheck className={iconClass} />
        ) : (
          <Clock className={iconClass} />
        )}
      </GlyphFrame>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {approval.href ? (
            <Link
              href={approval.href}
              className="font-sans text-sm font-semibold text-foreground hover:underline"
            >
              {approval.title}
            </Link>
          ) : (
            <span className="font-sans text-sm font-semibold text-foreground">
              {approval.title}
            </span>
          )}
          <EligibilityPill actionable={approval.actionable} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {approval.subtitle ? `${approval.subtitle} · ` : ""}
          <FeedTimestamp value={createdAt} />
        </p>
      </div>

      {/* Trailing slot (§II): the inline decide when the viewer is eligible;
          otherwise an explicit "no action for you". Never a read-dot. */}
      <div className="flex-none" data-action="decide-approval -> decided">
        {approval.actionable ? (
          <ApprovalInlineActions approval={approval} onDecided={onDecided} />
        ) : (
          <span className="font-mono text-badge-xs text-muted-foreground">
            no action for you
          </span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Empty states (§V)
// ---------------------------------------------------------------------------
function FeedEmptyState({
  feedIsEmpty,
  chip,
}: {
  feedIsEmpty: boolean;
  chip: FilterChip;
}): React.ReactElement {
  // The one universal state — exactly "No notifications" — for a genuinely
  // empty feed. A filter that merely matches nothing (the feed HAS rows) shows
  // a muted in-place note, not a per-type/per-source empty card (§V forbids
  // per-type empties).
  if (feedIsEmpty) {
    return (
      <div
        data-conformance-id="notifications-empty"
        className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
      >
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
  const chipLabel =
    chip === "needs-action"
      ? "needs action"
      : chip === "in-progress"
        ? "in progress"
        : chip;
  return (
    <p className="rounded-lg border border-line bg-surface-strong px-4 py-6 text-center text-sm text-muted-foreground">
      Nothing {chipLabel} right now.
    </p>
  );
}
