/**
 * A CHAT-STARTED RUN CAN PAUSE ON THE RECOMMENDATION HOLD (chat-hitl S9b).
 *
 * The `agent_run` primitive is the one run-start that never consulted the
 * run-start recommendation hold. It created the row already `queued` and
 * stamped no presence, so `maybeHoldRunForRecommendation` classified every
 * chat-started run as headless and the card built for this interaction was
 * starved on the surface it was designed for.
 *
 * Two properties are proved here, and they are the two the fix could plausibly
 * get wrong:
 *
 *   PRESENCE IS SERVER-DERIVED. It comes from the verified launch frame — the
 *   in-process pre-router's `launchOrigin`, or the remote transport's
 *   `delegatedRestricted` — and never from the primitive's input. A model
 *   writing `launchOrigin` or `humanPresent` into its own arguments changes
 *   nothing, which is asserted directly rather than assumed.
 *
 *   THE HOLD IS EVALUATED BEFORE DISPATCH, NOT AFTER. A held run must be
 *   `pending_input`, because Confirm/Skip releases only the two pre-dispatch
 *   waiting states; a run held while already `queued` would be stranded with
 *   nothing able to let it go. So the chat branch creates the row parked,
 *   decides, and only then drives the canonical CAS + enqueue.
 *
 * Regression axes, on the same run of the same handler: an OBO / agent-as-tool
 * frame still dispatches unheld, a hold-evaluation failure fails OPEN, and
 * neither branch ever enqueues twice or reports `queued` for a run it did not
 * queue.
 *
 * Integration in the sense that matters here: the REAL `agent_run` handler runs,
 * across the real launch-origin derivation, the real state path and the real
 * enqueue chokepoint. It needs no database, so it carries the plain test suffix
 * and runs in the fast tier rather than the Postgres-bound `*.integration`
 * one — only the DB seams and the hold's own verdict are stubbed.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/chat-origin-recommendation-hold.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Auth session
// ---------------------------------------------------------------------------
const SESSION_WITH_ORG = {
  user: { id: "owner-1", role: "user", name: "Owner", email: "owner@example.com" },
  session: { id: "s1", activeOrganizationId: "org-1", userId: "owner-1" },
};
const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// ---------------------------------------------------------------------------
// Store. `createAgentRun` HONORS `initialStatus` so the row the rest of the
// handler reasons about carries the state the handler asked for — otherwise
// the assertions below would pass on a fixture rather than on the seam.
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => {
  class StubRunTransitionError extends Error {
    readonly code: string;
    constructor(code = "stale_from_status", message = code) {
      super(message);
      this.name = "RunTransitionError";
      this.code = code;
    }
  }
  return {
    assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
    assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
    readAgentVersionsByTemplate: vi.fn(async () => [{ id: "ver-1" }]),
    createAgentRun: vi.fn(
      async (args: { id: string; templateId: string; initialStatus?: string; humanPresent?: boolean }) => ({
        id: args.id,
        templateId: args.templateId,
        status: args.initialStatus ?? "queued",
        humanPresent: args.humanPresent ?? null,
        runBy: "owner-1",
        orgId: "org-1",
        inputParams: {},
        createdAt: new Date(),
        versionId: null,
        sourceType: "internal",
        sourceId: null,
        packageVersion: null,
        a2aTaskId: null,
        parentRunId: null,
        agUiEnabled: true,
        timeoutSeconds: null,
        error: null,
        title: null,
        startedAt: null,
        completedAt: null,
        stepResults: null,
        authPolicy: null,
      }),
    ),
    readAgentTemplateById: vi.fn(),
    readAgentTemplateByPackageName: vi.fn(),
    readAgentRunById: vi.fn(async (): Promise<{ id: string; status: string } | null> => null),
    readAgentRuns: vi.fn(),
    readAgentRunsByTemplate: vi.fn(),
    readAgentRunsByTemplateRaw: vi.fn(),
    readAgentRunMessages: vi.fn(),
    appendAgentRunMessage: vi.fn(),
    transitionRunStatus: vi.fn(
      async (
        _runId: string,
        _from: string,
        _to: string,
        _meta?: unknown,
        _authority?: unknown,
      ): Promise<void> => undefined,
    ),
    RunTransitionError: StubRunTransitionError,
    createAgentVersion: vi.fn(),
    createAgentTemplate: vi.fn(),
    readAgentTemplates: vi.fn(),
    updateAgentTemplate: vi.fn(),
    resolveDefaultOrgId: vi.fn(async () => "org-1"),
    readAgentTemplateVersions: vi.fn(),
    readAgentTemplateVersionById: vi.fn(),
    diffSnapshots: vi.fn(),
    createAgentTemplateVersionIfChanged: vi.fn(),
    rollbackAgentTemplateToVersion: vi.fn(),
    setAgentTemplatePackageName: vi.fn(),
    bulkStopAgentRuns: vi.fn(),
    bulkStopAgentRunsByTemplate: vi.fn(),
    writeHitlPrompt: vi.fn(async () => undefined),
    readAllHitlPromptsForRun: vi.fn(async () => []),
    updateHitlPromptsExcludedForRunAgent: vi.fn(),
    readRunCoOwners: vi.fn(async () => []),
    resolveRunCoOwnerUserIds: vi.fn(async () => []),
  };
});
vi.mock("../store", () => storeMock);

// ---------------------------------------------------------------------------
// THE HOLD ITSELF IS NOT STUBBED. `maybeHoldRunForRecommendation` runs for
// real — its presence gate, its idempotency read, its policy evaluation, its
// candidate gate and its park write — and only the LEAF stores under it are
// faked. That matters for this suite specifically: the property under test is
// "a chat frame reaches the hold and a headless one does not", and a stubbed
// hold would make both look identical from the outside.
//
// The HELD / NOT-HELD switch is the product's own discriminator: whether the
// request-aware scorer returns a candidate to confirm.
// ---------------------------------------------------------------------------
const parkStore = vi.hoisted(() => ({
  readContinuationParksForRun: vi.fn(async (_runId: string): Promise<unknown[]> => []),
  maybeParkCheckpoint: vi.fn(async () => ({ parked: true, parkId: "park-1" })),
  sweepParks: vi.fn(async () => ({ released: 0 })),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  readContinuationParksForRun: (runId: string) => parkStore.readContinuationParksForRun(runId),
  maybeParkCheckpoint: (...a: unknown[]) => parkStore.maybeParkCheckpoint(...(a as [])),
  sweepParks: (...a: unknown[]) => parkStore.sweepParks(...(a as [])),
}));

const getRunRecommendations = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ skillId: string; recommended: boolean }>> => []),
);
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: () => getRunRecommendations(),
  parseLifecycleConfig: vi.fn(() => undefined),
}));

vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({
  isRecommendationChipRowHoldActive: vi.fn(() => true),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: vi.fn(async () => ({ bound: "require" })),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => ["@cinatra-ai/chat:blog-content"]),
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: vi.fn(async () => ({ principalId: "owner-1" })),
}));

// ---------------------------------------------------------------------------
// The enqueue chokepoint — "was this run dispatched, and exactly once?".
// ---------------------------------------------------------------------------
const enqueueAgentRun = vi.hoisted(() =>
  vi.fn(async (_record: { runId: string }, _opts?: unknown): Promise<void> => undefined),
);
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (record: { runId: string }, opts?: unknown) => enqueueAgentRun(record, opts),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Gates the handler runs before creation — all allow, so the state path is
// what the assertions see.
// ---------------------------------------------------------------------------
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../runtime-install-gate", () => ({ assertAgentPackageRunnable: vi.fn(async () => null) }));
vi.mock("../wayflow-preflight", () => ({ preflightWayflowAgent: vi.fn(async () => ({ code: "OK" })) }));
vi.mock("@/lib/agent-run-readiness", () => ({ assertAgentRunReadyByPackage: vi.fn(async () => null) }));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode = 403;
    reason = "denied";
  },
}));
vi.mock("@/lib/authz/delegated-agent-run", () => ({
  captureDelegatedActorSnapshot: vi.fn(() => ({ principalId: "owner-1" })),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({
    orgId: "org-1",
    can: () => true,
  })),
}));

// ---------------------------------------------------------------------------
// Transitive deps the primitive hub pulls in but this suite never exercises.
// ---------------------------------------------------------------------------
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  createWayflowFetch: vi.fn(),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
}));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: () => true,
  assertSafePathSegment: () => undefined,
  listAgentPackages: vi.fn(),
}));
vi.mock("@cinatra-ai/skills", () => ({ upsertSkill: vi.fn(), parseFrontmatter: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(),
  resolveDevExtensionSourceRoot: vi.fn(),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/dev-extensions", () => ({ readEffectivePublishScopeOverride: vi.fn(async () => null) }));

const TEMPLATE = {
  id: "tpl-1",
  name: "Blog Draft Writer",
  packageName: "@cinatra-ai/blog-draft-writer-agent",
  lifecycleConfig: null as string | null,
  agentAuthPolicy: null,
  status: "published",
  sourceType: "internal",
  type: "leaf",
};

// The three launch frames the handler must tell apart. All three are shaped the
// way their real transport shapes them.
/** In-process chat pre-router — `chatActorToPrimitive` stamps `launchOrigin`. */
const CHAT_PRE_ROUTER_FRAME = {
  actorType: "human" as const,
  source: "mcp" as const,
  userId: "owner-1",
  launchOrigin: "chat" as const,
};
/** Remote MCP chat delegation — the agents registry forwards the
 *  transport-verified `delegatedRestricted` onto the model actor. */
