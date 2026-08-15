"use client";

// The viewer's platform-admin standing, provided ONCE by the root layout
// (cinatra#2701, epic #2699 S2) — the same value the layout already resolves
// with `isPlatformAdmin(session)` and hands to `AppShell` for the configuration
// cog. Mirrors the `CrumbEpochProvider` pattern next door: one server-resolved
// fact, published to the whole client tree, so a client renderer deep inside a
// page (the command menu, a chat error card, a connectors empty state) can ask
// "may this viewer reach /configuration?" without new session plumbing of its own.
//
// DISCOVERABILITY ONLY, never the boundary. `/configuration` is admin-gated on
// the server at the segment layout, at every page and at every server action
// (S1, #2700). This context decides whether a LINK is offered; a non-admin who
// types the URL is still refused server-side. Defaults to `false` so a subtree
// rendered without the provider (tests, isolated renders, the sign-in shell)
// offers nothing rather than offering a link that bounces.

import { createContext, useContext } from "react";

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
