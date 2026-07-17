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
