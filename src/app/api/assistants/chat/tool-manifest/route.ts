import "server-only";

import { randomUUID } from "node:crypto";
import {
  deliverInjectedSkillsInline,
  resolveBoundDefaultAdapter,
  resolveChatExternalMcpTools,
  resolveProviderAdapter,
  selectSkillDeliveryAdapter,
  type ChatMcpCatalogState,
  type LlmTool,
} from "@cinatra-ai/llm";
import { RUN_WINDOW_SURFACES } from "@cinatra-ai/agents/run-window-conversation-store";
import {
  getAuthSession,
  isPlatformAdmin,
  requireActorContext,
  resolveUserContextForUserId,
} from "@/lib/auth-session";
import type { ActorContext } from "@/lib/authz/actor-context";
import { authorizeThreadForTurn } from "@/lib/assistant-runtime/ag-ui-stream-route";
import { buildCinatraAssistantRuntimeConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";
import { selectAdapterProvider } from "@/lib/assistant-runtime/model-routing";
import {
  areAssistantSkillsRegistered,
  buildAssistantInjectionPorts,
  readChatMcpCatalogState,
} from "@/lib/assistant-runtime/runtime";
import {
  assembleAssistantTurnTools,
  type AssistantTurnToolAssembly,
  type AssistantTurnToolAssemblyReads,
  type AssistantTurnToolAssemblyResume,
  type TurnSelfMcpAdmission,
} from "@/lib/assistant-runtime/turn-tool-assembly";
import {
  TOOL_MANIFEST_VERSION,
  ToolManifestError,
  buildToolManifestReport,
  createToolManifestHashKey,
} from "@/lib/assistant-runtime/tool-manifest-report";
import { requireRunWindowAccess } from "@/lib/lifecycle/run-window-turn";

// ---------------------------------------------------------------------------
// GET /api/assistants/chat/tool-manifest (cinatra#3487;
// packages/agent-ui-protocol/CONTRACT.md section 5.2, which is binding).
//
// A READ-ONLY report of the tools that the chat composer and the run window
// would hand to the model, so that a test can compare the two roads without
// reading the DOM. One request returns BOTH reports, assembled from one set of
// reads ("One snapshot"), through the one tool assembly the turn itself uses
// (`assembleAssistantTurnTools`, "One source").
//
// It writes nothing. At the assembly's write steps it resumes without the
// write: `register_skills` resumes as registered (the route first refuses with
// `503 skills_not_registered` unless this process has already registered every
// skill of the config), and `admit_self_mcp_reference` resumes with an inert
// fixed token, no lent-action grant and no reachability probe. The report
// excludes the reference's headers, so the inert token never shows.
// ---------------------------------------------------------------------------

/** The site transport-token prefix: a broker-auth caller, never served here. */
const SHORT_LIVED_TOKEN_PREFIX = "cit_";

/** The token the self-MCP reference carries in a report. It is never minted. */
const INERT_ACTOR_TOKEN = "tool-manifest-report-inert-token";

const REQUIRED_PARAMS = ["threadId", "runId", "surface"] as const;
const MAX_ID_LENGTH = 200;
const PRINTABLE_ASCII_ID = /^[\x21-\x7E]+$/;

type ManifestErrorCode =
  | "actor_unavailable"
  | "provider_unavailable"
  | "skills_not_registered"
  | "skills_not_synced"
  | "skill_delivery_refused"
  | "tools_unavailable"
  | "catalog_unavailable"
  | "external_tools_unavailable"
  | "tool_unserializable"
  | "assembly_failed";

/** A failure of one read or step, carrying the 503 code it answers with. */
class ManifestRouteError extends Error {
  readonly code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, cause?: unknown) {
    super(
      cause instanceof Error ? `${code}: ${cause.message}` : code,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ManifestRouteError";
    this.code = code;
  }
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function unavailable(code: ManifestErrorCode, cause: unknown): Response {
  // The cause stays on the server; the body is the code and nothing else.
  console.error(
    `[tool-manifest] 503 ${code}:`,
    cause instanceof Error ? cause.message : String(cause),
  );
  return errorResponse(503, code);
}

type ManifestParams = { threadId: string; runId: string; surface: string };

/**
 * Exactly the three parameters, each once, each well formed. Reads no store,
 * so a 400 says nothing about whether a run or a thread exists.
 */
function parseParams(request: Request): ManifestParams | null {
  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(request.url).searchParams;
  } catch {
    return null;
  }
  const values = new Map<string, string[]>();
  for (const [name, value] of searchParams) {
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  if (values.size !== REQUIRED_PARAMS.length) return null;
  const single = (name: string): string | null => {
    const given = values.get(name);
    if (!given || given.length !== 1) return null;
    return given[0];
  };
  const threadId = single("threadId");
  const runId = single("runId");
  const surface = single("surface");
  if (threadId === null || runId === null || surface === null) return null;
  for (const id of [threadId, runId]) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH || !PRINTABLE_ASCII_ID.test(id)) {
      return null;
    }
  }
  if (!(RUN_WINDOW_SURFACES as readonly string[]).includes(surface)) return null;
  return { threadId, runId, surface };
}

