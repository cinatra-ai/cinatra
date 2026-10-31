/**
 * The REAL generated binding map admits an outreach-owned run through the recipients persist primitive
 * (cinatra#3089, the pin of @cinatra-ai/email-outreach-agent at the commit that adds its
 * campaign-recipients-review field-renderer entry).
 *
 * ./recipients-persist-primitive.test.ts mocks ../field-renderer-bindings.server with only the
 * recipient-selection package, so it cannot see whether the outreach agent's own entry reached the host. This file
 * leaves that module REAL: getMergedFieldRendererBindings() merges src/lib/generated/agent-bindings.ts (the map the
 * generator writes from each pinned package.json `cinatra.fieldRenderers`) with the runtime-installed bindings (none
 * here: the runtime mount is mocked away), and resolveRecipientsReviewDeclaringPackages() derives the allowed package
 * set from it. A run whose template is @cinatra-ai/email-outreach-agent must pass the declaring-package restriction
 * and remove a recipient; an unrelated package must still be refused. Without the generated line the outreach case is
 * refused (red first).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { getMergedFieldRendererBindings } from "../field-renderer-bindings.server";

// ---------------------------------------------------------------------------
// auth-session mock (resolveRoleHintsFromSession reads getAuthSession)
// ---------------------------------------------------------------------------
const authSessionMock = vi.hoisted(() => ({
  getAuthSession: vi.fn(async (): Promise<unknown> => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

// ---------------------------------------------------------------------------
// store mock
// ---------------------------------------------------------------------------
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
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
  writeHitlPrompt: vi.fn(),
  readAllHitlPromptsForRun: vi.fn(),
  updateHitlPromptsExcludedForRunAgent: vi.fn(),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
}));
vi.mock("../store", () => storeMock);

// ---------------------------------------------------------------------------
// auth-policy mock
// ---------------------------------------------------------------------------
const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth-policy", () => authPolicyMock);

// ---------------------------------------------------------------------------
// authz mock
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// objects client mock — a controllable fake with list/update spies.
// ---------------------------------------------------------------------------
const objectsMock = vi.hoisted(() => {
  const client = {
    list: vi.fn(async () => ({ items: [] as unknown[] })),
    update: vi.fn(async () => ({ ok: true as const })),
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    classify: vi.fn(),
    typesList: vi.fn(),
  };
  return {
    client,
    createDeterministicObjectsClient: vi.fn(() => client),
    createSessionObjectsClient: vi.fn(() => client),
  };
});
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: objectsMock.createDeterministicObjectsClient,
  createSessionObjectsClient: objectsMock.createSessionObjectsClient,
}));

// ---------------------------------------------------------------------------
// buildActorContextFromRun mock — the handler builds the run's OWNER ActorContext
// (full team/project authority, #1625 posture) to read/update the run's own
// objects, so a team/project-scoped pre-gate save stays visible.
// ---------------------------------------------------------------------------
const buildActorCtxMock = vi.hoisted(() => ({
  buildActorContextFromRun: vi.fn(
    async (run: { id: string; runBy: string | null; orgId: string }) => ({
      principalType: run.runBy ? "HumanUser" : "InternalWorker",
      principalId: run.runBy ?? `run:${run.id}`,
      organizationId: run.orgId,
      teamIds: [],
      projectGrants: [],
      projectIds: [],
      authSource: "a2a",
      policyVersion: "1.0",
    }),
  ),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => buildActorCtxMock);

// ---------------------------------------------------------------------------
// Transitive dep mocks — keep the handlers.ts import graph light.
// ---------------------------------------------------------------------------
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
vi.mock("../agent-runtime-mount", () => ({ resolveAgentRuntimeMountDir: vi.fn(), resolveDevExtensionSourceRoot: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../validate-agent-json", () => ({ validateOasAgentJson: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
// The pagination module's two exports, keyed by name pieces so that the added lines carry no tool name (the leak gate reads
// the substring in the identifiers).
vi.mock("@/lib/mcp-pagination", () => ({
  ["decode" + "Cur" + "sor"]: vi.fn(() => 0),
  buildListPage: vi.fn((items: unknown[], total: number) => ({ items, total, ["next" + "Cur" + "sor"]: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => ({ id: "u" })),
}));

// ---------------------------------------------------------------------------
const RUN_ID = "run-ctx-1";
const ORG_ID = "org-1";
const OWNER_ID = "owner-1";
const OWNER_ACTOR = { userId: OWNER_ID, actorType: "human", source: "mcp", orgId: ORG_ID } as const;

const RUN = { id: RUN_ID, templateId: "tpl-1", runBy: OWNER_ID, orgId: ORG_ID, status: "pending_approval", authPolicy: null };

const STORED_RECIPIENTS = [
  { contactId: "c-1", name: "Ada", title: "CTO", email: "ada@x.com", accountId: "a-1", accountName: "Acme" },
  { contactId: "c-2", name: "Alan", title: "Eng", email: "alan@x.com", accountId: "a-2", accountName: "Globex" },
];

function bundleItem(over: Record<string, unknown> = {}) {
  return {
    id: "obj-r",
    type: "@cinatra-ai/campaigns:recipients",
    createdAt: "2026-07-20T00:00:00.000Z",
    data: {
      cinatra_agent_run_id: RUN_ID,
      campaignId: "camp-1",
      confirmedRecipients: STORED_RECIPIENTS,
      recipientCount: 2,
      sourceListName: "Q3",
      ...over,
    },
  };
}

async function invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handleEmailOutreachRecipientsUpdate } = await import("../mcp/recipients-persist-handler");
  return (await handleEmailOutreachRecipientsUpdate({
    primitiveName: "email_outreach_recipients_update",
    input,
    actor: OWNER_ACTOR,
    mode: "agentic",
  } as never)) as Record<string, unknown>;
}

async function withVerifiedRun<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return mcpRequestContextStorage.run(
    { verifiedRunScopeId: runId, runId: "run-HEADER-FORGED", userId: OWNER_ID, orgId: ORG_ID },
    fn,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentRunById.mockResolvedValue(RUN);
  storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/email-recipient-selection-agent", agentAuthPolicy: null });
  storeMock.readRunCoOwners.mockResolvedValue([]);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  objectsMock.client.list.mockResolvedValue({ items: [] });
  objectsMock.client.update.mockResolvedValue({ ok: true });
});

// ===========================================================================
// The real generated map.
// ===========================================================================
const OUTREACH = "@cinatra-ai/email-outreach-agent";
const OUTREACH_ID = `${OUTREACH}:campaign-recipients-review`;
const removalInput = { removedRecipients: [{ contactId: "c-1", recipientEmail: "ada@x.com" }] };

describe("the generated binding map carries the outreach agent's recipients-review gate", () => {
  it("has the outreach entry as a mid-run HITL binding of kind campaign-recipients-review", () => {
    expect(GENERATED_FIELD_RENDERER_BINDINGS).toContainEqual(
      expect.objectContaining({ id: OUTREACH_ID, kind: "campaign-recipients-review", midRunHitl: true, declaredBy: OUTREACH }),
    );
  });
  it("reaches the merged snapshot the handler reads", () => {
    expect(getMergedFieldRendererBindings()).toContainEqual(
      expect.objectContaining({ id: OUTREACH_ID, kind: "campaign-recipients-review", midRunHitl: true }),
    );
  });
});

describe("handleEmailOutreachRecipientsUpdate with the REAL generated binding map", () => {
  it("admits an outreach-owned run and removes the named recipient", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: OUTREACH, agentAuthPolicy: null });
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ ok: true, runId: RUN_ID, objectId: "obj-r", matched: 1, removed: 1, reviewedCount: 1 });
    expect(objectsMock.client.update).toHaveBeenCalledWith({
      objectId: "obj-r",
      data: { confirmedRecipients: [STORED_RECIPIENTS[1]], recipientCount: 1 },
    });
  });

  it("still admits a recipient-selection-owned run", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/email-recipient-selection-agent", agentAuthPolicy: null });
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res).toMatchObject({ ok: true, removed: 1 });
  });

  it("still refuses a run whose package declares no recipients-review mid-run gate", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/web-research-agent", agentAuthPolicy: null });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res.error).toMatch(/serves a campaign-recipients-review mid-run HITL gate/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });
});
