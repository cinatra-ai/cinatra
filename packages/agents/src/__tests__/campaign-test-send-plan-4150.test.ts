/**
 * The plan primitive and the pinned send (cinatra#4150).
 *
 *   campaign_test_send_plan       — answers what a publish card shows (From, To, the pinned drafts) and the pinned
 *                                   plan; sends nothing; refusals are recorded like the send's so the form's cycle
 *                                   advances.
 *   email_test_delivery_run_send  — with `pinnedPlanJson` sends exactly that plan; without it, the selection send
 *                                   exactly as before.
 *
 * Same seams as email-test-delivery-run-send-primitive.test.ts: the real ALS frame and the real leaf port module (a
 * fake port injected), the ledger and the decision store mocked.
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
  readUnacknowledgedDeliveredDraftIds: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("../agent-run-test-sends", () => ledgerMock);

// --- field-renderer bindings (registry-routed gate-owner restriction) ---------
// The send wrapper resolves the AGENT packages that OWN the test-delivery gate
// from the manifest/registry (core names NO extension package). The gate owner is
// the binding-ID prefix — NOT the binding's physical `declaredBy`.
//
// The default binding mirrors the REAL post-#1958 generated binding: the renderer
// was RELOCATED into @cinatra-ai/email-artifacts (so `declaredBy` is the artifacts
// pack) while the binding ID — the gate identity — stays
// `@cinatra-ai/email-test-delivery-agent:input`. This shape is deliberate: the
// happy-path send tests dispatch a run whose package is
// @cinatra-ai/email-test-delivery-agent, so they PASS only if authz keys on the
// binding-ID owner (the fix) and FAIL if it keys on `declaredBy` (the #1958
// regression) — the whole suite guards the relocation.
const bindingsMock = vi.hoisted(() => ({
  getMergedFieldRendererBindings: vi.fn(() => [
    {
      id: "@cinatra-ai/email-test-delivery-agent:input",
      kind: "test-delivery-input",
      priority: 80,
      declaredBy: "@cinatra-ai/email-artifacts",
    },
  ]),
}));
vi.mock("../field-renderer-bindings.server", () => bindingsMock);

// --- auth-policy ------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// --- publish decision store (the released decision a pinned send is compared with) ---
const decisionMock = vi.hoisted(() => ({
  readDecisionOfRun: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../publish-decision-store", () => decisionMock);

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
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 3600,
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
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
async function handler(name: string): Promise<(req: Record<string, unknown>) => Promise<unknown>> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  const fn = (createAgentBuilderPrimitiveHandlers() as HandlerMap)[name];
  expect(typeof fn).toBe("function");
  return fn!;
}

const RUN_ID = "run-td-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";
const PKG = "@cinatra-ai/email-test-delivery-agent";
const CAMPAIGN_ID = "camp-1";
const FORM_TASK = "task-form-1";
const CARD_TASK = "task-card-1";
const REV1 = "a".repeat(64);
const REV2 = "b".repeat(64);

const RUN = {
  id: RUN_ID,
  templateId: "tpl-1",
  runBy: OWNER_ID,
  orgId: ORG_ID,
  status: "running",
  inputParams: { campaignId: CAMPAIGN_ID },
  dependentInstallId: null,
  authPolicy: null,
  oboCeiling: null,
};
const OWNER_ACTOR = { userId: OWNER_ID, actorType: "human", source: "a2a" } as const;

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "arts_1", runId: RUN_ID, submissionId: CARD_TASK, seq: 3, status: "sending",
    recipientEmail: "tester@example.com", selectedDraftIds: ["d1", "d2"], resultJson: null,
    claimedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 120_000), createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function frame<T>(submissionId: string, fn: () => Promise<T>, stepId?: string, claimedDecisionId?: string): Promise<T> {
  return mcpRequestContextStorage.run(
    { verifiedRunScopeId: RUN_ID, verifiedSubmissionId: submissionId, userId: OWNER_ID, orgId: ORG_ID,
      ...(stepId ? { verifiedStepId: stepId } : {}),
      ...(claimedDecisionId ? { publishCallClaim: { runId: RUN_ID, decisionId: claimedDecisionId } } : {}) },
    fn,
  );
}

async function plan(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fn = await handler("campaign_test_send_plan");
  return (await frame(FORM_TASK, () =>
    fn({ primitiveName: "campaign_test_send_plan", input, actor: OWNER_ACTOR, mode: "deterministic" }))) as Record<string, unknown>;
}

async function send(input: Record<string, unknown>, stepId?: string, claimedDecisionId?: string): Promise<Record<string, unknown>> {
  const fn = await handler("email_test_delivery_run_send");
  return (await frame(CARD_TASK, () =>
    fn({ primitiveName: "email_test_delivery_run_send", input, actor: OWNER_ACTOR, mode: "deterministic" }), stepId, claimedDecisionId)) as Record<string, unknown>;
}

const PLAN_INPUT = { recipientEmail: "tester@example.com", selectionMode: "random_initial" };
const PLAN_WIRE = {
  v: 1,
  campaignId: CAMPAIGN_ID,
  sender: { email: "sales@example.com", name: "Sales" },
  recipientEmail: "tester@example.com",
  drafts: [{ id: "d1", revision: REV1 }, { id: "d2", revision: REV2 }],
};
const PLAN_JSON = JSON.stringify(PLAN_WIRE);

let fakePort: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  authSessionMock.getAuthSession.mockResolvedValue(null);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  storeMock.readAgentRunById.mockResolvedValue({ ...RUN });
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: PKG, approvalPolicy: { steps: [] } });
  storeMock.readRunCoOwners.mockResolvedValue([]);
  decisionMock.readDecisionOfRun.mockResolvedValue(null);
  ledgerMock.readTestSendBySubmission.mockResolvedValue(null);
  ledgerMock.readUnacknowledgedDeliveredDraftIds.mockResolvedValue([]);
  bindingsMock.getMergedFieldRendererBindings.mockReturnValue([
    { id: "@cinatra-ai/email-test-delivery-agent:input", kind: "test-delivery-input", priority: 80, declaredBy: "@cinatra-ai/email-artifacts" },
  ]);
  ledgerMock.claimTestSend.mockResolvedValue({ kind: "claimed", row: row() });
  ledgerMock.recordPreClaimFailure.mockImplementation(async (input: { submissionId: string; recipientEmail: string | null; result: Record<string, unknown> }) => ({
    kind: "recorded" as const,
    row: row({ status: "failed", seq: 7, submissionId: input.submissionId, recipientEmail: input.recipientEmail, resultJson: input.result }),
  }));
  ledgerMock.settleTestSend.mockImplementation(async (input: { id: string; status: string; result: Record<string, unknown> }) =>
    row({ id: input.id, status: input.status, resultJson: input.result }));
  fakePort = {
    prepareSend: vi.fn(async () => ({
      ok: true,
      recipientEmail: "tester@example.com",
      selectedDraftIds: ["d1", "d2"],
      sender: { email: "sales@example.com", name: "Sales" },
      drafts: [
        { id: "d1", revision: REV1, subject: "Hello", preview: "Hi there." },
        { id: "d2", revision: REV2, subject: "Follow", preview: "Second." },
      ],
    })),
    performSend: vi.fn(async () => ({ ok: true, sentTo: "tester@example.com", sentCount: 1, deliveredDraftIds: ["d9"], message: "Test email sent to tester@example.com." })),
    performPinnedSend: vi.fn(async () => ({ ok: true, sentTo: "tester@example.com", sentCount: 2, deliveredDraftIds: ["d1", "d2"], message: "Test email sent to tester@example.com." })),
    reconcile: vi.fn(async () => "unknown"),
  };
  setTestDeliverySendPort(fakePort as unknown as TestDeliverySendPort);
});

describe("campaign_test_send_plan answers what the publish card shows", () => {
  it("answers From, To, the pinned drafts and the plan, and sends nothing", async () => {
    const answer = await plan(PLAN_INPUT);
    expect(answer).toEqual({
      ok: true,
      sender: "Sales <sales@example.com>",
      recipient: "tester@example.com",
      drafts: [
        { subject: "Hello", preview: "Hi there.", draftId: "d1", revision: REV1 },
        { subject: "Follow", preview: "Second.", draftId: "d2", revision: REV2 },
      ],
      draftCount: 2,
      planJson: PLAN_JSON,
      lastSendResult: null,
      gateCycle: 0,
    });
    expect(fakePort.prepareSend).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: CAMPAIGN_ID, recipientEmail: "tester@example.com", selectionMode: "random_initial",
    }));
    expect(fakePort.performSend).not.toHaveBeenCalled();
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
    expect(ledgerMock.recordPreClaimFailure).not.toHaveBeenCalled();
  });

  it("is held to execute-tier run authz and to the run that hosts the test-delivery gate", async () => {
    await plan(PLAN_INPUT);
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(expect.anything(), OWNER_ACTOR, "execute", undefined);
    storeMock.readAgentTemplateById.mockResolvedValue({ id: "tpl-1", packageName: "@cinatra-ai/other-agent" });
    const refused = await plan(PLAN_INPUT);
    expect(refused).toMatchObject({ ok: false, reason: "not_authorized", gateCycle: 7, planJson: "" });
    expect(fakePort.prepareSend).toHaveBeenCalledTimes(1);
  });

  it("records a refusal so the form's cycle advances, and answers it in the form's shape", async () => {
    const answer = await plan({ recipientEmail: "", selectionMode: "random_initial" });
    expect(answer).toMatchObject({
      ok: false,
      reason: "invalid_recipient",
      seq: 7,
      gateCycle: 7,
      lastSendResult: { ok: false, message: "Enter a valid recipient email address for the test send." },
      sender: "",
      recipient: "",
      drafts: [],
      draftCount: 0,
      planJson: "",
    });
    expect(ledgerMock.recordPreClaimFailure).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, submissionId: FORM_TASK }));
  });

  it("leaves out drafts a previous partial send already delivered to this recipient", async () => {
    ledgerMock.readUnacknowledgedDeliveredDraftIds.mockResolvedValue(["d1"]);
    const answer = await plan(PLAN_INPUT);
    expect(answer.drafts).toEqual([{ subject: "Follow", preview: "Second.", draftId: "d2", revision: REV2 }]);
    expect(JSON.parse(answer.planJson as string).drafts).toEqual([{ id: "d2", revision: REV2 }]);
  });

  it("refuses more drafts than the card's list row draws", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `d${i}`, revision: REV1, subject: "S", preview: "P" }));
    fakePort.prepareSend!.mockResolvedValue({
      ok: true, recipientEmail: "tester@example.com", selectedDraftIds: many.map((d) => d.id),
      sender: { email: "sales@example.com", name: "Sales" }, drafts: many,
    });
    expect(await plan(PLAN_INPUT)).toMatchObject({ ok: false, reason: "too_many_drafts", planJson: "" });
  });

  it("fails closed when the host port answers no plan detail", async () => {
    fakePort.prepareSend!.mockResolvedValue({ ok: true, recipientEmail: "tester@example.com", selectedDraftIds: ["d1"] });
    expect(await plan(PLAN_INPUT)).toMatchObject({ error: expect.stringContaining("no plan detail") });
  });

  it("refuses at planning a recipient the send would refuse (over 320 characters)", async () => {
    const long = `${"a".repeat(310)}@example.com`;
    expect(await plan({ ...PLAN_INPUT, recipientEmail: long })).toMatchObject({ ok: false, reason: "invalid_recipient", planJson: "" });
    expect(fakePort.prepareSend).not.toHaveBeenCalled();
  });

  it("refuses at planning a plan the send could not read or the publish gate could not record", async () => {
    fakePort.prepareSend!.mockResolvedValue({
      ok: true, recipientEmail: "tester@example.com", selectedDraftIds: ["d1"],
      sender: { email: "sales@example.com", name: "S".repeat(30_000) },
      drafts: [{ id: "d1", revision: REV1, subject: "Hello", preview: "Hi there." }],
    });
    expect(await plan(PLAN_INPUT)).toMatchObject({ ok: false, reason: "plan_too_large", planJson: "" });
    fakePort.prepareSend!.mockResolvedValue({
      ok: true, recipientEmail: "tester@example.com", selectedDraftIds: ["x"],
      sender: { email: "sales@example.com", name: "Sales" },
      drafts: [{ id: "x".repeat(201), revision: REV1, subject: "Hello", preview: "Hi there." }],
    });
    expect(await plan(PLAN_INPUT)).toMatchObject({ ok: false, reason: "plan_too_large", planJson: "" });
  });
});

describe("email_test_delivery_run_send with a pinned plan sends exactly it", () => {
  it("sends the plan through the pinned port road and never re-plans", async () => {
    const result = await send({ pinnedPlanJson: PLAN_JSON });
    expect(result).toMatchObject({ ok: true, seq: 3, sentCount: 2 });
    expect(fakePort.prepareSend).not.toHaveBeenCalled();
    expect(fakePort.performSend).not.toHaveBeenCalled();
    expect(fakePort.performPinnedSend).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: CARD_TASK,
      plan: { campaignId: CAMPAIGN_ID, sender: PLAN_WIRE.sender, recipientEmail: "tester@example.com", drafts: PLAN_WIRE.drafts },
    }));
    expect(ledgerMock.claimTestSend).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: CARD_TASK, selectedDraftIds: ["d1", "d2"], recipientEmail: "tester@example.com",
    }));
  });

  it("ignores every selection field beside a pinned plan", async () => {
    await send({ pinnedPlanJson: PLAN_JSON, recipientEmail: "other@example.com", selectionMode: "all_initial", specificInitialDraftIds: ["d7"] });
    expect(fakePort.performPinnedSend).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ recipientEmail: "tester@example.com", drafts: PLAN_WIRE.drafts }),
    }));
  });

  it("refuses a plan that cannot be read, or that names another campaign, sending nothing", async () => {
    const bad = [
      "", "{", JSON.stringify({ ...PLAN_WIRE, v: 2 }), JSON.stringify({ ...PLAN_WIRE, extra: 1 }),
      JSON.stringify({ ...PLAN_WIRE, drafts: [] }), JSON.stringify({ ...PLAN_WIRE, drafts: [{ id: "d1", revision: "nope" }] }),
      JSON.stringify({ ...PLAN_WIRE, drafts: [{ id: "d1", revision: REV1 }, { id: "d1", revision: REV1 }] }),
      JSON.stringify({ ...PLAN_WIRE, campaignId: "camp-OTHER" }),
    ];
    for (const pinnedPlanJson of bad) {
      expect(await send({ pinnedPlanJson })).toMatchObject({ ok: false, reason: "plan_invalid", seq: 7 });
    }
    expect(await send({ pinnedPlanJson: 42 })).toMatchObject({ ok: false, reason: "plan_invalid" });
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
    expect(ledgerMock.claimTestSend).not.toHaveBeenCalled();
  });

  it("refuses, sending nothing, when a planned draft was already delivered by a previous partial send", async () => {
    ledgerMock.readUnacknowledgedDeliveredDraftIds.mockResolvedValue(["d2"]);
    expect(await send({ pinnedPlanJson: PLAN_JSON })).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("returns the recorded result of the same submission without a second send", async () => {
    ledgerMock.readTestSendBySubmission.mockResolvedValue(row({ status: "sent", resultJson: { ok: true, sentTo: "tester@example.com", message: "Test email sent to tester@example.com." } }));
    expect(await send({ pinnedPlanJson: PLAN_JSON })).toMatchObject({ ok: true, seq: 3 });
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("fails closed when the host port has no pinned send", async () => {
    delete fakePort.performPinnedSend;
    setTestDeliverySendPort(fakePort as unknown as TestDeliverySendPort);
    expect(await send({ pinnedPlanJson: PLAN_JSON })).toMatchObject({ ok: false, reason: "connector_unavailable" });
    expect(fakePort.performSend).not.toHaveBeenCalled();
  });

  it("passes the plan_changed answer of the port through, recorded as failed", async () => {
    fakePort.performPinnedSend!.mockResolvedValue({ ok: false, reason: "plan_changed", message: "changed", deliveredDraftIds: [] });
    expect(await send({ pinnedPlanJson: PLAN_JSON })).toMatchObject({ ok: false, reason: "plan_changed", seq: 3 });
    expect(ledgerMock.settleTestSend).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

describe("a pinned send under a publishing step mails what the claimed decision's card drew", () => {
  // The card the pack declares for its publishing step: From, To and the Drafts list (labels are the pack's).
  const CARD_ROWS = [
    { label: "From", input: "sender" },
    { label: "To", input: "recipient" },
    { kind: "list", label: "Drafts", input: "drafts", columns: [{ label: "Subject", field: "subject" }, { label: "Preview", field: "preview" }] },
  ];
  const surfaced = {
    planJson: PLAN_JSON,
    sender: "Sales <sales@example.com>",
    recipient: "tester@example.com",
    drafts: [
      { subject: "Hello", preview: "Hi there.", draftId: "d1", revision: REV1 },
      { subject: "Follow", preview: "Second.", draftId: "d2", revision: REV2 },
    ],
  };
  // The decision of the PARENT publishing node: the child API step that calls the send has no row of its own, and the
  // road claims the parent's decision for it.
  const decision = (over: Record<string, unknown> = {}) =>
    ({ id: "dec-1", runId: RUN_ID, nodeId: "test_send_flow", status: "released", declaredRows: CARD_ROWS, surfacedValues: surfaced, ...over });
  const CHILD = "perform_test_send";

  it("sends from a child step when the claimed decision's card is this plan, and hands the shown drafts to the port", async () => {
    decisionMock.readDecisionOfRun.mockResolvedValue(decision());
    expect(await send({ pinnedPlanJson: PLAN_JSON }, CHILD, "dec-1")).toMatchObject({ ok: true });
    expect(decisionMock.readDecisionOfRun).toHaveBeenCalledWith(RUN_ID, "dec-1");
    expect(fakePort.performPinnedSend).toHaveBeenCalledWith(expect.objectContaining({
      shownDrafts: [{ subject: "Hello", preview: "Hi there." }, { subject: "Follow", preview: "Second." }],
    }));
  });

  it("refuses, sending nothing, an altered plan from a child step under a parent's claimed decision", async () => {
    decisionMock.readDecisionOfRun.mockResolvedValue(decision());
    const other = JSON.stringify({ ...PLAN_WIRE, recipientEmail: "someone@example.com" });
    expect(await send({ pinnedPlanJson: other }, CHILD, "dec-1")).toMatchObject({ ok: false, reason: "plan_not_approved" });
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("refuses, sending nothing, a governed call whose claimed decision is missing, of another run or not released", async () => {
    for (const read of [null, decision({ runId: "run-OTHER" }), decision({ status: "parked" })]) {
      decisionMock.readDecisionOfRun.mockResolvedValue(read);
      expect(await send({ pinnedPlanJson: PLAN_JSON }, CHILD, "dec-1")).toMatchObject({ ok: false, reason: "plan_not_approved" });
    }
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("refuses when the card omits From, To or the Drafts list, or draws another row", async () => {
    const variants: Array<Record<string, unknown>> = [
      { declaredRows: CARD_ROWS.filter((r) => r.input !== "sender") },
      { declaredRows: CARD_ROWS.filter((r) => r.input !== "recipient") },
      { declaredRows: CARD_ROWS.filter((r) => r.input !== "drafts") },
      { declaredRows: [...CARD_ROWS, { label: "Note", input: "note" }] },
      { declaredRows: [CARD_ROWS[0], CARD_ROWS[1], { ...CARD_ROWS[2], columns: [{ label: "Subject", field: "subject" }] }] },
      { declaredRows: null },
      { surfacedValues: { ...surfaced, sender: undefined } },
      { surfacedValues: { ...surfaced, recipient: "" } },
    ];
    for (const over of variants) {
      decisionMock.readDecisionOfRun.mockResolvedValue(decision(over));
      expect(await send({ pinnedPlanJson: PLAN_JSON }, CHILD, "dec-1")).toMatchObject({ ok: false, reason: "plan_not_approved" });
    }
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("refuses when a row the card drew is not the plan's own value", async () => {
    for (const change of [
      { sender: "Someone <x@example.com>" },
      { recipient: "someone@example.com" },
      { drafts: [surfaced.drafts[0]] },
      { drafts: [surfaced.drafts[1], surfaced.drafts[0]] },
      { drafts: [{ ...surfaced.drafts[0], subject: 7 }, surfaced.drafts[1]] },
    ]) {
      decisionMock.readDecisionOfRun.mockResolvedValue(decision({ surfacedValues: { ...surfaced, ...change } }));
      expect(await send({ pinnedPlanJson: PLAN_JSON }, CHILD, "dec-1")).toMatchObject({ ok: false, reason: "plan_not_approved" });
    }
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
  });

  it("hands an altered subject or preview the card showed to the port, which compares it with the drafts it reads", async () => {
    const altered = [{ ...surfaced.drafts[0], subject: "Hello!" }, { ...surfaced.drafts[1], preview: "Other." }];
    decisionMock.readDecisionOfRun.mockResolvedValue(decision({ surfacedValues: { ...surfaced, drafts: altered } }));
    fakePort.performPinnedSend!.mockResolvedValue({ ok: false, reason: "plan_changed", message: "changed", deliveredDraftIds: [] });
    expect(await send({ pinnedPlanJson: PLAN_JSON }, CHILD, "dec-1")).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(fakePort.performPinnedSend).toHaveBeenCalledWith(expect.objectContaining({
      shownDrafts: [{ subject: "Hello!", preview: "Hi there." }, { subject: "Follow", preview: "Other." }],
    }));
  });

  it("compares nothing for a call the road let through with no claim (no publishing step governs it)", async () => {
    expect(await send({ pinnedPlanJson: PLAN_JSON }, "some_step")).toMatchObject({ ok: true });
    expect(decisionMock.readDecisionOfRun).not.toHaveBeenCalled();
    expect(fakePort.performPinnedSend).toHaveBeenCalledWith(expect.not.objectContaining({ shownDrafts: expect.anything() }));
  });
});

describe("the selection send without a pinned plan stays exactly as it was", () => {
  it("plans through prepareSend and sends through performSend, never the pinned road or the decision", async () => {
    const result = await send({ recipientEmail: "tester@example.com", selectionMode: "random_initial" }, "perform_test_send", "dec-1");
    expect(result).toMatchObject({ ok: true, seq: 3 });
    expect(fakePort.prepareSend).toHaveBeenCalledTimes(1);
    expect(fakePort.performSend).toHaveBeenCalledTimes(1);
    expect(fakePort.performPinnedSend).not.toHaveBeenCalled();
    expect(decisionMock.readDecisionOfRun).not.toHaveBeenCalled();
  });
});