/** One shared read per key within this request. */
function memoized<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const started = read();
  cache.set(key, started);
  return started;
}

/**
 * The skill-delivery errors of packages/llm/src/errors.ts, read structurally
 * by the suffix of their `code` (`<provider>_skill_not_synced`,
 * `<provider>_skill_cap_exceeded`), so that a delivery adapter's faithful copy
 * of the error in another module realm, or another provider's adapter, maps
 * the same way. Any other error is assembly_failed.
 */
function deliveryErrorCode(error: unknown): ManifestErrorCode {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return "assembly_failed";
  if (code.endsWith("_skill_not_synced")) return "skills_not_synced";
  if (code.endsWith("_skill_cap_exceeded")) return "skill_delivery_refused";
  return "assembly_failed";
}

/**
 * The reads of one request: each distinct input is read once and both roads
 * use that one result (section 5.2, "One snapshot").
 */
function createRequestSnapshot() {
  const deliveries = new Map<string, Promise<unknown>>();
  const inlineDeliveries = new Map<string, Promise<unknown>>();
  const externalTools = new Map<
    string,
    ReturnType<typeof resolveChatExternalMcpTools>
  >();
  const catalogStates = new Map<string, Promise<ChatMcpCatalogState>>();
  const assignedSkills = new Map<string, Promise<readonly string[]>>();

  const assemblyReads: AssistantTurnToolAssemblyReads = {
    selectSkillDeliveryAdapter: (provider) => {
      const adapter = selectSkillDeliveryAdapter(provider);
      return {
        provider: adapter.provider,
        deliver: (request) =>
          memoized(
            deliveries,
            JSON.stringify([provider, request.selectionMode ?? null, request.skillIds]),
            () =>
              adapter.deliver(request).catch((error: unknown) => {
                throw new ManifestRouteError(deliveryErrorCode(error), error);
              }),
          ) as ReturnType<typeof adapter.deliver>,
      };
    },
    deliverInjectedSkillsInline: (input) =>
      memoized(
        inlineDeliveries,
        JSON.stringify(input.set),
        () => deliverInjectedSkillsInline(input),
      ) as ReturnType<typeof deliverInjectedSkillsInline>,
    resolveChatExternalMcpTools: (provider, context) =>
      memoized(externalTools, JSON.stringify([provider, context ?? null]), () =>
        resolveChatExternalMcpTools(provider, context).catch((error: unknown) => {
          throw new ManifestRouteError("external_tools_unavailable", error);
        }),
      ),
  };

  return {
    assemblyReads,
    catalogState(input: {
      actorContext: ActorContext;
      userId: string;
      sessionOrgId: string | null;
      platformRole: string;
    }): Promise<ChatMcpCatalogState> {
      return memoized(
        catalogStates,
        JSON.stringify([input.userId, input.sessionOrgId, input.platformRole]),
        () =>
          readChatMcpCatalogState({
            actorContext: input.actorContext,
            userId: input.userId,
            sessionOrgId: input.sessionOrgId,
          }).catch((error: unknown) => {
            throw new ManifestRouteError("catalog_unavailable", error);
          }),
      );
    },
    assignedSkillIds(agentId: string, sessionId: string): Promise<readonly string[]> {
      return memoized(assignedSkills, JSON.stringify([agentId, sessionId]), async () => {
        const { resolveAssistantAssignedSkillIds } = await import(
          "@/lib/assistant-assigned-skills-delivery"
        );
        return resolveAssistantAssignedSkillIds({ agentId, sessionId });
      });
    },
  };
}

