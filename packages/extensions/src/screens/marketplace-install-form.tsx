"use client";

// MarketplaceInstallForm — graceful client wrapper for the marketplace
// Install/Update/Restore CTAs (#356).
//
// WHY THIS EXISTS: the marketplace lifecycle form actions
// (installExtensionPackageFormAction / updateExtensionPackageFormAction /
// restoreExtensionPackageFormAction) redirect() on success and THROW on
// failure. Rendered as a plain server-action `<form action={boundAction}>`
// inside the (server) marketplace screen, a thrown failure had no error
// boundary (no app/configuration/marketplace/error.tsx) and surfaced as a
// full-page Next.js Runtime Error. A failed install for ANY reason (the
// @cinatra-ai/* package not present in the connected registry → 404, the
// registry being unreachable, a DB/auth race on restore) took down the route.
//
// This "use client" wrapper moves the form action into a client function so a
// failure becomes a catchable rejected promise: we surface a friendly,
// operation-specific toast instead of crashing the page. The success path is
// preserved verbatim — the action's redirect() throws a NEXT_REDIRECT sentinel
// which we re-throw so Next.js performs the navigation. Mirrors the established
// local idioms in src/app/configuration/development/save-development-form.tsx
// (redirect-sentinel re-throw) and extension-row-actions.tsx (friendly
// toast.error on a masked server-action failure).

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import { isRedirectError } from "./is-redirect-error";

type MarketplaceInstallFormProps = {
  /** Bound lifecycle form action (install/update/restore) — redirects on success, throws on failure. */
  action: () => Promise<void>;
  /** Friendly, operation-specific error copy shown via toast when the action fails. */
  failureMessage: string;
  className?: string;
  children: ReactNode;
};

export function MarketplaceInstallForm({
  action,
  failureMessage,
  className,
  children,
}: MarketplaceInstallFormProps) {
  async function handleSubmit() {
    try {
      await action();
    } catch (error) {
      // Success path: redirect() sentinel — re-throw so Next.js navigates.
      if (isRedirectError(error)) throw error;
      // Real failure (registry 404 / unreachable / lifecycle error): the raw
      // server-action message is masked in production builds, so show friendly,
      // operation-specific copy instead of crashing the route.
      toast.error(failureMessage);
    }
  }

  return (
    <form action={handleSubmit} className={className}>
      {children}
    </form>
  );
}

// Pending-aware submit button. useFormStatus reads the enclosing
// <MarketplaceInstallForm> submission state so the button disables + shows a
// busy label during install — preventing the double-submit a plain
// server-action submit allowed.
type MarketplaceInstallSubmitProps = {
  children: ReactNode;
  pendingLabel: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
};

export function MarketplaceInstallSubmit({
  children,
  pendingLabel,
  className,
  variant,
}: MarketplaceInstallSubmitProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending} className={className}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