const REMOTE_CHAT_DELEGATION_FRAME = {
  actorType: "model" as const,
  source: "agent" as const,
  userId: "owner-1",
  delegatedRestricted: true,
};
/** OBO / agent-as-tool child dispatch — neither carrier, so headless. */
const OBO_AGENT_AS_TOOL_FRAME = {
  actorType: "model" as const,
  source: "agent" as const,
  userId: "owner-1",
  oboCeiling: [{ tier: "organization" as const, id: "org-1" }],
};

async function dispatch(
  actor: Record<string, unknown>,
  input: Record<string, unknown> = { packageName: TEMPLATE.packageName },
): Promise<{ runId?: string; status?: string; error?: string }> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  const handlers = createAgentBuilderPrimitiveHandlers();
  return (await handlers.agent_run({
    primitiveName: "agent_run",
    input,
    actor,
    mode: "deterministic",
  })) as { runId?: string; status?: string; error?: string };
}

/** Every `pending_input → queued` CAS this call made. */
function dispatchCasCalls(): unknown[][] {
  return storeMock.transitionRunStatus.mock.calls.filter(
    (c: unknown[]) => c[1] === "pending_input" && c[2] === "queued",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authSessionMock.getAuthSession.mockResolvedValue(SESSION_WITH_ORG);
  authSessionMock.isPlatformAdmin.mockReturnValue(false);
  authSessionMock.resolveOrgRoleForUser.mockResolvedValue("member");
  storeMock.readAgentTemplateByPackageName.mockResolvedValue(TEMPLATE);
  storeMock.readAgentTemplateById.mockResolvedValue(TEMPLATE);
  storeMock.readAgentVersionsByTemplate.mockResolvedValue([{ id: "ver-1" }]);
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  storeMock.readAgentRunById.mockResolvedValue(null);
  enqueueAgentRun.mockResolvedValue(undefined);
  parkStore.readContinuationParksForRun.mockResolvedValue([]);
  parkStore.maybeParkCheckpoint.mockResolvedValue({ parked: true, parkId: "park-1" });
  // Default: the scorer finds nothing to confirm, so the hold declines.
  getRunRecommendations.mockResolvedValue([]);
});

