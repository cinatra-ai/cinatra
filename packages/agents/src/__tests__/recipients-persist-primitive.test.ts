/**
 * Unit tests for the run-scoped campaign-recipients-review PERSIST primitive
 * (cinatra#1960): email_outreach_recipients_update. The recipients analogue of
 * ./drafts-persist-primitive.test.ts.
 *
 * Contract under test (handler level; a real DB round-trip is proven separately
 * in the live persist walk):
 *   - run id derived from the VERIFIED channel only (verifiedRunScopeId), never
 *     caller input nor the forgeable ambient `runId`;
 *   - the declaring package is matched against the REGISTRY set of packages that
 *     serve a campaign-recipients-review mid-run gate (resolved from the manifest,
 *     never a hardcoded name) — a non-recipients run is rejected;
 *   - respondToHitl-tier authz (enforceRunAccess);
 *   - the operator's EXPLICIT removals are matched one-to-one onto the run's own
 *     latest recipients bundle row (by contactId then email then accountId) and
 *     ONLY the matched rows are removed via objects_update; every other stored row
 *     is kept (NON-DESTRUCTIVE — codex #1960 findings 1+2);
 *   - empty/absent removals ⇒ benign no-op (keeps all, no write); a removal with
 *     NO stored match ⇒ fail closed; removals against a MISSING bundle ⇒ honest
 *     error, but NO removals + missing bundle ⇒ a legitimate zero-recipient run
 *     completes with an empty reviewed set (finding 3); no verified run ⇒ fail closed.
 *
 * Uses the REAL mcpRequestContextStorage ALS to establish the run-bound frame,
 * exactly as the deterministic passthrough seam does in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  applyRemovalsToBundleArray,
  normalizeRemovedRecipients,
} from "../mcp/recipients-persist-handler";

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
// field-renderer-bindings.server mock (the registry-derived allowed-package set)
// ---------------------------------------------------------------------------
const bindingsMock = vi.hoisted(() => ({
  getMergedFieldRendererBindings: vi.fn(() => [
    { id: "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review", kind: "campaign-recipients-review", priority: 80, midRunHitl: true, declaredBy: "@cinatra-ai/email-artifacts" },
    // The agent's own :output gate and an UNRELATED-scope gate of the same kind
    // carry NO midRunHitl → neither scope may enter the set. (Pre-cinatra#1796
    // the unrelated-scope row was the retired reviewer binding; a live retained
    // package now plays the same role.)
    { id: "@cinatra-ai/email-recipient-selection-agent:output", kind: "campaign-recipients-review", priority: 80, a2uiTranslator: "recipients-output", declaredBy: "@cinatra-ai/email-recipient-selection-agent" },
    { id: "@cinatra-ai/web-research-agent:contacts-output", kind: "campaign-recipients-review", priority: 80, declaredBy: "@cinatra-ai/web-research-agent" },
  ]),
}));
vi.mock("../field-renderer-bindings.server", () => bindingsMock);

// ---------------------------------------------------------------------------
// Transitive dep mocks — keep the handlers.ts import graph light.
// ---------------------------------------------------------------------------
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
// Pure logic — the persistence core (no mocks needed).
// ===========================================================================
describe("normalizeRemovedRecipients", () => {
  it("keeps ONLY rows keyed by a real contactId; DROPS recipientId/email/accountId-only + no-key rows (codex rounds 4-6 — only contactId is unique)", () => {
    const rows = normalizeRemovedRecipients([
      { contactId: "c-1", recipientEmail: "a@x.com" },
      { recipientId: "c-2" }, // recipientId is a collidable alias, NOT a match key → dropped
      { email: "b@x.com" }, // email-only → collidable → dropped
      { accountId: "a-9" }, // company-only → ambiguous → dropped
      { subject: "no-key" },
      "not-an-object",
    ]);
    expect(rows).toEqual([{ contactId: "c-1" }]);
  });
  it("returns [] for a non-array", () => {
    expect(normalizeRemovedRecipients(undefined)).toEqual([]);
    expect(normalizeRemovedRecipients({})).toEqual([]);
  });
});

describe("applyRemovalsToBundleArray", () => {
  it("removes ONLY the matched row (by contactId) and keeps the rest (non-destructive)", () => {
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(STORED_RECIPIENTS, [
      { contactId: "c-1" },
    ]);
    expect(matched).toBe(1);
    expect(removed).toBe(1);
    expect(keptRows).toEqual([STORED_RECIPIENTS[1]]);
    expect(keptRows[0]).toBe(STORED_RECIPIENTS[1]); // stored row kept by reference (full content)
  });
  it("keeps EVERY row for an empty removal batch (removed=0) — the non-destructive no-op", () => {
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(STORED_RECIPIENTS, []);
    expect(matched).toBe(0);
    expect(removed).toBe(0);
    expect(keptRows).toEqual(STORED_RECIPIENTS);
  });
  it("keeps a stored row the operator never saw (not named by any removal)", () => {
    // Gate showed only c-1; stored bundle drifted to include c-3. Removing c-1
    // must NOT delete the unseen c-3.
    const stored = [...STORED_RECIPIENTS, { contactId: "c-3", email: "cara@x.com", accountId: "a-3" }];
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(stored, [{ contactId: "c-1" }]);
    expect(matched).toBe(1);
    expect(removed).toBe(1);
    expect(keptRows.map((r) => r.contactId)).toEqual(["c-2", "c-3"]); // unseen c-3 kept
  });
  it("UNIQUE-KEY: a contactId removal never deletes a sibling sharing its accountId or email (codex F2)", () => {
    // Two contacts at the SAME account (a1) SHARING an email; B is stored FIRST.
    // Removing A must delete A only — neither accountId nor email is a match key.
    const stored = [
      { contactId: "b", accountId: "a1", email: "shared@x.com" },
      { contactId: "a", accountId: "a1", email: "shared@x.com" },
    ];
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(stored, [{ contactId: "a" }]);
    expect(matched).toBe(1);
    expect(removed).toBe(1);
    expect(keptRows.map((r) => r.contactId)).toEqual(["b"]); // B kept, A removed
  });
  it("IDEMPOTENT + SIBLING-SAFE: replaying A's removal after A is gone does NOT delete sibling B sharing its accountId/email (codex rounds 3-5)", () => {
    // After A was removed, only B (sharing accountId a1 AND email) remains.
    // Replaying A's removal must NO-OP — contactId 'a' is gone and there is no
    // weaker key to fall through to, so B (contactId 'b') is never touched.
    const storedAfterFirstApply = [{ contactId: "b", accountId: "a1", email: "shared@x.com" }];
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(storedAfterFirstApply, [
      { contactId: "a" },
    ]);
    expect(matched).toBe(0);
    expect(removed).toBe(0);
    expect(keptRows).toEqual(storedAfterFirstApply); // B untouched (idempotent + sibling-safe)
  });
  it("a removal matching NO stored row is a safe no-op (idempotent retry / stale — codex round-2 F4)", () => {
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(STORED_RECIPIENTS, [
      { contactId: "already-gone" },
    ]);
    expect(matched).toBe(0);
    expect(removed).toBe(0);
    expect(keptRows).toEqual(STORED_RECIPIENTS); // nothing deleted
  });
  it("removes exactly the two named rows for two distinct contactId removals (one-to-one)", () => {
    const stored = [
      { contactId: "r1", email: "same@x.com" },
      { contactId: "r2", email: "same@x.com" },
      { contactId: "r3", email: "other@x.com" },
    ];
    const { keptRows, removed, matched } = applyRemovalsToBundleArray(stored, [
      { contactId: "r1" },
      { contactId: "r3" },
    ]);
    expect(matched).toBe(2);
    expect(removed).toBe(2);
    expect(keptRows.map((r) => r.contactId)).toEqual(["r2"]);
  });
});

// ===========================================================================
// Handler orchestration.
// ===========================================================================
describe("handleEmailOutreachRecipientsUpdate", () => {
  // Remove c-1 (Ada); c-2 (Alan) is kept.
  const removalInput = { removedRecipients: [{ contactId: "c-1", recipientEmail: "ada@x.com" }] };

  it("fails closed with NO verified run context", async () => {
    const res = await invoke(removalInput);
    expect(res.error).toMatch(/only callable within a VERIFIED agent run/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("ignores the forgeable ambient runId and scopes to verifiedRunScopeId", async () => {
    await withVerifiedRun(RUN_ID, () => invoke({ removedRecipients: [] }));
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith(RUN_ID, expect.anything(), undefined);
  });

  it("rejects a run whose declaring package is NOT a recipients-review gate (registry-derived, not hardcoded)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/other-agent" });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res.error).toMatch(/serves a campaign-recipients-review mid-run HITL gate/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (error, not ok) when REMOVALS are supplied but the run has no recipients bundle", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [] });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res.error).toMatch(/no recipients bundle object/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("MISSING bundle + genuinely EMPTY surfaced snapshot completes with an empty reviewed set (codex #1960 finding 3 — zero-recipient run)", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [] });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ removedRecipients: [], approvedRecipientIds: [] }));
    expect(res).toMatchObject({ ok: true, objectId: null, matched: 0, removed: 0, reviewedCount: 0 });
    expect((res as { reviewedRecipients?: unknown[] }).reviewedRecipients).toEqual([]);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("MISSING bundle + NON-empty surfaced snapshot FAILS CLOSED (persistence gap, not a zero-recipient run — codex round-2 finding 3)", async () => {
    // The gate surfaced [c-1, c-2] (approvedRecipientIds) but the bundle is gone;
    // an unchanged approval (no removals) must NOT silently complete with zero.
    objectsMock.client.list.mockResolvedValue({ items: [] });
    const res = await withVerifiedRun(RUN_ID, () =>
      invoke({ removedRecipients: [], approvedRecipientIds: ["c-1", "c-2"] }),
    );
    expect(res.error).toMatch(/no recipients bundle object, but the gate surfaced 2 recipient/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("MISSING bundle + an UN-KEYABLE surfaced removal FAILS CLOSED (codex round-3 F3 — un-keyable must not collapse surfacedCount to 0)", async () => {
    // A degenerate surfaced recipient (no contactId/email/accountId) the operator
    // removed. Its removal is un-keyable; the guard must fire BEFORE the missing-
    // bundle path so it cannot silently complete with zero recipients.
    objectsMock.client.list.mockResolvedValue({ items: [] });
    const res = await withVerifiedRun(RUN_ID, () =>
      invoke({
        removedRecipients: [{ id: "recipient-0", contactId: null, accountId: null, recipientEmail: null }],
        approvedRecipientIds: [],
      }),
    );
    expect(res.error).toMatch(/carried no stable match key/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("TOLERATES a removal that matches no CURRENT stored row (idempotent retry / stale no-op — codex round-2 finding 4)", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    const res = await withVerifiedRun(RUN_ID, () =>
      invoke({ removedRecipients: [{ contactId: "does-not-exist", recipientEmail: "zzz@x.com" }] }),
    );
    // Non-destructive: nothing matched, nothing removed, every stored row kept, NO write.
    expect(res).toMatchObject({ ok: true, objectId: "obj-r", matched: 0, removed: 0, reviewedCount: 2 });
    expect((res as { reviewedRecipients?: unknown[] }).reviewedRecipients).toEqual(STORED_RECIPIENTS);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when a submitted removal is un-keyable (no stable match key)", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    const res = await withVerifiedRun(RUN_ID, () =>
      invoke({ removedRecipients: [{ contactId: "c-1", recipientEmail: "ada@x.com" }, { note: "no-key" }] }),
    );
    expect(res.error).toMatch(/carried no stable match key/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("removes the matched row onto the run's LATEST recipients bundle and keeps the rest", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        { ...bundleItem({}), id: "obj-old", createdAt: "2026-07-01T00:00:00.000Z" },
        { ...bundleItem({}), id: "obj-new", createdAt: "2026-07-20T00:00:00.000Z" },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res).toMatchObject({ ok: true, runId: RUN_ID, objectId: "obj-new", matched: 1, removed: 1 });
    expect(objectsMock.client.update).toHaveBeenCalledWith({
      objectId: "obj-new",
      data: { confirmedRecipients: [STORED_RECIPIENTS[1]], recipientCount: 1 },
    });
    expect((res as { reviewedRecipients?: unknown }).reviewedRecipients).toEqual([STORED_RECIPIENTS[1]]);
    expect((res as { reviewedCount?: number }).reviewedCount).toBe(1);
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, coOwnerUserIds: [] }),
      expect.anything(),
      "respondToHitl",
      undefined,
    );
  });

  it("does NOT write and keeps EVERY row on a clean approval (empty removals, removed=0) — non-destructive", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ removedRecipients: [] }));
    expect(res).toMatchObject({ ok: true, objectId: "obj-r", matched: 0, removed: 0, reviewedCount: 2 });
    expect((res as { reviewedRecipients?: unknown[] }).reviewedRecipients).toEqual(STORED_RECIPIENTS);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("recognizes an existing but EMPTY pre-gate bundle by type (returns empty reviewed outputs, not 'missing')", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [bundleItem({ confirmedRecipients: [], recipientCount: 0 })],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ removedRecipients: [] }));
    expect(res).toMatchObject({ ok: true, objectId: "obj-r", matched: 0, removed: 0, reviewedCount: 0 });
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("reads/updates through the run's OWNER ActorContext so team/project-scoped bundles stay visible (#1959 finding 3 posture)", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(buildActorCtxMock.buildActorContextFromRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, runBy: OWNER_ID, orgId: ORG_ID }),
    );
    expect(objectsMock.createSessionObjectsClient).toHaveBeenCalled();
  });

  it("surfaces a run-access denial as a safe error", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [bundleItem()] });
    authPolicyMock.enforceRunAccess.mockRejectedValue(
      new authzMock.AuthzError({ statusCode: 403, reason: "denied", message: "no access" }),
    );
    const res = await withVerifiedRun(RUN_ID, () => invoke(removalInput));
    expect(res.error).toBeTruthy();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Registration — the primitive is exposed to the passthrough seam.
// ===========================================================================
describe("registration", () => {
  it("is registered in createAgentBuilderPrimitiveHandlers", async () => {
    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    expect(typeof handlers["email_outreach_recipients_update"]).toBe("function");
  });
});
