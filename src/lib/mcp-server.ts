import "@/lib/extensions"; // initialises extensionRegistry side effects
import "@/lib/register-test-delivery-send-port"; // wires the run-scoped test-delivery send PORT (#1625)
import { createMcpServerAuthPlugins, createMcpServerMount, type McpServerSettings, type McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { CINATRA_MCP_INSTRUCTIONS, CINATRA_MCP_EXPERIMENTAL } from "./mcp-instructions";
import { getRunContext } from "./agent-run-context-registry";
import {
  resolveDurableRunContext,
  recordMcpRunContextServedBy,
} from "./agent-run-context-durable";
import { readAgentRunByTokenHash } from "@cinatra-ai/agents";
import { verifyChatMcpActorToken } from "./chat-mcp-actor-token";
import { verifyAgentRunMcpActorToken } from "./agent-run-mcp-actor-token";
import { verifyWidgetMcpActorToken } from "./widget-mcp-actor-token";
import { createObjectsModule } from "@cinatra-ai/objects/module";
import { createArtifactsModule } from "@/lib/artifacts/mcp";
import { createContextModule } from "@/lib/artifacts/context-mcp";
import { createApprovalsMcpModule } from "@/app/configuration/approvals/approvals-mcp";
import { createProjectSeamMcpModule } from "@/lib/project-seam-mcp";
import { createAssistantMcpModule } from "@/lib/assistant-mcp";
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
import { createExtensionsModule } from "@cinatra-ai/extensions/mcp-module";
import { readActiveManifestsFromStore } from "@cinatra-ai/extensions/runtime-discovery-host";
import { setLiveAgentManifestProvider } from "@cinatra-ai/agents";
import { auth } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { resolveProviderAdapter } from "@cinatra-ai/llm";
import { z } from "zod";
import {
  listExtensionMcpTools,
  markEffectiveExtensionMcpTools,
  unmarkEffectiveExtensionMcpToolCollisions,
} from "@/lib/extension-mcp-registry";
// Edge-bound serving chokepoint (cinatra#1392 Gap 1 wiring): an extension tool
// dispatch consults the TRUSTED dependent identity and — when its resolved edge
// pins a NON-DEFAULT version of the tool's package — serves THAT version's
// retained handler from the version-keyed registry, fail-closed (a refusal
// never falls through to the global/default handler).
// cinatra#1392 S8 adds the DISCOVERY union: the per-request registration pass
// plans, for the CURRENT caller, which extension tool names to register — a
// pinned package advertises the RESOLVED version's names + schemas (validation
// runs against the resolved version's registered schema, not the default's),
// including names existing ONLY in the pinned version (strict versioned-only
// dispatch), and hides default names the pinned version does not register.
import {
  dispatchExtensionMcpToolEdgeBound,
  dispatchPlannedExtensionMcpTool,
  dispatchVersionedOnlyExtensionMcpTool,
  planExtensionToolDiscovery,
  planSelfInvokerRetainedUnion,
} from "@/lib/extension-edge-bound-serving";
import { listServableVersionKeyedMcpTools } from "@/lib/extension-version-keyed-serving";

const MCP_SERVER_SETTINGS_KEY = "mcp_server";

// Reserved names the host registers OUTSIDE the shared registration pass: the
// runtime server registers `system_screen_lookup` AFTER registerCapabilities
// returns (packages/mcp-server). Seeded into BOTH builders (the live-transport
// replay AND the in-process self-primitive capture — codex S8 round-1 #3) so
// an extension can neither break the live server build by claiming the name
// first nor slip an in-process handler + effective-set entry under it.
const RESERVED_HOST_TOOL_NAMES = ["system_screen_lookup"];

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
  // Unified approvals_* (list/get/decide) over the ApprovalSource registry —
  // federates agent creation requests and (once they join the registry) the
  // marketplace sources. Agent-adjacent slot.
  createApprovalsMcpModule(),
  // Project-manager pilot host tool seam (cinatra#1033 W3 / #1032 D3):
  // project_instantiate / project_tick_context / project_dispatch_worker as
  // run-token-authenticated MCP tools offered to the PM seat's own agent run.
  createProjectSeamMcpModule(),
  // Generalized assistant MCP surface (cinatra#1037 P5.5): assistant_send /
  // assistant_thread_list / assistant_thread_get — registry-driven,
  // handle-generic tools over the STRUCTURED assistant_threads/assistant_turns
  // store. The legacy chat_thread_* set (createChatModule below) stays
  // registered untouched; its teardown is P5.6.
  createAssistantMcpModule(),
  createExtensionsModule(),
  createChatModule(),
  createTriggerModule(),
  createDashboardsModule(),
  createDashboardCubesMcpModule(),
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

/** The MCP result envelope for a plain extension-handler value (mirrors the
 * connector modules): arrays → { items }, objects → as-is, scalars/undefined →
 * { result }. Shared by the live-transport replay and the self-invoker capture
 * so the two surfaces stay byte-identical. */
function wrapExtensionToolResult(raw: unknown) {
  const resolved = raw === undefined ? null : raw;
  return {
    content: [{ type: "text", text: JSON.stringify(resolved) }],
    structuredContent: Array.isArray(resolved)
      ? { items: resolved }
      : typeof resolved === "object" && resolved !== null
        ? (resolved as Record<string, unknown>)
        : { result: resolved },
  };
}

/** Request-scoped info the transport threads into the per-request registration
 * pass (cinatra#1392 S8 discovery union). `verifiedAgentRunId` is the agent-run
 * id from the SIGNED OBO token ONLY — the same (and only) transport-side trusted
 * identity source the S7 dispatch chokepoint consults. */
export type RegisterCapabilitiesRequestContext = {
  verifiedAgentRunId?: string;
};

// Exported so a hermetic test can run the registration pass against a stub
// server and assert the registered tool count stays below the 128 function-tool
// ceiling that the OpenAI Responses API silently truncates above. Future module
// additions get a typecheck failure if they push past the cap.
export async function registerAllCapabilities(
  server: McpRuntimeToolServer,
  requestContext?: RegisterCapabilitiesRequestContext,
) {
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
  // cinatra#1392 S8 — DISCOVERY UNION: plan the extension-tool set for the
  // CURRENT caller. With no transport-verified identity the planner short-
  // circuits to the exact default replay (byte-identical pre-S8 behavior); with
  // one, a pinned package advertises the RESOLVED version's names, with input
  // validated against THAT version's registered schema.
  const plan = await planExtensionToolDiscovery(listExtensionMcpTools(), {
    getCtxIdentity: () => undefined,
    getDependentInstallId: () => undefined,
    getVerifiedRunId: () => requestContext?.verifiedAgentRunId,
  });
  for (const note of plan.notes) console.warn(`[mcp] discovery union: ${note}`);
  const skippedCollisions: { name: string; packageName: string }[] = [];
  for (const entry of plan.entries) {
    const name = entry.tool.name;
    const packageName = entry.mode === "default" ? entry.tool.packageName : entry.packageName;
    if (registeredNames.has(name)) {
      console.debug(
        `[mcp] extension tool "${name}" (${packageName}) skipped — name already claimed by a registered module or a reserved host built-in`,
      );
      skippedCollisions.push({ name, packageName });
      continue;
    }
    registeredNames.add(name);
    effectiveExtensionTools.push({ name, packageName });
    // The advertised description/schema follow the PLANNED registration: the
    // default's for default entries; the RETAINED version's for versioned
    // entries (the MCP SDK validates input against `~standard` of this schema —
    // the resolved version's, per the S8 contract). The dispatch below is
    // PLAN-PINNED: it re-resolves the edge at call time and REFUSES on drift
    // (codex round-0 #3 — input validated against one version's schema must
    // never reach another version's handler).
    const registration = entry.tool;
    const dispatchPlanned =
      entry.mode === "default"
        ? (input: unknown) =>
            dispatchPlannedExtensionMcpTool({ expected: "default", tool: entry.tool }, input)
        : (input: unknown) =>
            dispatchPlannedExtensionMcpTool(
              { expected: "versioned", packageName: entry.packageName, name, version: entry.version },
              input,
            );
    (server.registerTool as (...a: unknown[]) => unknown)(
      name,
      {
        title: name,
        description: registration.description ?? name,
        // Standard Schema (zod) — the MCP SDK validates against `~standard`.
        inputSchema: (registration.inputSchema as z.ZodTypeAny) ?? z.object({}).passthrough(),
      },
      async (input: unknown) => {
        const raw = await dispatchPlanned(input);
        return wrapExtensionToolResult(raw);
      },
    );
  }
  // Publish the EFFECTIVE extension-tool set so the authz boundary shadow-allows
  // only tools actually registered into the server (never a skipped collision).
  // MERGE semantics (cinatra#1392 S8): per-request builds now differ per caller
  // (a versioned-only name registers only for its edge-bound dependent), so a
  // replace-on-build would let concurrent builds erase each other's effective
  // entries mid-call. Collision-skipped names are explicitly UNMARKED (codex
  // round-0 #4 — a stale entry must not outlive a later host-name collision);
  // teardown still removes a package's entries wholesale.
  markEffectiveExtensionMcpTools(effectiveExtensionTools);
  unmarkEffectiveExtensionMcpToolCollisions(skippedCollisions);
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
  const unionEffective: { name: string; packageName: string }[] = [];
  const unionSkipped: { name: string; packageName: string }[] = [];
  // Names claimed by host/platform modules + reserved built-ins BEFORE the
  // extension replay. This is the ONLY collision class whose skip may UNMARK
  // an effective entry (codex S8 round-2 #1): the unmark is package-scoped, so
  // pushing an extension-extension dedupe into the skip list would erase the
  // WINNING entry's attribution whenever the packages match (default `P:x` +
  // retained `P@v:x`, or two retained versions of `P:x`) and the deny-by-
  // default boundary would then block a legitimately-registered handler.
  const hostClaimedNames = new Set<string>([...handlers.keys(), ...RESERVED_HOST_TOOL_NAMES]);
  for (const tool of listExtensionMcpTools()) {
    if (hostClaimedNames.has(tool.name)) {
      unionSkipped.push({ name: tool.name, packageName: tool.packageName });
      continue;
    }
    handlers.set(tool.name, async (input: unknown) => {
      // Edge-bound serve (cinatra#1392 Gap 1) — same chokepoint as the live
      // transport replay, so the in-process self-invoker serves identically.
      // (No plan-pinning here: this map applies no schema validation, so the
      // dispatch-time decision is authoritative — see
      // dispatchPlannedExtensionMcpTool's doc.)
      const raw = await dispatchExtensionMcpToolEdgeBound(tool, input);
      return wrapExtensionToolResult(raw);
    });
    unionEffective.push({ name: tool.name, packageName: tool.packageName });
  }

  // cinatra#1392 S8 — DISCOVERY UNION, self-invoke side. This map is memoised
  // per activation generation (extension-self-mcp), so it cannot be built
  // per-caller like the live transport's per-request server. Instead the UNION
  // of ALL servable retained (non-default) tool names is added, each behind the
  // STRICT versioned-only dispatch that re-verifies the CALLER's edge binding
  // at call time — a caller whose edges do not pin a version serving the name
  // is refused with evidence, never served across the pin. First name wins on
  // a cross-version/cross-package collision (the dispatch keys the point lookup
  // on the CALLER's own pinned version, so the winner only fixes which package
  // the decision is resolved against). Collision classes are SPLIT (codex S8
  // round-2 #1): a host/module/reserved collision is unmark-worthy (round-1
  // #3 — a stale attribution must not survive it); an extension-extension
  // dedupe (the default replay or an earlier retained sibling already serves
  // the name) preserves the WINNING registration + attribution.
  const retainedUnion = planSelfInvokerRetainedUnion(listServableVersionKeyedMcpTools(), {
    hostClaimedNames,
    extensionClaimedNames: new Set(unionEffective.map((t) => t.name)),
  });
  for (const entry of retainedUnion.register) {
    const target = { packageName: entry.packageName, name: entry.name };
    handlers.set(entry.name, async (input: unknown) => {
      const raw = await dispatchVersionedOnlyExtensionMcpTool(target, input);
      return wrapExtensionToolResult(raw);
    });
  }
  for (const deduped of retainedUnion.dedupedExtensionNames) {
    console.debug(
      `[mcp] self-invoker union: retained ${deduped.packageName}@${deduped.version} tool ` +
        `"${deduped.name}" already served by the extension replay — deduped (winning attribution preserved)`,
    );
  }
  unionEffective.push(...retainedUnion.effective);
  unionSkipped.push(...retainedUnion.skippedHostCollisions);
  // The union names must be in the EFFECTIVE set too (merge semantics): the
  // in-process invoker runs the same deny-by-default boundary as the live
  // transport, and an unmarked versioned-only name would be blocked as an
  // unclassified primitive even for its legitimately edge-bound caller.
  // Collision-skipped names are unmarked for the same reason the live builder
  // unmarks them (codex round-0 #4).
  markEffectiveExtensionMcpTools(unionEffective);
  unmarkEffectiveExtensionMcpToolCollisions(unionSkipped);

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
  // #1195 durable run-context binding: resolve the run-token-keyed redis
  // binding through the ONE run-token seam (readAgentRunByTokenHash — the run
  // row stays the source of truth). App-wired because packages/mcp-server
  // cannot import the app layer. The resolver classifies its own failures
  // (transport ⇒ absent, present-but-unresolvable ⇒ invalid) and never throws.
  resolveDurableRunContext: (rawBearerToken: string) =>
    resolveDurableRunContext(rawBearerToken, readAgentRunByTokenHash),
  // #1195 cutover metric — counts which channel attributed each MCP request
  // (the registry-removal gate needs proof no production traffic still rides
  // the in-process registry).
  onRunContextServedBy: recordMcpRunContextServedBy,
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
  //   3. widget-OBO (`cinatra.widget.mcp-obo`, S5 cinatra#1221): the
  //      public-site (WordPress/Drupal) widget turn on /api/assistants/chat.
  //      Resolves to `delegation: "public_site_widget"` → the CLOSED,
  //      kind-keyed `delegated-widget` tool policy (only the bound kind's
  //      `*_content_editor_run`), the pinned canonical `instanceId`, and
  //      `platformRole: "member"` (floored at mint). A missing/blank `inst`
  //      or `knd`, wrong `t`, expired/over-long TTL, or bad HMAC → the
  //      verifier returns null → this falls through to the machine-token
  //      path, DENIED at the boundary (never an un-pinned OBO actor).
  //
  // App-layer callback because the mcp-server package cannot import
  // app-local modules (no `@/` imports in packages/mcp-server). Each token
  // type carries a DISTINCT `t` discriminator and every verifier is
  // fail-closed (returns null on any mismatch), so the try order is purely
  // about which path is more common — a non-matching type can never be
  // mis-resolved by the wrong verifier.
  verifyDelegatedActorToken: async (input) => {
    const chatActor = await verifyChatMcpActorToken(input);
    if (chatActor) return chatActor;
    // The agent-run verifier already surfaces the NORMALIZED
    // `connectorInstancePin` from its signed `pin:{ck,iid}` claim (cinatra#2017
    // S2 / B1); absent ⇒ org scope. No re-mapping needed here.
    const agentRunActor = await verifyAgentRunMcpActorToken(input);
    if (agentRunActor) return agentRunActor;
    const widgetActor = await verifyWidgetMcpActorToken(input);
    if (!widgetActor) return null;
    // Normalize the widget token's native `inst`/`knd` into the SAME unified
    // `connectorInstancePin` shape (cinatra#2017 S2 / B1) — a widget turn is
    // ALWAYS instance-pinned, so the governed invoker reads one field regardless
    // of token type.
    return {
      ...widgetActor,
      connectorInstancePin: {
        connectorKey: widgetActor.kind,
        instanceId: widgetActor.instanceId,
      },
    };
  },
});
