"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// Height of the banner in pixels — must match the rendered height so the
// sticky app-shell header can offset itself by this amount.
const BANNER_HEIGHT = 24;

export function ImpersonationBanner() {
  const { data, isPending } = authClient.useSession();
  const [isStopping, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isActive = !isPending && !!data?.session?.impersonatedBy;

  // Push the rest of the page down by setting a CSS variable that the
  // sticky app-shell header reads as its `top` offset.
  useEffect(() => {
    if (isActive) {
      document.documentElement.style.setProperty("--banner-height", `${BANNER_HEIGHT}px`);
    } else {
      document.documentElement.style.removeProperty("--banner-height");
    }
    return () => {
      document.documentElement.style.removeProperty("--banner-height");
    };
  }, [isActive]);

  if (!isActive) {
    return null;
  }

  function stopImpersonating() {
    startTransition(async () => {
      setErrorMessage(null);

      try {
        const result = await authClient.admin.stopImpersonating();
        if (result.error) {
          setErrorMessage(result.error.message || "Unable to stop impersonation.");
          return;
        }

        // Full navigation so the session is re-initialised immediately.
        window.location.reload();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to stop impersonation.");
      }
    });
  }

  const displayName = data.user.name?.trim() || data.user.email || data.user.id;

  return (
    // z-[150] sits above the app-shell sticky header (z-[140]) and sidebar (z-[70]).
    <div
      style={{ height: BANNER_HEIGHT }}
      className="fixed inset-x-0 top-0 z-[150] flex w-full items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-4 sm:px-6"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium leading-none text-warning">
        <UserCheck className="h-2.5 w-2.5 shrink-0" />
        <span>
          <Link href="/accounts" className="font-semibold underline-offset-2 hover:underline">{displayName}</Link>
        </span>
        {errorMessage ? <span className="ml-1 text-destructive">{errorMessage}</span> : null}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={stopImpersonating}
        disabled={isStopping}
        className="h-[18px] shrink-0 rounded-full border border-warning/40 bg-warning/15 px-2 text-[9px] font-semibold leading-none text-warning transition hover:bg-warning/25 hover:text-warning disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isStopping ? "Stopping…" : "Stop impersonating"}
      </Button>
    </div>
  );
}
