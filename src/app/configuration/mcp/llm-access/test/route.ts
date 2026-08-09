import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { auth } from "@/lib/auth";
import { getLlmMcpCredentials, getPublicMcpServerUrl } from "@cinatra-ai/llm";
import { getLocalTokenEndpointUrl, getLocalMcpServerUrl } from "@cinatra-ai/mcp-server/credentials";
// Provider connection reads resolve through the `llm-provider-surface`
// capability each LLM connector registers at activation (lazy/guarded
// host-access cutover). An absent connector degrades to a
// 400 ("connector not installed"), never a 500.
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { canProviderSatisfyCapability } from "@cinatra-ai/agents";
import { emitUsageEvent } from "@cinatra-ai/metric-usage-api";
import type { LlmProvider } from "@cinatra-ai/llm";
import type { LlmProviderSurface } from "@cinatra-ai/sdk-extensions";

const VALID_PROVIDERS: LlmProvider[] = ["openai", "gemini", "anthropic"];
const AUTH_BASE_PATH = "/api/auth";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

// ---------------------------------------------------------------------------
// Key validation is a CHEAP, COUNTED, DIRECT probe (cinatra#2579)
//
// This handler used to "test" a provider by sending a real chat request
// (`gpt-4o` by default) carrying a remote-MCP tool with
// `require_approval: "never"` — i.e. it asked the provider to run a
// multi-step, server-side tool-calling loop against the Cinatra MCP server,
// through a raw `fetch` that never reached `emitUsageEvent`. Every click cost
// real money and left NO trace in `usage_events` / `/analytics/llm`.
//
// What it does now: ONE minimal catalog read (a models list) that proves the
// stored API key is live, with NO model call, NO tools, NO MCP server
// attached, and therefore NO agentic loop the provider could schedule on our
// behalf. The call is recorded through the usage seam AT ITS CALL SITE
// (`recordKeyValidationCall`) so validation is visible in `/analytics/llm`.
//
// The probe prefers the CONNECTOR's own catalog reader
// (`LlmProviderSurface.listAvailableModels`) — the same "live, minimal call
// through the connector's own catalog reader" the setup saga's credential
// validation uses (`src/lib/setup-readiness-ports.ts`). A provider whose
// installed connector does not expose that member yet falls back to the same
// cheap models endpoint called directly.
//
// SCOPE BOUNDARY: this counts THIS call site only. Making every provider call
// counted by construction (a general usage seam) is cinatra#2578's lane — this
// change deliberately adds no shared instrumentation.
// ---------------------------------------------------------------------------

/** Usage-event label for the validation probe (its `/analytics/llm` row). */
const KEY_VALIDATION_LABEL = "llm-access-key-validation";
/**
 * The probe reads a provider's model CATALOG; it never calls a model. The
 * usage event therefore names the endpoint class rather than a model id — a
 * model id would claim an inference call that did not happen.
 */
const KEY_VALIDATION_MODEL = "models.list";

/**
 * Record the validation probe through the usage seam.
 *
 * Emitted once per probe ATTEMPT (success or failure) — the point of the
 * record is that a provider call was made at all, which is exactly what
 * cinatra#2579 found missing. Token counts are ZERO because a catalog read
 * bills none; the event is priced at 0 and never inflates spend.
 */
function recordKeyValidationCall(provider: LlmProvider): void {
  try {
    emitUsageEvent({
      source: "llm",
      provider,
      model: KEY_VALIDATION_MODEL,
      operation: "generate",
      agentLabel: KEY_VALIDATION_LABEL,
      skillLabel: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      requestedProvider: provider,
      effectiveProvider: provider,
    });
  } catch (err) {
    // Usage accounting must never break the validation it is recording.
    console.warn("[llm-access/test] emitUsageEvent failed", err);
  }
}

type KeyProbeResult = { endpoint: string; models: string[] };

type AnthropicModelListResponse = {
  data?: Array<{ id?: string }>;
  error?: { message?: string };
};

/**
 * The cheapest call that proves the stored key: a models-list read.
 *
 * NEVER attaches tools, an MCP server, or a message — a validation call must
 * not be able to schedule work on the provider side.
 */
async function probeProviderKey(
  provider: LlmProvider,
  surface: Pick<LlmProviderSurface, "listAvailableModels">,
  apiKey: string,
): Promise<KeyProbeResult> {
  if (surface.listAvailableModels) {
    const models = await surface.listAvailableModels({});
    return {
      endpoint: `${provider} connector catalog read — listAvailableModels()`,
      models: models ?? [],
    };
  }

  if (provider === "anthropic") {
    // The installed Anthropic connector exposes no `listAvailableModels` yet,
    // so the route reads the same catalog endpoint directly. `limit=1` keeps
    // the response to a single row — this is a liveness check on the key, not
    // a catalog sync. Move to the connector's reader as soon as it ships one.
    const endpoint = "https://api.anthropic.com/v1/models?limit=1";
    const apiResponse = await fetch(endpoint, {
      method: "GET",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      cache: "no-store",
    });
    const payload = (await apiResponse.json().catch(() => null)) as AnthropicModelListResponse | null;
    if (!apiResponse.ok) {
      throw new Error(payload?.error?.message ?? `Anthropic returned HTTP ${apiResponse.status}.`);
    }
    return {
      endpoint: `GET ${endpoint}`,
      models: (payload?.data ?? []).map((m) => m.id ?? "").filter(Boolean),
    };
  }

  throw new Error(
    `The installed ${PROVIDER_LABELS[provider] ?? provider} connector exposes no catalog reader, ` +
      `so its API key cannot be validated without a billed model call. Update the connector.`,
  );
}

