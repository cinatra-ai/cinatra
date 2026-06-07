"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LinkIcon, MailIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";

import {
  cancelRemoteRequestAction,
  disconnectLocalRegistryAction,
  disconnectRemoteRegistryAction,
  pollRemoteRequestNowAction,
  requestRemoteAccessAction,
  resetRemoteRegistryAction,
  setLocalRegistryAction,
} from "./actions";
import { DEFAULT_LOCAL_REGISTRY_URL, REMOTE_REGISTRY_URL } from "./constants";

type LocalState = {
  configured: boolean;
  url: string | null;
  tokenUpdatedAt: string | null;
};

type RemoteState = {
  state:
    | "not_connected"
    | "pending"
    | "connected"
    | "denied"
    | "expired"
    | "error";
  url: string;
  namespace?: string | null;
  contactEmail?: string | null;
  requestedAt?: string | null;
  expiresAt?: string | null;
  tokenUpdatedAt?: string | null;
  denyReason?: string | null;
  terminalReason?: string | null;
};

type Props = {
  instanceNamespace: string;
  local: LocalState;
  remote: RemoteState;
  defaultContactEmail?: string | null;
  ok?: string | null;
  error?: string | null;
};

function maskToken(): string {
  return "••••••••••••";
}

function StatusMessage({ kind, message }: { kind: "ok" | "error"; message: string }) {
  if (kind === "error") {
    return (
      <Alert variant="destructive" className="rounded-control">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success" className="rounded-control">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

type FlashChannel = "local" | "remote";
type Flash = { kind: "ok" | "error"; message: string; channel: FlashChannel };

const REMOTE_OK_CODES = new Set([
  "requested",
  "cancelled",
  "connected",
  "remote-disconnected",
  "requested-reset",
]);
const REMOTE_ERROR_CODES = new Set([
  "namespace_taken",
  "request_in_flight",
  "idempotency_conflict",
  "registry_unreachable",
  "nango_unavailable",
]);

function resolveFlash(ok: string | null, error: string | null): Flash | null {
  if (error) {
    return {
      kind: "error",
      message: translateError(error),
      channel: REMOTE_ERROR_CODES.has(error) ? "remote" : "local",
    };
  }
  if (!ok) return null;
  const channel: FlashChannel = REMOTE_OK_CODES.has(ok) ? "remote" : "local";
  switch (ok) {
    case "local-saved":
      return { kind: "ok", channel, message: "Local registry connection saved." };
    case "local-disconnected":
      return { kind: "ok", channel, message: "Local registry disconnected." };
    case "requested":
      return { kind: "ok", channel, message: "Public registry access request submitted." };
    case "cancelled":
      return { kind: "ok", channel, message: "Public registry request cancelled." };
    case "connected":
      return { kind: "ok", channel, message: "Public registry connected." };
    case "remote-disconnected":
      return { kind: "ok", channel, message: "Public registry disconnected." };
    case "requested-reset":
      return {
        kind: "ok",
        channel,
        message:
          "Previous request cleared. Submit a new application to try again.",
      };
    default:
      return null;
  }
}

// Error code translation provides operator-readable copy for the five
// `?error=` codes from the polling flow.
function translateError(code: string): string {
  switch (code) {
    case "namespace_taken":
      return "This namespace is already registered. Contact the registry admin if you believe this is in error.";
    case "request_in_flight":
      return "A request is already pending for this namespace.";
    case "idempotency_conflict":
      return "An identical request is already in flight; please refresh the page.";
    case "registry_unreachable":
      return "The registry is unreachable; please try again.";
    case "nango_unavailable":
      return "Local credential storage is not configured; ask an operator. The registry has accepted your request — once Nango is configured, retry the same form within 24h to receive the same approval link.";
    default:
      return code;
  }
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 19).replace("T", " ") + "Z";
}

// ----------------------------------------------------------------------------
// Top-level dispatch
// ----------------------------------------------------------------------------

export function NetworkStateClient(props: Props) {
  const flash = resolveFlash(props.ok ?? null, props.error ?? null);
  const localFlash = flash?.channel === "local" ? flash : null;
  const remoteFlash = flash?.channel === "remote" ? flash : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        {localFlash ? (
          <StatusMessage kind={localFlash.kind} message={localFlash.message} />
        ) : null}
        <LocalRegistryCard local={props.local} />
      </div>
      <div className="flex flex-col gap-3">
        {remoteFlash ? (
          <StatusMessage kind={remoteFlash.kind} message={remoteFlash.message} />
        ) : null}
        <RemoteRegistryCard remote={props.remote} defaultContactEmail={props.defaultContactEmail ?? null} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Local registry card — operator enters URL + credential, saves. Two states.
// ----------------------------------------------------------------------------

function LocalRegistryCard({
  local,
}: {
  local: LocalState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Local registry</CardTitle>
        <CardAction>
          {local.configured ? (
            <StatusPill status="approved">Connected</StatusPill>
          ) : (
            <StatusPill status="idle">Not configured</StatusPill>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Connect to a private registry you control.
        </p>

        <form action={setLocalRegistryAction} className="mt-6 flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="local-url">Registry URL</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <LinkIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="local-url"
                name="url"
                type="url"
                required
                defaultValue={local.url ?? DEFAULT_LOCAL_REGISTRY_URL}
                placeholder={DEFAULT_LOCAL_REGISTRY_URL}
              />
            </InputGroup>
          </Field>
          <div className="flex flex-col gap-2">
            <Label htmlFor="local-token">Token</Label>
            <Input
              id="local-token"
              name="token"
              type="password"
              required={!local.configured}
              autoComplete="off"
              placeholder={local.configured ? maskToken() : "Paste the registry token"}
            />
            <p className="text-xs text-muted-foreground">
              {local.configured
                ? "Manually configured here. Paste a new token only when replacing it."
                : "Not configured yet. Paste a token manually to connect."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit">{local.configured ? "Save changes" : "Connect"}</Button>
            {local.configured ? (
              <Button type="submit" variant="destructive" form="disconnect-local-registry">
                Disconnect
              </Button>
            ) : null}
          </div>
        </form>
        {local.configured ? <form id="disconnect-local-registry" action={disconnectLocalRegistryAction} /> : null}
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Remote registry (Public registry) card — 6-state polling flow.
//
// Dispatch on:
//   not_connected | pending | connected | denied | expired | error
// The npm credential never crosses to the browser: there is no inline
// credential-entry form, and the connected view masks token state instead of
// exposing the secret. Terminal-state views (denied / expired / error) share
// `RemoteResetCta`, wired to `resetRemoteRegistryAction`.
// ----------------------------------------------------------------------------

function RemoteRegistryCard({
  remote,
  defaultContactEmail,
}: {
  remote: RemoteState;
  defaultContactEmail: string | null;
}) {
  if (remote.state === "connected") {
    return <RemoteConnectedView remote={remote} />;
  }
  if (remote.state === "pending") {
    return <RemotePendingView remote={remote} />;
  }
  if (remote.state === "denied") {
    return <RemoteDeniedView remote={remote} />;
  }
  if (remote.state === "expired") {
    return <RemoteExpiredView remote={remote} />;
  }
  if (remote.state === "error") {
    return <RemoteErrorView remote={remote} />;
  }
  return <RemoteNotConnectedView remote={remote} defaultContactEmail={defaultContactEmail} />;
}

function RemoteNotConnectedView({
  remote,
  defaultContactEmail,
}: {
  remote: RemoteState;
  defaultContactEmail: string | null;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="idle">Not connected</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Connect to the public registry to install third-party extensions and to share your extensions on the marketplace.
          Submit the form and the registry will review your request. When approved, this Cinatra instance connects
          automatically — the registry emails the contact address with a status notice (no credentials are sent by email).
        </p>

        <form action={requestRemoteAccessAction} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="remote-url">Registry URL</Label>
            <Input
              id="remote-url"
              value={REMOTE_REGISTRY_URL}
              disabled
              aria-disabled
              className="bg-surface-muted"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="remote-token">Token</Label>
            <Input
              id="remote-token"
              type="password"
              value=""
              readOnly
              disabled
              aria-disabled
              className="bg-surface-muted"
            />
            <p className="text-xs text-muted-foreground">
              The token is issued by the public registry after approval and cannot be entered manually.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor="remote-contact-email">Contact email</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <MailIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="remote-contact-email"
                name="contactEmail"
                type="email"
                required
                defaultValue={remote.contactEmail ?? defaultContactEmail ?? ""}
                placeholder="admin@example.com"
                autoComplete="email"
              />
            </InputGroup>
            <FieldDescription>
              The token will be emailed to this address once approved.
            </FieldDescription>
          </Field>
          <Button type="submit" className="self-start">
            Apply for access
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RemotePendingView({
  remote,
}: {
  remote: RemoteState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="scheduled">Pending</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Your request is under review. When approved, this Cinatra instance
          connects automatically — no further action needed. The registry will
          email <span className="font-mono">{remote.contactEmail ?? "the contact address"}</span>{" "}
          with a status notice (no credentials are sent by email).
        </p>

        <dl className="mt-4 grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Registry URL</dt>
          <dd className="font-mono text-foreground">{remote.url}</dd>
          <dt className="text-muted-foreground">Contact email</dt>
          <dd className="text-foreground">{remote.contactEmail ?? "—"}</dd>
          <dt className="text-muted-foreground">Requested at</dt>
          <dd className="text-foreground">{formatTimestamp(remote.requestedAt)}</dd>
          <dt className="text-muted-foreground">Expires at</dt>
          <dd className="text-foreground">{formatTimestamp(remote.expiresAt)}</dd>
        </dl>

        <div className="mt-6 flex items-center gap-3">
          <RefreshStatusButton />
          <form action={cancelRemoteRequestAction}>
            <Button type="submit" variant="outline">
              Cancel request
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

// Refresh-status is locked to the client-side refresh path. A server-action
// variant would require changing `actions.ts`, so this stays inline. This is
// the only "use client" boundary in this flow; the file already had
// `"use client"` at the top because LocalRegistryCard uses useState.
function RefreshStatusButton() {
  return (
    <form action={pollRemoteRequestNowAction}>
      <Button type="submit" variant="outline">
        Refresh status
      </Button>
    </form>
  );
}

function RemoteConnectedView({
  remote,
}: {
  remote: RemoteState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="approved">Connected</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>

      <div className="mt-4 flex max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="remote-connected-url">Registry URL</Label>
          <Input
            id="remote-connected-url"
            value={remote.url}
            readOnly
            disabled
            aria-disabled
            className="bg-surface-muted"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="remote-connected-token">Token</Label>
          <Input
            id="remote-connected-token"
            type="password"
            value={maskToken()}
            readOnly
            disabled
            aria-disabled
            className="bg-surface-muted"
          />
        </div>
      </div>

      <form action={disconnectRemoteRegistryAction} className="mt-6">
        <Button type="submit" variant="outline">
          Disconnect
        </Button>
      </form>
      </CardContent>
    </Card>
  );
}

function RemoteDeniedView({
  remote,
}: {
  remote: RemoteState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="declined">Denied</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          {remote.denyReason ?? "Your request was denied."}
        </p>

        <dl className="mt-4 grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Contact email</dt>
          <dd className="text-foreground">{remote.contactEmail ?? "—"}</dd>
        </dl>

        <div className="mt-6">
          <RemoteResetCta />
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteExpiredView({
  remote,
}: {
  remote: RemoteState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="failed">Expired</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Your request expired before approval. Submit a new request to try again.
        </p>

        <dl className="mt-4 grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Expired at</dt>
          <dd className="text-foreground">{formatTimestamp(remote.expiresAt)}</dd>
        </dl>

        <div className="mt-6">
          <RemoteResetCta />
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteErrorView({
  remote,
}: {
  remote: RemoteState;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Public registry</CardTitle>
        <CardAction>
          <StatusPill status="failed">Error</StatusPill>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-destructive">
          {remote.terminalReason ?? "An error occurred."}
        </p>
        <div className="mt-6">
          <RemoteResetCta />
        </div>
      </CardContent>
    </Card>
  );
}

// Shared CTA wired to `resetRemoteRegistryAction`.
// Action enforces admin gate, no-ops on non-terminal states, idempotently
// cleans up Nango credentials, and resets the slot to `not_connected`.
function RemoteResetCta() {
  return (
    <form action={resetRemoteRegistryAction}>
      <Button type="submit" variant="outline">
        Submit a new request
      </Button>
    </form>
  );
}
