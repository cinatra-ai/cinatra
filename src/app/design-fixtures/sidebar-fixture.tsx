"use client";

import { LayoutDashboard, FileText, Settings, ChevronRight } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar";

import { PrimitiveRow } from "./primitive-row";

/**
 * Sidebar primitive fixture row.
 *
 * Renders the shadcn Sidebar primitive at `src/components/ui/sidebar.tsx` in
 * three supported states: expanded (default), collapsed
 * (`data-state=collapsed`), and mobile sheet (a narrow-width approximation
 * — the actual `useIsMobile()` switch is media-query-driven, so the
 * fixture renders the bare `<Sidebar>` inside a phone-width frame to
 * exercise the same chrome the mobile-sheet path produces).
 *
 * Each fixture is rendered inside a fixed-width container so the
 * primitive's `w-(--sidebar-width)` flex behavior does not blow out the
 * page width. `SidebarProvider` is required because the primitive's
 * internal context (`useSidebar()`) throws if mounted bare.
 */

function makeBody() {
  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive>
                <LayoutDashboard />
                Dashboards
                <ChevronRight className="ml-auto" />
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <FileText />
                Documents
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <Settings />
                Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

function ExpandedSidebar() {
  return (
    <div className="relative w-[280px] overflow-hidden rounded-card border border-line bg-surface-strong">
      <SidebarProvider defaultOpen className="min-h-[320px]">
        <Sidebar collapsible="none" className="static h-[320px] border-r border-line">
          <SidebarHeader className="px-3 py-3">
            <div className="font-display text-base font-extrabold italic tracking-tight text-foreground">
              cinatra
            </div>
          </SidebarHeader>
          <SidebarSeparator />
          {makeBody()}
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

function CollapsedSidebar() {
  // The `data-state=collapsed` flag drives the icon-only collapse via the
  // `group-data-[collapsible=icon]:*` selectors inside the primitive. Use
  // a SidebarProvider whose `defaultOpen=false` so the menu buttons render
  // in their icon-only chrome.
  return (
    <div className="relative w-[72px] overflow-hidden rounded-card border border-line bg-surface-strong">
      <SidebarProvider defaultOpen={false} className="min-h-[320px]">
        <Sidebar collapsible="icon" className="static h-[320px] border-r border-line">
          <SidebarHeader className="px-1 py-3">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
              <span className="font-display text-sm font-extrabold italic">c</span>
            </div>
          </SidebarHeader>
          <SidebarSeparator />
          {makeBody()}
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

function MobileSheetSidebar() {
  // Mobile-sheet uses the same chrome as expanded but framed inside a
  // phone-width container, so the visual diff covers the same surface a
  // small-screen user sees when toggling the sheet open.
  return (
    <div className="relative w-[288px] overflow-hidden rounded-card border border-line bg-sidebar shadow-strong">
      <SidebarProvider defaultOpen className="min-h-[360px]">
        <Sidebar collapsible="none" className="static h-[360px] border-0 bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="px-3 py-3">
            <div className="font-display text-base font-extrabold italic tracking-tight">
              cinatra
            </div>
          </SidebarHeader>
          <SidebarSeparator />
          {makeBody()}
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

export function SidebarFixture() {
  return (
    <PrimitiveRow
      name="Sidebar"
      spec="@/components/ui/sidebar"
      conformance="Token-conformant chrome: bg-sidebar / text-sidebar-foreground / bg-sidebar-border. Group label mono uppercase, menu hover bg-sidebar-accent, focus-visible ring-sidebar-ring. Brand head adopts <BrandMark> via app-sidebar composition. Three states rendered: expanded, collapsed (icon-only), mobile sheet (phone-width)."
    >
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col items-start gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            expanded
          </span>
          <ExpandedSidebar />
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            collapsed (icon)
          </span>
          <CollapsedSidebar />
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            mobile sheet
          </span>
          <MobileSheetSidebar />
        </div>
      </div>
    </PrimitiveRow>
  );
}