/** Make the real hold FIRE: the scorer returns a candidate to confirm. */
function withRecommendationCandidate(): void {
  getRunRecommendations.mockResolvedValue([
    { skillId: "@cinatra-ai/chat:blog-content", recommended: true },
  ]);
}

// ---------------------------------------------------------------------------
// The chat pre-router parks
// ---------------------------------------------------------------------------
describe("a chat-pre-router dispatch parks on a recommendation hold", () => {
  beforeEach(() => {
    withRecommendationCandidate();
  });

  it("creates the run PARKED and human-present, so the hold can see it at all", async () => {
    await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(storeMock.createAgentRun).toHaveBeenCalledTimes(1);
    expect(storeMock.createAgentRun.mock.calls[0][0]).toMatchObject({
      initialStatus: "pending_input",
      humanPresent: true,
    });
    // The hold was asked about THIS run, with the template's own package name
    // and lifecycle config — the inputs its classification actually reads.
    // The hold ran against THIS run: its idempotency read is keyed on the run
    // id, and it only gets that far because the run is human-present.
    expect(parkStore.readContinuationParksForRun).toHaveBeenCalledTimes(1);
    expect(parkStore.readContinuationParksForRun.mock.calls[0]?.[0]).toBe(
      (storeMock.createAgentRun.mock.calls[0][0] as { id: string }).id,
    );
    expect(parkStore.maybeParkCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue it and does NOT move it off pending_input", async () => {
    await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(dispatchCasCalls()).toHaveLength(0);
  });

  it("reports the held status honestly, so the conversation cannot announce a run that is waiting", async () => {
    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(result.status).toBe("pending_input");
    expect(result.runId).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it("leaves the run in the state the Confirm/Skip release admits", async () => {
    // THE STRANDING TRAP, stated as an assertion. The release path refuses any
    // run that is not `pending_input` / `pending_trigger`, so a hold applied to
    // an already-`queued` row could never be let go. The handler's held result
    // is exactly one of the two admitted states.
    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);
    // READ FROM WHERE THE CONSTANT LIVES, which is the dispatch core since
    // cinatra#2790 (S9f) lifted the run-start dispatch out of `run-actions.ts`
    // so the widget's API branch could reach it. The assertion is unchanged —
    // it still reads the release path's own admitted set out of the source
    // rather than restating it — and it now reads the file that defines it.
    const dispatchCore = readFileSync(
      join(import.meta.dirname, "..", "run-dispatch-core.ts"),
      "utf8",
    );
    const admitted = dispatchCore.match(
      /RUN_START_DISPATCH_FROM_STATUSES = \[([^\]]+)\]/,
    );
    expect(admitted).not.toBeNull();
    expect(admitted?.[1]).toContain(`"${result.status}"`);
  });
});

// ---------------------------------------------------------------------------
// A released hold dispatches, exactly once
// ---------------------------------------------------------------------------
describe("a released hold dispatches through the canonical path, exactly once", () => {
  it("CASes pending_input → queued once and enqueues once when the hold does not fire", async () => {
    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(dispatchCasCalls()).toHaveLength(1);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("never enqueues twice when a concurrent writer already won the CAS", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new storeMock.RunTransitionError("stale_from_status"),
    );
    storeMock.readAgentRunById.mockResolvedValue({ id: "run-x", status: "running" });

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    // The other writer owns the dispatch. This call adds no second job, and it
    // reports the row's ACTUAL status rather than claiming a queue it did not
    // fill.
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
  });

  it("never reports queued when the enqueue failed, and reverts its own CAS", async () => {
    enqueueAgentRun.mockRejectedValue(new Error("redis down"));

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(result.status).toBeUndefined();
    expect(result.error).toContain("redis down");
    // Compensation: the run goes back to the state a person can retry from,
    // instead of sitting in `queued` with no job behind it.
    const reverts = storeMock.transitionRunStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "queued" && c[2] === "pending_input",
    );
    expect(reverts).toHaveLength(1);
  });

  it("FAILS the run when the enqueue fails AND the revert fails", async () => {
    // The one state nothing recovers on its own is `queued` with no job: no
    // worker picks it up and no surface offers a way to move it. When the run
    // cannot be returned to its waiting state, it is landed TERMINAL instead,
    // so the person sees a failed run carrying the reason rather than a run
    // that waits forever.
    enqueueAgentRun.mockRejectedValue(new Error("redis down"));
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, from: string, to: string) => {
        if (from === "queued" && to === "pending_input") throw new Error("revert failed");
        return undefined;
      },
    );

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    const failed = storeMock.transitionRunStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "queued" && c[2] === "failed",
    );
    expect(failed).toHaveLength(1);
    // The reason travels with the run rather than only into a log line.
    expect(JSON.stringify(failed[0]?.[3])).toContain("redis down");
    // The caller still learns the dispatch failed, and never sees `queued`.
    expect(result.status).toBeUndefined();
    expect(result.error).toContain("redis down");
  });

  it("reports the run STRANDED by name when it can be neither reverted nor failed", async () => {
    // The last rung. Nothing can land the run honestly, so the error says so
    // and names the run — rather than reporting only the enqueue failure and
    // leaving a phantom queued row nobody is looking for.
    enqueueAgentRun.mockRejectedValue(new Error("redis down"));
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, from: string) => {
        if (from === "queued") throw new Error("writer down");
        return undefined;
      },
    );

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(result.status).toBeUndefined();
    expect(result.error).toContain("STRANDED");
    expect(result.error).toContain("queued with no job behind it");
    const created = storeMock.createAgentRun.mock.calls[0][0] as { id: string };
    expect(result.error).toContain(created.id);
  });

  it("refuses to guess when the stale-CAS re-read THROWS", async () => {
    // Losing the dispatch race is fine; guessing the winner's state is not.
    // The previous default answered `pending_input`, which reports a run as
    // parked and decidable when no park is live and no job was made.
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new storeMock.RunTransitionError("stale_from_status"),
    );
    storeMock.readAgentRunById.mockRejectedValue(new Error("read down"));

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(result.status).toBeUndefined();
    expect(result.error).toContain("could not be re-read");
    const created = storeMock.createAgentRun.mock.calls[0][0] as { id: string };
    expect(result.error).toContain(created.id);
  });

  it("refuses to guess when the stale-CAS re-read finds NOTHING", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new storeMock.RunTransitionError("stale_from_status"),
    );
    storeMock.readAgentRunById.mockResolvedValue(null);

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(result.status).toBeUndefined();
    expect(result.error).toContain("no longer reads back");
  });
});

