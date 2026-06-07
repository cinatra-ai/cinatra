"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type OAuthClientRecord = {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  scope?: string;
  user_id?: string | null;
  client_id_issued_at?: number;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
  grant_types?: ("authorization_code" | "client_credentials" | "refresh_token")[];
  response_types?: "code"[];
  public?: boolean;
  type?: "web" | "native" | "user-agent-based";
  disabled?: boolean;
  [key: string]: unknown;
};

type ClientFormState = {
  client_name: string;
  redirect_uris: string;
  scope: string;
  type: "web" | "native" | "user-agent-based";
  token_endpoint_auth_method: "none" | "client_secret_basic" | "client_secret_post";
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

function normalizeUris(value: string) {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  if ("message" in payload && typeof payload.message === "string" && payload.message.length > 0) return payload.message;
  if ("error_description" in payload && typeof payload.error_description === "string" && payload.error_description.length > 0)
    return payload.error_description;
  if ("error" in payload && typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  return fallback;
}

function sortClients(clients: OAuthClientRecord[]) {
  return [...clients].sort((left, right) => {
    const leftName = (left.client_name ?? left.client_id).toLowerCase();
    const rightName = (right.client_name ?? right.client_id).toLowerCase();
    return leftName.localeCompare(rightName);
  });
}

function defaultCreateState(initialScope: string): ClientFormState {
  return {
    client_name: "",
    redirect_uris: "",
    scope: initialScope,
    type: "web",
    token_endpoint_auth_method: "client_secret_basic",
  };
}

function clientToEditState(client: OAuthClientRecord): ClientFormState {
  return {
    client_name: client.client_name ?? "",
    redirect_uris: client.redirect_uris.join("\n"),
    scope: client.scope ?? "",
    type: client.type ?? "web",
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? (client.public ? "none" : "client_secret_basic"),
  };
}

function buildCreateBody(state: ClientFormState) {
  return {
    client_name: state.client_name.trim() || undefined,
    redirect_uris: normalizeUris(state.redirect_uris),
    scope: state.scope.trim() || undefined,
    type: state.type,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: state.token_endpoint_auth_method,
  };
}

function buildUpdateBody(clientId: string, state: ClientFormState) {
  return {
    client_id: clientId,
    update: {
      client_name: state.client_name.trim() || undefined,
      redirect_uris: normalizeUris(state.redirect_uris),
      scope: state.scope.trim() || undefined,
      type: state.type,
    },
  };
}

async function postJson<T>(url: string, body: unknown, fallbackError: string) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as T | { message?: string; error_description?: string; error?: string } | null;
  if (!response.ok) throw new Error(extractErrorMessage(payload, fallbackError));
  return payload as T;
}

async function deleteJson<T>(url: string, body: unknown, fallbackError: string) {
  const response = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as T | { message?: string; error?: string } | null;
  if (!response.ok) throw new Error(extractErrorMessage(payload, fallbackError));
  return payload as T;
}

function formatAuthMethod(client: OAuthClientRecord) {
  switch (client.token_endpoint_auth_method) {
    case "none":
      return "Public client";
    case "client_secret_post":
      return "Confidential via client_secret_post";
    default:
      return "Confidential via client_secret_basic";
  }
}

// ---------------------------------------------------------------------------
// LLM API access section
// ---------------------------------------------------------------------------

type LlmProviderState = {
  configured: boolean;
  justGranted: boolean;
  error: string | null;
  pending: boolean;
};

type McpTestModal = {
  provider: string;
  loading: boolean;
  request?: unknown;
  response?: unknown;
  error?: string;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={copy}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-success" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      )}
    </Button>
  );
}

