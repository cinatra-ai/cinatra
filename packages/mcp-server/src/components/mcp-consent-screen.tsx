"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type OAuthClientSummary = {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  redirect_uris: string[];
  scope?: string;
  type?: "web" | "native" | "user-agent-based";
  token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
};

function parseScopes(queryString: string) {
  const scope = new URLSearchParams(queryString).get("scope");
  if (!scope) {
    return [];
  }

  return scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  if ("message" in payload && typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  if (
    "error_description" in payload &&
    typeof payload.error_description === "string" &&
    payload.error_description.length > 0
  ) {
    return payload.error_description;
  }

  return fallback;
}

export function McpConsentScreen(props: {
  authBasePath: string;
  client: OAuthClientSummary | null;
  fallbackHref: string;
  queryString: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestedScopes = useMemo(() => parseScopes(props.queryString), [props.queryString]);
  const clientName = props.client?.client_name?.trim() || "Unnamed client";

  function submitConsent(accept: boolean) {
    startTransition(() => {
      setErrorMessage(null);

      void fetch(`${props.authBasePath}/oauth2/consent`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept,
          scope: requestedScopes.join(" ") || undefined,
          oauth_query: props.queryString || undefined,
        }),
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as { url?: string } | null;

          if (!response.ok || !payload?.url) {
            throw new Error(extractErrorMessage(payload, "Unable to finish the MCP authorization request."));
          }

          router.replace(payload.url);
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Unable to finish the MCP authorization request.");
        });
    });
  }

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="p-6">
      <div className="max-w-2xl">
        <p className="section-kicker">MCP Access</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">Authorize client access</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Confirm that this MCP client application can request tokens for the Cinatra MCP server.
        </p>
      </div>

      <div className="mt-6 grid gap-5 rounded-panel border border-line bg-surface-strong/90 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
        <div className="flex items-start gap-4">
          {props.client?.logo_uri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={props.client.logo_uri}
              alt=""
              className="h-14 w-14 rounded-control border border-line object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-control border border-line bg-surface-muted text-lg font-semibold text-muted-foreground">
              {clientName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold text-foreground">{clientName}</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{props.client?.client_id ?? "Unknown client"}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {props.client?.type ?? "web"} client using{" "}
              <span className="font-medium text-foreground">{props.client?.token_endpoint_auth_method ?? "client_secret_basic"}</span>
            </p>
          </div>
        </div>

        <div className="grid gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Redirect URIs</p>
            <div className="mt-2 grid gap-2">
              {(props.client?.redirect_uris ?? []).map((redirectUri) => (
                <code key={redirectUri} className="rounded-xl border border-line bg-surface-muted px-3 py-2 text-xs text-foreground">
                  {redirectUri}
                </code>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Requested scopes</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {requestedScopes.length > 0 ? (
                requestedScopes.map((scope) => (
                  <span key={scope} className="rounded-full border border-line bg-surface-muted px-3 py-1 text-xs font-medium text-foreground">
                    {scope}
                  </span>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">No explicit scopes were requested.</span>
              )}
            </div>
          </div>
        </div>

        {errorMessage ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</p>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            onClick={() => {
              submitConsent(true);
            }}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "Processing…" : "Authorize access"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              submitConsent(false);
            }}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-full border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Deny access
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              router.push(props.fallbackHref);
            }}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-full px-5 py-3 text-sm font-semibold text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </Button>
        </div>
      </div>
      </CardContent>
    </Card>
  );
}
