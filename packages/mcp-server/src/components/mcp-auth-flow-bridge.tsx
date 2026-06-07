"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mcpAuthClient } from "./mcp-auth-ui-provider";

function hasOAuthQuery(queryString: string) {
  if (!queryString) {
    return false;
  }

  const params = new URLSearchParams(queryString);
  return [
    "client_id",
    "response_type",
    "redirect_uri",
    "scope",
    "state",
    "prompt",
    "code_challenge",
  ].some((key) => params.has(key));
}

async function continueOAuthFlow(input: {
  authBasePath: string;
  path: string;
  queryString: string;
}) {
  const response = await fetch(`${input.authBasePath}/oauth2/continue`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      oauth_query: input.queryString || undefined,
      created: input.path === "sign-up" ? true : undefined,
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { url?: string; message?: string; error_description?: string }
    | null;

  if (!response.ok || !payload?.url) {
    throw new Error(payload?.message ?? payload?.error_description ?? "Unable to continue the OAuth sign-in flow.");
  }

  return payload.url;
}

export function McpAuthFlowBridge(props: {
  authBasePath: string;
  fallbackHref: string;
  path: string;
  queryString: string;
}) {
  const router = useRouter();
  const session = mcpAuthClient.useSession();
  const handledKeyRef = useRef<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const oauthQuery = useMemo(() => props.queryString, [props.queryString]);
  const isOAuthFlow = useMemo(() => hasOAuthQuery(oauthQuery), [oauthQuery]);

  useEffect(() => {
    if (!session.data || props.path === "sign-out") {
      return;
    }

    const handledKey = `${props.path}:${oauthQuery}`;
    if (handledKeyRef.current === handledKey) {
      return;
    }

    handledKeyRef.current = handledKey;

    if (!isOAuthFlow) {
      router.replace(props.fallbackHref);
      return;
    }

    void continueOAuthFlow({
      authBasePath: props.authBasePath,
      path: props.path,
      queryString: oauthQuery,
    })
      .then((url) => {
        router.replace(url);
      })
      .catch((error) => {
        handledKeyRef.current = null;
        setErrorMessage(error instanceof Error ? error.message : "Unable to continue the OAuth sign-in flow.");
      });
  }, [isOAuthFlow, oauthQuery, props.authBasePath, props.fallbackHref, props.path, router, session.data]);

  if (!session.data || !isOAuthFlow) {
    return errorMessage ? (
      <p className="rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</p>
    ) : null;
  }

  return (
    <div className="rounded-control border border-line bg-surface-muted px-4 py-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Continuing the MCP authorization flow…</p>
      {errorMessage ? <p className="mt-2 text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