function McpTestModal(props: { modal: McpTestModal; onClose: () => void }) {
  const { modal } = props;
  return (
    <AppDialog
      open={true}
      onOpenChange={(isOpen) => { if (!isOpen) props.onClose(); }}
      maxWidth="max-w-4xl"
      className="flex max-h-[90vh] flex-col overflow-hidden p-0"
      dismissible={!modal.loading}
    >
      {/* header */}
      <div className="flex shrink-0 items-center border-b border-line px-6 py-4">
        <h3 className="text-base font-semibold text-foreground">
          MCP test — {PROVIDER_LABELS[modal.provider] ?? modal.provider}
        </h3>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {modal.loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Running test…</p>
        ) : modal.error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{modal.error}</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Request</p>
                <CopyButton text={JSON.stringify(modal.request, null, 2)} />
              </div>
              <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-4 text-xs leading-relaxed text-foreground">
                {JSON.stringify(modal.request, null, 2)}
              </pre>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Response</p>
                <CopyButton text={JSON.stringify(modal.response, null, 2)} />
              </div>
              <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-4 text-xs leading-relaxed text-foreground">
                {JSON.stringify(modal.response, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </AppDialog>
  );
}

function LlmAccessSection(props: {
  connectedProviders: string[];
  initialStatus: Record<string, { configured: boolean }>;
  llmAccessPath: string;
}) {
  const [testModal, setMcpTestModal] = useState<McpTestModal | null>(null);
  const [providerStates, setProviderStates] = useState<Record<string, LlmProviderState>>(() => {
    const init: Record<string, LlmProviderState> = {};
    for (const id of props.connectedProviders) {
      init[id] = {
        configured: props.initialStatus[id]?.configured ?? false,
        justGranted: false,
        error: null,
        pending: false,
      };
    }
    return init;
  });

  function setProviderState(provider: string, patch: Partial<LlmProviderState>) {
    setProviderStates((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }));
  }

  function grantAccess(provider: string) {
    setProviderState(provider, { pending: true, error: null, justGranted: false });
    void postJson<{ clientId: string; clientSecret: string }>(
      props.llmAccessPath,
      { provider },
      "Unable to grant LLM access.",
    )
      .then((result) => {
        void result;
        setProviderState(provider, { configured: true, justGranted: true, pending: false });
      })
      .catch((err) => {
        setProviderState(provider, { pending: false, error: err instanceof Error ? err.message : "Unable to grant LLM access." });
      });
  }

  function revokeAccess(provider: string) {
    setProviderState(provider, { pending: true, error: null });
    void deleteJson<{ ok: boolean }>(
      props.llmAccessPath,
      { provider },
      "Unable to revoke LLM access.",
    )
      .then(() => {
        setProviderState(provider, { configured: false, justGranted: false, pending: false });
      })
      .catch((err) => {
        setProviderState(provider, { pending: false, error: err instanceof Error ? err.message : "Unable to revoke LLM access." });
      });
  }

  function testAccess(provider: string) {
    setMcpTestModal({ provider, loading: true });
    void postJson<{ request: unknown; response: unknown }>(
      `${props.llmAccessPath}/test`,
      { provider },
      "Test request failed.",
    )
      .then((result) => {
        setMcpTestModal({ provider, loading: false, request: result.request, response: result.response });
      })
      .catch((err) => {
        setMcpTestModal({ provider, loading: false, error: err instanceof Error ? err.message : "Test request failed." });
      });
  }

  return (
    <>
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="p-6">
      <div className="max-w-2xl">
        <p className="section-kicker">LLM API Access</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">Grant AI providers access</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Allow connected LLM providers to use the Cinatra MCP server as a tool. Each provider gets a dedicated OAuth client that is passed automatically when making LLM calls.
        </p>
      </div>

      <div className="mt-6 grid gap-3">
        {props.connectedProviders.map((id) => {
          const state = providerStates[id];
          if (!state) return null;
          return (
            <div key={id} className="rounded-panel border border-line bg-surface-strong px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-foreground">{PROVIDER_LABELS[id] ?? id}</span>
                  {state.configured ? (
                    <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success ring-1 ring-inset ring-success/20">
                      Configured
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning ring-1 ring-inset ring-warning/20">
                      Not configured
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {state.configured ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => { testAccess(id); }}
                        disabled={state.pending}
                      >
                        Test
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => { grantAccess(id); }}
                        disabled={state.pending}
                      >
                        {state.pending ? "Rotating…" : "Rotate secret"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => { revokeAccess(id); }}
                        disabled={state.pending}
                        className="text-destructive hover:text-destructive"
                      >
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => { grantAccess(id); }}
                      disabled={state.pending}
                    >
                      {state.pending ? "Granting…" : "Grant access"}
                    </Button>
                  )}
                </div>
              </div>

              {state.justGranted ? (
                <div className="mt-3 rounded-control border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
                  <p className="font-semibold">Access granted.</p>
                  <p className="mt-1 text-xs text-success">
                    The OAuth client has been created and the credentials are stored automatically. Cinatra will use them whenever it sends requests to this provider with MCP access enabled — no action needed on your part.
                  </p>
                </div>
              ) : null}

              {state.error ? (
                <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{state.error}</p>
              ) : null}
            </div>
          );
        })}
      </div>
      </CardContent>
    </Card>

    {testModal ? <McpTestModal modal={testModal} onClose={() => setMcpTestModal(null)} /> : null}
  </>
  );
}

