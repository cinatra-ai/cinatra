"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import NangoFrontend from "@nangohq/frontend";
import type { ConnectUI } from "@nangohq/frontend";
import { StatusPill } from "./status-pill";
import { Button } from "./ui/button";

// Host-pure Nango connect UI primitives — connectors depend only on the SDK. All host
// data arrives via props; `connectorKey` is `string` (the SDK does not import the
// host connector-roster union). The two fetch endpoints are stable host API
// routes; the host page owns the data (Nango frontend config / connection state).

export type NangoFrontendConfig = {
  apiURL?: string;
  baseURL?: string;
};

type NangoUserConnectButtonProps = {
  connectorKey: string;
  reconnectConnectionId?: string;
  connected?: boolean;
  connectLabel?: string;
  reconnectLabel?: string;
  nangoFrontendConfig?: NangoFrontendConfig;
  className?: string;
  prerequisiteErrorMessage?: string;
  onError?: (message: string) => void;
  onClickOverride?: () => void | Promise<void>;
};

type NangoUserConnectState = {
  pending: boolean;
  openConnection: () => Promise<void>;
};

function useNangoUserConnect({
  connectorKey,
  reconnectConnectionId,
  nangoFrontendConfig,
  prerequisiteErrorMessage,
  onError,
}: Pick<
  NangoUserConnectButtonProps,
  "connectorKey" | "reconnectConnectionId" | "prerequisiteErrorMessage" | "onError" | "nangoFrontendConfig"
> & {
  nangoFrontendConfig?: NangoFrontendConfig;
}): NangoUserConnectState {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (pending) {
      return;
    }

    if (prerequisiteErrorMessage) {
      onError?.(prerequisiteErrorMessage);
      return;
    }

    setPending(true);
    onError?.("");

    // Hoisted so the catch blocks below can close the Connect UI iframe.
    // openConnectUI() mounts a full-viewport modal (skeleton loaders) BEFORE a
    // session token exists; without close() on the failure paths the modal is
    // orphaned: it spins forever and keeps body scroll locked (#48).
    // ConnectUI.close() is idempotent and safe to call before a token is set.
    let connect: ConnectUI | undefined;
    try {
      const nangoFrontend = new NangoFrontend();
      connect = nangoFrontend.openConnectUI({
        ...(nangoFrontendConfig?.baseURL ? { baseURL: nangoFrontendConfig.baseURL } : {}),
        ...(nangoFrontendConfig?.apiURL ? { apiURL: nangoFrontendConfig.apiURL } : {}),
        onEvent: async (event) => {
          if (event.type === "connect") {
            // This callback is invoked as `void onEvent(event)` by
            // @nangohq/frontend — a thrown error would become an unhandled
            // rejection and orphan the modal, so failures must be handled here.
            try {
              const response = await fetch("/api/nango/connections/save", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  connectorKey,
                  providerConfigKey: event.payload.providerConfigKey,
                  connectionId: event.payload.connectionId,
                  scope: "user",
                }),
              });

              if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                throw new Error(payload?.error ?? "Unable to save the connection.");
              }

              connect?.close();
              setPending(false);
              router.refresh();
            } catch (error) {
              connect?.close();
              setPending(false);
              onError?.(error instanceof Error ? error.message : "Unable to save the connection.");
            }
          }

          if (event.type === "error") {
            setPending(false);
            onError?.(event.payload.errorMessage || "Authorization failed.");
          }

          if (event.type === "close") {
            setPending(false);
          }
        },
      });

      const response = await fetch("/api/nango/connect/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectorKey,
          reconnectConnectionId,
          scope: "user",
        }),
      });
      const payload = (await response.json().catch(() => null)) as { sessionToken?: string; error?: string } | null;
      if (!response.ok || !payload?.sessionToken) {
        throw new Error(payload?.error ?? "Unable to start the connection flow.");
      }

      connect.setSessionToken(payload.sessionToken);
    } catch (error) {
      // Close the orphaned Connect UI so the error is actually visible
      // (programmatic close() does not emit a "close" event, so pending is
      // cleared here explicitly).
      connect?.close();
      setPending(false);
      onError?.(error instanceof Error ? error.message : "Unable to open the connection flow.");
    }
  }

  return {
    pending,
    openConnection: handleClick,
  };
}

export function NangoUserConnectButton({
  connectorKey,
  reconnectConnectionId,
  connected = false,
  connectLabel = "Connect",
  reconnectLabel = "Reconnect",
  nangoFrontendConfig,
  className,
  prerequisiteErrorMessage,
  onError,
  onClickOverride,
}: NangoUserConnectButtonProps) {
  // Fallback error surface: no call site is required to pass `onError`, and a
  // connect-session failure must still be visible once the orphaned Connect UI
  // is closed (#48). Used only when the caller does not supply `onError`.
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const { pending, openConnection } = useNangoUserConnect({
    connectorKey,
    reconnectConnectionId,
    nangoFrontendConfig,
    prerequisiteErrorMessage,
    onError: onError ?? ((message) => setFallbackError(message || null)),
  });

  const button = (
    <Button
      type="button"
      onClick={() => {
        if (onClickOverride) {
          void onClickOverride();
          return;
        }
        void openConnection();
      }}
      disabled={pending}
      className={className}
    >
      {pending ? "Opening..." : connected ? reconnectLabel : connectLabel}
    </Button>
  );

  if (onError) {
    return button;
  }

  return (
    <div className="inline-flex flex-col items-start gap-2">
      {button}
      {fallbackError ? <p className="text-sm text-destructive">{fallbackError}</p> : null}
    </div>
  );
}

type NangoUserConnectCardProps = Pick<
  NangoUserConnectButtonProps,
  "connectorKey" | "reconnectConnectionId" | "connected" | "nangoFrontendConfig" | "prerequisiteErrorMessage"
> & {
  title: string;
  icon: ReactNode;
  subtitle?: string;
  className?: string;
  onClickOverride?: () => void | Promise<void>;
};

export function NangoUserConnectCard({
  connectorKey,
  reconnectConnectionId,
  connected = false,
  nangoFrontendConfig,
  prerequisiteErrorMessage,
  title,
  subtitle,
  icon,
  className,
  onClickOverride,
}: NangoUserConnectCardProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { pending, openConnection } = useNangoUserConnect({
    connectorKey,
    reconnectConnectionId,
    nangoFrontendConfig,
    prerequisiteErrorMessage,
    onError: (message) => setErrorMessage(message || null),
  });

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        if (onClickOverride) {
          void onClickOverride();
          return;
        }
        void openConnection();
      }}
      disabled={pending}
      className={
        className ??
        "group flex h-full w-full flex-col justify-between rounded-card border border-line bg-surface-strong p-6 text-left transition hover:border-primary hover:shadow-strong disabled:cursor-wait disabled:opacity-80 h-auto items-stretch whitespace-normal"
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-control border border-line bg-surface-muted text-foreground">
          {icon}
        </div>
        <StatusPill status={connected ? "approved" : "idle"}>
          {connected ? "Connected" : "Not connected"}
        </StatusPill>
      </div>
      <div className="mt-6">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {subtitle ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{subtitle}</p> : null}
        {errorMessage ? <p className="mt-3 text-sm text-destructive">{errorMessage}</p> : null}
      </div>
    </Button>
  );
}
