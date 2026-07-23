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
  Sparkles,
} from "lucide-react";
import { domainIcons } from "@/components/domain-icons";
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

// Configuration moved OUT of the sidebar to a top-bar cog (cinatra#1563):
// `/configuration` is now reached from the admin-only cog in the app-shell
// control row (ConfigurationTopbarCog), immediately left of the notifications
// bell — not from a sidebar nav entry. That cog was the former Admin group's
// SOLE remaining item (the "Approvals" item was already retired in the #1558
// notifications cutover, §VII), so the group no longer exists and no "Admin"
// heading renders for any viewer. `/configuration` stays server-side
// admin-gated (requireAdminSession) independently of nav visibility — hiding
// the cog is discoverability only, never the security boundary.
//
// Exported for the model-level regression test (cinatra#1563) that locks the
// sidebar model to contain no "Admin" group and no "/configuration" entry.
export function buildSidebarData() {
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

// ---------- Assistants nav item ----------

// A single FLAT sidebar entry — "Assistants" — sitting directly below Chat and
// above Agents (ratified spec design@f1b000be6 `specs/app.html` §IX). It is one
// nav entry, NOT a group: it introduces no section heading of its own and
// leaves the Agents entry below it untouched. Selecting it opens the
// `/assistants` surface (the audience-scoped assistants directory, epic #1873
// W3), exactly as Chat opens /chat and Agents opens /agents. Standard
// sidebar-row treatment — a leading icon (§IX renders the Sparkles glyph) + the
// 13px sans label, with the shared indigo-tint active row supplied by
// SidebarMenuButton's `isActive`. The `data-conformance-id` /​ `data-action`
// literals pin the §IX conformance surface (`sidebar-assistants-entry`, whose
// sole action is `open-assistants -> assistants`) and are asserted by the
// source-conformance test (../__tests__/sidebar-assistants-conformance.test.ts).
// This entry is shown to every viewer — there is no signed-out shell, so it
// carries no audience/registry fan-out and no hiddenNavTitles wiring.
function AssistantsNavItem() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const isActive = pathname === "/assistants" || pathname.startsWith("/assistants/");
  return (
    <SidebarMenuItem data-conformance-id="sidebar-assistants-entry">
      <SidebarMenuButton asChild isActive={isActive} tooltip="Assistants">
        <Link
          href="/assistants"
          data-action="open-assistants -> assistants"
          data-testid="sidebar-assistants-link"
          onClick={() => setOpenMobile(false)}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>Assistants</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ---------- AppSidebar ----------

export function AppSidebar({
  connectionReady: _connectionReady,
  userAccentColor = null,
  singleOrg = false,
  hiddenNavTitles,
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
}) {
  const hidden = new Set([
    ...(hiddenNavTitles ?? []),
    ...(singleOrg ? ["Organizations"] : []),
  ]);
  const navGroups = buildSidebarData()
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
        {/* Configuration is no longer a sidebar entry — it lives in the top-bar
            cog (cinatra#1563), so the sidebar opens at Intelligence for every
            viewer and no "Admin" heading renders. */}
        {/* Chat renders separately — it has a dynamic thread sub-menu NavGroup can't express */}
        <SidebarGroup className="pb-0">
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarMenu>
            <ChatNavItem />
            {/* Assistants — one flat entry directly below Chat, above Agents
                (ratified spec design@f1b000be6 §IX). No group container, no new
                section heading; opens the /assistants surface on click. */}
            <AssistantsNavItem />
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
