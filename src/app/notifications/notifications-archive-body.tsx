"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Bell, CheckCheck } from "lucide-react";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import {
  collapseByJobId,
  getInProgressItems,
  isRunningProgressNotification,
} from "@cinatra-ai/notifications/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Toolbar,
  ToolbarButton,
  ToolbarCount,
  ToolbarGroup,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// /notifications archive client body.
//
// Server page (`page.tsx`) fetches notifications via the per-user
// service and hands them off here. All controls live in ONE canonical
// `<Toolbar>` (the toolbar replaces the section rule below PageHeader):
//   - Free-text search at the far left (ToolbarSearchInput)
//   - All / Unread / In progress as toggle buttons (ToolbarButton active)
//     with ToolbarCount badges — this REPLACES the old Radix Tabs tablist
//   - Kind options (Any / Success / Error / Warning / Info) as toggle buttons
//   - Mark all as read at the far right (PATCH /api/notifications {all:true})
//
// The server page stays a small wrapper so `requireAuthSession()` runs on
// the server (no client-side session leak).
// ---------------------------------------------------------------------------

type Tab = "all" | "unread" | "in-progress";
type KindFilter = AppNotification["kind"] | "any";

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

const subscribeToHydration = () => () => {};

function isTerminal(n: AppNotification): boolean {
  return n.kind === "success" || n.kind === "error" || n.kind === "warning";
}

function categoryOf(n: AppNotification): string {
  const md = n.metadata as { category?: unknown } | undefined;
  return typeof md?.category === "string" ? md.category : "";
}

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

function NotificationTimestamp({ value }: { value: string }): React.ReactElement | null {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const label = hydrated ? formatLocalTimestamp(value) : formatStableTimestamp(value);
  if (!label) return null;

  return <time dateTime={value}>{label}</time>;
}

