"use client";

import { useContext, useMemo, useState, useEffect } from "react";
import {
  AccountSettingsCards,
  AuthUIContext,
  ChangePasswordCard,
  DeleteAccountCard,
  GoogleIcon,
  PasskeysCard,
  SessionsCard,
  SettingsCard,
  TwoFactorCard,
} from "@daveyplate/better-auth-ui";
import { authClient } from "@/lib/auth-client";
import { SidebarNav } from "@/components/sidebar-nav";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";

// These components must live in the main app to share the same @daveyplate/better-auth-ui
// module instance as AuthUIProvider (pnpm creates separate virtual-store instances per package).

type AccountViewMode = "administration" | "security";

const cardClassNames = {
  base: "border border-line bg-surface backdrop-blur-none rounded-card",
  header: "px-6 pt-6",
  content: "px-6",
  footer: "px-6 pb-6",
};

const sidebarNavItems = [
  { href: "/account", title: "Account" },
  { href: "/account/security", title: "Security" },
];

function AccountNav() {
  return (
    <aside className="mb-6 md:mb-0 md:w-48 lg:w-56">
      <SidebarNav items={sidebarNavItems} />
    </aside>
  );
}

function ProviderBadge({ connected }: { connected: boolean }) {
  return (
    <StatusPill status={connected ? "approved" : "idle"}>
      {connected ? "Connected" : "Not connected"}
    </StatusPill>
  );
}

function GoogleProviderCard() {
  const { hooks, mutators } = useContext(AuthUIContext);
  const { data: accounts, refetch } = hooks.useListAccounts();
  const account = accounts?.find((a) => a.providerId === "google");
  const connected = Boolean(account);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClick() {
    if (pending) return;
    setPending(true);
    setErrorMessage(null);
    const callbackURL = `${window.location.origin}/account/security`;
    try {
      if (account) {
        await mutators.unlinkAccount({ accountId: account.accountId, providerId: "google" });
        await refetch?.();
      } else {
        await authClient.linkSocial({
          provider: "google",
          callbackURL,
          scopes: ["openid", "email", "profile"],
          fetchOptions: { throw: true },
        });
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unable to update Google.");
      setPending(false);
      return;
    }
    setPending(false);
  }

  return (
    <SettingsCard
      title="Sign-in provider"
      description="Manage the Google identity linked to your account sign-in."
      classNames={cardClassNames}
    >
      <div className="grid gap-4 px-6">
        <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface-muted text-foreground">
            <GoogleIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <p className="truncate text-sm font-semibold text-foreground">Google sign-in</p>
              <ProviderBadge connected={connected} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {connected
                ? "Your Google sign-in identity is linked to this account."
                : "Link a Google identity for sign-in to this account."}
            </p>
          </div>
          <div className="shrink-0">
            <Button
              type="button"
              onClick={handleClick}
              disabled={pending}
              variant={connected ? "outline" : "default"}
            >
              {pending ? "Opening..." : connected ? "Unlink" : "Connect"}
            </Button>
          </div>
        </div>
        {errorMessage ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}

function SecurityCards() {
  const { credentials, deleteUser, hooks, passkey, twoFactor } = useContext(AuthUIContext);
  const { data: accounts } = hooks.useListAccounts();
  const credentialsLinked = useMemo(
    () => accounts?.some((a) => a.providerId === "credential") ?? false,
    [accounts],
  );

  return (
    <>
      {credentials ? <ChangePasswordCard classNames={cardClassNames} /> : null}
      {twoFactor && credentialsLinked ? <TwoFactorCard classNames={cardClassNames} /> : null}
      <GoogleProviderCard />
      {passkey ? <PasskeysCard classNames={cardClassNames} /> : null}
      <SessionsCard classNames={cardClassNames} />
      {deleteUser ? <DeleteAccountCard classNames={cardClassNames} /> : null}
    </>
  );
}

export function AccountViewClient({ view }: { view: AccountViewMode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
      <AccountNav />
      {view === "administration" ? (
        <AccountSettingsCards
          className="min-w-0 flex-1 grid grid-cols-1 md:grid-cols-2"
          classNames={{ card: cardClassNames }}
        />
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          <SecurityCards />
        </div>
      )}
    </div>
  );
}
