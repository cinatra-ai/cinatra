import {
  McpServer,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type ResourceMetadata,
  type ResourceTemplate,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  evaluateDelegatedChatAdmission,
  type DelegatedChatDecision,
  unavailableDelegatedChatAdmissionSnapshot,
  type DelegatedChatAdmissionSnapshot,
} from "./delegated-chat-admission";
import {
  isDelegatedWidgetMcpToolAllowed,
  type WidgetDelegationKind,
} from "./delegated-widget-tool-policy";
import { mcpRequestContextStorage } from "./request-context";
import {
  CapabilityPlanRecorder,
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  type CapabilityPlan,
  type HostPrimitiveIdentity,
  type PlannedPrimitive,
} from "./capability-plan";

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

/**
 * The tool-handler callback of the STANDARD-SCHEMA `registerTool` overload
 * (cinatra#2218 L1).
 *
 * Consumers that must cast an untyped handler MUST use this and never
 * `Parameters<typeof server.registerTool>[2]`: `@modelcontextprotocol/server@2.0.0`
 * added a SECOND, deprecated raw-Zod-shape overload, and `Parameters<T>` on an
 * overloaded signature resolves to the LAST overload — which would pin the
 * raw-shape callback and, with it, demand `inputSchema: ZodRawShape` instead of
 * the Standard Schema every registry actually holds. Naming the callback type
 * directly makes the cast independent of overload ORDER, and keeps it a real
 * type rather than an `any`/`never` hole.
 */