export function NotificationsArchiveBody({
  notifications,
}: {
  notifications: AppNotification[];
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>("all");
  const [kind, setKind] = useState<KindFilter>("any");
  const [search, setSearch] = useState<string>("");
  // Optimistic local mirror so "Mark all as read" + per-row open feel instant.
  // Diverges from the server snapshot only briefly — the next page refresh
  // (or a refresh after a server action) realigns them.
  const [items, setItems] = useState<AppNotification[]>(notifications);
  const [markingAll, setMarkingAll] = useState(false);

  // Mirror the flyout's collapse contract so the archive doesn't show
  // duplicate rows for the same `sourceJobId` (e.g. running + completed
  // for the same job both rendered) and so the In progress tab excludes
  // running rows whose terminal has already arrived. `collapseByJobId`
  // selects the terminal row over the running one when both exist;
  // `getInProgressItems` returns running rows with NO terminal counterpart.
  const collapsed = useMemo(() => collapseByJobId(items), [items]);
  const inProgress = useMemo(() => getInProgressItems(items), [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matchesSearch = (n: AppNotification): boolean => {
      if (!term) return true;
      const haystack =
        `${n.title}\n${n.body}\n${n.sourceJobName ?? ""}\n${categoryOf(n)}`.toLowerCase();
      return haystack.includes(term);
    };
    const matchesKind = (n: AppNotification): boolean =>
      kind === "any" || n.kind === kind;

    if (tab === "in-progress") {
      return inProgress.filter((n) => matchesKind(n) && matchesSearch(n));
    }
    if (tab === "unread") {
      return collapsed.filter(
        (n) =>
          !n.readAt &&
          !isRunningProgressNotification(n) &&
          matchesKind(n) &&
          matchesSearch(n),
      );
    }
    return collapsed.filter((n) => matchesKind(n) && matchesSearch(n));
  }, [collapsed, inProgress, kind, search, tab]);

  const unreadCount = useMemo(
    () =>
      collapsed.filter(
        (n) => !n.readAt && !isRunningProgressNotification(n),
      ).length,
    [collapsed],
  );

  const inProgressCount = inProgress.length;

  async function handleMarkAllRead(): Promise<void> {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    const readAt = new Date().toISOString();
    setItems((current) =>
      current.map((n) => ({ ...n, readAt: n.readAt ?? readAt })),
    );
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      // Best-effort — the next page refresh will realign with the server.
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleOpenNotification(n: AppNotification): Promise<void> {
    if (n.readAt) return;
    setItems((current) =>
      current.map((item) =>
        item.id === n.id
          ? { ...item, readAt: item.readAt ?? new Date().toISOString() }
          : item,
      ),
    );
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      });
    } catch {
      // Best-effort.
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar aria-label="Notification filters">
        <ToolbarSearchGroup className="w-full max-w-md flex-none">
          <ToolbarSearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title, body, job name, or category…"
            aria-label="Search notifications"
          />
        </ToolbarSearchGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          <ToolbarButton
            type="button"
            active={tab === "all"}
            onClick={() => setTab("all")}
          >
            All
            {collapsed.length > 0 ? (
              <ToolbarCount active={tab === "all"}>{collapsed.length}</ToolbarCount>
            ) : null}
          </ToolbarButton>
          <ToolbarButton
            type="button"
            active={tab === "unread"}
            onClick={() => setTab("unread")}
          >
            Unread
            {unreadCount > 0 ? (
              <ToolbarCount active={tab === "unread"}>{unreadCount}</ToolbarCount>
            ) : null}
          </ToolbarButton>
          <ToolbarButton
            type="button"
            active={tab === "in-progress"}
            onClick={() => setTab("in-progress")}
          >
            In progress
            {inProgressCount > 0 ? (
              <ToolbarCount active={tab === "in-progress"}>
                {inProgressCount}
              </ToolbarCount>
            ) : null}
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarSeparator />

        <ToolbarGroup>
          {KIND_FILTERS.map((option) => (
            <ToolbarButton
              key={option.value}
              type="button"
              active={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </ToolbarButton>
          ))}
        </ToolbarGroup>

        <div aria-hidden className="flex-1" />

        <ToolbarGroup>
          <ToolbarButton
            type="button"
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0 || markingAll}
          >
            <CheckCheck aria-hidden className="size-[15px]" />
            {markingAll ? "Marking…" : "Mark all as read"}
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>

      {filtered.length === 0 ? (
        <Card className="border-line bg-surface backdrop-blur-none">
          <Empty className="border-none p-6">
            <EmptyMedia variant="icon">
              <Bell className="size-4" />
            </EmptyMedia>
            <EmptyTitle>No notifications match</EmptyTitle>
            <EmptyDescription>
              Adjust the filters above, or wait for a new notification.
            </EmptyDescription>
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((notification) => (
            <ArchiveRow
              key={notification.id}
              notification={notification}
              onOpen={handleOpenNotification}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchiveRow({
  notification,
  onOpen,
}: {
  notification: AppNotification;
  onOpen: (n: AppNotification) => void;
}): React.ReactElement {
  const running = isRunningProgressNotification(notification);

  return (
    <Card className="border-line bg-surface p-6 backdrop-blur-none">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {running ? (
              <Spinner className="size-3.5 text-info" />
            ) : (
              <span
                className={cn(
                  "inline-flex h-2.5 w-2.5 rounded-full",
                  notification.kind === "error"
                    ? "bg-destructive"
                    : notification.kind === "warning"
                      ? "bg-warning"
                      : notification.kind === "info"
                        ? "bg-info"
                        : "bg-success",
                  notification.readAt ? "opacity-40" : "",
                )}
                aria-hidden="true"
              />
            )}
            <h3 className="text-base font-semibold">{notification.title}</h3>
            {isTerminal(notification) ? null : (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {running ? "Running" : "Info"}
              </Badge>
            )}
          </div>
          {notification.body ? (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {notification.body}
            </p>
          ) : null}
          <p className="mt-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {notification.readAt ? "Seen" : "Unseen"} ·{" "}
            <NotificationTimestamp value={notification.createdAt} />
            {notification.sourceJobName
              ? ` · ${notification.sourceJobName}`
              : ""}
          </p>
        </div>
        {notification.href ? (
          <Button asChild variant="default" onClick={() => onOpen(notification)}>
            <Link href={notification.href}>Open</Link>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
