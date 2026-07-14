"use client";

// ---------------------------------------------------------------------------
// Bind-panel open state shared between the page header's "Add agent" action
// and the bindings card (cinatra#1503, design cinatra#1509 §4.4).
//
// The PageHeader `actions` slot and <ProjectAgentBindingsClient> render in
// separate branches of the page tree, so the "open the bind panel" affordance
// (header action + the empty state's primary action) coordinates through this
// route-local context instead of ad-hoc events. Without a provider the hook
// degrades to the pre-#1503 behavior (panel always open, opener a no-op) so
// the card never crashes when mounted standalone.
// ---------------------------------------------------------------------------

import { createContext, useContext, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

type BindPanelContextValue = {
  /** Whether the "Bind an agent template" panel is shown. */
  open: boolean;
  /** Open (and keep open) the bind panel. */
  openPanel: () => void;
};

const BindPanelContext = createContext<BindPanelContextValue>({
  open: true,
  openPanel: () => {},
});

export function useBindPanel(): BindPanelContextValue {
  return useContext(BindPanelContext);
}

export function BindPanelProvider({
  initialOpen = false,
  children,
}: {
  /** Open the panel on first render (…?bindTemplate=<id> deep link). */
  initialOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const value = useMemo<BindPanelContextValue>(
    () => ({ open, openPanel: () => setOpen(true) }),
    [open],
  );
  return (
    <BindPanelContext.Provider value={value}>
      {children}
    </BindPanelContext.Provider>
  );
}

/** The PageHeader "Add agent" action (§4.4 — only rendered when canEdit). */
export function AddAgentHeaderButton() {
  const { openPanel } = useBindPanel();
  return (
    <Button type="button" onClick={openPanel} data-testid="add-agent-header-action">
      <Plus data-icon="inline-start" />
      Add agent
    </Button>
  );
}
