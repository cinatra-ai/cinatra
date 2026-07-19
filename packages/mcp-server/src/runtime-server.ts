import {
  McpServer,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type ResourceMetadata,
  type ResourceTemplate,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { isDelegatedChatMcpToolAllowed } from "./delegated-chat-tool-policy";
import {
  isDelegatedWidgetMcpToolAllowed,
  type WidgetDelegationKind,
} from "./delegated-widget-tool-policy";
import { mcpRequestContextStorage } from "./request-context";

export type ScreenDescriptor = {
  readonly screen_id: string;
  readonly url_pattern: string;
  readonly required_args: readonly string[];
  readonly capabilities: readonly string[];
  readonly title: string;
  readonly module: string;
};

export type NavigationTarget = {
  readonly screen_id: string;
  readonly url: string;
  readonly capabilities: readonly string[];
  readonly requires: Readonly<Record<string, string>>;
};

export type McpRuntimeToolServer = {
  registerTool: InstanceType<typeof McpServer>["registerTool"];
  registerResource(name: string, uri: string, config: ResourceMetadata, cb: ReadResourceCallback): void;
  registerResource(name: string, template: ResourceTemplate, config: ResourceMetadata, cb: ReadResourceTemplateCallback): void;
  registerPrompt: InstanceType<typeof McpServer>["registerPrompt"];
  registerScreen(descriptor: ScreenDescriptor): void;
};

/**
 * Request-scoped, transport-VERIFIED facts threaded into the per-request
 * `registerCapabilities` pass (cinatra#1392 S8 — the extension-tool discovery
 * union registers a caller-dependent tool set). `verifiedAgentRunId` is the
 * run id from a VERIFIED agent-run OBO token ONLY (the delegated-actor
 * verifier's output) — never a header/registry-derived run id, which stays
 * forgeable on the legacy channels (#1195).
 */
export type McpRegisterCapabilitiesRequestContext = {
  verifiedAgentRunId?: string;
};

function registerPlaceholderCapabilities(server: InstanceType<typeof McpServer>) {
  void server;
  // Placeholder for future tools/resources/prompts registration.
}

/**
 * Build a fresh per-request MCP runtime server.
 *
 * NOTE (future S5 — compiled capability cache, DEFERRED): per-request
 * registration is intentionally PRESERVED here. A future compiled-cache layer
 * MUST key + invalidate by the FULL capability surface — tools, resources,
 * prompts, AND screens — together with DB-derived published-agent surface
 * changes and the delegated-chat-vs-unrestricted tool policy. A cache keyed on
 * fewer axes would serve a stale or over-broad tool list across activation /
 * policy transitions. Until that work lands, every request rebuilds, which is
 * behavior-preserving and fail-closed.
 */
export async function createMcpRuntimeServer(input: {
  name: string;
  version: string;
  registerCapabilities?: (
    server: McpRuntimeToolServer,
    requestContext?: McpRegisterCapabilitiesRequestContext,
  ) => void | Promise<void>;
  /**
   * Forwarded verbatim as the second argument of `registerCapabilities`
   * (cinatra#1392 S8). Optional; an absent context keeps the registration pass
   * caller-agnostic (the exact pre-S8 behavior).
   */
  registerRequestContext?: McpRegisterCapabilitiesRequestContext;
  instructions?: string;
  experimental?: Record<string, object>;
  /**
   * When set to "delegated-chat", the runtime server only registers tools
   * the delegated-chat policy allows (so `tools/list` never
   * advertises a denied tool and `tools/call` can't resolve one). Allowed
   * tools are additionally wrapped with a defense-in-depth handler guard
   * that re-checks `mcpRequestContextStorage.delegatedRestricted` at call
   * time. "unrestricted" (default) registers everything as before.
   *
   * "delegated-widget" (S5-W1 §4.1) applies the CLOSED, KIND-KEYED
   * `public_site_widget` allowlist instead: only the bound kind's
   * `*_content_editor_run` primitive registers (`widgetDelegationKind` names
   * the kind). This is STRICTLY narrower than delegated-chat and enforces the
   * G9 knd↔primitive binding at the boundary — a wordpress widget token can
   * never see/call `drupal_content_editor_run`, and vice versa.
   */
  toolPolicyMode?: "unrestricted" | "delegated-chat" | "delegated-widget";
  /**
   * REQUIRED when `toolPolicyMode === "delegated-widget"`: the connector KIND
   * the widget delegation is bound to (the OBO token's `knd` claim, resolved
   * from the verified delegated actor at the transport boundary — NEVER caller
   * input). Selects the kind-scoped allowlist. Ignored for other modes.
   */
  widgetDelegationKind?: WidgetDelegationKind;
}) {
  const server = new McpServer(
    {
      name: input.name,
      version: input.version,
    },
    { instructions: input.instructions },
  );

  // Registration-time tool filter + call-time guard for delegated-chat
  // requests. A fresh runtime server is built per request
  // (see transportHandler), so when the request is delegated we simply skip
  // registering denied tools — that filters `tools/list` AND makes
  // `tools/call` unable to resolve them. The handler guard is belt-and-
  // braces in case a tool slips the registration filter.
  //
  // Every wrapped tool also runs the registry-driven deny-by-default check.
  // Per-primitive `status` in
  // src/lib/authz/inventory-augment.ts controls strict vs. shadow:
  //   - status === "enforced": throw a 403 on deny.
  //   - status === "partial" / "unenforced": emit audit, allow through.
  // Primitives move to "enforced" only after their consumers are validated.
  // The delegated-chat carve-out (`workflow_draft_create` /_update)
  // short-circuits via the typed CarveOut entry.
  const policyMode = input.toolPolicyMode ?? "unrestricted";
  const widgetKind = input.widgetDelegationKind;

  // Registration-time filter: is the named tool permitted under the ACTIVE
  // policy mode? delegated-widget applies the CLOSED kind-keyed allowlist (G9 /
  // G12) selected by `widgetKind`. An absent/unknown widgetKind on a
  // delegated-widget request denies everything (fail-closed) — no widget
  // delegation may register a tool without a resolved kind.
  const isRegistrableUnderPolicy = (name: string): boolean => {
    if (policyMode === "delegated-chat") return isDelegatedChatMcpToolAllowed(name);
    if (policyMode === "delegated-widget") {
      return widgetKind ? isDelegatedWidgetMcpToolAllowed(widgetKind, name) : false;
    }
    return true;
  };

  // Call-time guard (defense-in-depth): re-derive the policy from the DELEGATED
  // ACTOR in the live ALS frame so a tool that somehow slipped registration is
  // still denied. Delegation-aware — chat uses the chat allowlist, a
  // public_site_widget delegation uses its own KIND-scoped allowlist (reading
  // the kind from the actor's `knd`, NEVER caller input).
  const isCallableForCtxActor = (
    ctx: ReturnType<typeof mcpRequestContextStorage.getStore>,
    name: string,
  ): boolean => {
    const actor = ctx?.delegatedActor;
    if (actor?.delegation === "public_site_widget") {
      return isDelegatedWidgetMcpToolAllowed(actor.kind, name);
    }
    // Legacy chat gate keyed on `delegatedRestricted` (set only for the chat
    // delegation at the transport boundary).
    if (ctx?.delegatedRestricted) return isDelegatedChatMcpToolAllowed(name);
    return true;
  };

  const policedRegisterTool: InstanceType<typeof McpServer>["registerTool"] = ((
    name: string,
    config: unknown,
    cb: (...cbArgs: unknown[]) => unknown,
  ) => {
    if (!isRegistrableUnderPolicy(name)) {
      // Not registered: invisible to tools/list, unresolvable by tools/call.
      return undefined as never;
    }
    return (
      server.registerTool as unknown as (
        n: string,
        c: unknown,
        h: (...a: unknown[]) => unknown,
      ) => unknown
    )(name, config, async (...cbArgs: unknown[]) => {
      const ctx = mcpRequestContextStorage.getStore();
      if (!isCallableForCtxActor(ctx, name)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool ${name} is not available to this delegated MCP request.`,
            },
          ],
          isError: true,
        };
      }
      // Boundary enforcement.
      // We avoid pulling the authz module into the per-tool hot path until the
      // wrapper runs the first call, so cold-boot cost stays outside this
      // closure. Any failure of the boundary check (failed import, runtime
      // exception, etc.) MUST fail closed — never fall through to the user
      // handler.
      try {
        const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
        const decision = await enforceMcpBoundary({
          primitiveName: name,
          ctx,
          delegatedRestricted: !!ctx?.delegatedRestricted,
        });
        if (!decision.allowed && decision.shouldBlock) {
          return {
            content: [
              { type: "text", text: `Authorization denied for ${name}: ${decision.reason}` },
            ],
            isError: true,
          };
        }
      } catch (err) {
        // Fail-closed. The boundary is the deny-by-default backstop; we
        // never allow a tool call to slip through on import / runtime
        // failure of the kernel.
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[mcp-boundary] enforcement error on ${name}:`, err);
        }
        return {
          content: [
            { type: "text", text: `Authorization unavailable for ${name}: boundary_error` },
          ],
          isError: true,
        };
      }
      // Re-enter the ALS frame around the user handler. The outer
      // mcpRequestContextStorage.run wrapper at the transport entry
      // populates `ctx`, but the await boundaries inside this wrapper
      // (boundary import + enforceMcpBoundary) can drop the ALS frame on
      // some runtimes — observed live as `dashboards_cube_load` raising
      // "missing user/organization identity in MCP request context" while
      // sibling reads succeed. Minimal,
      // null-safe: if no ctx was captured, the bare callback runs (matches
      // the behavior for unauthenticated dev probes).
      return ctx ? mcpRequestContextStorage.run(ctx, () => cb(...cbArgs)) : cb(...cbArgs);
    });
  }) as InstanceType<typeof McpServer>["registerTool"];

  // Capability merge order. Must be called BEFORE server.connect(transport);
  // the vendored SDK throws SdkErrorCode.AlreadyConnected once a transport is attached
  // (vendor/.../index.mjs:651). Done here, immediately after construction, so the
  // experimental block is merged into capabilities before any registerCapabilities
  // callback or connect attempt.
  if (input.experimental) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.server.registerCapabilities({ experimental: input.experimental as any });
  }

  const screenRegistry = new Map<string, ScreenDescriptor>();
  const toolServer: McpRuntimeToolServer = {
    // Policed registerTool for the delegated-chat allowlist.
    registerTool: policedRegisterTool,
    registerResource: server.registerResource.bind(server) as InstanceType<typeof McpServer>["registerResource"],
    registerPrompt: server.registerPrompt.bind(server),
    registerScreen(descriptor) {
      if (screenRegistry.has(descriptor.screen_id)) {
        throw new Error(`Screen "${descriptor.screen_id}" is already registered.`);
      }
      screenRegistry.set(descriptor.screen_id, descriptor);
    },
  };

  registerPlaceholderCapabilities(server);
  await input.registerCapabilities?.(toolServer, input.registerRequestContext);

  policedRegisterTool(
    "system_screen_lookup",
    {
      title: "Screen lookup",
      description:
        "Returns registered screens by screen_id or module name. Call with no arguments to list all known screens.",
      inputSchema: z.object({
        screen_id: z.string().optional(),
        module: z.string().optional(),
      }),
    },
    async (lookupInput) => {
      const entries = [...screenRegistry.values()];
      const filtered = lookupInput.screen_id
        ? entries.filter((s) => s.screen_id === lookupInput.screen_id)
        : lookupInput.module
          ? entries.filter((s) => s.module === lookupInput.module)
          : entries;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
        structuredContent: { screens: filtered },
      };
    },
  );

  return server;
}
