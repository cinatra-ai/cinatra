"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import NangoFrontend from "@nangohq/frontend";
import { Check } from "lucide-react";
import { AppDialog } from "./app-dialog";
import { Button } from "./ui/button";
import { StatusPill } from "./status-pill";
import type { StatusPillStatus } from "./status-pill";
import type { NangoFrontendConfig } from "./nango-user-connect-button";

// Host-pure managed-API connect card. Data arrives via props; `connectorKey` is `string`.

type NangoManagedApiCardProps = {
  connectorKey: string;
  title: string;
  description?: string;
  badge?: string;
  badgeTone?: "connected" | "warning" | "neutral";
  isConnected?: boolean;
  detail?: string;
  usesConnectUI: boolean;
  manageHref?: string;
  reconnectConnectionId?: string;
  nangoFrontendConfig?: NangoFrontendConfig;
  connectionServiceReady?: boolean;
  prerequisiteErrorMessage?: string;
  children?: ReactNode;
  connectLabel?: string;
  reconnectLabel?: string;
  naked?: boolean;
  icon?: ReactNode;
  /** When true, clicking the whole card triggers the Nango connect flow (no interior button rendered). */
  clickToConnect?: boolean;
};

export function NangoManagedApiCard(props: NangoManagedApiCardProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [prerequisiteModalOpen, setPrerequisiteModalOpen] = useState(false);
  const connectionServiceReady = props.connectionServiceReady ?? Boolean(props.nangoFrontendConfig?.apiURL);

  // Map the connection badge tone to the canonical StatusPill status (never
  // hand-roll a status pill with raw color classes).
  const badgeStatus: StatusPillStatus =
    props.badgeTone === "connected" ? "approved" : props.badgeTone === "warning" ? "hold" : "idle";

  const buttonLabel = pending
    ? "Opening connection..."
    : !connectionServiceReady
      ? "Configure connection service"
      : props.isConnected
        ? (props.reconnectLabel ?? "Reconnect")
        : (props.connectLabel ?? "Connect");

  async function handleConnect() {
    if (!props.usesConnectUI || pending) {
      return;
    }

    if (!connectionServiceReady) {
      // The Environment "Connections" tab is dev-only, so it is NOT a valid
      // target in production (cinatra#66). /setup/connections is the
      // canonical, mode-independent connection-service setup page — the
      // setup wizard surfaces it whenever the service is not connected.
      router.push("/setup/connections");
      return;
    }

    if (props.prerequisiteErrorMessage) {
      setPrerequisiteModalOpen(true);
      return;
    }

    setPending(true);
    setErrorMessage(null);

    try {
      const nangoFrontend = new NangoFrontend();
      let connectUiClosed = false;
      const connect = nangoFrontend.openConnectUI({
        ...(props.nangoFrontendConfig?.baseURL ? { baseURL: props.nangoFrontendConfig.baseURL } : {}),
        ...(props.nangoFrontendConfig?.apiURL ? { apiURL: props.nangoFrontendConfig.apiURL } : {}),
        onEvent: async (event) => {
          if (event.type === "connect") {
            await fetch("/api/nango/connections/save", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                connectorKey: props.connectorKey,
                providerConfigKey: event.payload.providerConfigKey,
                connectionId: event.payload.connectionId,
              }),
            }).then(async (response) => {
              if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                throw new Error(payload?.error ?? "Unable to save the connection.");
              }
            });
            if (!connectUiClosed) {
              connect.close();
              connectUiClosed = true;
            }
            setPending(false);
            router.refresh();
          }

          if (event.type === "error") {
            setPending(false);
            setErrorMessage(event.payload.errorMessage || "Authorization failed.");
          }

          if (event.type === "close") {
            connectUiClosed = true;
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
          connectorKey: props.connectorKey,
          reconnectConnectionId: props.reconnectConnectionId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { sessionToken?: string; error?: string } | null;
      if (!response.ok || !payload?.sessionToken) {
        throw new Error(payload?.error ?? "Unable to start the connection flow.");
      }

      connect.setSessionToken(payload.sessionToken);
    } catch (error) {
      setPending(false);
      setErrorMessage(error instanceof Error ? error.message : "Unable to open the connection flow.");
    }
  }

  const cardClassName = "group flex flex-col gap-4 rounded-card border border-line bg-surface p-5 shadow-sm block transition hover:border-foreground/30 hover:bg-surface-muted";

  const cardContent = (
    <>
      <AppDialog open={prerequisiteModalOpen} onOpenChange={setPrerequisiteModalOpen} maxWidth="max-w-md">
        <div className="flex items-start gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">Setup required</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Configure Google OAuth first</h2>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          {props.prerequisiteErrorMessage}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Link
            href="/configuration/llm/gmail"
            className="rounded-control bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/80"
          >
            Open Google OAuth
          </Link>
        </div>
      </AppDialog>

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          {props.icon ? (
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control border border-line bg-surface text-foreground">
              {props.icon}
            </div>
          ) : null}
          {props.badge ? <StatusPill status={badgeStatus}>{props.badge}</StatusPill> : null}
        </div>
        <div>
          <p className="text-base font-semibold text-foreground">{props.title}</p>
          {props.description ? <p className="mt-1 text-sm text-muted-foreground">{props.description}</p> : null}
          {props.detail ? <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p> : null}
        </div>
      </div>

      {errorMessage ? (
        <div className="mt-4 rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</div>
      ) : null}

      {props.usesConnectUI && !props.manageHref && !props.clickToConnect ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            type="button"
            variant={props.isConnected && connectionServiceReady ? "outline" : "default"}
            onClick={handleConnect}
            disabled={pending}
          >
            <span className="inline-flex items-center gap-1.5">
              {props.isConnected && connectionServiceReady ? <Check data-icon="inline-start" aria-hidden="true" /> : null}
              {buttonLabel}
            </span>
          </Button>
        </div>
      ) : null}

      {props.children}
    </>
  );

  if (props.manageHref) {
    return (
      <Link href={props.manageHref} className={cardClassName}>
        {cardContent}
      </Link>
    );
  }

  if (props.clickToConnect && props.usesConnectUI) {
    return (
      <Button type="button" onClick={handleConnect} disabled={pending} className={`${cardClassName} w-full text-left disabled:opacity-70`}>
        {cardContent}
      </Button>
    );
  }

  if (props.naked) {
    return <div>{cardContent}</div>;
  }

  return <div className={cardClassName}>{cardContent}</div>;
}
