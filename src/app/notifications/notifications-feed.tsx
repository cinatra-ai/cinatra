"use client";

// ---------------------------------------------------------------------------
// /notifications v2 — the single chronological feed (cinatra#2380, S2).
//
// ONE interleaved, time-ordered list of notifications + pending approvals, per
// the ratified notifications design spec (the current toolbar shape
// supersedes the earlier "tablist" shape named in some older issue text):
//   §I   one list, newest first, no clusters / no section headers;
//   §II  one uniform row shell, two species, rendered as SPACED CLICKABLE
//        CARDS (never hairline-divided rows) — whole-card activation via a
//        STRETCHED SIBLING overlay (never role="button" on the card), with
//        inline controls layered above it;
//   §III a TOOLBAR (not a tablist) whose toggle group — All · Needs action ·
//        Unread · In progress — leads the bar, filtering the one list IN
//        PLACE; a borderless "Mark all read" icon button anchors the far
//        right, separated by a hairline. The toolbar replaces the page
//        header's own closing rule.
//   §V   one universal "No notifications" empty state;
//   §VI  a single inline "some approvals are currently unavailable" line when
//        a source degrades, with a retry that re-requests the same window;
//   §VII known-total pagination — 25 rows/page over the FILTERED, POST-
//        COLLAPSE rendered rows, numbered pages + an "X of N" caption. "Load
//        more" is retired.
//
// Data: the server WALKS the union feed (feed-window.ts, bounded) and returns
// a known-total window for a (chip, page) pair — `page.tsx` computes page 1 /
// "all" for the first paint; `feed-actions.ts`'s `fetchFeedWindow` server
// action serves every subsequent filter or page change. Mark-read / mark-
// unread PATCH the same `/api/notifications` endpoint (the discriminated
// `{id}` / `{id, unread:true}` verbs, cinatra#2383) with a per-notification-id
// mutation queue so a rapid double-toggle can't race out of order; a
// stretched-link click auto-marks read with `keepalive:true` so the PATCH
// survives the navigation.
// ---------------------------------------------------------------------------

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  CheckCheck,
  CircleCheck,
  Clock,
  Info,
  Mail,
  MailOpen,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import {
  isRunningProgressNotification,
  getNotificationRunReference,
} from "@cinatra-ai/notifications/client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { notificationIsUnread, type ApprovalRowVM, type FeedRowVM, type FilterChip } from "./feed-view-model";
import { fetchFeedWindow } from "./feed-actions";
import type { FeedWindowResult } from "./feed-window";
import { ApprovalInlineActions } from "./approval-inline-actions";

