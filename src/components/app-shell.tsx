"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useMemo } from "react";
import { useEffect, useRef, useState } from "react";
import { LoadingSpinner } from "@cinatra-ai/sdk-ui";
import { CreateOrganizationDialog } from "@daveyplate/better-auth-ui";
import { authClient } from "@/lib/auth-client";
import {
  getCurrentChatThreadTitle,
  CHAT_TITLE_CHANGED_EVENT,
} from "@/lib/chat-shell-bus";
import { ThemeSwitch } from "@/components/theme-switch";
import { IconButton } from "@/components/icon-button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  buildBreadcrumbTrail,
  breadcrumbCrumbKey,
  humanizePathSegment,
  type BreadcrumbCrumb,
} from "@/lib/breadcrumb-trail";
import { Building2, FolderKanban, MessageSquare, Play, Plus, Settings, TriangleAlert, UsersRound, Wrench } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AppSidebar } from "@/components/app-sidebar";
import {
  NotificationsBellTrigger,
  NotificationsProvider,
} from "@cinatra-ai/notifications/client";

function EmbedMessageListener() {
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data === "cinatra:embed:submit") {
        const form = document.querySelector("form");
        if (form) {
          const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (btn) btn.click();
          else form.requestSubmit();
        }
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);
  return null;
}

// Notifications flyout state lives in `src/components/notifications-flyout.tsx`.
// The Provider owns state; the BellTrigger renders the bell + popover.

function deriveDocumentTitle(pathname: string, explicitTitle?: string) {
  if (explicitTitle) {
    return `${explicitTitle} | Cinatra`;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "Personal | Cinatra";
  }

  const preferredSegment = segments[segments.length - 1] === "edit" || segments[segments.length - 1] === "new" || segments[segments.length - 1] === "review" || segments[segments.length - 1] === "send"
    ? segments.slice(-2).join(" ")
    : segments[segments.length - 1];

  return `${humanizePathSegment(preferredSegment)} | Cinatra`;
}

const pageHeaders = [
  // Pages whose layouts manage their own PageHeader component
  // only package pages that cannot yet import PageHeader remain here
  {
    match: (pathname: string) =>
      pathname === "/setup" ||
      pathname.startsWith("/setup/") ||
      pathname === "/configuration/llm/initial-setup",
    title: "Setup",
  },
  {
    match: (pathname: string) =>
      pathname === "/configuration/llm/openai-skills" ||
      pathname === "/configuration/apps/openai-skills",
    title: "OpenAI API Skills",
  },
  {
    match: (pathname: string) =>
      pathname === "/configuration/llm/gmail" ||
      pathname === "/configuration/apps/gmail",
    title: "Google OAuth",
  },
  {
    match: (pathname: string) =>
      pathname === "/configuration/llm/apollo" ||
      pathname === "/configuration/apps/apollo",
    title: "Apollo API",
  },
];