// Call the Better Auth token endpoint in-process to avoid Turbopack on-demand
// compilation deadlocks when route handlers self-reference via HTTP fetch.
async function exchangeClientCredentials(clientId: string, clientSecret: string, scope: string, resource: string) {
  const tokenEndpoint = getLocalTokenEndpointUrl(AUTH_BASE_PATH);
  const basicCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const inProcessRequest = new Request(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicCredentials}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope, resource }),
  });
  const tokenResponse = await auth.handler(inProcessRequest);

  const responseText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(`Token endpoint returned ${tokenResponse.status}: ${responseText}`);
  }

  let tokenData: { access_token?: string };
  try {
    tokenData = JSON.parse(responseText) as { access_token?: string };
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${responseText}`);
  }

  if (!tokenData.access_token) {
    throw new Error(`Token endpoint did not return an access_token. Response: ${responseText}`);
  }
  return tokenData.access_token;
}

export async function POST(request: Request) {
  const session = await getAuthSession();
  const roles = String(session?.user?.role ?? "")
    .split(",")
    .map((r) => r.trim());
  if (!session || !roles.includes("admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json() as { provider?: string };
  const provider = body.provider as LlmProvider | undefined;
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  // llm-providers S2 truth cleanup (cinatra#1713 AC4, epic #1711): MCP access
  // is only testable for a provider whose DECLARED capability matrix satisfies
  // `native_mcp`. Function-tool emulation does not qualify as MCP (the MCP
  // Injection Rule), so the old fake `call_cinatra_mcp` function-declaration
  // stand-in that presented a non-MCP Gemini request as an MCP test is removed
  // rather than relabeled — Gemini is refused honestly here. When the dormant
  // Gemini arm activates and the declared catalog flips Gemini's
  // `native_mcp.status` to "native", this gate opens for it too.
  if (!canProviderSatisfyCapability(provider, "native_mcp")) {
    return NextResponse.json(
      {
        error:
          `Provider "${provider}" does not support native MCP per its declared ` +
          `capability matrix (function-tool emulation does not qualify as MCP), ` +
          `so there is no MCP access to test.`,
      },
      { status: 400 },
    );
  }

  const credentials = getLlmMcpCredentials(provider);
  if (!credentials) {
    return NextResponse.json(
      { error: "No MCP credentials stored for this provider. Use the Grant access button first." },
      { status: 400 },
    );
  }

  const serverUrl = getPublicMcpServerUrl();
  if (!serverUrl) {
    return NextResponse.json(
      { error: "No public MCP server URL configured. Set the public base URL in /configuration/development?tab=tunnel before testing." },
      { status: 400 },
    );
  }

  try {
    // Proves the granted MCP client still mints a token. In-process and free —
    // the access token itself is deliberately NOT returned to the caller (the
    // old diagnostic echoed the live bearer token into the admin modal).
    await exchangeClientCredentials(
      credentials.clientId,
      credentials.clientSecret,
      credentials.scope,
      getLocalMcpServerUrl("/api/mcp"),
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const label = PROVIDER_LABELS[provider] ?? provider;
  const surface = getLlmProviderSurface(provider);
  if (!surface?.getConfiguredConnection) {
    return NextResponse.json({ error: `The ${label} connector is not installed.` }, { status: 400 });
  }
  const conn = (await surface.getConfiguredConnection()) as { apiKey?: string } | null | undefined;
  if (!conn?.apiKey) {
    return NextResponse.json({ error: `${label} API key not configured.` }, { status: 400 });
  }

  let probe: KeyProbeResult;
  try {
    probe = await probeProviderKey(provider, surface, conn.apiKey);
  } catch (err) {
    recordKeyValidationCall(provider);
    return NextResponse.json(
      {
        error:
          `The ${label} API key could not be validated: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
  recordKeyValidationCall(provider);

  // Same verdict the setup saga's credential validation reaches: a catalog
  // that came back EMPTY proves nothing about the key, so it is not a pass.
  if (probe.models.length === 0) {
    return NextResponse.json(
      {
        error:
          `The ${label} credentials were accepted but no models are available to this key.`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    request: {
      provider,
      check: "API-key validation — one catalog read. No model call, no tools, no MCP server attached.",
      endpoint: probe.endpoint,
      method: "GET",
    },
    response: {
      ok: true,
      mcpAccess: {
        serverUrl,
        credentials: "exchanged",
      },
      keyValidation: {
        ok: true,
        modelCount: probe.models.length,
        sampleModels: probe.models.slice(0, 5),
        // Recorded in usage_events (0 tokens — a catalog read bills none).
        counted: true,
      },
    },
  });
}