type RoadInputs = {
  userId: string;
  actorContext: ActorContext;
  platformRole: "platform_admin" | "member";
  sessionOrgId: string | null;
  sessionId: string;
};

/**
 * Drive the one assembly for one road, resuming each write step WITHOUT the
 * write. Returns the assembled array or throws the road's 503 code.
 */
async function assembleRoad(
  snapshot: ReturnType<typeof createRequestSnapshot>,
  adapter: { provider: Parameters<typeof assembleAssistantTurnTools>[0]["provider"]; defaultModel: string },
  runtimeConfig: ReturnType<typeof buildCinatraAssistantRuntimeConfig>,
  road: RoadInputs,
): Promise<{ conversationOnly: boolean; tools: LlmTool[] }> {
  // Both roads pass no `assistantId`, so the runtime uses the namespace.
  const assistantAgentId = runtimeConfig.skillIdNamespace;
  const run = assembleAssistantTurnTools({
    provider: adapter.provider,
    defaultModel: adapter.defaultModel,
    skillIds: runtimeConfig.skillIds,
    allowedTools: runtimeConfig.allowedTools,
    assistantAgentId,
    userId: road.userId,
    sessionId: road.sessionId,
    injectionPorts: buildAssistantInjectionPorts({
      agentId: assistantAgentId,
      userId: road.userId,
      sessionId: road.sessionId,
      requiredSkillIds: runtimeConfig.skillIds,
      resolveAssignedSkillIdsForSession: (sessionId) =>
        snapshot.assignedSkillIds(assistantAgentId, sessionId),
    }),
    reads: snapshot.assemblyReads,
  });

  let resume: AssistantTurnToolAssemblyResume | undefined;
  for (;;) {
    const step = await run.next(resume);
    if (step.done) return assembledTools(step.value);
    if (step.value.kind === "register_skills") {
      // No registration here: the route refused already unless this process
      // had registered every skill (areAssistantSkillsRegistered).
      resume = { kind: "skills_registered" };
      continue;
    }
    // admit_self_mcp_reference: no probe, no grant, no mint.
    const catalogState = await snapshot.catalogState({
      actorContext: road.actorContext,
      userId: road.userId,
      sessionOrgId: road.sessionOrgId,
      platformRole: road.platformRole,
    });
    const admission: TurnSelfMcpAdmission = {
      kind: "chat",
      actor: {
        delegation: "chat",
        userId: road.userId,
        orgId: road.sessionOrgId,
        platformRole: road.platformRole,
      },
      catalogState,
      lentActionGrant: null,
      actorToken: { ok: true, token: INERT_ACTOR_TOKEN },
    };
    resume = { kind: "self_mcp_admitted", admission };
  }
}

/** The assembled array of one road, or the 503 code of its outcome. */
function assembledTools(
  outcome: AssistantTurnToolAssembly,
): { conversationOnly: boolean; tools: LlmTool[] } {
  if (outcome.kind === "delivery_refused") {
    throw new ManifestRouteError("skill_delivery_refused");
  }
  if (outcome.kind === "self_mcp_unavailable") {
    throw new ManifestRouteError("tools_unavailable");
  }
  return { conversationOnly: outcome.conversationOnly, tools: outcome.tools };
}

