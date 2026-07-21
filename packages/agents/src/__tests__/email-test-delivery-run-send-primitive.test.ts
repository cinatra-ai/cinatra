/**
 * Unit tests for the run-scoped test-delivery primitives (eng#548 #1625):
 *   email_test_delivery_run_send
 *   email_test_delivery_parse_action
 *
 * Contract under test (handler level; the ledger's atomic claim is proven
 * against a real DB by the store's own precedent, the app port impl by the app
 * suites):
 *   - run id + submission id derived from VERIFIED context channels only, never
 *     caller input;
 *   - declaring-package restriction to @cinatra-ai/email-test-delivery-agent;
 *   - EXECUTE-tier authz (not just read);
 *   - campaign PINNED from run.inputParams.campaignId (caller campaign ignored);
 *   - the two-phase prepare→claim→perform flow, fail-closed on an unwired port;
 *   - idempotency: a same-submission retry returns the prior result WITHOUT a
 *     second send; a distinct submission is a distinct send;
 *   - in-flight / expired-lease-reconcile / previous_send_unknown crash paths;
 *   - parse_action typed actions + halt-at-maxGateVisits + malformed→continue.
 *
 * Uses the REAL mcpRequestContextStorage ALS + the REAL (pure-leaf) send port
 * module (a fake port injected via setTestDeliverySendPort); the ledger store is
 * mocked so the tests pin the handler's decision logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  setTestDeliverySendPort,
  type TestDeliverySendPort,
} from "../test-delivery-send-port";

// --- auth-session (resolveRoleHintsFromSession) -----------------------------
const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// --- store ------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
  readAllHitlPromptsForRun: vi.fn(),
  updateHitlPromptsExcludedForRunAgent: vi.fn(),
  writeHitlPrompt: vi.fn(),
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(),
  readAgentRunMessages: vi.fn(),
  appendAgentRunMessage: vi.fn(),
  transitionRunStatus: vi.fn(),
  RunTransitionError: class extends Error {},
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  readAgentTemplateVersions: vi.fn(),
  readAgentTemplateVersionById: vi.fn(),
  diffSnapshots: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  setAgentTemplatePackageName: vi.fn(),
  bulkStopAgentRuns: vi.fn(),
  bulkStopAgentRunsByTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplatePackageVersion: vi.fn(),
}));
vi.mock("../store", () => storeMock);

// --- agent-run-test-sends ledger --------------------------------------------
const ledgerMock = vi.hoisted(() => ({
  claimTestSend: vi.fn(),
  settleTestSend: vi.fn(),
  recordPreClaimFailure: vi.fn(),
  readTestSendBySubmission: vi.fn(),
  readSentCountForRun: vi.fn(async () => 0),
  readMaxSeqForRun: vi.fn(async () => 0),
}));
vi.mock("../agent-run-test-sends", () => ledgerMock);

// --- auth-policy ------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// --- authz ------------------------------------------------------------------
const authzMock = vi.hoisted(() => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  can: vi.fn(async () => true),
  AuthzError: class extends Error {
    statusCode: number;
    reason: string;
    constructor({ statusCode, reason, message }: { statusCode: number; reason: string; message: string }) {
      super(message);
      this.statusCode = statusCode;
      this.reason = reason;
    }
  },
}));
vi.mock("@/lib/authz", () => authzMock);

// --- transitive dep mocks (keep the handlers.ts import graph light) ---------
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn(), AGENT_RUN_TIMEOUT_MAX_SECONDS: 3600 }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean => typeof s === "string",
  assertSafePathSegment: (): void => undefined,
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
vi.mock("../agent-runtime-mount", () => ({ resolveAgentRuntimeMountDir: vi.fn(), resolveDevExtensionSourceRoot: vi.fn() }));
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
  buildListPage: vi.fn((items: unknown[], total: number) => ({ items, total, nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => ({ id: "u" })),
}));

// ---------------------------------------------------------------------------
type HandlerMap = Record<string, (req: Record<string, unknown>) => Promise<unknown>>;
async function getHandlers(): Promise<HandlerMap> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return createAgentBuilderPrimitiveHandlers() as HandlerMap;
}

const RUN_ID = "run-td-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";
const PKG = "@cinatra-ai/email-test-delivery-agent";
const CAMPAIGN_ID = "camp-1";
const SUBMISSION_A = "task-A";
const SUBMISSION_B = "task-B";

const RUN = {
  id: RUN_ID,
  templateId: "tpl-1",
  runBy: OWNER_ID,
  orgId: ORG_ID,
  status: "pending_approval",
  inputParams: { campaignId: CAMPAIGN_ID },
  dependentInstallId: null,
  authPolicy: null,
  oboCeiling: null,
};

const OWNER_ACTOR = { userId: OWNER_ID, actorType: "human", source: "mcp" } as const;

let fakePort: {
  prepareSend: ReturnType<typeof vi.fn>;
  performSend: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
};

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "arts_1",
    runId: RUN_ID,
    submissionId: SUBMISSION_A,
    seq: 1,
    status: "sending",
    recipientEmail: "to@example.com",
    selectedDraftIds: ["d1"],
    resultJson: null,
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 120_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

async function withSendContext<T>(
  opts: { runId?: string; submissionId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return mcpRequestContextStorage.run(
    {
      verifiedRunScopeId: opts.runId,
      verifiedSubmissionId: opts.submissionId,
      // A forged ambient runId proves the handler trusts only the verified field.
      runId: "run-HEADER-FORGED",
      userId: OWNER_ID,
      orgId: ORG_ID,
    },
    fn,
  );
}

function callSend(handlers: HandlerMap, input: Record<string, unknown>, actor: unknown = OWNER_ACTOR) {
  return handlers["email_test_delivery_run_send"]({
    primitiveName: "email_test_delivery_run_send",
    input,
    actor,
    mode: "deterministic",
  });
}

const VALID_SEND_INPUT = { recipientEmail: "to@example.com", selectionMode: "random_initial" };

beforeEach(() => {
  vi.clearAllMocks();
  authSessionMock.getAuthSession.mockResolvedValue(null);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  storeMock.readAgentRunById.mockResolvedValue({ ...RUN });
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: PKG, approvalPolicy: { steps: [] } });
  storeMock.readRunCoOwners.mockResolvedValue([]);
  ledgerMock.readTestSendBySubmission.mockResolvedValue(null);
  ledgerMock.readSentCountForRun.mockResolvedValue(0);
  ledgerMock.readMaxSeqForRun.mockResolvedValue(0);
  ledgerMock.claimTestSend.mockResolvedValue({ kind: "claimed", row: makeRow() });
  // F3: a pre-claim failure ALLOCATES a fresh seq via a terminal `failed` row so
  // gateCycle advances. The default mock echoes the failure result + a fresh seq.
  ledgerMock.recordPreClaimFailure.mockImplementation(async (input: {
    runId: string; submissionId: string; recipientEmail: string | null; result: Record<string, unknown>;
  }) => ({
    kind: "recorded" as const,
    row: makeRow({
      status: "failed",
      seq: 7,
      submissionId: input.submissionId,
      recipientEmail: input.recipientEmail,
      resultJson: input.result,
    }),
  }));
  ledgerMock.settleTestSend.mockImplementation(async (input: { id: string; status: string; result: Record<string, unknown> }) =>
    makeRow({ id: input.id, status: input.status, resultJson: input.result }),
  );
  fakePort = {
    prepareSend: vi.fn(async () => ({ ok: true, recipientEmail: "to@example.com", selectedDraftIds: ["d1"] })),
    performSend: vi.fn(async () => ({ ok: true, sentTo: "to@example.com", sentCount: 1, message: "Test email sent to to@example.com." })),
    reconcile: vi.fn(async () => "unknown"),
  };
  setTestDeliverySendPort(fakePort as unknown as TestDeliverySendPort);
});

// ===========================================================================
// email_test_delivery_run_send — happy path + two-phase flow
// ===========================================================================
describe("email_test_delivery_run_send — send flow", () => {
  it("performs the two-phase send and returns { ok:true, seq }", async () => {
    const handlers = await getHandlers();
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, seq: 1, sentTo: "to@example.com" });
    // prepare BEFORE claim BEFORE perform BEFORE settle.
    expect(fakePort.prepareSend).toHaveBeenCalledTimes(1);
    expect(ledgerMock.claimTestSend).toHaveBeenCalledTimes(1);
    expect(fakePort.performSend).toHaveBeenCalledTimes(1);
    expect(ledgerMock.settleTestSend).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent" }),
    );
  });

  it("PINS the campaign from run.inputParams — a caller campaign is never read", async () => {
    const handlers = await getHandlers();
    await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      // A malicious campaignId in input must be ignored.
      callSend(handlers, { ...VALID_SEND_INPUT, campaignId: "camp-EVIL" }),
    );
    expect(fakePort.prepareSend).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
    expect(fakePort.performSend).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID, submissionId: SUBMISSION_A }),
    );
  });

  it("uses the EXECUTE tier for authz (a mutating send needs more than read)", async () => {
    const handlers = await getHandlers();
    await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    );
    const [, , opArg] = authPolicyMock.enforceRunAccess.mock.calls[0] as [unknown, unknown, string];
    expect(opArg).toBe("execute");
  });

  it("returns a typed failure (as data, no throw) when the send fails", async () => {
    const handlers = await getHandlers();
    fakePort.performSend.mockResolvedValueOnce({ ok: false, reason: "send_failed", message: "boom" });
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, reason: "send_failed", seq: 1 });
    expect(ledgerMock.settleTestSend).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

// ===========================================================================
// authz / scope denials
// ===========================================================================
describe("email_test_delivery_run_send — authz & scope", () => {
  it("denies a run whose declaring package is not the test-delivery agent", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentTemplateById.mockResolvedValueOnce({ id: "tpl-1", packageName: "@evil/other-agent" });
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as { error?: string };
    expect(result.error).toMatch(/only callable by the @cinatra-ai\/email-test-delivery-agent/i);
    expect(fakePort.prepareSend).not.toHaveBeenCalled();
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
  });

  it("surfaces an execute-tier denial (safe error + denial audit), no claim/send", async () => {
    const handlers = await getHandlers();
    authPolicyMock.enforceRunAccess.mockRejectedValueOnce(
      new authzMock.AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT, { userId: "intruder", actorType: "human", source: "mcp" }),
    )) as { error?: string };
    expect(result.error).toBe("Run access denied.");
    expect(fakePort.prepareSend).not.toHaveBeenCalled();
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
    expect(authzMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", resourceId: RUN_ID }),
    );
  });

  it("maps a cross-tenant campaign (prepare campaign_access_denied) to data, no claim, but ADVANCES seq (F3)", async () => {
    const handlers = await getHandlers();
    fakePort.prepareSend.mockResolvedValueOnce({ ok: false, reason: "campaign_access_denied" });
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    // F3: the pre-claim failure is recorded as a `failed` row that allocates a
    // fresh seq (7 here) so gateCycle advances and the renderer clears pending.
    expect(result).toMatchObject({ ok: false, reason: "campaign_access_denied", seq: 7 });
    expect(ledgerMock.recordPreClaimFailure).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, submissionId: SUBMISSION_A }),
    );
    // still NO real send claim.
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
    expect(fakePort.performSend).not.toHaveBeenCalled();
  });

  it("fails closed on an unwired send port (never a phantom success)", async () => {
    const handlers = await getHandlers();
    setTestDeliverySendPort(null);
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as { error?: string };
    expect(result.error).toMatch(/send port is not wired/i);
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
  });

  it("fails closed with connector_unavailable when the run has no owner mailbox, ADVANCING seq (F3)", async () => {
    const handlers = await getHandlers();
    storeMock.readAgentRunById.mockResolvedValueOnce({ ...RUN, runBy: null });
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    // F3: even the null-owner pre-claim failure advances seq so the gate never strands.
    expect(result).toMatchObject({ ok: false, reason: "connector_unavailable", seq: 7 });
    expect(ledgerMock.recordPreClaimFailure).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, submissionId: SUBMISSION_A }),
    );
    expect(fakePort.performSend).not.toHaveBeenCalled();
  });

  it("returns the WINNING row verbatim when a pre-claim failure conflicts with an existing send (F3)", async () => {
    const handlers = await getHandlers();
    // A same-submission transport retry: the row already SENT. recordPreClaimFailure
    // ON CONFLICT reads it back and the handler returns it verbatim — never a fresh seq.
    fakePort.prepareSend.mockResolvedValueOnce({ ok: false, reason: "campaign_access_denied" });
    ledgerMock.recordPreClaimFailure.mockResolvedValueOnce({
      kind: "existing",
      row: makeRow({
        status: "sent",
        seq: 2,
        resultJson: { ok: true, sentTo: "to@example.com", sentCount: 1, message: "Test email sent to to@example.com." },
      }),
    });
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, seq: 2, sentTo: "to@example.com" });
  });

  it("fails closed with no verified run context", async () => {
    const handlers = await getHandlers();
    const result = (await withSendContext({ runId: undefined, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as { error?: string };
    expect(result.error).toMatch(/verified run context/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
  });

  it("fails closed with no verified submission id", async () => {
    const handlers = await getHandlers();
    const result = (await withSendContext({ runId: RUN_ID, submissionId: undefined }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as { error?: string };
    expect(result.error).toMatch(/no verified submission id/i);
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
  });

  it("rejects an invalid selectionMode without any send", async () => {
    const handlers = await getHandlers();
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, { recipientEmail: "to@example.com", selectionMode: "bogus" }),
    )) as { error?: string };
    expect(result.error).toMatch(/selectionMode/i);
    expect(fakePort.prepareSend).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Idempotency — same submission retry vs distinct submission (the matrix)
// ===========================================================================
describe("email_test_delivery_run_send — idempotency matrix", () => {
  it("a same-submission retry returns the prior result WITHOUT a second send", async () => {
    const handlers = await getHandlers();
    // First call: no row → claim → send → settle.
    const first = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, seq: 1 });

    // Second call, SAME submission: the ledger now has a terminal row.
    ledgerMock.readTestSendBySubmission.mockResolvedValueOnce(
      makeRow({ status: "sent", seq: 1, resultJson: { ok: true, sentTo: "to@example.com", sentCount: 1, message: "Test email sent to to@example.com." } }),
    );
    const second = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;

    expect(second).toMatchObject({ ok: true, seq: 1, sentTo: "to@example.com" });
    // performSend ran exactly ONCE across both calls.
    expect(fakePort.performSend).toHaveBeenCalledTimes(1);
  });

  it("a DISTINCT submission is a distinct send (two claims, two sends)", async () => {
    const handlers = await getHandlers();
    ledgerMock.claimTestSend
      .mockResolvedValueOnce({ kind: "claimed", row: makeRow({ submissionId: SUBMISSION_A, seq: 1 }) })
      .mockResolvedValueOnce({ kind: "claimed", row: makeRow({ submissionId: SUBMISSION_B, seq: 2 }) });

    await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    );
    await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_B }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    );

    expect(fakePort.performSend).toHaveBeenCalledTimes(2);
    expect(fakePort.performSend.mock.calls[0][0]).toMatchObject({ submissionId: SUBMISSION_A });
    expect(fakePort.performSend.mock.calls[1][0]).toMatchObject({ submissionId: SUBMISSION_B });
  });

  it("reports send_in_progress for a live in-flight claim (never a second send)", async () => {
    const handlers = await getHandlers();
    ledgerMock.readTestSendBySubmission.mockResolvedValueOnce(
      makeRow({ status: "sending", leaseExpiresAt: new Date(Date.now() + 60_000), seq: 3 }),
    );
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, reason: "send_in_progress", seq: 3 });
    expect(fakePort.performSend).not.toHaveBeenCalled();
  });

  it("reconciles an expired-lease claim to 'sent' when the outbound store confirms coverage", async () => {
    const handlers = await getHandlers();
    ledgerMock.readTestSendBySubmission.mockResolvedValueOnce(
      makeRow({ status: "sending", leaseExpiresAt: new Date(Date.now() - 1000), seq: 4, selectedDraftIds: ["d1"] }),
    );
    // settle preserves the claimed row's seq (real store updates by id).
    ledgerMock.settleTestSend.mockResolvedValueOnce(
      makeRow({ status: "sent", seq: 4, resultJson: { ok: true, sentTo: "to@example.com", sentCount: 1, message: "Test email sent to to@example.com." } }),
    );
    fakePort.reconcile.mockResolvedValueOnce("sent");
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(fakePort.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: SUBMISSION_A, expectedDraftIds: ["d1"] }),
    );
    expect(ledgerMock.settleTestSend).toHaveBeenCalledWith(expect.objectContaining({ status: "sent" }));
    expect(result).toMatchObject({ ok: true, seq: 4 });
    expect(fakePort.performSend).not.toHaveBeenCalled();
  });

  it("returns previous_send_unknown for an ambiguous expired-lease claim (no auto-resend)", async () => {
    const handlers = await getHandlers();
    ledgerMock.readTestSendBySubmission.mockResolvedValueOnce(
      makeRow({ status: "sending", leaseExpiresAt: new Date(Date.now() - 1000), seq: 5 }),
    );
    fakePort.reconcile.mockResolvedValueOnce("unknown");
    const result = (await withSendContext({ runId: RUN_ID, submissionId: SUBMISSION_A }, () =>
      callSend(handlers, VALID_SEND_INPUT),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, reason: "previous_send_unknown", seq: 5 });
    expect(fakePort.performSend).not.toHaveBeenCalled();
    expect(ledgerMock.settleTestSend).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// email_test_delivery_parse_action
// ===========================================================================
describe("email_test_delivery_parse_action", () => {
  function callParse(handlers: HandlerMap, userResponse: unknown) {
    return withSendContext({ runId: RUN_ID }, () =>
      handlers["email_test_delivery_parse_action"]({
        primitiveName: "email_test_delivery_parse_action",
        input: { userResponse },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    );
  }

  it("parses a typed send envelope into { action:'send', ...fields }", async () => {
    const handlers = await getHandlers();
    const result = (await callParse(
      handlers,
      JSON.stringify({ action: "send", recipientEmail: "to@example.com", selectionMode: "specific_initial", specificInitialDraftIds: ["d1", "d2"] }),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      action: "send",
      recipientEmail: "to@example.com",
      selectionMode: "specific_initial",
      specificInitialDraftIds: ["d1", "d2"],
    });
  });

  it("returns action:'continue' for a continue envelope", async () => {
    const handlers = await getHandlers();
    const result = (await callParse(handlers, JSON.stringify({ action: "continue" }))) as { action: string };
    expect(result.action).toBe("continue");
  });

  it("defaults to action:'continue' for a malformed / absent envelope (never crashes)", async () => {
    const handlers = await getHandlers();
    for (const bad of ["not json", "", undefined, JSON.stringify({ noAction: true })]) {
      const result = (await callParse(handlers, bad)) as { action: string };
      expect(result.action).toBe("continue");
    }
  });

  it("forces action:'halt' when the performed-send count has reached maxGateVisits", async () => {
    const handlers = await getHandlers();
    ledgerMock.readSentCountForRun.mockResolvedValueOnce(25); // == default cap
    const result = (await callParse(handlers, JSON.stringify({ action: "send", recipientEmail: "to@example.com", selectionMode: "random_initial" }))) as {
      action: string;
      maxGateVisits?: number;
    };
    expect(result.action).toBe("halt");
    expect(result.maxGateVisits).toBe(25);
  });

  it("does NOT halt a continue action regardless of send count", async () => {
    const handlers = await getHandlers();
    ledgerMock.readSentCountForRun.mockResolvedValueOnce(99);
    const result = (await callParse(handlers, JSON.stringify({ action: "continue" }))) as { action: string };
    expect(result.action).toBe("continue");
  });

  it("fails closed with no verified run context", async () => {
    const handlers = await getHandlers();
    const result = (await mcpRequestContextStorage.run({ runId: "forged", userId: OWNER_ID, orgId: ORG_ID }, () =>
      handlers["email_test_delivery_parse_action"]({
        primitiveName: "email_test_delivery_parse_action",
        input: { userResponse: JSON.stringify({ action: "send" }) },
        actor: OWNER_ACTOR,
        mode: "deterministic",
      }),
    )) as { error?: string };
    expect(result.error).toMatch(/verified run context/i);
  });
});
