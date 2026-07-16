"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// ConfigurationTopbarCog (cinatra#1563)
//
// The single discoverability entry point to `/configuration`, moved out of the
// left sidebar's former "Admin" group into the top-bar control row. Rendered
// immediately to the LEFT of the notifications bell (DOM / keyboard order:
// cog → bell) and ONLY for platform admins.
//
// Discoverability, NOT the security boundary: `/configuration` (and every
// descendant) stays server-side admin-gated via requireAdminSession(). Hiding
// the cog for non-admins never weakens or replaces that check — a non-admin who
// deep-links to `/configuration` is still rejected server-side.
//
// Chrome parity: matches the bell's control-row treatment exactly — a ghost,
// icon-sized, rounded-full button wrapping a link, with an h-5 w-5 glyph — so
// sizing / spacing / hover read identically to its neighbour. Self-contained
// TooltipProvider (same pattern as ExtensionCompatBadge) so it renders correctly
// without depending on an ancestor provider.
//
// Active state (a11y): reflects the current route with aria-current="page" when
// the path is exactly `/configuration` OR any `/configuration/...` descendant —
// which naturally includes the surviving configuration-namespaced approvals
// detail route. Carries an accessible name + tooltip and real link semantics.
// ---------------------------------------------------------------------------

/** True when `pathname` is `/configuration` or one of its descendants. */
export function isConfigurationActive(pathname: string): boolean {
  return pathname === "/configuration" || pathname.startsWith("/configuration/");
}

export function ConfigurationTopbarCog({
  isAdmin,
}: {
  isAdmin: boolean;
}): React.ReactElement | null {
  const pathname = usePathname();
  // Discoverability gate only — the server-side requireAdminSession() gate on
  // /configuration is the actual boundary and is unaffected by this.
  if (!isAdmin) return null;

  const active = isConfigurationActive(pathname);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon" className="rounded-full">
            <Link
              href="/configuration"
              aria-label="Configuration"
              aria-current={active ? "page" : undefined}
              data-testid="topbar-configuration-cog"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Configuration</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
