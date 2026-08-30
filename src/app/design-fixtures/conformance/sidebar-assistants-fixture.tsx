"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness mount for `sidebar-assistants-entry` — the
// surface conformance/app.json gained when the design system published §IX,
// adopted by the cinatra#3057 pin reconciliation.
//
// THE REAL ENTRY IS ALREADY SHIPPED: src/components/app-sidebar.tsx's
// AssistantsNavItem, built for epic #1873 W3, carrying the
// `data-conformance-id="sidebar-assistants-entry"` and
// `data-action="open-assistants -> assistants"` literals that
// testid-contract.json pins and that
// src/components/__tests__/sidebar-assistants-conformance.test.ts asserts at
// the source. What a source test cannot do is exercise the entry's ACTION to
// the outcome the manifest declares, and that is the only thing this mount
// adds.
//
// The shipped entry lives in the authenticated app shell (a session, an org,
// the server-resolved hidden-nav set) and its outcome is a route no
// standalone harness boot can reach — the same wall the approvals and
// scheduling surfaces hit, and the reason those are modelled rather than
// booted (see ./approvals-scheduling-fixtures.tsx). So the entry is modelled
// here with the REAL sidebar primitives it is built from
// (SidebarProvider / SidebarMenu / SidebarMenuItem / SidebarMenuButton), the
// REAL Sparkles glyph and the REAL 13px label, carrying the same two
// conformance literals; activating it records the manifest outcome on the
// harness `data-outcome` instrumentation.
//
// SidebarProvider is here for its context only (SidebarMenuButton reads
// `isMobile`/`state` from it); `min-h-0` overrides the wrapper's `min-h-svh`
// so the mount stays a block inside the harness card, and no <Sidebar> shell
// is rendered, so nothing on this page becomes fixed-position.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";

export function SidebarAssistantsConformanceFixture() {
  const [outcome, setOutcome] = useState("idle");
  const opened = outcome === "assistants";

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="flex flex-col gap-6 p-4">
        <p className="text-sm font-medium text-muted-foreground">
          App shell — Assistants nav entry (surface: sidebar-assistants-entry)
        </p>

        <div
          data-surface-id="sidebar-assistants-entry"
          data-variant="populated"
          data-outcome={outcome}
        >
          <SidebarProvider className="min-h-0 w-full">
            <SidebarMenu>
              <SidebarMenuItem data-conformance-id="sidebar-assistants-entry">
                <SidebarMenuButton
                  isActive={opened}
                  data-action="open-assistants -> assistants"
                  data-testid="sidebar-assistants-link"
                  onClick={() => setOutcome("assistants")}
                >
                  <Sparkles className="h-4 w-4 shrink-0" />
                  <span>Assistants</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarProvider>

          {opened ? (
            <p
              className="mt-3 text-sm text-foreground"
              data-testid="sidebar-assistants-outcome"
            >
              The assistants surface is open.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
