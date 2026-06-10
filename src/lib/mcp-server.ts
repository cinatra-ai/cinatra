import "@/lib/extensions"; // initialises extensionRegistry side effects
import { createMcpServerAuthPlugins, createMcpServerMount, type McpServerSettings, type McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { CINATRA_MCP_INSTRUCTIONS, CINATRA_MCP_EXPERIMENTAL } from "./mcp-instructions";
import { getRunContext } from "./agent-run-context-registry";
import { verifyChatMcpActorToken } from "./chat-mcp-actor-token";
import { verifyAgentRunMcpActorToken } from "./agent-run-mcp-actor-token";
import { createObjectsModule } from "@cinatra-ai/objects/module";
import { createArtifactsModule } from "@/lib/artifacts/mcp";
import { createContextModule } from "@/lib/artifacts/context-mcp";
import { createProjectsModule } from "@cinatra-ai/projects/module";
import { createBlogContentModule } from "@/lib/blog/integration/module";
import { createDashboardsModule } from "@cinatra-ai/dashboards/module";
// Vanilla drizzle-cube/mcp tools (discover, validate, load) are mounted under
// /api/mcp with the existing Better Auth / OAuth gate.
import { createDashboardCubesMcpModule } from "@cinatra-ai/dashboards/cubes-mcp-module";
// Connector MCP capability modules are NOT imported here. They are discovered
// from the generated extension manifest and registered through the same
// registration pass as extension-registered tools — see
// loadConnectorMcpModules (src/lib/connector-mcp-registration.server.ts).
import { loadConnectorMcpModules } from "@/lib/connector-mcp-registration.server";
import { createPermissionsModule } from "@cinatra-ai/permissions/mcp-module";
import { createSkillsModule } from "@cinatra-ai/skills/mcp-module";
import { createMetricsCostModule } from "@cinatra-ai/metric-cost-api";
import { createMetricCostMcpModule } from "@cinatra-ai/metric-cost-api/mcp-module";
import { createMetricUsageMcpModule } from "@cinatra-ai/metric-usage-api/mcp-module";
import { createTriggerModule } from "@cinatra-ai/trigger/module";
import { createChatModule } from "@cinatra-ai/chat/module";
import { createAgentsModule } from "@cinatra-ai/agents/module";
import { createWorkflowsModule } from "@cinatra-ai/workflows/module";
import { createExtensionsModule } from "@cinatra-ai/extensions/mcp-module";
import { readActiveManifestsFromStore } from "@cinatra-ai/extensions/runtime-discovery-host";
import { setLiveAgentManifestProvider } from "@cinatra-ai/agents";
import { buildWorkflowHandlerDeps } from "@/lib/workflow-host-deps";
import { auth } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { resolveProviderAdapter } from "@cinatra-ai/llm";
import { z } from "zod";
import { listExtensionMcpTools, markEffectiveExtensionMcpTools } from "@/lib/extension-mcp-registry";

const MCP_SERVER_SETTINGS_KEY = "mcp_server";

// Host/platform capability modules. Connector modules are NOT listed here —
// they resolve from the generated extension manifest (loadConnectorMcpModules)
// so no specific connector package is named on this registration path. The
// split preserves the long-standing registration order: the connector block
// registers between the blog-content module and the permissions module,
// exactly where the hand-curated list used to sit.
const preConnectorPlatformModules = [
  createArtifactsModule(),
  createContextModule(),
  createObjectsModule(),
  createProjectsModule(),
  createBlogContentModule(),
];

const postConnectorPlatformModules = [
  createPermissionsModule(),
  createSkillsModule(),
  createMetricsCostModule(),
  createMetricCostMcpModule(),
  createMetricUsageMcpModule(),
  createAgentsModule(),
  createExtensionsModule(),
  createChatModule(),
  createTriggerModule(),
  createDashboardsModule(),
  createDashboardCubesMcpModule(),
  // Workflow proposal chat tools. Host injects the project-archive gate,
  // agent-existence, and approver-scope resolvability so the instantiate
  // handler and start-time re-auth share one set of probes.
  // Workflow host deps (project write-grant gate, agent-existence,
  // approver-scope) are built in ONE place so the launcher portlet action and the
  // MCP server share the exact same gates (no authz drift).
  createWorkflowsModule(buildWorkflowHandlerDeps()),
];

// TRUSTED actor resolver, passed uniformly to every manifest-discovered
// connector module factory: a connector tool that must derive the human
// subject userId/orgId from the request/run context (the MCP SDK `extra`
// carries no actor) consumes it; the others ignore it. Same resolution the
// register(ctx) path uses via ctx.authSession.
const connectorModuleHostOptions = {
  resolveActor: async () => {
    const { resolveExtensionActorSummary } = await import("@/lib/extension-host-actor");
    const s = await resolveExtensionActorSummary();
    return { userId: s?.userId ?? undefined, orgId: s?.organizationId ?? undefined };
  },
};

// Exported so a hermetic test can run the registration pass against a stub
// server and assert the registered tool count stays below the 128 function-tool
// ceiling that the OpenAI Responses API silently truncates above. Future module
// additions get a typecheck failure if they push past the cap.
export async function registerAllCapabilities(server: McpRuntimeToolServer) {
  // Wire the canonical install/lifecycle gate into the dynamic
  // agent MCP tool registration. The agents package cannot import the canonical
  // store (it lives in @cinatra-ai/extensions, which depends on agents), so the
  // host injects the gate: only agents with an `active|locked` installed_extension
  // manifest register as tools. Read per registration pass so an archive/uninstall
  // is reflected on the next tools/list without a restart. This is the LIFECYCLE
  // gate; the visibility policy (exclude PRIVATE agents) is applied
  // separately inside registerPublishedAgentTools via isAgentPubliclyDiscoverable.
  setLiveAgentManifestProvider(async () => {
    const manifests = await readActiveManifestsFromStore({ kind: "agent" });
    return new Set(manifests.map((m) => m.packageName));
  });

  // Record the tool names the platform + manifest-discovered modules register
  // so the extension replay below can skip any name already claimed (dedup — the vendored server's
  // duplicate behavior is not relied upon). Non-registerTool members delegate to
  // the real server (bound to it, not the proxy, to avoid proxy-`this` surprises).
  //
  // SEED reserved names the host registers OUTSIDE this function: the runtime
  // server registers `system_screen_lookup` AFTER registerCapabilities returns
  // (packages/mcp-server). If an extension replayed that name first, the host's
  // later registration would throw "already registered" and break server build.
  const RESERVED_HOST_TOOL_NAMES = ["system_screen_lookup"];
  const registeredNames = new Set<string>(RESERVED_HOST_TOOL_NAMES);
  const recordingServer = new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, config: unknown, handler: unknown) => {
          registeredNames.add(name);
          return (target.registerTool as (...a: unknown[]) => unknown)(name, config, handler);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpRuntimeToolServer;

  for (const mod of preConnectorPlatformModules) {
    await mod.registerCapabilities(recordingServer);
  }

  // Manifest-discovered connector MCP modules — same slot the hand-curated
  // connector list occupied. Registered through the SAME recording pass as the
  // platform modules so the replay below dedupes against them — no connector
  // package is named on this path (the generated manifest is the only place a
  // connector is identified).
  for (const mod of await loadConnectorMcpModules(connectorModuleHostOptions)) {
    await mod.registerCapabilities(recordingServer);
  }

  for (const mod of postConnectorPlatformModules) {
    await mod.registerCapabilities(recordingServer);
  }

  // PRIMARY extension registration mechanism: replay EXTENSION-registered MCP
  // tools (register(ctx) → ctx.mcp.registerTool). An extension that registers
  // its tools at activation needs no module entry at all — this replay is how
  // extension tools reach the server. Runs AFTER the platform + discovered
  // modules so a name they already claimed is SKIPPED — deliberate precedence:
  // a runtime registration must never displace (or shadow-allow over) a tool
  // the host/bundled surface already serves. Wrap the extension's plain
  // handler result into the MCP content/structuredContent envelope (mirrors
  // the connector modules). Track which tools were ACTUALLY registered (not
  // skipped) → the authz boundary keys its shadow-allow on this EFFECTIVE
  // set, so a skipped (host-colliding) registration can never unlock a host
  // tool.
  const effectiveExtensionTools: { name: string; packageName: string }[] = [];
  for (const tool of listExtensionMcpTools()) {
    if (registeredNames.has(tool.name)) {
      console.debug(
        `[mcp] extension tool "${tool.name}" (${tool.packageName}) skipped — name already claimed by a registered module or a reserved host built-in`,
      );
      continue;
    }
    registeredNames.add(tool.name);
    effectiveExtensionTools.push({ name: tool.name, packageName: tool.packageName });
    const handler = tool.handler;
    (server.registerTool as (...a: unknown[]) => unknown)(
      tool.name,
      {
        title: tool.name,
        description: tool.description ?? tool.name,
        // Standard Schema (zod) — the MCP SDK validates against `~standard`.
        inputSchema: (tool.inputSchema as z.ZodTypeAny) ?? z.object({}).passthrough(),
      },
      async (input: unknown) => {
        const raw = await handler(input);
        // Normalize the plain handler result into the MCP envelope (mirrors the
        // connector modules): arrays → { items }, objects → as-is,
        // scalars/undefined → { result }.
        const resolved = raw === undefined ? null : raw;
        return {
          content: [{ type: "text", text: JSON.stringify(resolved) }],
          structuredContent: Array.isArray(resolved)
            ? { items: resolved }
            : typeof resolved === "object" && resolved !== null
              ? (resolved as Record<string, unknown>)
              : { result: resolved },
        };
      },
    );
  }
  // Publish the EFFECTIVE extension-tool set so the authz boundary shadow-allows
  // only tools actually registered into the server (never a skipped collision).
  markEffectiveExtensionMcpTools(effectiveExtensionTools);
}

/** A captured MCP tool handler — the SDK callback `(args, extra) => CallToolResult`. */
type CapturedMcpToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * Build the host's UNIVERSAL in-process primitive-handler map
 * so `ctx.mcp.callPrimitive(name, input)` can invoke ANY host primitive by name,
 * the same code path the live MCP transport uses. Captures every registered
 * module's `registerTool(name, config, handler)` plus the replayed extension tools into a
 * `name → handler` map by running the SAME registration pass against a pure
 * RECORDING server (no real transport, no live server mutated). The captured
 * handler is the MCP-SDK callback `(args, extra) => CallToolResult`; the
 * self-invoker (`@/lib/extension-self-mcp`) runs it under the caller's resolved
 * MCP request-context and unwraps the result envelope.
 *
 * The recording server stubs the non-`registerTool` surface
 * (`registerResource`/`registerPrompt`/`registerScreen`) as no-ops — module
 * registrations only call `registerTool`, but the stubs keep an errant call from
 * throwing. The capability modules register idempotently (replace-by-id), so
 * building this map alongside the live registration is side-effect-safe; callers
 * should still MEMOISE it (see `extension-self-mcp`) to build it at most once.
 */
export async function buildHostSelfPrimitiveHandlers(): Promise<Map<string, CapturedMcpToolHandler>> {
  const handlers = new Map<string, CapturedMcpToolHandler>();
  const recordingServer = {
    registerTool: (name: string, _config: unknown, handler: CapturedMcpToolHandler) => {
      // Mirror the live server: the MCP SDK rejects a duplicate tool name, so a
      // silent overwrite here would let the self-call surface diverge from the
      // live transport. Fail loudly instead.
      if (handlers.has(name)) {
        throw new Error(
          `[mcp] duplicate tool registration "${name}" during self-primitive capture (the live server would reject it)`,
        );
      }
      handlers.set(name, handler);
      return undefined as never;
    },
    registerResource: () => undefined as never,
    registerPrompt: () => undefined as never,
    registerScreen: () => undefined,
  } as unknown as McpRuntimeToolServer;

  // Platform + manifest-discovered connector modules in the SAME order the
  // live server registers them (pre-connector platform block, connector block,
  // post-connector platform block).
  for (const mod of preConnectorPlatformModules) {
    await mod.registerCapabilities(recordingServer);
  }

  // Same discovery + options the live server uses, so the captured map mirrors
  // the live tool surface.
  for (const mod of await loadConnectorMcpModules(connectorModuleHostOptions)) {
    await mod.registerCapabilities(recordingServer);
  }

  for (const mod of postConnectorPlatformModules) {
    await mod.registerCapabilities(recordingServer);
  }

  // Replay extension-registered tools (register(ctx) → ctx.mcp.registerTool),
  // skipping names a platform/discovered module already claimed (dedupe parity
  // with the live server). Wrap the plain handler result into the MCP envelope
  // so the captured handler shape is uniform with the module-registered ones.
  for (const tool of listExtensionMcpTools()) {
    if (handlers.has(tool.name)) continue;
    const handler = tool.handler;
    handlers.set(tool.name, async (input: unknown) => {
      const raw = await handler(input);
      const resolved = raw === undefined ? null : raw;
      return {
        content: [{ type: "text", text: JSON.stringify(resolved) }],
        structuredContent: Array.isArray(resolved)
          ? { items: resolved }
          : typeof resolved === "object" && resolved !== null
            ? (resolved as Record<string, unknown>)
            : { result: resolved },
      };
    });
  }

  return handlers;
}

function readMcpServerSettings() {
  return readConnectorConfigFromDatabase<Partial<McpServerSettings>>(MCP_SERVER_SETTINGS_KEY, {});
}

async function writeMcpServerSettings(value: McpServerSettings) {
  writeConnectorConfigToDatabase(MCP_SERVER_SETTINGS_KEY, value);
}

export const mcpServerAuthPlugins = createMcpServerAuthPlugins({
  authBasePath: "/api/auth",
  mcpBasePath: "/api/mcp",
  adminBasePath: "/configuration/mcp",
  handshakeBasePath: "/api/mcp",
  scopes: ["openid", "profile", "email", "offline_access", "mcp:connect"],
});

export const mcpServerMount = createMcpServerMount({
  auth,
  getSession: getAuthSession,
  authBasePath: "/api/auth",
  mcpBasePath: "/api/mcp",
  registerCapabilities: registerAllCapabilities,
  readSettings: readMcpServerSettings,
  adminBasePath: "/configuration/mcp",
  handshakeBasePath: "/api/mcp",
  reagentName: "Cinatra MCP Server",
  scopes: ["openid", "profile", "email", "offline_access", "mcp:connect"],
  serverName: "cinatra-mcp-server",
  serverVersion: "0.2.0",
  serverInstructions: CINATRA_MCP_INSTRUCTIONS,
  serverExperimental: CINATRA_MCP_EXPERIMENTAL,
  writeSettings: writeMcpServerSettings,
  getRunContext,
  readConfiguredLlmProviders: async () => {
    const providers = ["openai", "anthropic", "gemini"] as const;
    const results = await Promise.all(
      providers.map(async (p) => ({ p, adapter: await resolveProviderAdapter(p) })),
    );
    return results.filter((r) => r.adapter !== null).map((r) => r.p);
  },
  // Verify delegated MCP on-behalf-of tokens. Two flavors:
  //   1. chat-OBO (`cinatra.chat.mcp-obo`): the chat user calling via
  //      OpenAI's hosted MCP relay. Resolves to `delegation: "chat"` →
  //      chat tool-policy allowlist applies.
  //   2. agent-run-OBO (`cinatra.agent-run.mcp-obo`): an agent dispatched
  //      by the chat, calling cinatra-mcp through the bridge. Resolves to
  //      `delegation: "agent_run"` → unrestricted at registration time,
  //      per-handler authz + `enforceMcpBoundary` gate the rest. The
  //      run's owner identity (userId + orgId) is carried in the token
  //      and the runId is propagated into the request store for audit.
  //
  // App-layer callback because the mcp-server package cannot import
  // app-local modules (no `@/` imports in packages/mcp-server). Try chat
  // first then agent-run — both verifiers are fail-closed (return null on
  // any mismatch), and the chat token type discriminator (`t` claim) is
  // distinct from the agent-run discriminator, so the order is purely
  // about which path is more common.
  verifyDelegatedActorToken: async (input) => {
    const chatActor = await verifyChatMcpActorToken(input);
    if (chatActor) return chatActor;
    return verifyAgentRunMcpActorToken(input);
  },
});
