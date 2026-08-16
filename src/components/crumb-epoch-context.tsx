"use client";

// The crumb-contributions session/org fence, provided ONCE by the root layout
// (cinatra#1737). Publisher islands and the AppShell consumer read the same
// value, so a parked crumb snapshot from another session or active org is
// never applied: the layout re-renders on login/org switch, changing the
// epoch, which fences the stale snapshot out at selection time.

import { createContext, useContext } from "react";

const CrumbEpochContext = createContext<string>("anon");

export function CrumbEpochProvider({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return <CrumbEpochContext.Provider value={value}>{children}</CrumbEpochContext.Provider>;
}

export function useCrumbEpoch(): string {
  return useContext(CrumbEpochContext);
}

// ---------------------------------------------------------------------------
// Viewer-admin context (cinatra#2701). Root-published `isAdmin` for the
// member-facing producers of /configuration links (command menu, error CTAs,
// restore affordances): the root layout already computes isAdmin for the
// topbar cog and publishes it here, next to the crumb epoch, so no member
// surface mints a link it cannot follow. Lives in this module (not a sibling
// file) so the locked route graphs do not grow by a module for a 20-line
// context.
// ---------------------------------------------------------------------------

const ViewerAdminContext = createContext<boolean>(false);

export function ViewerAdminProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <ViewerAdminContext.Provider value={value}>{children}</ViewerAdminContext.Provider>;
}

/** True when the viewer holds the platform-admin role — i.e. may reach `/configuration`. */
export function useViewerIsAdmin(): boolean {
  return useContext(ViewerAdminContext);
}