const NOTIFICATIONS_ENDPOINT = "/api/notifications";

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
  initialWindow,
  highlightRunId,
}: {
  initialWindow: FeedWindowResult;
  /** cinatra#2413 — deep-linked from the run panel's "Review approval" CTA
   *  (`?run=<runId>`). When the CURRENT PAGE holds a notification row whose
   *  run reference matches (run-awaiting-human OR run-failed — the failure
   *  row supersedes the approval row on the same key), that row is scrolled
   *  into view and briefly highlighted. No match (already resolved without a
   *  failure, or simply not on page 1) degrades silently — an ordinary feed
   *  render, never a dead link or an error. */
  highlightRunId?: string;
}): React.ReactElement {
  const [chip, setChip] = useState<FilterChip>("all");
  const [page, setPage] = useState(1);
  const [windowVM, setWindowVM] = useState<FeedWindowResult>(initialWindow);
  const [loadError, setLoadError] = useState(false);
  const [pending, startTransition] = useTransition();

  // Client mutation OVERLAYS, held separately from the server-computed window
  // and reapplied on every render — a chip/page change re-fetches a fresh
  // window from the server, and the overlays re-hide decided rows / re-apply
  // read-state on top so an in-flight optimistic change survives it.
  //   • `decidedKeys` — optimistically-removed approval INCARNATIONS, keyed by
  //     `key + version` ({@link decideIdentity}).
  //   • `readOverrides` — a TRI-STATE per-notification override: an ISO
  //     timestamp (marked read), the `"unread"` sentinel (explicitly marked
  //     unread — wins over the mark-all watermark below), or absent (defer to
  //     the server value / watermark).
  //   • `markAllReadAt` — a mark-all-read WATERMARK (a server `createdAt`):
  //     PATCH `{beforeId}` marks read only the unread rows THROUGH the
  //     viewer's newest notification server-side (cinatra#1557), computed from
  //     `windowVM.newestNotification` (the true feed-wide newest — NOT merely
  //     the current page — so mark-all-read is correct from any page/tab).
  const [decidedKeys, setDecidedKeys] = useState<Set<string>>(() => new Set());
  const [readOverrides, setReadOverrides] = useState<Map<string, string | "unread">>(
    () => new Map(),
  );
  const [markAllReadAt, setMarkAllReadAt] = useState<string | null>(null);
  // Per-notification-id mutation queue: a rapid double-toggle (or a toggle
  // fired while the previous one is still in flight) is SERIALIZED, never
  // raced, so the last click always wins in request order.
  const mutationQueueRef = useRef<Map<string, Promise<void>>>(new Map());

  // Toolbar badge OPTIMISM: `windowVM.unreadCount` / `.needsActionCount` are a
  // snapshot from the last fetch (§III "every segment but All carries its live
  // count") — the overlays above only affect the CURRENT PAGE's rendered rows,
  // not a feed-wide recount (the client never holds the full feed), so a toggle
  // or decide on the current page would otherwise leave the toolbar's badge
  // stale until the next chip/page fetch. These deltas correct the DISPLAYED
  // count immediately; they reset to 0 whenever a fresh window lands (the new
  // snapshot is itself authoritative).
  const [unreadDelta, setUnreadDelta] = useState(0);
  const [needsActionDelta, setNeedsActionDelta] = useState(0);
  const displayedUnreadCount = Math.max(0, windowVM.unreadCount + unreadDelta);
  const displayedNeedsActionCount = Math.max(0, windowVM.needsActionCount + needsActionDelta);

  const items = useMemo(() => {
    return windowVM.pageItems
      .filter(
        (v) =>
          v.kind !== "approval" ||
          !decidedKeys.has(decideIdentity(v.key, v.approval.version)),
      )
      .map((v) => {
        if (v.kind !== "notification") return v;
        const override = readOverrides.get(v.notification.id);
        if (override === "unread") {
          if (!v.notification.readAt) return v;
          return { ...v, notification: { ...v.notification, readAt: undefined } };
        }
        if (!v.notification.readAt) {
          const watermark =
            markAllReadAt && v.createdAt <= markAllReadAt ? markAllReadAt : undefined;
          const readAt = override ?? watermark;
          if (readAt) return { ...v, notification: { ...v.notification, readAt } };
        }
        return v;
      });
  }, [windowVM, decidedKeys, readOverrides, markAllReadAt]);

  function patchNotifications(body: Record<string, unknown>): Promise<void> {
    // `keepalive` lets a stretched-link auto-mark-read PATCH survive the
    // navigation it fires alongside.
    return fetch(NOTIFICATIONS_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then(() => undefined)
      .catch(() => {
        // Best-effort — a page refresh realigns with the server.
      });
  }

  /** Serialize every mutation for one notification id through a promise chain
   *  so an id's PATCHes always resolve in the order they were issued. */
  function serializeMutation(id: string, run: () => Promise<void>): void {
    const queue = mutationQueueRef.current;
    const prior = queue.get(id) ?? Promise.resolve();
    const chained = prior.then(run, run);
    queue.set(id, chained);
    void chained.finally(() => {
      if (queue.get(id) === chained) queue.delete(id);
    });
  }

  function markRead(id: string): void {
    setReadOverrides((m) => {
      const next = new Map(m);
      next.set(id, new Date().toISOString());
      return next;
    });
    serializeMutation(id, () => patchNotifications({ id }));
  }

  function markUnread(id: string): void {
    setReadOverrides((m) => {
      const next = new Map(m);
      next.set(id, "unread");
      return next;
    });
    serializeMutation(id, () => patchNotifications({ id, unread: true }));
  }

  /** Whole-card / trailing-toggle activation for a notification: unread → mark
   *  read; read → mark unread (§II "one glyph, two states"). Also nudges the
   *  toolbar's optimistic Unread badge in the same direction. */
  function handleToggleRead(notification: AppNotification): void {
    if (notificationIsUnread(notification)) {
      markRead(notification.id);
      setUnreadDelta((d) => d - 1);
    } else {
      markUnread(notification.id);
      setUnreadDelta((d) => d + 1);
    }
  }

  /** Stretched-link activation for a notification WITH an href: auto-marks
   *  read, then navigates (the Link's own href does the navigating). */
  function handleOpenNotification(notification: AppNotification): void {
    markRead(notification.id);
    if (notificationIsUnread(notification)) setUnreadDelta((d) => d - 1);
  }

  function handleMarkAllRead(): void {
    if (displayedUnreadCount === 0 || !windowVM.newestNotification) return;
    const boundary = windowVM.newestNotification.createdAt;
    setMarkAllReadAt((prev) => (prev && prev > boundary ? prev : boundary));
    // The watermark is the viewer's newest notification, so EVERY unread row
    // is <= it — the whole badge clears. An explicit per-id "unread" override
    // still wins over the watermark (readOverrides is consulted before
    // markAllReadAt above), and a toggle after this point nudges the delta
    // again from its new (zeroed) baseline.
    setUnreadDelta(-windowVM.unreadCount);
    void patchNotifications({ beforeId: windowVM.newestNotification.id });
  }

  function handleDecided(key: string, version?: string, actionable?: boolean): void {
    const identity = decideIdentity(key, version);
    setDecidedKeys((s) => {
      if (s.has(identity)) return s;
      const next = new Set(s);
      next.add(identity);
      return next;
    });
    if (actionable) setNeedsActionDelta((d) => d - 1);
  }

  function loadWindow(nextChip: FilterChip, nextPage: number): void {
    setLoadError(false);
    startTransition(async () => {
      try {
        const w = await fetchFeedWindow(nextChip, nextPage);
        setWindowVM(w);
        // A fresh window is itself authoritative — the prior deltas were
        // corrections against the OLD snapshot.
        setUnreadDelta(0);
        setNeedsActionDelta(0);
      } catch {
        setLoadError(true);
      }
    });
  }

  function handleChipChange(next: FilterChip): void {
    if (next === chip) return;
    setChip(next);
    setPage(1); // §III — switching filters resets to page 1.
    loadWindow(next, 1);
  }

  function handlePageChange(next: number): void {
    if (next === page || next < 1 || next > windowVM.pageCount || pending) return;
    setPage(next);
    loadWindow(chip, next);
  }

  function handleRetryDegraded(): void {
    if (pending) return;
    loadWindow(chip, page);
  }

  // cinatra#2413 — resolve the deep-linked row (if any) among the CURRENTLY
  // rendered page items. Recomputed whenever the page's items or the target
  // runId change; a chip/page change that scrolls the target off-page simply
  // stops matching (graceful degrade, not a lost ref).
  const highlightedKey = useMemo(() => {
    if (!highlightRunId) return null;
    const hit = items.find(
      (v) =>
        v.kind === "notification" &&
        getNotificationRunReference(v.notification) === highlightRunId,
    );
    return hit?.key ?? null;
  }, [items, highlightRunId]);

  const highlightedRowRef = useRef<HTMLLIElement | null>(null);
  // Tracks the LAST key this effect already scrolled to, so a re-render for
  // an unrelated reason (a mutation overlay, a poll) never re-triggers the
  // scroll — only a genuine change of the highlighted target does. Read/set
  // exclusively inside the effect (never during render) to satisfy the
  // refs-during-render rule.
  const scrolledToKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightedKey || scrolledToKeyRef.current === highlightedKey) return;
    highlightedRowRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    scrolledToKeyRef.current = highlightedKey;
  }, [highlightedKey]);

  return (
    <div className="flex flex-col gap-4">
      {/* §III — toolbar: the toggle group leads; "Mark all read" anchors the
          far right, separated by a hairline (matches the shipped /connectors
          toolbar toggle exactly — hairline border + dividers, selected = solid
          ink fill / inverse text, idle = muted tint). */}
      <Toolbar aria-label="Notifications toolbar" data-conformance-id="notifications-filter-rail">
        <ToolbarGroup>
          <ToggleGroup
            type="single"
            size="sm"
            value={chip}
            onValueChange={(v) => v && handleChipChange(v as FilterChip)}
            aria-label="Filter notifications"
            data-conformance-id="notifications-filters"
            data-action="filter -> filtered"
            className="overflow-hidden rounded-[7px] border border-line [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-line"
          >
            <ToggleGroupItem
              value="all"
              className="rounded-none bg-surface-muted text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground"
            >
              All
            </ToggleGroupItem>
            <ToggleGroupItem
              value="needs-action"
              className="rounded-none bg-surface-muted text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground"
            >
              Needs action
              <FilterCount value={displayedNeedsActionCount} active={chip === "needs-action"} />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="unread"
              className="rounded-none bg-surface-muted text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground"
            >
              Unread
              <FilterCount value={displayedUnreadCount} active={chip === "unread"} />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="in-progress"
              className="rounded-none bg-surface-muted text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground"
            >
              In progress
              <FilterCount value={windowVM.inProgressCount} active={chip === "in-progress"} />
            </ToggleGroupItem>
          </ToggleGroup>
        </ToolbarGroup>
        <div aria-hidden className="flex-1" />
        <ToolbarSeparator />
        <ToolbarGroup>
          <ToolbarButton
            onClick={handleMarkAllRead}
            disabled={displayedUnreadCount === 0}
            aria-label="Mark all read"
            className="text-muted-foreground"
          >
            <CheckCheck aria-hidden className="size-[13px]" />
            Mark all read
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>

      {/* §VI — one inline degraded line for any number of failed sources;
          never shown alongside the pager. */}
      {windowVM.degraded ? (
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

      {/* §I / §V — the single interleaved list of spaced cards, or the
          universal empty state. */}
      {items.length === 0 ? (
        <FeedEmptyState feedIsEmpty={windowVM.feedIsEmpty} chip={chip} />
      ) : (
        <ul data-conformance-id="notifications-list" className="grid gap-2.5">
          {items.map((row) => (
            <FeedCard
              key={row.key}
              row={row}
              onOpen={handleOpenNotification}
              onToggleRead={handleToggleRead}
              onDecided={() =>
                handleDecided(
                  row.key,
                  row.kind === "approval" ? row.approval.version : undefined,
                  row.kind === "approval" ? row.approval.actionable : undefined,
                )
              }
              highlighted={row.key === highlightedKey}
              highlightRef={row.key === highlightedKey ? highlightedRowRef : undefined}
            />
          ))}
        </ul>
      )}

      {loadError ? (
        <p className="text-center text-xs text-destructive">
          Could not load this page.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => loadWindow(chip, page)}
            className="h-auto p-0 align-baseline text-xs underline underline-offset-2"
          >
            Try again
          </Button>
        </p>
      ) : null}

      {/* §VII — known-total pagination, 25/page; never alongside the degraded
          line; only when there is more than one page. */}
      {!windowVM.degraded ? (
        <FeedPager
          page={windowVM.page}
          pageCount={windowVM.pageCount}
          total={windowVM.total}
          disabled={pending}
          onPageChange={handlePageChange}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar toggle-group count badge (§III)
// ---------------------------------------------------------------------------
function FilterCount({ value, active }: { value: number; active: boolean }): React.ReactElement | null {
  if (value <= 0) return null;
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full px-1.5 py-px font-mono text-badge-xs leading-none",
        active ? "bg-white/20 text-background" : "bg-surface-strong text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// §VII pagination
// ---------------------------------------------------------------------------

/** Windowed page-number list with ellipses for a large page count — never
 *  more than 7 slots (first, last, current ± 1, and up to two ellipses). */
function pageNumberSlots(page: number, pageCount: number): Array<number | "ellipsis"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const slots = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...slots].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (i > 0 && n - sorted[i - 1]! > 1) out.push("ellipsis");
    out.push(n);
  }
  return out;
}

function FeedPager({
  page,
  pageCount,
  total,
  disabled,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  disabled: boolean;
  onPageChange: (next: number) => void;
}): React.ReactElement | null {
  // The pager renders ONLY when there is more than one page (§VII).
  if (pageCount <= 1) return null;
  const slots = pageNumberSlots(page, pageCount);
  const atFirst = page <= 1;
  const atLast = page >= pageCount;

  // Spec-exact pager (§VII): plain (non-anchor) buttons via the shadcn
  // <Button> wrapper, the current page rendered as a non-interactive
  // aria-current span (never a button), and an ellipsis rendered as a plain
  // muted span — matching the shared Pagination component's own reference
  // markup exactly, geometry included.
  const pagerButtonBase =
    "h-auto rounded-[5px] border border-line bg-surface-strong font-mono text-xs hover:bg-surface-strong disabled:pointer-events-none disabled:opacity-50";

  return (
    <div
      data-conformance-id="notifications-list-pager"
      className="mt-1 flex flex-col items-center gap-2"
    >
      <div className="flex items-center gap-1 font-mono text-xs">
        <Button
          type="button"
          variant="ghost"
          aria-label="Previous page"
          data-action="page-prev -> paged"
          disabled={atFirst || disabled}
          onClick={() => onPageChange(page - 1)}
          className={cn(pagerButtonBase, "px-2 py-[5px]")}
        >
          ‹
        </Button>
        {slots.map((slot, i) =>
          slot === "ellipsis" ? (
            <span key={`ellipsis-${i}`} aria-hidden className="px-1 text-muted-foreground">
              …
            </span>
          ) : slot === page ? (
            <span
              key={slot}
              aria-current="page"
              className="rounded-[5px] border border-foreground bg-foreground px-2.5 py-[5px] text-background"
            >
              {slot}
            </span>
          ) : (
            <Button
              key={slot}
              type="button"
              variant="ghost"
              aria-label={`Page ${slot}`}
              disabled={disabled}
              onClick={() => onPageChange(slot)}
              className={cn(pagerButtonBase, "px-2.5 py-[5px]")}
            >
              {slot}
            </Button>
          ),
        )}
        <Button
          type="button"
          variant="ghost"
          aria-label="Next page"
          data-action="page-next -> paged"
          disabled={atLast || disabled}
          onClick={() => onPageChange(page + 1)}
          className={cn(pagerButtonBase, "px-2 py-[5px]")}
        >
          ›
        </Button>
      </div>
      <span className="font-mono text-xs text-muted-foreground">
        Page {page} of {pageCount} · {total} total
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One card shell, two species (§II) — whole-card activation via a stretched
// sibling overlay; inline controls sit above it (relative z-10).
// ---------------------------------------------------------------------------
function FeedCard({
  row,
  onOpen,
  onToggleRead,
  onDecided,
  highlighted,
  highlightRef,
}: {
  row: FeedRowVM;
  onOpen: (notification: AppNotification) => void;
  onToggleRead: (notification: AppNotification) => void;
  onDecided: () => void;
  /** cinatra#2413 — this row is the CTA deep-link target (see `NotificationsFeed`). */
  highlighted?: boolean;
  highlightRef?: React.RefObject<HTMLLIElement | null>;
}): React.ReactElement {
  if (row.kind === "notification") {
    return (
      <NotificationCard
        notification={row.notification}
        createdAt={row.createdAt}
        onOpen={onOpen}
        onToggleRead={onToggleRead}
        highlighted={highlighted}
        highlightRef={highlightRef}
      />
    );
  }
  return <ApprovalCard approval={row.approval} createdAt={row.createdAt} onDecided={onDecided} />;
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
        "relative z-10 grid size-[34px] flex-none place-items-center rounded-lg",
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

// The read/unread toggle icon — a closed envelope (unread, the action marks
// read) or an opened envelope (read, the action marks unread).
function ReadEnvelopeIcon({ unread }: { unread: boolean }): React.ReactElement {
  const IconComponent = unread ? Mail : MailOpen;
  return <IconComponent width={13} height={13} aria-hidden />;
}

const CARD_SHELL =
  "relative flex items-center gap-3.5 rounded-[11px] border border-line bg-surface-strong p-3.5 transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-[0_2px_6px_rgba(21,33,58,0.10)]";
const STRETCH_OVERLAY = "absolute inset-0 z-0 rounded-[inherit]";

function NotificationCard({
  notification,
  createdAt,
  onOpen,
  onToggleRead,
  highlighted,
  highlightRef,
}: {
  notification: AppNotification;
  createdAt: string;
  onOpen: (notification: AppNotification) => void;
  onToggleRead: (notification: AppNotification) => void;
  /** cinatra#2413 — this row is the CTA deep-link target. */
  highlighted?: boolean;
  highlightRef?: React.RefObject<HTMLLIElement | null>;
}): React.ReactElement {
  const running = isRunningProgressNotification(notification);
  const unread = notificationIsUnread(notification);
  const tone = notificationTone(notification);
  const iconClass = "size-[17px]";

  return (
    <li
      ref={highlightRef}
      data-conformance-id="notification-row"
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        CARD_SHELL,
        highlighted && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
    >
      {/* Whole-card activation, by species (§II). */}
      {notification.href ? (
        <Link
          href={notification.href}
          onClick={() => onOpen(notification)}
          data-action="activate -> navigated"
          aria-label={`Open: ${notification.title}`}
          className={STRETCH_OVERLAY}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onToggleRead(notification)}
          data-action="activate -> toggled"
          aria-label={`${notification.title} — mark as ${unread ? "read" : "unread"}`}
          className={cn(
            STRETCH_OVERLAY,
            "h-auto min-h-0 w-full cursor-pointer justify-start border-0 bg-transparent p-0 shadow-none hover:bg-transparent",
          )}
        />
      )}

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

      {/* No z-10 here: unlike the trailing toggle/decide slot, this block has
          no independently-clickable content of its own, so it must stay
          BELOW the stretched overlay (never occlude the whole-card click). */}
      <div className="min-w-0 flex-1">
        <span data-field="item.title" className="font-sans text-sm font-semibold text-foreground">
          {notification.title}
        </span>
        {notification.body ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{notification.body}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {notification.sourceJobName ? `${notification.sourceJobName} · ` : ""}
          <FeedTimestamp value={createdAt} />
        </p>
      </div>

      {/* Trailing slot (§II): the read/unread toggle, sitting above the
          overlay — present for every notification card regardless of
          species, matching the stretched button of an href-less card. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onToggleRead(notification)}
        data-action="toggle-read -> toggled"
        aria-label={unread ? "Mark as read" : "Mark as unread"}
        title={unread ? "Unread — mark as read" : "Read — mark as unread"}
        className="relative z-10 size-[26px] rounded-md text-primary hover:bg-primary/[0.08]"
      >
        <ReadEnvelopeIcon unread={unread} />
      </Button>
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

function ApprovalCard({
  approval,
  createdAt,
  onDecided,
}: {
  approval: ApprovalRowVM;
  createdAt: string;
  onDecided: () => void;
}): React.ReactElement {
  const iconClass = "size-[17px]";
  return (
    <li data-conformance-id="approval-row" className={CARD_SHELL}>
      {/* Href-less approvals OPT OUT of the whole card — inline decide only
          (§II species exemption). */}
      {approval.href ? (
        <Link
          href={approval.href}
          data-action="activate -> navigated"
          aria-label={`Open: ${approval.title}`}
          className={STRETCH_OVERLAY}
        />
      ) : null}

      <GlyphFrame tone={approval.actionable ? "warning" : "muted"}>
        {approval.actionable ? (
          <CircleCheck className={iconClass} />
        ) : (
          <Clock className={iconClass} />
        )}
      </GlyphFrame>

      {/* No z-10 here: unlike the trailing decide slot, this block has no
          independently-clickable content of its own, so it must stay BELOW
          the stretched overlay (never occlude the href species' whole-card
          click). */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-semibold text-foreground">
            {approval.title}
          </span>
          <EligibilityPill actionable={approval.actionable} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {approval.subtitle ? `${approval.subtitle} · ` : ""}
          <FeedTimestamp value={createdAt} />
        </p>
      </div>

      {/* Trailing slot (§II): the inline decide when the viewer is eligible;
          otherwise an explicit "no action for you". Never a read toggle —
          read-state is a notifications-only concept. */}
      <div className="relative z-10 flex-none" data-action="decide-approval -> decided">
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
  if (feedIsEmpty) {
    return (
      <Empty data-conformance-id="notifications-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon" aria-hidden>
            <Info />
          </EmptyMedia>
          <EmptyTitle>No notifications</EmptyTitle>
        </EmptyHeader>
      </Empty>
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