// ---------------------------------------------------------------------------
// MCP Applications section (authorization_code clients)
// ---------------------------------------------------------------------------

export function McpClientsDashboard(props: {
  authBasePath: string;
  clients: OAuthClientRecord[];
  detailBasePath: string;
  defaultScope: string;
  connectedProviders: string[];
  llmAccessStatus: Record<string, { configured: boolean }>;
  llmAccessPath: string;
}) {
  const [formState, setFormState] = useState<ClientFormState>(defaultCreateState(props.defaultScope));
  const [clients, setClients] = useState<OAuthClientRecord[]>(sortClients(props.clients));
  const [issuedClient, setIssuedClient] = useState<OAuthClientRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function updateField<Key extends keyof ClientFormState>(key: Key, value: ClientFormState[Key]) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  function prefillForClaude() {
    setFormState((current) => ({
      ...current,
      client_name: current.client_name || "Claude",
      redirect_uris: current.redirect_uris || "https://claude.ai/api/mcp/auth_callback",
    }));
  }

  function submitCreate() {
    startTransition(() => {
      setErrorMessage(null);
      setIssuedClient(null);
      void postJson<OAuthClientRecord>(
        `${props.authBasePath}/oauth2/create-client`,
        buildCreateBody(formState),
        "Unable to create the OAuth client.",
      )
        .then((createdClient) => {
          setClients((current) => sortClients([...current, createdClient]));
          setIssuedClient(createdClient);
          setFormState(defaultCreateState(props.defaultScope));
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Unable to create the OAuth client.");
        });
    });
  }

  return (
    <div className="grid gap-6">
      {props.connectedProviders.length > 0 ? (
        <LlmAccessSection
          connectedProviders={props.connectedProviders}
          initialStatus={props.llmAccessStatus}
          llmAccessPath={props.llmAccessPath}
        />
      ) : null}

      <Card className="border-line bg-surface backdrop-blur-none">
        <CardContent className="p-6">
        <div className="max-w-2xl">
          <p className="section-kicker">OAuth Clients</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">MCP applications</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create clients for MCP-compatible applications (such as Claude) that users authorize to access their account.
          </p>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Label className="grid gap-2 text-sm text-foreground">
            <div className="flex items-center justify-between">
              <span className="font-medium">Client name</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={prefillForClaude}
                className="text-xs font-medium text-muted-foreground"
              >
                Pre-fill for Claude
              </Button>
            </div>
            <Input
              value={formState.client_name}
              onChange={(event) => { updateField("client_name", event.target.value); }}
              placeholder="My MCP app"
            />
          </Label>

          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Allowed scopes</span>
            <Input
              value={formState.scope}
              onChange={(event) => { updateField("scope", event.target.value); }}
              placeholder={props.defaultScope}
              className="font-mono text-xs"
            />
          </Label>

          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Client type</span>
            <Select
              value={formState.type}
              onValueChange={(value) => { updateField("type", value as ClientFormState["type"]); }}
            >
              <SelectTrigger className="rounded-control border border-line bg-surface-strong px-4 py-3">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="native">Native</SelectItem>
                <SelectItem value="user-agent-based">User-agent based</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Authentication scheme</span>
            <Select
              value={formState.token_endpoint_auth_method}
              onValueChange={(value) => {
                updateField("token_endpoint_auth_method", value as ClientFormState["token_endpoint_auth_method"]);
              }}
            >
              <SelectTrigger className="rounded-control border border-line bg-surface-strong px-4 py-3">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client_secret_basic">Confidential: client_secret_basic</SelectItem>
                <SelectItem value="client_secret_post">Confidential: client_secret_post</SelectItem>
                <SelectItem value="none">Public client</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          <Label className="grid gap-2 text-sm text-foreground lg:col-span-2">
            <span className="font-medium">Redirect URIs</span>
            <Textarea
              value={formState.redirect_uris}
              onChange={(event) => { updateField("redirect_uris", event.target.value); }}
              rows={5}
              placeholder={"https://example.com/oauth/callback\napp://myapp/oauth/callback"}
              className="rounded-panel border border-line bg-surface-strong px-4 py-3 font-mono text-xs"
            />
          </Label>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          <p className="text-xs leading-6 text-muted-foreground">
            Public clients do not receive a client secret. Confidential clients do, and the secret is only shown when the client is created or rotated.
          </p>

          {issuedClient?.client_secret ? (
            <div className="rounded-panel border border-success/30 bg-success/10 px-4 py-4 text-sm text-success">
              <p className="font-semibold">Copy this client secret now.</p>
              <code className="mt-2 block overflow-x-auto rounded-xl border border-success/30 bg-surface-strong px-3 py-3 text-xs text-success">
                {issuedClient.client_secret}
              </code>
            </div>
          ) : null}

          {errorMessage ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</p>
          ) : null}

          <div>
            <Button
              type="button"
              onClick={submitCreate}
              disabled={isPending}
            >
              {isPending ? "Creating…" : "Create OAuth client"}
            </Button>
          </div>
        </div>
        </CardContent>
      </Card>

      <section className="grid gap-4">
        {clients.length > 0 ? (
          clients.map((client) => (
            <Link
              key={client.client_id}
              href={`${props.detailBasePath}/${encodeURIComponent(client.client_id)}`}
              className="rounded-panel border border-line bg-surface-strong/90 px-5 py-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-border"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold text-foreground">{client.client_name?.trim() || client.client_id}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{client.client_id}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{formatAuthMethod(client)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {client.scope ? (
                      <span className="rounded-full border border-line bg-surface-muted px-3 py-1 text-xs font-medium text-foreground">
                        {client.scope}
                      </span>
                    ) : null}
                    {client.redirect_uris.slice(0, 2).map((redirectUri) => (
                      <span key={redirectUri} className="rounded-full border border-line bg-surface-muted px-3 py-1 text-xs text-muted-foreground">
                        {redirectUri}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">Open</div>
              </div>
            </Link>
          ))
        ) : (
          <div className="rounded-panel border border-dashed border-line bg-surface px-5 py-8 text-sm text-muted-foreground">
            No OAuth clients have been created yet.
          </div>
        )}
      </section>
    </div>
  );
}

