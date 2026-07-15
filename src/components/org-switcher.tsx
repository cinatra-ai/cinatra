"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { toast } from "@/lib/cinatra-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  listMemberOrganizations,
  type SwitcherOrganizations,
} from "@/components/org-switcher-actions";

type FetchStatus = "idle" | "loading" | "loaded" | "error";

/**
 * Compact active-organization context block for the top of the sidebar
 * (cinatra#1502). Two data tiers, deliberately split:
 *
 *  - Always-visible tier (server): `activeOrgName` is resolved in the root
 *    layout (membership-scoped, per-request cached, fail-soft to null) and
 *    arrives as a prop — the active org is visible before any interaction.
 *  - Lazy tier (client): the member-org list is fetched on FIRST open via the
 *    parameterless `listMemberOrganizations` server action and cached across
 *    open/close; the cache is cleared after a successful switch.
 *
 * Switching goes through Better Auth's own `setActive` endpoint (it
 * re-validates target-org membership server-side) followed by
 * `router.refresh()`, which re-runs the root layout and recomputes the
 * server tier — never a bespoke mutation accepting a client org id.
 *
 * Built from the existing sidebar primitives (the `NavUser` composition:
 * SidebarMenu → DropdownMenu with a size-"lg" SidebarMenuButton trigger)
 * rather than better-auth-ui's `OrganizationSwitcher`: the vendored component
 * hard-wires an organization-settings item and a signed-out sign-in item that
 * props cannot remove, its `hidePersonal` mode auto-selects the first org
 * when none is active (an unwanted session mutation for always-mounted
 * chrome), and its Button-based trigger doesn't participate in the sidebar's
 * collapsed-rail/tooltip behavior.
 */
export function OrgSwitcher({
  activeOrgName,
  canCreateOrganizations = false,
}: {
  /**
   * Server-resolved (membership-scoped) display name of the active
   * organization; null degrades to the fallback trigger label.
   */
  activeOrgName: string | null;
  /**
   * Gates the "Create organization" item — the SAME server-resolved flag that
   * gates the global "+" menu entry (single-org mode already forces it false).
   */
  canCreateOrganizations?: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  const [data, setData] = useState<SwitcherOrganizations | null>(null);
  const [status, setStatus] = useState<FetchStatus>("idle");
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);

  async function loadOrganizations() {
    setStatus("loading");
    try {
      const result = await listMemberOrganizations();
      setData(result);
      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  }

  function handleOpenChange(open: boolean) {
    // Lazy tier: fetch on first open only. The loaded list is cached across
    // open/close; a successful switch clears it (see handleSelect), so the
    // next open refetches against the new session state.
    if (open && status === "idle") void loadOrganizations();
  }

  async function handleSelect(organizationId: string) {
    if (switchingOrgId) return; // a switch is already in flight
    if (organizationId === data?.activeOrganizationId) return; // already active — no-op
    setSwitchingOrgId(organizationId);
    try {
      // Better Auth's own endpoint validates target-org membership
      // server-side. The client result surfaces failures as `error` (not a
      // throw), so check both shapes.
      const result = await authClient.organization.setActive({ organizationId });
      if (result?.error) {
        toast.error("Couldn't switch organization.");
        return;
      }
      // Invalidate the client list cache and recompute the server tier
      // (active-org name + gating flags) in one pass.
      setData(null);
      setStatus("idle");
      router.refresh();
      setOpenMobile(false);
    } catch {
      toast.error("Couldn't switch organization.");
    } finally {
      setSwitchingOrgId(null);
    }
  }

  const organizations = data?.organizations ?? [];
  const isEmpty = status === "loaded" && organizations.length === 0;

  const allOrganizationsLeaf = (
    <DropdownMenuItem asChild data-testid="org-switcher-all">
      <Link href="/organizations" onClick={() => setOpenMobile(false)}>
        All organizations →
      </Link>
    </DropdownMenuItem>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={handleOpenChange}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={activeOrgName ?? "Select organization"}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              data-testid="org-switcher-trigger"
            >
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Building2 className="size-4" />
              </div>
              <div className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-semibold" data-testid="org-switcher-label">
                  {activeOrgName ?? "Select organization"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  Organization
                </span>
              </div>
              <ChevronsUpDown className="ms-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg z-[80]"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Organizations
            </DropdownMenuLabel>
            {status === "idle" || status === "loading" ? (
              <>
                {/* The skeletons are decoration; the sr-only live region is
                    what announces the pending fetch to assistive tech. */}
                <span role="status" aria-live="polite" className="sr-only">
                  Loading organizations
                </span>
                <div data-testid="org-switcher-loading" aria-hidden="true">
                  <SidebarMenuSkeleton />
                  <SidebarMenuSkeleton />
                  <SidebarMenuSkeleton />
                </div>
              </>
            ) : null}
            {status === "error" ? (
              <>
                <span role="alert" className="sr-only">
                  Couldn&apos;t load organizations
                </span>
                <DropdownMenuItem
                  data-testid="org-switcher-retry"
                  className="text-muted-foreground"
                  onSelect={(event) => {
                    // Keep the menu open — retry re-runs the fetch in place so
                    // the list can never wedge in a stuck-loading state.
                    event.preventDefault();
                    void loadOrganizations();
                  }}
                >
                  Couldn&apos;t load — Retry
                </DropdownMenuItem>
              </>
            ) : null}
            {status === "loaded" ? (
              isEmpty ? (
                // Degenerate pre-bootstrap case: no memberships at all — just
                // the leaf to the full list page.
                allOrganizationsLeaf
              ) : (
                <>
                  {organizations.map((org) => (
                    <DropdownMenuItem
                      key={org.id}
                      data-testid={`org-switcher-org-${org.id}`}
                      disabled={switchingOrgId !== null && switchingOrgId !== org.id}
                      onSelect={() => void handleSelect(org.id)}
                      className="gap-2"
                    >
                      <span className="truncate">
                        {org.name || "Untitled organization"}
                      </span>
                      {org.id === data?.activeOrganizationId ? (
                        <Check
                          data-testid="org-switcher-active-check"
                          className="ms-auto size-4 shrink-0"
                        />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  {canCreateOrganizations ? (
                    <DropdownMenuItem asChild data-testid="org-switcher-create">
                      <Link
                        href="/organizations/new"
                        className="gap-2"
                        onClick={() => setOpenMobile(false)}
                      >
                        <Plus className="size-4" />
                        Create organization
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {allOrganizationsLeaf}
                </>
              )
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
