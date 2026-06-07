import "server-only";

import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { auth } from "@/lib/auth";
import { getLlmMcpCredentials, getPublicMcpServerUrl } from "@cinatra-ai/llm";
import { getLocalTokenEndpointUrl, getLocalMcpServerUrl } from "@cinatra-ai/mcp-server/credentials";
import { getConfiguredOpenAIConnection } from "@cinatra-ai/openai-connector";
import { getConfiguredGeminiAPIKey } from "@cinatra-ai/gemini-connector";
import { getConfiguredAnthropicConnection, getDefaultClaudeModel } from "@cinatra-ai/anthropic-connector";
import type { LlmProvider } from "@cinatra-ai/llm";

const VALID_PROVIDERS: LlmProvider[] = ["openai", "gemini", "anthropic"];
const AUTH_BASE_PATH = "/api/auth";

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

  let accessToken: string;
  try {
    accessToken = await exchangeClientCredentials(credentials.clientId, credentials.clientSecret, credentials.scope, getLocalMcpServerUrl("/api/mcp"));
  } catch (err) {
    return NextResponse.json(
      { error: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const mcpToolHeaders = { "Authorization": `Bearer ${accessToken}` };

  if (provider === "openai") {
    const conn = await getConfiguredOpenAIConnection();
    if (!conn?.apiKey) {
      return NextResponse.json({ error: "OpenAI API key not configured." }, { status: 400 });
    }

    const requestBody = {
      model: conn.defaultModel ?? "gpt-4o",
      instructions:
        "You have access to the Cinatra MCP server. " +
        "Use it to list the available tools and report what you find. Be concise.",
      input: [
        {
          role: "user",
          content: "Call the Cinatra MCP server and tell me which tools are available.",
        },
      ],
      tools: [
        {
          type: "mcp",
          server_label: "cinatra",
          server_url: serverUrl,
          headers: mcpToolHeaders,
          server_description:
            "Cinatra MCP server — exposes the platform's agents, workflows, data objects " +
            "(accounts, contacts, campaigns, lists, projects, custom types), content publishing, " +
            "connectors, analytics, and skills. " +
            "Does NOT have access to permissions, settings, or auth functions.",
          require_approval: "never",
        },
      ],
    };

    const apiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${conn.apiKey}`,
        ...(conn.organizationId ? { "OpenAI-Organization": conn.organizationId } : {}),
        ...(conn.projectId ? { "OpenAI-Project": conn.projectId } : {}),
      },
      body: JSON.stringify(requestBody),
    });

    const responseBody = await apiResponse.json() as unknown;
    return NextResponse.json({ request: requestBody, response: responseBody });
  }

  if (provider === "gemini") {
    const apiKey = await getConfiguredGeminiAPIKey();
    if (!apiKey) {
      return NextResponse.json({ error: "Gemini API key not configured." }, { status: 400 });
    }

    // Gemini does not support native MCP tools. We expose the MCP server as a
    // function declaration so the model can signal intent to call it.
    const requestBody = {
      systemInstruction: {
        parts: [
          {
            text:
              "You have access to the Cinatra MCP server as a function tool. " +
              "When asked, call the 'call_cinatra_mcp' function and report what you receive.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: "Call the Cinatra MCP server and tell me which tools are available." }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "call_cinatra_mcp",
              description:
                `Cinatra MCP server (server URL: ${serverUrl}). ` +
                `Gemini does not yet support the MCP protocol natively — ` +
                `this function declaration represents what would be a native MCP tool call.`,
              parameters: {
                type: "OBJECT",
                properties: {
                  tool_name: {
                    type: "STRING",
                    description: "Name of the MCP tool to call (e.g. contacts.list, entities.list)",
                  },
                  arguments: {
                    type: "OBJECT",
                    description: "Arguments for the MCP tool call",
                  },
                },
                required: ["tool_name"],
              },
            },
          ],
        },
      ],
    };

    const model = "gemini-2.5-flash";
    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    const responseBody = await apiResponse.json() as unknown;
    return NextResponse.json({ request: requestBody, response: responseBody });
  }

  if (provider === "anthropic") {
    const conn = await getConfiguredAnthropicConnection();
    if (!conn?.apiKey) {
      return NextResponse.json({ error: "Anthropic API key not configured." }, { status: 400 });
    }

    const model = getDefaultClaudeModel();
    const mcpMode = conn.mcpMode ?? "function-tools";
    const anthropicHeaders = {
      "Content-Type": "application/json",
      "x-api-key": conn.apiKey,
      "anthropic-version": "2023-06-01",
    };

    if (mcpMode === "native") {
      const requestBody = {
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Call the Cinatra MCP server and tell me which tools are available." }],
        mcp_servers: [{ type: "url", url: serverUrl, name: "cinatra", authorization_token: accessToken }],
        // mcp_toolset entry is required — references the mcp_server by name so the model can use it
        tools: [{ type: "mcp_toolset", mcp_server_name: "cinatra" }],
      };
      const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { ...anthropicHeaders, "anthropic-beta": "mcp-client-2025-11-20" },
        body: JSON.stringify(requestBody),
      });
      const responseBody = await apiResponse.json() as unknown;
      return NextResponse.json({ request: requestBody, response: responseBody });
    }

    // function-tools mode: fetch tool list via JSON-RPC then pass as function tools
    const localMcpUrl = getLocalMcpServerUrl("/api/mcp");
    const toolsResponse = await fetch(localMcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const toolsData = await toolsResponse.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> } };
    const mcpTools = toolsData.result?.tools ?? [];
    const anthropicTools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));

    const requestBody = {
      model,
      max_tokens: 1024,
      tools: anthropicTools,
      messages: [{ role: "user", content: "Call the Cinatra MCP server and tell me which tools are available." }],
    };
    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(requestBody),
    });
    const responseBody = await apiResponse.json() as unknown;
    return NextResponse.json({ request: { ...requestBody, tools: `[${anthropicTools.length} tools]` }, response: responseBody });
  }

  return NextResponse.json({ error: "Provider not supported for testing yet." }, { status: 400 });
}
