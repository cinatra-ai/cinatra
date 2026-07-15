"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import type { AppNotification } from "./types";
import type { ConfigurationNeedsConnector } from "./flyout-state";

// ---------------------------------------------------------------------------
// Agent post-install "needs configuration" row (cinatra #1057 ruling (c)).
//
// Relocated here from the retired `notifications-flyout.tsx` in the E8 cutover
// (cinatra#1558): the bell flyout that rendered this row inline is deleted, but
// the `bell-config-needs-row` design-conformance surface still mounts the REAL
// component (via `@cinatra-ai/notifications/client` →
// `src/app/design-fixtures/conformance/notification-config-needs-fixture.tsx`)
// to verify the ruling copy on a sessionless build. Kept a standalone,
// browser-safe module so it survives the flyout deletion unchanged.
//
// One entry per affected agent. The title is the ruling copy
// `Set up connections for "<displayName>":`; the body is the list of each
// required connector's human-readable displayName linking to that connector's
// setup page (never the bare package id). Rendered in the design system's
// Needs-review status colours — the mustard tint (`bg-warning/10`) over the
// mustard ink (`text-warning`) with a mustard hairline (`border-warning/42`).
// The links carry navigation (no whole-row nav button, no copy button); each
// invokes `onCloseFlyout` on click (a caller-supplied post-navigation hook —
// the name is retained for the conformance-fixture prop contract). The entry is
// not marked read on interaction — it clears only when the agent becomes
// runnable, at which point the server reconciler deletes it.
// ---------------------------------------------------------------------------

function formatNotificationTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleString();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "now";
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    const minutes = Math.floor((diffMs % hour) / minute);
    if (hours <= 0) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    if (minutes <= 0) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  return date.toLocaleString();
}

export function ConfigurationNeedsRow({
  notification,
  connectors,
  onCloseFlyout,
}: {
  notification: AppNotification;
  connectors: ConfigurationNeedsConnector[];
  onCloseFlyout: () => void;
}): React.ReactElement {
  return (
    <div
      data-slot="notification-configuration-needs"
      data-conformance="install-config-needs-callout"
      className="flex flex-col gap-2 rounded-chip border border-warning/42 bg-warning/10 px-3 py-3"
    >
      <div className="flex items-start gap-2 text-warning">
        <TriangleAlert
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0"
          strokeWidth={2.25}
        />
        <p className="text-sm font-semibold text-foreground">
          {notification.title}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-xs text-warning">
        {connectors.map((connector, index) => (
          <span key={connector.packageName} className="inline-flex items-center">
            {connector.settingsHref ? (
              <Link
                href={connector.settingsHref}
                data-field="manifest.displayName"
                onClick={onCloseFlyout}
                className="font-semibold underline decoration-warning/50 underline-offset-2 hover:decoration-warning"
              >
                {connector.displayName}
              </Link>
            ) : (
              <span data-field="manifest.displayName" className="font-semibold">
                {connector.displayName}
              </span>
            )}
            {index < connectors.length - 1 && (
              <span aria-hidden className="ml-2 text-warning/60">
                &middot;
              </span>
            )}
          </span>
        ))}
      </div>
      <p className="pl-5 text-badge-xs uppercase tracking-kicker text-muted-foreground">
        {formatNotificationTimestamp(notification.createdAt)}
      </p>
    </div>
  );
}
