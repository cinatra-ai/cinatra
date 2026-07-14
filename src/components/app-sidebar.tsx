"use client";

import { CinatraLogo } from "@/app/cinatra-logo";
import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { requestChatPanel } from "@/lib/chat-shell-bus";
import {
  ChevronRight,
  MessageSquare,
  Settings,
} from "lucide-react";
import { domainIcons } from "@/components/domain-icons";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { NavGroup } from "@/components/nav-group";
import { NavUser } from "@/components/nav-user";
import { type NavItem } from "@/components/layout-types";
import { ANALYTICS_CATEGORIES, ANALYTICS_CATEGORY_PATHS } from "@/lib/section-nav";

// ---------- sidebar data (mirrors shadcn-admin's sidebar-data.ts pattern) ----------

// Sidebar pill matching the topbar notification chip shape. Sits inline at
// the right edge of the menu row (the bell badge is absolute; here the count
// rides ml-auto inside the row).
function SidebarPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge variant="default" className="ml-auto min-w-5 px-1 text-[10px]">
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

type SidebarOpts = {
  isAdmin: boolean;
  pendingApprovalsTotal: number;
  approvalsNavVisible: boolean;
};

// The Admin group, rendered ABOVE Intelligence (top of the rail). Its two items
// gate INDEPENDENTLY so a new approval source can light Approvals without
// touching the sidebar:
//   • Approvals — availability-driven (approvalsNavVisible, resolved server-side
//     from the ApprovalSource registry): admins (an actionable Inbox source) OR
//     any viewer with an own request in flight (the option-b non-admin path,
//     cinatra#1302). Carries the pending-count pill.
//   • Configuration — the cog → /configuration entry, admin-only.
// The group renders when EITHER item is present, and is null when neither is.
// Exported for unit tests (the availability-driven Approvals split is the
// load-bearing behavior of cinatra#1047).
export function buildAdminGroup(opts: SidebarOpts): { title: string; items: NavItem[] } | null {
  const items: NavItem[] = [];
  if (opts.approvalsNavVisible) {
    items.push({
      title: "Approvals",
      url: "/configuration/approvals",
      icon: domainIcons.approvals,
      extra:
        opts.pendingApprovalsTotal > 0 ? (
          <SidebarPill count={opts.pendingApprovalsTotal} />
        ) : undefined,
    });
  }
  if (opts.isAdmin) {
    items.push({ title: "Configuration", url: "/configuration", icon: Settings });
  }
  if (items.length === 0) return null;
  return { title: "Admin", items };
}

function buildSidebarData(_opts: SidebarOpts) {
  const groups: { title: string; items: NavItem[] }[] = [];

  groups.push({
    title: "Management",
    items: [
      { title: "Personal", url: "/personal", icon: domainIcons.desk },
      { title: "Projects", url: "/projects", icon: domainIcons.projects },
      { title: "Teams", url: "/teams", icon: domainIcons.teams },
      { title: "Organizations", url: "/organizations", icon: domainIcons.organizations },
    ] as NavItem[],
  });

  groups.push({
    title: "Information",
    items: [
      // The former "Data" group (All data / Data types / History / Merge)
      // folded into the consolidated /artifacts surface (cinatra#1431 §VII):
      // Raw objects, Types & approvals, Undo and Merge proposals are admin
      // sub-views INSIDE /artifacts, reached from its in-page mode control —
      // not the sidebar. Only the top-level Artifacts entry remains.
      { title: "Artifacts", url: "/artifacts", icon: domainIcons.artifacts },
      {
        title: "Analytics",
        icon: domainIcons.metrics,
        // Sidebar lists Analytics CATEGORIES (#617), not the content tabs — for
        // now just "LLM". The category stays active across all of its tabs
        // (Costs / Usage / API Requests) via activePaths; the in-page tabs
        // (Costs|Usage|API Requests) still render from ANALYTICS_NAV in
        // MetricApiNav. The old "API" sidebar entry is dropped.
        items: ANALYTICS_CATEGORIES.map((cat) => ({
          title: cat.label,
          url: cat.href,
          activePaths: [...(ANALYTICS_CATEGORY_PATHS[cat.key] ?? [])],
        })),
      },
    ] as NavItem[],
  });

  groups.push({
    title: "Tools",
    items: [
      // Skills has no children — the package list moved into the unified
      // skills surface and the matches view left the sidebar — so Skills is a
      // direct link.
      { title: "Skills", url: "/skills", icon: domainIcons.skills },
      { title: "Connectors", url: "/connectors", icon: domainIcons.connectors },
      // Webhooks moved under Configuration (cinatra#696) — see the Webhooks
      // card on /configuration → /configuration/webhooks.
    ] as NavItem[],
  });

  return groups;
}