export function AppShell({
  children,
  connectionReady,
  canCreateProjects = false,
  canCreateTeams = false,
  canCreateOrganizations = false,
  isAdmin = false,
  userAccentColor = null,
  singleOrg = false,
  hiddenNavTitles,
  pendingApprovalsTotal = 0,
}: {
  children: React.ReactNode;
  connectionReady: boolean;
  canCreateProjects?: boolean;
  canCreateTeams?: boolean;
  canCreateOrganizations?: boolean;
  isAdmin?: boolean;
  userAccentColor?: import("@/lib/extension-accent").ExtensionAccent | null;
  // Server-resolved nav gating.
  singleOrg?: boolean;
  hiddenNavTitles?: string[];
  /**
   * Total of pending workflow approvals + admin-only agent creation
   * requests visible to the actor. 0 when not signed in or when the count
   * primitive returns 0; the sidebar pill hides at 0.
   */
  pendingApprovalsTotal?: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  authClient.useSession();
  // MCP OAuth handshake pages (sign-in / account / consent) are driven by
  // external MCP clients and must render clean, without the app sidebar/chrome.
  const isMcpHandshakePath =
    pathname.startsWith("/api/mcp/auth/") ||
    pathname.startsWith("/api/mcp/account/") ||
    pathname === "/api/mcp/consent";
  const isAuthPath =
    pathname === "/permissions" ||
    pathname.startsWith("/permissions/") ||
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    isMcpHandshakePath;
  const isSetupWizardPath = pathname === "/setup" || pathname.startsWith("/setup/");
  const [isEmbedMode] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("embed") === "1";
    }
    return false;
  });
  // Notifications flyout state lives in <NotificationsProvider>.
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [bypassSetupStepGates, setBypassSetupStepGates] = useState(() =>
    typeof window !== "undefined" && window.localStorage.getItem("__cinatra_dev_bypass_step_gates") === "true",
  );
  const [developmentToolsPending, setDevelopmentToolsPending] = useState(false);
  const [developmentToolsMessage, setDevelopmentToolsMessage] = useState<string | null>(null);
  // The skills Library tab owns repository recreation state.
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);
  const [defaultLlmProvider, setDefaultLlmProvider] = useState<string | null>(null);
  const [llmProviderPending, setLlmProviderPending] = useState(false);
  const [llmProviderSaved, setLlmProviderSaved] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [chatThreadTitle, setChatThreadTitle] = useState<string | null>(null);
  const [agentInstanceName, setAgentInstanceName] = useState<string | null>(null);
  // Broadcast page title (from <PageHeader>) for the breadcrumb leaf crumb.
  const [pageTitle, setPageTitle] = useState<{ title: string; pathname: string } | null>(null);
  const pageContentRef = useRef<HTMLDivElement | null>(null);

  const isSetupPath =
    pathname === "/permissions" ||
    pathname.startsWith("/permissions/") ||
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname === "/configuration/llm/initial-setup" ||
    pathname === "/configuration/llm/openai" ||
    pathname === "/configuration/apps/openai" ||
    isMcpHandshakePath;
  const requiresSetupRedirect = !connectionReady && !isSetupPath;
  const activeHeader = pageHeaders.find((entry) => entry.match(pathname));
  const hideShellPageHeader = pathname === "/chat" || pathname.startsWith("/chat/");
  const shouldBypassShell = isAuthPath || isSetupWizardPath || isEmbedMode;

  useEffect(() => {
    const onScroll = () => setScrollOffset(document.body.scrollTop || document.documentElement.scrollTop);
    document.addEventListener("scroll", onScroll, { passive: true });
    return () => document.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // Seed from the bus FIRST: ChatPage (a descendant) publishes its thread
    // title in a commit-phase effect that runs BEFORE this ancestor effect,
    // so on a direct-load of /chat/<uuid> the one-shot event is already gone
    // by the time this listener attaches. Reading the parked value captures
    // it; the listener then keeps the breadcrumb live for fresh-create +
    // thread-switch.
    setChatThreadTitle(getCurrentChatThreadTitle());
    function handleTitleChanged(e: Event) {
      const detail = (e as CustomEvent<{ title: string | null }>).detail;
      setChatThreadTitle(detail.title);
    }
    window.addEventListener(CHAT_TITLE_CHANGED_EVENT, handleTitleChanged);
    return () => window.removeEventListener(CHAT_TITLE_CHANGED_EVENT, handleTitleChanged);
  }, []);

  useEffect(() => {
    function handlePageTitle(e: Event) {
      const detail = (e as CustomEvent<{ title: string | null; pathname: string }>).detail;
      if (detail.title) {
        setPageTitle({ title: detail.title, pathname: detail.pathname });
      } else {
        // Only clear if the unmounting page is still the active one — guards
        // against an old page's cleanup nulling the incoming page's title.
        setPageTitle((prev) => (prev && prev.pathname === detail.pathname ? null : prev));
      }
    }
    window.addEventListener("cinatra:page:title", handlePageTitle);
    return () => window.removeEventListener("cinatra:page:title", handlePageTitle);
  }, []);

  useEffect(() => {
    function handleAgentNameChanged(e: Event) {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      setAgentInstanceName(detail.name || null);
    }
    window.addEventListener("cinatra:agent:name-changed", handleAgentNameChanged);
    return () => window.removeEventListener("cinatra:agent:name-changed", handleAgentNameChanged);
  }, []);

  useEffect(() => {
    const segments = pathname.split("/").filter(Boolean);
    const isAgentInstancePage = segments.length >= 3 && segments[0] === "agents" && !!segments[2];
    if (!isAgentInstancePage) {
      setAgentInstanceName(null);
      return;
    }

    const controller = new AbortController();
    const agentId = segments[1];
    const instanceId = segments[2];

    fetch(`/api/agents/instance-name?agentId=${encodeURIComponent(agentId)}&instanceId=${encodeURIComponent(instanceId)}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data: { name: string | null }) => {
        if (!controller.signal.aborted) {
          setAgentInstanceName(data.name ?? null);
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.name !== "AbortError") {
          console.warn("[app-shell] failed to resolve agent instance name", err);
        }
      });

    return () => controller.abort();
  }, [pathname]);

  const breadcrumbSegments = useMemo<BreadcrumbCrumb[]>(
    () =>
      buildBreadcrumbTrail(pathname, {
        pageTitle,
        chatThreadTitle,
        agentInstanceName,
      }),
    [pathname, chatThreadTitle, agentInstanceName, pageTitle],
  );

  useEffect(() => {
    if (requiresSetupRedirect) {
      router.replace("/setup");
    }
  }, [requiresSetupRedirect, router]);

  useEffect(() => {
    const isChatThread = /^\/chat\/[a-f0-9-]{36}$/.test(pathname);
    const agentInstancePathSegments = pathname.split("/").filter(Boolean);
    const isAgentInstance =
      agentInstancePathSegments.length >= 3 && agentInstancePathSegments[0] === "agents";
    if (isChatThread && chatThreadTitle) {
      document.title = `${chatThreadTitle} | Cinatra`;
    } else if (isAgentInstance && agentInstanceName) {
      document.title = `${agentInstanceName} | Cinatra`;
    } else {
      document.title = deriveDocumentTitle(pathname, activeHeader?.title);
    }
  }, [activeHeader?.title, pathname, chatThreadTitle, agentInstanceName]);

  // <NotificationsProvider> owns polling / SSE / per-route mark-read /
  // custom-event open behavior (`src/components/notifications-flyout.tsx`).

  if (requiresSetupRedirect) {
    // Show a minimal loading screen instead of a blank page. The useEffect
    // above fires `router.replace("/setup")` on the next tick. Returning null
    // here produces a completely blank/white page during that brief window,
    // which users report as "the entire app disappearing". A visible state is
    // better UX and also makes it easier to diagnose if the redirect fails.
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--background, #fff)",
          color: "var(--foreground, #000)",
          fontFamily: "system-ui, sans-serif",
          fontSize: "0.875rem",
          opacity: 0.6,
        }}
      >
        Redirecting to setup…
      </div>
    );
  }

  if (shouldBypassShell) {
    // Section-level embedding: ?embed=1&section=audience shows only that section.
    const embedSection = isEmbedMode && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("section")
      : null;

    return (
      <>
        {isEmbedMode && (
          <>
            <style>{`
              body { background: white !important; overflow-x: hidden !important; }
              main { padding: 0.75rem !important; min-height: auto !important; }
            `}</style>
            <EmbedMessageListener />
          </>
        )}
        {embedSection && (
          <style>{`
            /* Hide everything by default in section embed mode */
            main > * { display: none !important; }
            /* But show the form/container that has our target section */
            main > *:has([data-section="${embedSection}"]) { display: block !important; }
            /* Inside that container, hide all siblings of the target */
            [data-section] { display: none !important; }
            [data-section="${embedSection}"] { display: block !important; }
            /* Hide page chrome: titles, tabs, step nav, submit buttons, nav links */
            [data-embed-hide] { display: none !important; }
            form > button[type="submit"] { display: none !important; }
            a[href*="choose-recipients"] { display: none !important; }
            a[href*="provide-context"] { display: none !important; }
            /* Hide step navigation cards */
            [class*="step-navigation"], nav { display: none !important; }
          `}</style>
        )}
        {children}
      </>
    );
  }

  // <NotificationsBellTrigger> owns unread/visible/error derivations +
  // per-row open/mark-read handlers (`notifications-flyout.tsx`).

  // The /configuration/skills Library tab owns the Recreate-Library action.

  async function purgeAPILogs() {
    setDevelopmentToolsPending(true);
    setDevelopmentToolsMessage(null);

    try {
      const response = await fetch("/api/development/logs", {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Unable to purge API logs.");
      }
      setDevelopmentToolsMessage("API logs purged.");
      router.refresh();
    } catch (error) {
      setDevelopmentToolsMessage(error instanceof Error ? error.message : "Unable to purge API logs.");
    } finally {
      setDevelopmentToolsPending(false);
    }
  }

  async function handleSwitchProvider(provider: "openai" | "anthropic") {
    setLlmProviderPending(true);
    setLlmProviderSaved(false);
    try {
      const res = await fetch("/api/admin/default-llm-provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        setDefaultLlmProvider(provider);
        setLlmProviderSaved(true);
        setTimeout(() => setLlmProviderSaved(false), 2000);
      }
    } catch {
      // Ignore failures silently.
    } finally {
      setLlmProviderPending(false);
    }
  }

  return (
    <NotificationsProvider>
    {/* NotificationsProvider owns the public NotificationContext
        (consumed by useNotify() for form-save toasts) AND the internal flyout
        state machine consumed by <NotificationsBellTrigger /> below.
        It is only provided in the main shell path — bypass/redirect paths
        do not render forms that call useNotify(). */}
    <SidebarProvider>
      <AppSidebar
        connectionReady={connectionReady}
        userAccentColor={userAccentColor}
        singleOrg={singleOrg}
        hiddenNavTitles={hiddenNavTitles}
        isAdmin={isAdmin}
        pendingApprovalsTotal={pendingApprovalsTotal}
      />
      <SidebarInset>
        {/* Spacer: pushes the sticky header (and all page content) into normal flow
            below the impersonation banner so the flow position matches the visual sticky position. */}
        <div aria-hidden style={{ height: "var(--banner-height, 0px)" }} className="shrink-0" />
        <header
          style={{ top: "var(--banner-height, 0px)" }}
          className={cn(
            "sticky z-[140] h-16 w-full border-b border-sidebar-border bg-background/90 backdrop-blur-xl transition-shadow",
            scrollOffset > 10 ? "shadow-sm" : "shadow-none",
          )}
        >
          <div className="flex h-full items-center gap-3 px-4 sm:gap-4 sm:px-6">
            <SidebarTrigger variant="outline" className="max-md:scale-125" />
            <Separator orientation="vertical" className="h-6 shrink-0" />
            <Breadcrumb className="hidden sm:flex">
              <BreadcrumbList>
                {breadcrumbSegments.map((crumb, i) => (
                  <Fragment key={breadcrumbCrumbKey(crumb, i)}>
                    {i > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {crumb.ellipsis ? (
                        <BreadcrumbEllipsis />
                      ) : i === breadcrumbSegments.length - 1 ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : crumb.nonNavigable ? (
                        <span className="font-normal text-muted-foreground">
                          {crumb.label}
                        </span>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link href={crumb.href}>{crumb.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex items-center gap-3">
            {process.env.NODE_ENV === "development" && <Popover open={devToolsOpen} onOpenChange={(open) => {
              setDevToolsOpen(open);
              if (open) {
                void fetch("/api/admin/default-llm-provider", { method: "GET", cache: "no-store" })
                  .then((res) => res.json())
                  .then((data: { provider?: string }) => {
                    if (data.provider) setDefaultLlmProvider(data.provider);
                  })
                  .catch(() => {
                    // Ignore load failures.
                  });
              }
            }}>
              <PopoverTrigger asChild>
                <IconButton
                  aria-label="Open development tools"
                  className="text-warning hover:bg-warning/10 hover:text-warning data-[state=open]:bg-warning/10 data-[state=open]:text-warning"
                >
                  <Wrench className="h-5 w-5 fill-warning/10" />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="z-[200] w-[20rem] rounded-control border border-warning/30 bg-warning/10 p-2 shadow-[0_24px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl">
                <div className="px-3 py-2">
                  <p className="text-sm font-semibold text-warning">Development tools</p>
                </div>
                <div className="px-1 pb-3">
                  <p className="mb-2 px-2 text-xs font-medium text-warning">Default LLM provider</p>
                  <div className="flex gap-2 px-1">
                    {/* Claude deactivated — to re-enable: restore ["openai", "anthropic"] */}
                    {(["openai"] as const).map((id) => (
                      <Button
                        key={id}
                        type="button"
                        variant="outline"
                        disabled={llmProviderPending}
                        onClick={() => void handleSwitchProvider(id)}
                        className={cn(
                          "flex-1 rounded-control border px-3 py-2 text-sm font-medium transition",
                          defaultLlmProvider === id
                            ? "border-foreground bg-foreground text-background"
                            : "border-line bg-surface-muted text-foreground hover:bg-surface-strong",
                        )}
                      >
                        OpenAI
                      </Button>
                    ))}
                  </div>
                  {llmProviderSaved ? (
                    <p className="mt-2 px-2 text-xs text-success">Saved</p>
                  ) : null}
                </div>
                <Separator className="mx-1 my-1 border-warning/20" />
                <div className="px-1 py-2">
                  <p className="mb-2 px-2 text-xs font-medium text-warning">Agent setup</p>
                  <Label className="flex cursor-pointer items-center justify-between rounded-control px-2 py-1.5 hover:bg-warning/15">
                    <span className="text-sm text-warning">Dev stepper view</span>
                    <Switch
                      checked={bypassSetupStepGates}
                      onCheckedChange={(checked) => {
                        setBypassSetupStepGates(checked);
                        window.localStorage.setItem("__cinatra_dev_bypass_step_gates", String(checked));
                        window.dispatchEvent(new StorageEvent("storage", { key: "__cinatra_dev_bypass_step_gates", newValue: String(checked) }));
                      }}
                    />
                  </Label>
                </div>
                <Separator className="mx-1 my-1 border-warning/20" />
                <div className="px-1 py-1">
                  <p className="mb-2 flex items-center gap-1.5 px-2 text-xs font-medium text-warning"><TriangleAlert className="h-3 w-3" /> Purge actions</p>
                  <div className="px-1 pb-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void purgeAPILogs()}
                      disabled={developmentToolsPending}
                      className="w-full justify-between border-destructive/30 bg-destructive/10 font-semibold text-destructive hover:bg-destructive/20 hover:text-destructive"
                    >
                      <span>API logs</span>
                      {developmentToolsPending ? <LoadingSpinner className="h-4 w-4" /> : null}
                    </Button>
                    {developmentToolsMessage ? (
                      <p className={cn("mt-3 px-2 text-sm", developmentToolsMessage === "API logs purged." ? "text-success" : "text-destructive")}>
                        {developmentToolsMessage}
                      </p>
                    ) : null}
                    {/* Development tools intentionally omit the misleadingly named
                        "Skills GitHub repo" button. A "purge" label is misleading for an action that force-pushes
                        LOCAL state up to GitHub (potentially populating, not purging,
                        the remote). The Library-tab Recreate-Library action under
                        /configuration/skills is the correct destination for both
                        local wipe and optional empty-state push. */}
                  </div>
                </div>
                <div className="mt-1 border-t border-warning/20 px-1 pt-1">
                  <Link
                    href="/configuration/development"
                    className="flex w-full items-center rounded-control px-2 py-1.5 text-sm text-warning hover:bg-warning/15 hover:text-warning"
                    onClick={() => setDevToolsOpen(false)}
                  >
                    All development administration →
                  </Link>
                </div>
              </PopoverContent>
            </Popover>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label="Create new">
                  <Plus className="h-5 w-5" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[200] w-44">
                <DropdownMenuItem asChild>
                  <Link href="/chat" className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Start chat
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/agents/run" className="flex items-center gap-2">
                    <Play className="h-4 w-4" />
                    Run agent
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/chat?mode=create-agent" className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    Create agent
                  </Link>
                </DropdownMenuItem>
                {/* Top-bar "Create workflow" item removed (cinatra#609) —
                    redundant with the "Build a workflow" chat badge, which is
                    now the single conversational creation entry point
                    (→ /chat?mode=create-workflow). */}
                {canCreateProjects ? (
                  <DropdownMenuItem asChild>
                    <Link href="/projects/new" className="flex items-center gap-2">
                      <FolderKanban className="h-4 w-4" />
                      Create project
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canCreateTeams ? (
                  <DropdownMenuItem asChild>
                    <Link href="/teams/new" className="flex items-center gap-2">
                      <UsersRound className="h-4 w-4" />
                      Create team
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canCreateOrganizations ? (
                  <DropdownMenuItem
                    className="flex items-center gap-2"
                    onSelect={(event) => {
                      event.preventDefault();
                      setCreateOrganizationOpen(true);
                    }}
                  >
                    <Building2 className="h-4 w-4" />
                    Create organization
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <CreateOrganizationDialog
              open={createOrganizationOpen}
              onOpenChange={setCreateOrganizationOpen}
            />
            <ThemeSwitch />
            {/* Full notification flyout (bell + popover + tabs) */}
            <NotificationsBellTrigger />
            {/* The single home for /configuration access is the Admin sidebar
                group (Admin → Configuration). */}
            </div>
          </div>
        </header>


        <div ref={pageContentRef} className={hideShellPageHeader ? "" : "pb-4"}>
          {activeHeader?.title && !hideShellPageHeader ? (
            <section className="mx-auto mb-2 w-full max-w-7xl px-5 pt-5 text-left sm:px-8">
              {/* Adopt PageHeader's spec h1 className inline. Dynamic
                  shell header for package pages without their own <PageHeader>;
                  activeHeader.title is computed at runtime
                  and the surrounding chrome differs from a normal page mount. */}
              <h1 className="font-display italic font-extrabold leading-[1.05] tracking-[-0.018em] text-balance text-[38px] text-foreground text-left">{activeHeader.title}</h1>
            </section>
          ) : null}
          {children}
        </div>

      </SidebarInset>
    </SidebarProvider>
    </NotificationsProvider>
  );
}