export async function GET(request: Request): Promise<Response> {
  // Never served to the broker-auth embed: a `cit_` bearer is refused with no
  // fall back to an ambient cookie session (the capability route's guard).
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (bearer.startsWith(SHORT_LIVED_TOKEN_PREFIX)) {
    return errorResponse(401, "Unauthorized");
  }

  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) return errorResponse(401, "Unauthorized");

  const params = parseParams(request);
  if (!params) return errorResponse(400, "invalid_request");
  const { threadId, runId, surface } = params;

  // --- Composer inputs: the cookie branch of POST /api/assistants/chat. ---
  let composerActorContext: ActorContext;
  try {
    composerActorContext = await requireActorContext();
  } catch (error) {
    return unavailable("actor_unavailable", error);
  }
  const isAdmin = isPlatformAdmin(session);
  const composerPlatformRole: "platform_admin" | "member" = isAdmin ? "platform_admin" : "member";
  const composerOrgId =
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  // Reads only. A thread with no row is assembled as a new thread; the route
  // never claims or writes it.
  const threadAuthorization = authorizeThreadForTurn({
    threadId,
    callerId: userId,
    isAdmin,
    sessionOrgId: composerOrgId,
  });
  if (!threadAuthorization.ok) {
    return errorResponse(threadAuthorization.status, threadAuthorization.error);
  }

  // --- Window inputs: runWindowTurn. Every refusal is the same 404. ---
  let windowActor: Awaited<ReturnType<typeof requireRunWindowAccess>>["actor"];
  try {
    windowActor = (await requireRunWindowAccess(runId, "read")).actor;
  } catch (error) {
    console.error(
      "[tool-manifest] 404 not_found:",
      error instanceof Error ? error.message : String(error),
    );
    return errorResponse(404, "not_found");
  }
  let windowContext: Awaited<ReturnType<typeof resolveUserContextForUserId>>;
  try {
    windowContext = await resolveUserContextForUserId(windowActor.userId, {
      activeOrganizationId: windowActor.orgId,
      platformRole: windowActor.platformRole,
    });
  } catch (error) {
    return unavailable("actor_unavailable", error);
  }

  const runtimeConfig = buildCinatraAssistantRuntimeConfig();

  // The route registers no skill. A process that has not registered them yet
  // could hand the next turn a different list, so no manifest is answered.
  if (!areAssistantSkillsRegistered(runtimeConfig.skillIds)) {
    return unavailable("skills_not_registered", "the assistant skills are not registered yet");
  }

  // The provider adapter, resolved once as runAssistantTurn resolves it.
  let adapter: Awaited<ReturnType<typeof resolveProviderAdapter>>;
  try {
    const pinnedProvider = selectAdapterProvider(runtimeConfig.modelPrefs);
    adapter = pinnedProvider
      ? await resolveProviderAdapter(pinnedProvider as Parameters<typeof resolveProviderAdapter>[0])
      : await resolveBoundDefaultAdapter();
  } catch (error) {
    // BoundDefaultProviderUnavailableError, or any other failure to resolve.
    return unavailable("provider_unavailable", error);
  }
  if (!adapter) return unavailable("provider_unavailable", "no provider adapter resolves");

  const snapshot = createRequestSnapshot();
  const key = createToolManifestHashKey();
  try {
    const composer = await assembleRoad(snapshot, adapter, runtimeConfig, {
      userId,
      actorContext: composerActorContext,
      platformRole: composerPlatformRole,
      sessionOrgId: composerOrgId,
      sessionId: threadId,
    });
    const windowRoad = await assembleRoad(snapshot, adapter, runtimeConfig, {
      userId: windowActor.userId,
      actorContext: windowContext.actorContext,
      platformRole: windowContext.platformRole,
      sessionOrgId: windowContext.sessionOrgId,
      // runWindowTurn passes no sessionId, so the runtime mints a per-turn id
      // with no thread scope. The report does the same.
      sessionId: `assistant-turn:${randomUUID()}`,
    });
    const composerReport = buildToolManifestReport({ ...composer, key });
    const windowReport = buildToolManifestReport({ ...windowRoad, key });
    return Response.json(
      {
        manifestVersion: TOOL_MANIFEST_VERSION,
        composer: { threadId, ...composerReport },
        window: { runId, surface, ...windowReport },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ManifestRouteError) return unavailable(error.code, error);
    if (error instanceof ToolManifestError) return unavailable(error.code, error);
    return unavailable("assembly_failed", error);
  } finally {
    // The key is made for this one response and kept nowhere.
    key.fill(0);
  }
}