// ---------------------------------------------------------------------------
// Presence is server-derived
// ---------------------------------------------------------------------------
describe("presence comes from the verified frame, never from the call's arguments", () => {
  it("a remote delegation:\"chat\" frame parks", async () => {
    withRecommendationCandidate();

    const result = await dispatch(REMOTE_CHAT_DELEGATION_FRAME);

    expect(result.status).toBe("pending_input");
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    // No second remote claim was invented: the transport-verified
    // `delegatedRestricted` is the whole carrier for this path.
    expect(storeMock.createAgentRun.mock.calls[0][0]).toMatchObject({ humanPresent: true });
  });

  it("an OBO / agent-as-tool dispatch stays headless — created queued, enqueued, never held", async () => {
    withRecommendationCandidate();

    const result = await dispatch(OBO_AGENT_AS_TOOL_FRAME);

    expect(storeMock.createAgentRun.mock.calls[0][0]).toMatchObject({
      initialStatus: "queued",
      humanPresent: undefined,
    });
    // The hold is not merely answered "no" for this frame — it is never asked.
    // A candidate IS available; the run simply never reaches the question,
    // because it is not human-present.
    expect(parkStore.readContinuationParksForRun).not.toHaveBeenCalled();
    expect(parkStore.maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(dispatchCasCalls()).toHaveLength(0);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("a model cannot claim presence through the primitive's own input", async () => {
    withRecommendationCandidate();

    // Every spelling a model could reach for, on an otherwise headless frame.
    const result = await dispatch(OBO_AGENT_AS_TOOL_FRAME, {
      packageName: TEMPLATE.packageName,
      launchOrigin: "chat",
      humanPresent: true,
      delegatedRestricted: true,
      actor: { launchOrigin: "chat" },
      inputParams: JSON.stringify({ launchOrigin: "chat", humanPresent: true }),
    });

    expect(parkStore.readContinuationParksForRun).not.toHaveBeenCalled();
    expect(storeMock.createAgentRun.mock.calls[0][0]).toMatchObject({
      initialStatus: "queued",
      humanPresent: undefined,
    });
    expect(result.status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------
describe("a hold-evaluation failure fails OPEN", () => {
  it("dispatches the run normally, CASing and enqueueing exactly once", async () => {
    withRecommendationCandidate();
    parkStore.readContinuationParksForRun.mockRejectedValue(new Error("park store down"));

    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    expect(dispatchCasCalls()).toHaveLength(1);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The handler's existing creation semantics are untouched
// ---------------------------------------------------------------------------
describe("the chat branch preserves every other creation semantic", () => {
  it("keeps the version pin, timeout, project, delegated-actor snapshot and scope actor when it parks", async () => {
    withRecommendationCandidate();

    await dispatch(CHAT_PRE_ROUTER_FRAME, {
      packageName: TEMPLATE.packageName,
      timeoutSeconds: 120,
    });

    const created = storeMock.createAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(created.versionId).toBe("ver-1");
    expect(created.timeoutSeconds).toBe(120);
    expect(created.templateId).toBe(TEMPLATE.id);
    expect(created.orgId).toBe("org-1");
    expect(created.delegatedActorSnapshot).toBeTruthy();
    expect(created.scopeActor).toBeTruthy();
  });

  it("holds the handler-selected run id across create, hold, enqueue and result", async () => {
    // The handler picks the run id ONCE and every later step addresses that
    // same run. The parked branch inserts two more steps between the pick and
    // the enqueue, which is exactly where an id could drift.
    const result = await dispatch(CHAT_PRE_ROUTER_FRAME);

    const created = storeMock.createAgentRun.mock.calls[0][0] as { id: string };
    const held = parkStore.readContinuationParksForRun.mock.calls[0]?.[0] as string | undefined;
    const enqueued = enqueueAgentRun.mock.calls[0]?.[0] as { runId: string };
    const cas = dispatchCasCalls()[0] as unknown[];

    expect(result.runId).toBe(created.id);
    expect(held).toBe(created.id);
    expect(enqueued.runId).toBe(created.id);
    expect(cas[0]).toBe(created.id);
  });
});
