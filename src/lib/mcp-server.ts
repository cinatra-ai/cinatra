import "@/lib/extensions"; // initialises extensionRegistry side effects
import "@/lib/register-test-delivery-send-port"; // wires the run-scoped test-delivery send PORT (#1625)
import { admitToolInputSchema, createMcpRuntimeServer, createMcpServerAuthPlugins, createMcpServerMount, type McpServerSettings, type McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { CINATRA_MCP_INSTRUCTIONS, CINATRA_MCP_EXPERIMENTAL } from "./mcp-instructions";
// Re-exported so `@/lib/mcp-server` stays the single import surface for the
// self-primitive map's shape, while the testable seams live alongside the
// registry they replay — a module a unit test can import without this file's
// connector/DB graph, and one already on every route this file is on.
export type {
  CapturedHostPrimitive,
  CapturedMcpToolHandler,
  ReplayedExtensionRegistration,
} from "./extension-mcp-registry";
import type { CapabilityPlan, PrimitiveDispatchTarget } from "@cinatra-ai/mcp-server/capability-plan";
import type { DelegatedChatAdmissionSnapshot } from "@cinatra-ai/mcp-server/delegated-chat-admission";
import {
  resolveDurableRunContext,
  recordMcpRunContextServedBy,
} from "./agent-run-context-durable";
import { readAgentRunByTokenHash } from "@cinatra-ai/agents";
import { verifyChatMcpActorToken } from "./chat-mcp-actor-token";
import { verifyAgentRunMcpActorToken } from "./agent-run-mcp-actor-token";
import { resolveWidgetDelegatedActorForTransport } from "./widget-mcp-actor-authorization";
import { sessionAuthorityFromResolvedRole } from "./org-write/authority";
import { mintRunWriteAuthorityForMcp } from "./org-write/run-authority-mint";
import { createObjectsModule } from "@cinatra-ai/objects/module";
import { createArtifactsModule } from "@/lib/artifacts/mcp";
import { createContextModule } from "@/lib/artifacts/context-mcp";
import { createApprovalsMcpModule } from "@/lib/approvals/approvals-mcp";
import { createLifecyclePullMcpModule } from "@/lib/lifecycle/lifecycle-pull-mcp";
import { createScheduleProposalMcpModule } from "@/lib/lifecycle/schedule-proposal-mcp";
import { createProjectSeamMcpModule } from "@/lib/project-seam-mcp";
import { createConnectorInventoryMcpModule } from "@/lib/connector-inventory-mcp";
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
import { setLiveAgentManifestProvider } from "@cinatra-ai/agents";
import { readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";
import { auth } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { resolveProviderAdapter } from "@cinatra-ai/llm";
import {
  listExtensionMcpTools,
  markEffectiveExtensionMcpTools,
  unmarkEffectiveExtensionMcpToolCollisions,
  UNRESOLVED_EXTENSION_VERSION,
  buildReplayedExtensionToolConfig,
  createSelfPrimitiveRecordingServer,
  type CapturedHostPrimitive,
} from "@/lib/extension-mcp-registry";
export {
  buildReplayedExtensionToolConfig,
  createSelfPrimitiveRecordingServer,
  UNRESOLVED_EXTENSION_VERSION,
};
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
  wrapExtensionToolResult,
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
  // cinatra#2723 — `connector_inventory_list`, the platform's own read-only
  // "which connectors are live for this caller?" primitive. Deliberately in the
  // PRE-connector block: platform inventory is a HOST capability, not any one
  // connector's, so the host claims the name BEFORE the manifest-discovered
  // connector modules register. A connector that later claimed the same name
  // would fail the registration pass loudly rather than shadow the host tool,
  // and the ownership test pins the single owner against the real tree.
  createConnectorInventoryMcpModule(),
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
  // The conversational PULL for lifecycle state (cinatra#2567, epic #2564 S3):
  // artifact_review_gates_list / artifact_review_gate_render /
  // verification_record_render — read-only primitives that mint S1's
  // producer-bound card refs. Registered in the approvals-adjacent slot because
  // it is the same question ("what is waiting for me?") asked from a
  // conversation instead of a page. No decide/mutate primitive exists here or
  // anywhere on the lifecycle surface; both delegated tool policies reject that
  // class by construction (structural test in src/lib/lifecycle/__tests__).
  createLifecyclePullMcpModule(),
  // The schedule PROPOSAL producer (cinatra#2569, epic #2564 S5):
  // schedule_proposal_render — the tool that fills S1's deliberately empty
  // `trigger_schedule_proposal` producer allowlist. Read-only in the same sense
  // as the pull primitives above: it mints a signed, opaque, expiring proposal
  // token and returns a card envelope, and writes nothing. Arming happens only
  // in a human session action carrying that token.
  createScheduleProposalMcpModule(),
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
  // cinatra#2605: the SHARED reader (src/lib/a2a-manifest-gate) is now the one
  // place that answers "which agent packages may be advertised and run" — the
  // live-manifest condition AND the run-availability verdict every other surface
  // applies. This provider used to duplicate the manifest half inline, which is
  // exactly how a published-agent MCP tool could keep advertising an agent that
  // `agent_run` refuses. Same fail-open contract (null = keep everything).
  setLiveAgentManifestProvider(readLiveAgentPackageNames);

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
    // cinatra#2218 L1 — Standard-Schema admission at the ONE boundary where an
    // unchecked third-party `inputSchema` reaches `registerTool`. server@2.0.0
    // THROWS on a non-Standard-Schema value; unguarded, that throw escapes the
    // per-request capability build and fails the request, taking EVERY other
    // tool down with it (the retired alpha's equivalent failure mode was a
    // `-32603` on `tools/list`). Refuse the one tool, name the extension, keep
    // the endpoint serving. Rationale + the measured alpha behaviour:
    // `admitToolInputSchema` in packages/mcp-server/src/runtime-server.ts.
    //
    // The admission check is a cheap PRE-FILTER, not the isolation: a schema can
    // satisfy the structural check and still make `registerTool` throw (a
    // `jsonSchema.input` converter that throws, or one returning an invalid
    // root). The real isolation is the try/catch around the registration call
    // below, and the fact that `registeredNames` / `effectiveExtensionTools` are
    // only updated AFTER the registration actually succeeded — a failed
    // registration must never claim the name (which would shadow a later host
    // tool) nor enter the effective set (which the authz boundary shadow-allows
    // against).
    const schemaAdmission = admitToolInputSchema(entry.tool.inputSchema);
    if (!schemaAdmission.admitted) {
      console.warn(
        `[mcp] extension tool "${name}" (${packageName}) NOT registered — ${schemaAdmission.reason}`,
      );
      continue;
    }
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
    // cinatra#2817 slice 1 — the PROVENANCE the choke point plans this
    // registration under. Written by the host from the DISCOVERY PLAN's own
    // resolution (the default entry's registry version, or the retained
    // entry's pinned version), never from anything the extension supplied.
    const resolvedVersion =
      entry.mode === "default" ? entry.tool.resolvedVersion ?? null : entry.version;
    const dispatchTarget: PrimitiveDispatchTarget = {
      kind: entry.mode === "default" ? "extension-default" : "extension-versioned",
      packageName,
      version: resolvedVersion ?? UNRESOLVED_EXTENSION_VERSION,
      name: name.toLowerCase(),
    };
    try {
      (server.registerTool as (...a: unknown[]) => unknown)(
        name,
        buildReplayedExtensionToolConfig(name, registration, {
          ownerPackage: packageName,
          resolvedVersion,
          dispatchTarget,
        }),
        async (input: unknown) => {
          const raw = await dispatchPlanned(input);
          return wrapExtensionToolResult(raw);
        },
      );
    } catch (error) {
      // Fail ISOLATED: one extension's unusable registration must not fail the
      // per-request capability build (which would take down `tools/list` for
      // every other tool). The name is deliberately NOT claimed and the tool is
      // NOT published to the effective set.
      console.warn(
        `[mcp] extension tool "${name}" (${packageName}) NOT registered — registerTool rejected it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    registeredNames.add(name);
    effectiveExtensionTools.push({ name, packageName });
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

// ---------------------------------------------------------------------------
// THE ONE REQUEST-SCOPED CAPABILITY PLAN (cinatra#2817 slice 1).
//
// The delegated-chat CATALOG is derived, not listed — and since this slice it
// is derived from the SAME registration pass that decides what registers.
// `buildDelegatedChatCapabilityPlan` runs one delegated-chat registration pass
// and returns the plan it produced: `plan.servable` holds exactly the
// primitives `registerTool` accepted, each carrying its normalized name,
// declared class, owning package, exact resolved version, capability key and
// dispatch target.
//
// WHY THE CATALOG MAY NOT REPLAY REGISTRATION ITSELF. A second pass against a
// second sink is a second answer. The S8 discovery union already registers a
// CALLER-DEPENDENT tool set, and slice 2 adds an admission snapshot that can
// change between two passes — so a catalog built by its own replay could
// advertise a primitive the live perimeter refuses, or hide one it serves.
// Deriving the catalog from a plan the pass itself produced removes the
// possibility rather than testing for its absence.
//
// THE ONE THING THIS DOES NOT AND CANNOT COLLAPSE, stated plainly. A chat TURN
// and an MCP REQUEST are different requests, minutes apart, often in different
// processes. No plan can be shared between them, so the catalog a turn ships
// and the perimeter a later MCP request enforces are necessarily built by two
// passes at two times. That is why the catalog is ADVISORY and the transport is
// AUTHORITATIVE — the pre-existing contract, unchanged here: a hint that named
// a primitive the request's own plan does not serve buys a refusal, never a
// call. What this slice removes is the SECOND ANSWER: the catalog no longer
// derives from a different input (a static name list) than the perimeter, so
// the two can only differ by the state that genuinely changed between them.
// ---------------------------------------------------------------------------

/**
 * Run ONE delegated-chat registration pass and return the capability plan it
 * produced. The server built here is discarded; the plan is the product.
 */
export async function buildDelegatedChatCapabilityPlan(input?: {
  requestContext?: RegisterCapabilitiesRequestContext;
  resolveCapabilityKey?: (name: string) => string | null | undefined;
  /**
   * The snapshot to decide against. Supply one when the caller already holds
   * the request's snapshot; otherwise it is loaded here, so the plan and the
   * catalog derived from it are still decided against a real admission state
   * rather than an absent one (which would return an EMPTY plan).
   */
  admissionSnapshot?: DelegatedChatAdmissionSnapshot;
}): Promise<CapabilityPlan> {
  let captured: CapabilityPlan | undefined;
  const snapshot =
    input?.admissionSnapshot ??
    (await (
      await import("@/lib/delegated-chat-admission-store")
    ).loadDelegatedChatAdmissionSnapshot());
  await createMcpRuntimeServer({
    name: "cinatra-mcp-server",
    version: "0.2.0",
    toolPolicyMode: "delegated-chat",
    registerCapabilities: registerAllCapabilities,
    registerRequestContext: input?.requestContext,
    resolveCapabilityKey: input?.resolveCapabilityKey,
    delegatedChatAdmissionSnapshot: snapshot,
    onCapabilityPlan: (plan) => {
      captured = plan;
    },
  });
  if (!captured) {
    // Unreachable in practice (the callback fires before the builder returns),
    // but a plan that never arrived must read as EMPTY, never as "everything".
    return { entries: [], outcomes: [], servable: [] };
  }
  return captured;
}

/** A captured MCP tool handler — the SDK callback `(args, extra) => CallToolResult`. */

/**
 * One captured host primitive: its handler PLUS the typed delegated-chat
 * declaration its registration carried (cinatra#2771).
 *
 * The map used to be a bare `name → handler`, which is precisely the lossy hop
 * the #2771 review named: a declaration that survived the registry, versioned
 * discovery and the replay was still dropped before the in-process
 * self-invoker could see it, so a delegated-restricted self-invocation and the
 * live transport would have disagreed about the same registration. Carrying
 * the declaration alongside the handler is what lets
 * `@/lib/extension-self-mcp` apply the SAME narrow-only rule
 * `policedRegisterTool` applies.
 */
export async function buildHostSelfPrimitiveHandlers(): Promise<Map<string, CapturedHostPrimitive>> {
  const handlers = new Map<string, CapturedHostPrimitive>();
  const recordingServer = createSelfPrimitiveRecordingServer(handlers);

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
    // cinatra#2817 slice 1 — captured through the SAME recording server (and
    // therefore the SAME planner) the module block used, with the provenance
    // the host resolved for this registration. Setting the map directly, as
    // this did before, would have produced an entry with no planned identity —
    // and the self-invoker would then have had no way to consult an admission
    // record bound to the package + version actually about to serve.
    (recordingServer.registerTool as (...a: unknown[]) => unknown)(
      tool.name,
      buildReplayedExtensionToolConfig(tool.name, tool, {
        ownerPackage: tool.packageName,
        resolvedVersion: tool.resolvedVersion,
        dispatchTarget: {
          kind: "extension-default",
          packageName: tool.packageName,
          version: tool.resolvedVersion ?? UNRESOLVED_EXTENSION_VERSION,
          name: tool.name.toLowerCase(),
        },
      }),
      async (input: unknown) => {
        // Edge-bound serve (cinatra#1392 Gap 1) — same chokepoint as the live
        // transport replay, so the in-process self-invoker serves identically.
        // (No plan-pinning here: this map applies no schema validation, so the
        // dispatch-time decision is authoritative — see
        // dispatchPlannedExtensionMcpTool's doc.)
        const raw = await dispatchExtensionMcpToolEdgeBound(tool, input);
        return wrapExtensionToolResult(raw);
      },
    );
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
    (recordingServer.registerTool as (...a: unknown[]) => unknown)(
      entry.name,
      buildReplayedExtensionToolConfig(
        entry.name,
        { delegatedChat: entry.delegatedChat },
        {
          ownerPackage: entry.packageName,
          resolvedVersion: entry.version,
          dispatchTarget: {
            kind: "extension-versioned",
            packageName: entry.packageName,
            version: entry.version,
            name: entry.name.toLowerCase(),
          },
        },
      ),
      async (input: unknown) => {
        const raw = await dispatchVersionedOnlyExtensionMcpTool(target, input);
        return wrapExtensionToolResult(raw);
      },
    );
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
  // #1195 durable run-context binding: resolve the run-token-keyed redis
  // binding through the ONE run-token seam (readAgentRunByTokenHash — the run
  // row stays the source of truth). App-wired because packages/mcp-server
  // cannot import the app layer. The resolver classifies its own failures
  // (transport ⇒ absent, present-but-unresolvable ⇒ invalid) and never throws.
  // The in-process `getRunContext` registry callback that used to sit here was
  // DELETED with the registry (#1195 flip): this is the only run-context
  // channel the app wires besides the signed OBO token.
  resolveDurableRunContext: (rawBearerToken: string) =>
    resolveDurableRunContext(rawBearerToken, readAgentRunByTokenHash),
  // #1195 metric — counts which channel attributed each MCP request. It once
  // gated the registry removal; the removal has LANDED, so it now records the
  // surviving channels (obo / durable / header / none) as ongoing observability.
  onRunContextServedBy: recordMcpRunContextServedBy,
  // cinatra#2817 slice 1 — the LIVE request's plan carries the same capability
  // keys the chat catalog derives, from the same catalog-declared
  // `mcpPrimitivePrefixes`. Lazy so the connector catalog stays off this
  // module's eager graph.
  resolvePrimitiveCapabilityKeys: async () => {
    const { buildCatalogCapabilityKeyResolver } = await import("@/lib/connector-inventory.server");
    return buildCatalogCapabilityKeyResolver();
  },
  // cinatra#2817 slice 3 — ONE immutable admission snapshot per MCP request,
  // loaded BEFORE registration. Registration filtering, the plan the catalog is
  // derived from, and the call-time guard all decide against this same object,
  // so a revocation landing mid-request cannot make them disagree.
  loadDelegatedChatAdmissionSnapshot: async () => {
    const { loadDelegatedChatAdmissionSnapshot } = await import(
      "@/lib/delegated-chat-admission-store"
    );
    return loadDelegatedChatAdmissionSnapshot();
  },
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
  //      declaration-bound chat admission applies.
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
  //      cinatra#2687: the widget entry point is the AUTHORIZATION layer, not
  //      the raw token verifier — it additionally refuses a token whose parent
  //      `cwu_` sign-in has ended and one whose turn has finished, so the seal
  //      the token carries is actually enforced somewhere.
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
    // cinatra#2687 — ONE delegating line, deliberately. The widget branch
    // (verify → parent-session live → turn still running → normalize the
    // instance pin → drop the spent seals) lives in the leaf so a test can drive
    // the EXACT expression this seam runs; nothing about it is re-stated here,
    // where nothing could check it.
    return resolveWidgetDelegatedActorForTransport(input);
  },
  // cinatra#1939 S3: membership-grounded org-write authority for session /
  // chat-OBO callers. The transport already resolved the membership role for
  // this exact frame's (userId, orgId) pair, so the SYNC mint derives the
  // capability witness from it (content.write = any member; management
  // capabilities = the mapped authz permission) with no second membership
  // read. Carried opaquely on the request store; each seam (e.g. the
  // dashboards org-write seam) narrows it fail-closed. Agent-run OBO callers
  // never reach this mint — their authority is the run verifier's
  // (verifyRunAuthority), wired when the run path converts.
  mintOrgWriteAuthority: ({ orgId, orgRole }) =>
    sessionAuthorityFromResolvedRole(orgId, orgRole),
  // cinatra#1939 S3: run-grounded org-write authority for agent-run OBO
  // callers. Verifies the token's (runId, orgId, att) triple against the run
  // row — live-attempt predicate + claimed-vs-current attempt match — via
  // the pooled agents-store reader; every refusal/failure reads as an
  // unstamped frame (logged), never a transport error.
  mintRunOrgWriteAuthority: (input) => mintRunWriteAuthorityForMcp(input),
});