export type McpRuntimeToolCallback = ToolCallback<z.ZodTypeAny>;

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
  /**
   * The identity core/bundled primitives are planned under (cinatra#2817 slice
   * 1). A registration that carries no host-written provenance stamp is a
   * core/bundled one and inherits this owner + RELEASE version, which is the
   * identity its migrated admission record is written against. Defaults to the
   * host package at this server's own version.
   */
  hostPrimitiveIdentity?: HostPrimitiveIdentity;
  /**
   * Resolves the capability key that gates a primitive whose provenance stamp
   * does not name one. Injected because the connector catalog is app-layer
   * state this package must not reach for.
   */
  resolveCapabilityKey?: (name: string) => string | null | undefined;
  /**
   * Receives the finished request-scoped capability plan once the registration
   * pass has run (cinatra#2817 slice 1).
   *
   * THE PLAN IS A BY-PRODUCT OF THE ONE PASS, not a second one: every entry is
   * recorded from inside the single choke point every registration passes
   * through, and `plan.servable` holds exactly the entries `registerTool`
   * accepted. A consumer that wants "what is actually servable on this request"
   * reads this rather than replaying module registration against its own sink —
   * two passes can disagree for any caller-dependent registration, which is the
   * disagreement class this seam exists to end.
   */
  onCapabilityPlan?: (plan: CapabilityPlan) => void;
  /**
   * The ONE immutable admission snapshot this request decides against
   * (cinatra#2817 slice 3).
   *
   * Loaded BEFORE registration and used for every decision the request makes —
   * registration filtering, the call-time guard, and (through the plan it
   * produces) the catalog. One snapshot per request is what stops those from
   * disagreeing when a revocation lands mid-request.
   *
   * ABSENT MEANS CLOSED, not open: a delegated-chat build with no snapshot gets
   * an explicitly UNAVAILABLE one and admits nothing. A caller that forgets to
   * wire this loses the chat surface; it does not silently open it.
   */
  delegatedChatAdmissionSnapshot?: DelegatedChatAdmissionSnapshot;
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

  // The request-scoped capability PLAN (cinatra#2817 slice 1). Recorded from
  // inside the ONE choke point below, so the plan and the live server are
  // produced by the SAME pass rather than by two replays that could disagree
  // for a caller-dependent registration.
  const planRecorder = new CapabilityPlanRecorder({
    // The core RELEASE identity, deliberately NOT `input.version` (the MCP
    // server's own protocol-surface version): core admission records are
    // written against the release identity, and a routine server-version bump
    // must not silently invalidate — or silently carry forward — a reviewed
    // security decision.
    host: input.hostPrimitiveIdentity ?? {
      packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
      version: HOST_PRIMITIVE_RELEASE_VERSION,
    },
    resolveCapabilityKey: input.resolveCapabilityKey,
  });

  // Registration-time filter: is the PLANNED primitive permitted under the
  // ACTIVE policy mode? delegated-widget applies the CLOSED kind-keyed
  // allowlist (G9 / G12) selected by `widgetKind`. An absent/unknown widgetKind
  // on a delegated-widget request denies everything (fail-closed) — no widget
  // delegation may register a tool without a resolved kind.
  //
  // The decision reads the PLANNED ENTRY, never the raw `(name, config)` pair.
  // That is the whole point of slice 1: the declaration, the owning package and
  // the exact resolved version were resolved ONCE, at the moment the
  // registration happened, and every later decision about this primitive — the
  // catalog, the call-time guard, the self-invoker — is made about that same
  // entry rather than about a name re-looked-up later.
  //
  // THE DECLARATION ADMITS NOTHING BY ITSELF, and the evaluator's order is the
  // proof: the family denies and the verb backstop run BEFORE any declaration
  // is read, and a declaration that survives them still has to match a
  // reviewed, version-bound admission record. So a connector cannot
  // self-classify its way past a denied family, the destructive-verb backstop,
  // or admission — a class it asserts about itself matches no review and is
  // refused as `self_classified_only`.
  // ABSENT MEANS CLOSED. A delegated-chat build handed no snapshot decides
  // against an explicitly unavailable one, so every primitive is refused with
  // `admission_store_unavailable` rather than slipping through an
  // unconditional branch.
  const admissionSnapshot: DelegatedChatAdmissionSnapshot =
    input.delegatedChatAdmissionSnapshot ??
    unavailableDelegatedChatAdmissionSnapshot({
      reason: "no_admission_snapshot_supplied",
      activationGeneration: -1,
      admissionGeneration: -1,
    });

  /** The shared evaluator, applied to one planned entry under this snapshot. */
  const chatDecision = (planned: PlannedPrimitive): DelegatedChatDecision =>
    evaluateDelegatedChatAdmission(planned, admissionSnapshot);

  const registrationRefusal = (planned: PlannedPrimitive): string | null => {
    // A CLOSED perimeter decides about the normalized name but the SDK serves
    // the name as registered. When the two differ, the thing the policy
    // reasoned about is not the thing the wire exposes — so on both delegated
    // perimeters a non-canonical casing is refused outright rather than
    // reconciled. Strictly narrowing (every cinatra primitive registers under
    // its canonical lowercase name), and it removes the whole class in which a
    // catalog entry, an admission key and a `tools/call` target could name
    // three different things.
    if (policyMode !== "unrestricted" && planned.registeredName !== planned.name) {
      return "non_canonical_primitive_name";
    }
    if (policyMode === "delegated-chat") {
      const decision = chatDecision(planned);
      return decision.allowed ? null : decision.reason;
    }
    if (policyMode === "delegated-widget") {
      // The widget perimeter is its own CLOSED, kind-keyed allowlist and is
      // deliberately NOT declaration-aware: a connector must not be able to
      // influence it in either direction (#2817 keeps it untouched too). It is
      // also deliberately NOT plan-aware — nothing about the capability plan
      // widens it, and its decision still reads only (kind, name).
      if (!widgetKind) return "widget_kind_unresolved";
      // The name AS REGISTERED, never the normalized one: the widget allowlist
      // is deliberately case-SENSITIVE (a `WordPress_Content_Editor_Run` is a
      // DIFFERENT primitive and must be denied, not case-folded into the
      // editor), so handing it a lower-cased name would widen it.
      return isDelegatedWidgetMcpToolAllowed(widgetKind, planned.registeredName)
        ? null
        : "widget_policy_denied";
    }
    return null;
  };

  // Call-time guard (defense-in-depth): re-derive the policy from the DELEGATED
  // ACTOR in the live ALS frame so a tool that somehow slipped registration is
  // still denied. Delegation-aware — chat uses the chat allowlist, a
  // public_site_widget delegation uses its own KIND-scoped allowlist (reading
  // the kind from the actor's `knd`, NEVER caller input).
  //
  // Keyed on the PLANNED entry, so registration and call time decide about the
  // same primitive identity rather than about a bare name.
  const isCallableForCtxActor = (
    ctx: ReturnType<typeof mcpRequestContextStorage.getStore>,
    planned: PlannedPrimitive,
  ): boolean => {
    const actor = ctx?.delegatedActor;
    if (actor?.delegation === "public_site_widget") {
      // Case-SENSITIVE by design — same reason as the registration filter.
      return isDelegatedWidgetMcpToolAllowed(actor.kind, planned.registeredName);
    }
    // Chat gate keyed on `delegatedRestricted` (set only for the chat delegation
    // at the transport boundary). Re-runs the SAME evaluator against the SAME
    // request snapshot the registration filter used, so a tool that somehow
    // slipped registration is still refused — and so registration and call time
    // can never disagree about one primitive within one request.
    //
    // INCLUDING the canonical-name rule (codex whole-diff round #3). "The same
    // perimeter" has to mean every rule, not just the evaluator: a tool that
    // reached this server through an unfiltered path would otherwise be admitted
    // under a mixed-case name that registration refuses outright, because the
    // evaluator case-folds. Defense in depth that skips one of the rules is not
    // depth.
    if (ctx?.delegatedRestricted) {
      if (planned.registeredName !== planned.name) return false;
      return chatDecision(planned).allowed;
    }
    return true;
  };

  // The raw, plan-recording implementation. Kept under its own precise type so
  // the internal reserved-built-in registration below can pass `planOptions`;
  // `policedRegisterTool` is the same function re-typed as the SDK's
  // `registerTool` for the capability surface handed to registration callbacks.
  const planRegisterTool = ((
    name: string,
    config: unknown,
    cb: (...cbArgs: unknown[]) => unknown,
    planOptions?: { reserved?: boolean },
  ) => {
    // PLAN FIRST, then decide, then register FROM the planned entry. The plan
    // records every registration the pass attempted (in registration order) and
    // the outcome of each, so `plan.servable` is the set that ACTUALLY
    // registered — never a second replay's guess at it.
    const planned = planRecorder.record(name, config, planOptions);
    const refusal = registrationRefusal(planned);
    if (refusal) {
      // Not registered: invisible to tools/list, unresolvable by tools/call.
      planRecorder.markRefused(planned, refusal);
      return undefined as never;
    }
    let handle: unknown;
    try {
      handle = (
        server.registerTool as unknown as (
          n: string,
          c: unknown,
          h: (...a: unknown[]) => unknown,
        ) => unknown
      )(planned.registeredName, config, async (...cbArgs: unknown[]) => {
      const ctx = mcpRequestContextStorage.getStore();
      if (!isCallableForCtxActor(ctx, planned)) {
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
      //
      // ONE SNAPSHOT PER REQUEST, ACROSS THE IN-PROCESS HOP TOO (cinatra#2817
      // slice 3). The frame re-entered here carries the snapshot this request
      // decided against, so a self-invocation the handler makes reuses it
      // instead of loading a fresher one. Two snapshots inside one request is
      // exactly the disagreement class the immutable snapshot exists to end:
      // the later one could admit what this request's perimeter refused.
      const frame =
        policyMode === "delegated-chat" && ctx
          ? { ...ctx, delegatedChatAdmissionSnapshot: admissionSnapshot }
          : ctx;
      return frame ? mcpRequestContextStorage.run(frame, () => cb(...cbArgs)) : cb(...cbArgs);
      });
    } catch (error) {
      // The SDK refused it (a duplicate name, an unusable schema). The entry is
      // NOT servable, and the plan must say so — an outcome that claimed
      // otherwise would let the catalog advertise a tool `tools/call` cannot
      // resolve.
      planRecorder.markRefused(planned, "register_tool_threw");
      throw error;
    }
    planRecorder.markRegistered(planned);
    return handle as never;
  }) as (
    name: string,
    config: unknown,
    cb: (...cbArgs: unknown[]) => unknown,
    planOptions?: { reserved?: boolean },
  ) => never;

  const policedRegisterTool = planRegisterTool as unknown as InstanceType<
    typeof McpServer
  >["registerTool"];

  // Capability merge order. Must be called BEFORE server.connect(transport);
  // the SDK throws SdkErrorCode.AlreadyConnected once a transport is attached
  // ("Cannot register capabilities after connecting to transport"). Done here,
  // immediately after construction, so the
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

  planRegisterTool(
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
    (async (lookupInput: { screen_id?: string; module?: string }) => {
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
    }) as (...cbArgs: unknown[]) => unknown,
    // A RESERVED host built-in: registered by the runtime server itself, after
    // the registration pass, and marked as such in the plan so a consumer can
    // tell it from an ordinary module registration without a name table.
    { reserved: true },
  );

  // The pass is complete: hand the finished plan to whoever asked for it.
  input.onCapabilityPlan?.(planRecorder.plan());

  return server;
}