export function McpClientDetailManager(props: {
  authBasePath: string;
  client: OAuthClientRecord;
  listHref: string;
}) {
  const router = useRouter();
  const [formState, setFormState] = useState<ClientFormState>(() => clientToEditState(props.client));
  const [client, setClient] = useState<OAuthClientRecord>(props.client);
  const [secretValue, setSecretValue] = useState<string | null>(props.client.client_secret ?? null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const clientHeadline = useMemo(() => client.client_name?.trim() || client.client_id, [client.client_id, client.client_name]);

  function updateField<Key extends keyof ClientFormState>(key: Key, value: ClientFormState[Key]) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  function saveChanges() {
    startTransition(() => {
      setErrorMessage(null);
      setSecretValue(null);
      void postJson<OAuthClientRecord>(
        `${props.authBasePath}/oauth2/update-client`,
        buildUpdateBody(client.client_id, formState),
        "Unable to update the OAuth client.",
      )
        .then((updatedClient) => { setClient(updatedClient); })
        .catch((error) => { setErrorMessage(error instanceof Error ? error.message : "Unable to update the OAuth client."); });
    });
  }

  function rotateSecret() {
    startTransition(() => {
      setErrorMessage(null);
      void postJson<OAuthClientRecord>(
        `${props.authBasePath}/oauth2/client/rotate-secret`,
        { client_id: client.client_id },
        "Unable to rotate the client secret.",
      )
        .then((updatedClient) => {
          setClient(updatedClient);
          setSecretValue(updatedClient.client_secret ?? null);
        })
        .catch((error) => { setErrorMessage(error instanceof Error ? error.message : "Unable to rotate the client secret."); });
    });
  }

  function deleteClient() {
    if (!window.confirm(`Delete OAuth client "${clientHeadline}"? This cannot be undone.`)) return;
    startTransition(() => {
      setErrorMessage(null);
      void postJson(
        `${props.authBasePath}/oauth2/delete-client`,
        { client_id: client.client_id },
        "Unable to delete the OAuth client.",
      )
        .then(() => {
          router.push(props.listHref);
          router.refresh();
        })
        .catch((error) => { setErrorMessage(error instanceof Error ? error.message : "Unable to delete the OAuth client."); });
    });
  }

  return (
    <div className="grid gap-6">
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardContent className="p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="section-kicker">OAuth Client</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{clientHeadline}</h1>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{client.client_id}</p>
          </div>
          <Button asChild variant="outline">
            <Link href={props.listHref}>
              Back to clients
            </Link>
          </Button>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Client name</span>
            <Input
              value={formState.client_name}
              onChange={(event) => { updateField("client_name", event.target.value); }}
            />
          </Label>

          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Allowed scopes</span>
            <Input
              value={formState.scope}
              onChange={(event) => { updateField("scope", event.target.value); }}
              className="font-mono text-xs"
            />
          </Label>

          <Label className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Client type</span>
            <Select
              value={formState.type}
              onValueChange={(value) => { updateField("type", value as ClientFormState["type"]); }}
            >
              <SelectTrigger className="rounded-control border border-line bg-surface-strong px-4 py-3">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="native">Native</SelectItem>
                <SelectItem value="user-agent-based">User-agent based</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          <div className="grid gap-2 text-sm text-foreground">
            <span className="font-medium">Authentication scheme</span>
            <div className="rounded-control border border-line bg-surface-muted px-4 py-3 text-sm text-foreground">
              {formatAuthMethod(client)}
            </div>
          </div>

          <Label className="grid gap-2 text-sm text-foreground lg:col-span-2">
            <span className="font-medium">Redirect URIs</span>
            <Textarea
              value={formState.redirect_uris}
              onChange={(event) => { updateField("redirect_uris", event.target.value); }}
              rows={6}
              className="rounded-panel border border-line bg-surface-strong px-4 py-3 font-mono text-xs"
            />
          </Label>
        </div>

        <div className="mt-5 grid gap-3">
          {secretValue ? (
            <div className="rounded-panel border border-success/30 bg-success/10 px-4 py-4 text-sm text-success">
              <p className="font-semibold">Copy this client secret now.</p>
              <code className="mt-2 block overflow-x-auto rounded-xl border border-success/30 bg-surface-strong px-3 py-3 text-xs text-success">
                {secretValue}
              </code>
            </div>
          ) : null}

          {errorMessage ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</p>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              onClick={saveChanges}
              disabled={isPending}
            >
              {isPending ? "Saving…" : "Save changes"}
            </Button>
            {!client.public ? (
              <Button
                type="button"
                variant="outline"
                onClick={rotateSecret}
                disabled={isPending}
              >
                Rotate client secret
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={deleteClient}
              disabled={isPending}
              className="text-destructive hover:text-destructive"
            >
              Delete client
            </Button>
          </div>
        </div>
        </CardContent>
      </Card>

      <section className="rounded-panel border border-line bg-surface px-5 py-5">
        <p className="text-sm font-semibold text-foreground">Client details</p>
        <dl className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="font-medium text-foreground">Client ID</dt>
            <dd className="mt-1 break-all font-mono text-xs">{client.client_id}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Auth scheme</dt>
            <dd className="mt-1">{formatAuthMethod(client)}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Scopes</dt>
            <dd className="mt-1">{client.scope || "Not restricted"}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Type</dt>
            <dd className="mt-1">{client.type ?? "web"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