// ---------- Chat nav item ----------

function ChatNavItem() {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isActive = pathname === "/chat" || pathname.startsWith("/chat/");
  const [open, setOpen] = useState(isActive);
  const [activePanel, setActivePanel] = useState<"threads" | "teams" | null>(null);

  // Auto-expand children when navigating to /chat
  useEffect(() => {
    if (isActive) setOpen(true);
  }, [isActive]);

  // Stay in sync with the panel state driven by ChatViewPanel.
  useEffect(() => {
    function handleShowPanel(e: Event) {
      const panel = (e as CustomEvent<"threads" | "teams">).detail;
      setActivePanel((prev) => (prev === panel ? null : panel));
    }
    function handleClose() {
      setActivePanel(null);
    }
    window.addEventListener("cinatra:chat:show-panel", handleShowPanel);
    window.addEventListener("cinatra:chat:panel-close", handleClose);
    window.addEventListener("cinatra:chat:new", handleClose);
    return () => {
      window.removeEventListener("cinatra:chat:show-panel", handleShowPanel);
      window.removeEventListener("cinatra:chat:panel-close", handleClose);
      window.removeEventListener("cinatra:chat:new", handleClose);
    };
  }, []);

  function handleNewChat() {
    setActivePanel(null);
    setOpenMobile(false);
    if (pathname.startsWith("/chat")) {
      window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
    } else {
      router.push("/chat");
    }
  }

  function handleShowPanel(panel: "threads" | "teams") {
    // requestChatPanel parks the desired panel AND dispatches the live event,
    // so a click from a non-chat route (where ChatViewPanel has not mounted
    // yet) is honoured once the panel mounts post-navigation, instead of the
    // event firing into the void.
    requestChatPanel(panel);
    setOpenMobile(false);
    if (!pathname.startsWith("/chat")) router.push("/chat");
  }

  const newChatCurrent = pathname === "/chat";

  const subItems = [
    { title: "New chat", isActive: newChatCurrent, onClick: newChatCurrent ? undefined : handleNewChat, current: newChatCurrent },
    { title: "Threads", isActive: activePanel === "threads", onClick: () => handleShowPanel("threads"), current: false },
    { title: "Team chats", isActive: activePanel === "teams", onClick: () => handleShowPanel("teams"), current: false },
  ];

  function handleChatLinkClick(e: React.MouseEvent) {
    setOpenMobile(false);
    // Clicking the label row also toggles the collapsible — mirrors the full-button
    // trigger behaviour of NavCollapsible items (Data/Analytics) so label-click is
    // uniform across all sidebar groups (cinatra#819). The chevron remains a
    // secondary toggle via SidebarMenuAction. Navigation to /chat is preserved:
    // the auto-expand useEffect above re-opens sub-items whenever isActive
    // becomes true (i.e. on any navigation that lands on a /chat route).
    setOpen((prev) => !prev);
    // ChatPage uses pushState for thread navigation — Next.js router doesn't know
    // the URL changed, so a <Link href="/chat"> click is treated as a same-route
    // no-op. Check the real browser URL and dispatch the new-chat event instead.
    if (window.location.pathname.startsWith("/chat")) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
    }
  }

  // Collapsed sidebar — direct link to /chat
  if (state === "collapsed" && !isMobile) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Chat" isActive={isActive}>
          <Link href="/chat" onClick={handleChatLinkClick}>
            <MessageSquare className="h-4 w-4 shrink-0" />
            <span>Chat</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Expanded sidebar — label-click toggles collapsible (uniform with NavCollapsible
  // groups); chevron is a secondary toggle; link navigates to /chat
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isActive} tooltip="Chat">
          <Link href="/chat" onClick={handleChatLinkClick} data-testid="sidebar-chat-label">
            <MessageSquare className="h-4 w-4 shrink-0" />
            <span>Chat</span>
          </Link>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction data-testid="sidebar-chat-chevron">
            <ChevronRight className="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 rtl:rotate-180" />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent className="CollapsibleContent">
          <SidebarMenuSub data-testid="sidebar-chat-subitems">
            {subItems.map((sub) => (
              <SidebarMenuSubItem key={sub.title}>
                {sub.current ? (
                  <SidebarMenuSubButton isActive>
                    <span>{sub.title}</span>
                  </SidebarMenuSubButton>
                ) : (
                  <SidebarMenuSubButton isActive={sub.isActive} onClick={sub.onClick} className="w-full cursor-pointer text-left">
                    <span>{sub.title}</span>
                  </SidebarMenuSubButton>
                )}
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// ---------- AppSidebar ----------

export function AppSidebar({
  connectionReady: _connectionReady,
  userAccentColor = null,
  singleOrg = false,
  hiddenNavTitles,
  isAdmin = false,
  pendingApprovalsTotal = 0,
  approvalsNavVisible = false,
}: {
  connectionReady: boolean;
  userAccentColor?: import("@/lib/extension-accent").ExtensionAccent | null;
  // When single-org mode is on, the "Organizations" entry is hidden for
  // everyone (resolved server-side in layout.tsx via isSingleOrgMode()).
  singleOrg?: boolean;
  // Top-level nav titles the actor has no read access to. Computed
  // server-side in layout.tsx via canSeeNavTarget(); the sidebar hides them
  // rather than relying on "click → 403".
  hiddenNavTitles?: string[];
  /**
   * Gates the Admin → Configuration entry (and, today, most admin surfaces).
   * Plumbed from layout.tsx via isPlatformAdmin(session). Approvals no longer
   * rides this flag — it is availability-driven via approvalsNavVisible.
   */
  isAdmin?: boolean;
  /**
   * Total count for the Admin → Approvals pill. Resolved server-side in
   * layout.tsx by summing the ApprovalSource registry's per-source
   * Inbox-actionable counts for the viewer.
   */
  pendingApprovalsTotal?: number;
  /**
   * Availability-driven visibility of the Admin → Approvals item: the viewer
   * has any available source with an actionable Inbox (v1 → admins, unchanged;
   * a future non-admin-actionable source lights it with no edit here).
   * Resolved server-side in layout.tsx from the registry.
   */
  approvalsNavVisible?: boolean;
}) {
  const hidden = new Set([
    ...(hiddenNavTitles ?? []),
    ...(singleOrg ? ["Organizations"] : []),
  ]);
  const adminGroupRaw = buildAdminGroup({ isAdmin, pendingApprovalsTotal, approvalsNavVisible });
  const adminGroup = adminGroupRaw
    ? {
        ...adminGroupRaw,
        items: (adminGroupRaw.items as NavItem[]).filter((item) => !hidden.has(item.title)),
      }
    : null;
  const navGroups = buildSidebarData({ isAdmin, pendingApprovalsTotal, approvalsNavVisible })
    .map((group) => ({
      ...group,
      items: (group.items as NavItem[]).filter((item) => !hidden.has(item.title)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 border-b border-sidebar-border px-2 py-0">
        <Link
          href="/chat"
          className="flex h-full items-center gap-2.5 px-2 transition hover:opacity-90 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          {/* Sidebar brand head uses <BrandMark> — the official horizontal
              lockup (fedora + outlined wordmark, spec §I proportions baked
              in). Mustard on the light sidebar; on dark grounds the lockup
              goes cream, not mustard (§I inverted colourway). The
              collapsible-icon state hides the wordmark — we drop back to the
              bare <CinatraLogo> there to preserve the existing 32px chip
              size. */}
          <span className="group-data-[collapsible=icon]:hidden">
            <BrandMark
              size={28}
              tone="mustard"
              variant="animated"
              className="dark:text-foreground"
            />
          </span>
          <CinatraLogo className="hidden size-8 shrink-0 text-brand-mustard group-data-[collapsible=icon]:block dark:text-foreground" />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {/* Admin group renders first (above Intelligence) for platform admins. */}
        {adminGroup ? <NavGroup {...adminGroup} className="pt-0" /> : null}
        {/* Chat renders separately — it has a dynamic thread sub-menu NavGroup can't express */}
        <SidebarGroup className="pb-0">
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarMenu>
            <ChatNavItem />
          </SidebarMenu>
        </SidebarGroup>
        <NavGroup
          items={[
            {
              title: "Agents",
              icon: domainIcons.agents,
              url: "/agents",
            },
          ]}
          className="py-0"
        />
        {/* The "Workflows" browse nav item was removed (cinatra#609) — workflow
            overview/tracking now lives in Plane. The native workflow engine,
            approvals, and the per-workflow detail/run page remain (reached via
            chat creation, deep-links, and the Approvals surface). */}
        {/* "Agent Setup" link to /chat/copilot retired together with the legacy
            page. Inline agent dispatch + HITL now happen in the main /chat
            surface via InlineAgentRunCard. */}
        {navGroups.map((group, i) => (
          <NavGroup key={i} {...group} className="py-0" />
        ))}
      </SidebarContent>

      <SidebarFooter>
        <NavUser accent={userAccentColor} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