/**
 * Standard-Schema admission for tool `inputSchema` values that arrive from
 * OUTSIDE the type system (cinatra#2218 L1).
 *
 * ## Why this exists
 *
 * `McpServer.registerTool`'s TYPE has always required a Standard Schema
 * (`{ "~standard": { validate, jsonSchema } }`) — a zod v4 schema is one. Every
 * in-repo registration passes one: each module registry types its table as
 * `Record<string, { inputSchema: z.ZodTypeAny }>`. There is exactly one place a
 * value the compiler never checked can reach `registerTool`: the extension
 * replay in `src/lib/mcp-server.ts`, where a third-party extension's
 * `registration.inputSchema` is cast to `z.ZodTypeAny`.
 *
 * ## What changed at the SDK boundary
 *
 * The retired vendored `@modelcontextprotocol/server@2.0.0-alpha.0` bundled two
 * JSON-Schema validator providers and carried `@cfworker/json-schema` as a hard
 * dependency. `2.0.0` drops that dependency entirely and moves the providers to
 * the `./validators/ajv` and `./validators/cf-worker` subpath exports, to be
 * supplied explicitly by a consumer that converts a raw JSON Schema through
 * `fromJsonSchema()`.
 *
 * cinatra imports NEITHER provider, deliberately. The reason is a measured fact
 * about the retired tree, not an assumption: passing a raw JSON Schema to the
 * alpha's `registerTool` was accepted at registration and then **broken at
 * runtime** — `tools/call` answered `isError` with
 * `Cannot read properties of undefined (reading 'validate')`, and `tools/list`
 * failed the WHOLE list with `-32603`
 * (`Cannot read properties of undefined (reading 'jsonSchema')`), taking every
 * other tool on the server down with it. So the alpha's tolerance was never
 * working JSON-Schema validation; there is no behaviour to preserve, and wiring
 * a validator in would be a shim for a path that never functioned.
 *
 * `2.0.0` instead THROWS at registration (`inputSchema/outputSchema/argsSchema
 * must be a Standard Schema …`). Unguarded, that throw propagates out of the
 * per-request capability build and fails the request — again taking down every
 * tool. This module is the guard: a non-Standard-Schema value is refused at the
 * boundary, loudly and by name, and only that one tool is dropped.
 */

