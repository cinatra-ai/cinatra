"use client";

// next-themes renders an inline <script> to prevent theme flicker. React 19
// warns about script tags inside client components; the warning is a false
// positive — the script runs correctly during SSR. Guard with typeof window so
// this only patches the browser console, not the server's Node.js console
// (which Next.js 16.2+ relays to the browser overlay via browserToTerminal).
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("Encountered a script tag")) return;
    orig.apply(console, args);
  };
}

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "@/lib/cinatra-toast";
import { UndoToastHost } from "@/components/data-safety/undo-toast";
import { ThemeProvider } from "next-themes";
import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import { ImpersonationBanner } from "@cinatra-ai/permissions";
import { authClient } from "@/lib/auth-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SearchProvider } from "@/context/search-provider";
import { FieldRendererInit } from "./field-renderer-init";

export function Providers({
  children,
  googleEnabled,
}: {
  children: ReactNode;
  googleEnabled: boolean;
}) {
  const router = useRouter();

  return (
    <ThemeProvider attribute="class" defaultTheme="cinatra" themes={["cinatra", "dark"]} disableTransitionOnChange>
    <FieldRendererInit />
    <TooltipProvider>
    <SearchProvider>
    <AuthUIProvider
      authClient={authClient}
      changeEmail
      credentials={{
        confirmPassword: true,
        forgotPassword: true,
        passwordValidation: {
          minLength: 7,
        },
        username: true,
        usernameRequired: true,
      }}
      twoFactor={["totp"]}
      social={googleEnabled ? { providers: ["google"] } : undefined}
      account={{ basePath: "/accounts", fields: ["name"] }}
      organization={{
        basePath: "/configuration/workspace",
        pathMode: "default",
      }}
      toast={({ variant, message }) => {
        if (!message) return;
        if (variant === "error") toast.error(message);
        else if (variant === "success") toast.success(message);
        else if (variant === "warning") toast.warning(message);
        else toast(message);
      }}
      navigate={(href) => router.push(href)}
      replace={(href) => router.replace(href)}
      onSessionChange={() => {
        router.refresh();
      }}
      Link={({ href, ...props }) => (
        <Link href={href === "/configuration/workspace/settings" ? "/configuration/workspace" : href} {...props} />
      )}
    >
      <ImpersonationBanner />
      {children}
      <Toaster richColors position="top-right" closeButton duration={8000} />
      {/* app-shell host so the data-safety "Saved … [Undo]" toast is
          available app-wide. */}
      <UndoToastHost />
    </AuthUIProvider>
    </SearchProvider>
    </TooltipProvider>
    </ThemeProvider>
  );
}