/** A minimal structural check for the Standard Schema + JSON Schema interface the SDK requires. */
export function isStandardSchemaWithJson(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const standard = (value as { "~standard"?: unknown })["~standard"];
  if (standard === null || typeof standard !== "object") return false;
  const props = standard as { validate?: unknown; jsonSchema?: unknown };
  if (typeof props.validate !== "function") return false;
  // The SDK CALLS `~standard.jsonSchema.input(options)` to advertise the tool in
  // `tools/list`, so a present-but-empty `jsonSchema` (`{}`) is NOT enough — the
  // `input` converter must exist and be callable. This check is a cheap
  // pre-filter only: a converter that exists and THROWS is caught by the
  // registration try/catch at the call site, which is the real isolation.
  if (props.jsonSchema === null || typeof props.jsonSchema !== "object") return false;
  return typeof (props.jsonSchema as { input?: unknown }).input === "function";
}

export type ToolInputSchemaAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

/**
 * Decide whether an externally-supplied `inputSchema` may be handed to
 * `registerTool`. `undefined` is admitted — the caller substitutes its own
 * default schema, exactly as before.
 *
 * Two checks, because a structural check alone is NOT enough. Measured against
 * `server@2.0.0`:
 *
 * - a raw JSON Schema is rejected by `registerTool` itself, with a throw;
 * - but a schema carrying a `~standard.jsonSchema.input` converter that THROWS
 *   (or returns a non-object root) registers CLEANLY and then fails
 *   `tools/list` for the ENTIRE server with `-32603` the first time the list is
 *   served — the same whole-surface outage the retired alpha produced. No
 *   try/catch at the registration call site can catch that, because nothing
 *   throws there.
 *
 * So the converter is PROBED here, once, with the same call the SDK makes when
 * advertising the tool. A converter that cannot produce a JSON-Schema object is
 * refused at admission, before it can take `tools/list` down.
 */
export function admitToolInputSchema(value: unknown): ToolInputSchemaAdmission {
  if (value === undefined || value === null) return { admitted: true };
  if (!isStandardSchemaWithJson(value)) {
    const shape =
      typeof value === "object"
        ? Object.prototype.hasOwnProperty.call(value, "type")
          ? "a raw JSON Schema object"
          : "an object without a usable `~standard.jsonSchema.input` converter"
        : `a ${typeof value}`;
    return {
      admitted: false,
      reason:
        `inputSchema is ${shape}, not a Standard Schema. ` +
        "@modelcontextprotocol/server@2.0.0 requires a Standard Schema with a JSON Schema " +
        "converter (e.g. a zod v4 schema); a raw JSON Schema is rejected at registration.",
    };
  }
  const convert = (
    (value as { "~standard": { jsonSchema: { input: (options: { target: string }) => unknown } } })[
      "~standard"
    ]
  ).jsonSchema.input;
  let converted: unknown;
  try {
    converted = convert({ target: "draft-2020-12" });
  } catch (error) {
    return {
      admitted: false,
      reason:
        "inputSchema's `~standard.jsonSchema.input` converter threw: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Such a schema registers cleanly and then fails tools/list for the WHOLE server with -32603.",
    };
  }
  if (converted === null || typeof converted !== "object" || Array.isArray(converted)) {
    return {
      admitted: false,
      reason:
        "inputSchema's `~standard.jsonSchema.input` converter returned " +
        `${Array.isArray(converted) ? "an array" : typeof converted} instead of a JSON Schema object.`,
    };
  }
  return { admitted: true };
}
