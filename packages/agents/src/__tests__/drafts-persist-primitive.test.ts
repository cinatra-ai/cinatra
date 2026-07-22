/**
 * Unit tests for the run-scoped drafts-review PERSIST primitive (cinatra#1959):
 *   email_outreach_initial_drafts_update
 *
 * Contract under test (handler level; a real DB round-trip is proven separately
 * in the live persist walk):
 *   - run id derived from the VERIFIED channel only (verifiedRunScopeId), never
 *     caller input nor the forgeable ambient `runId`;
 *   - the declaring package is matched against the REGISTRY set of packages that
 *     serve an email-drafts-review mid-run gate (resolved from the manifest,
 *     never a hardcoded name) — a non-drafts run is rejected;
 *   - respondToHitl-tier authz (enforceRunAccess);
 *   - the reviewed edits are merged onto the run's own latest draft-bundle row
 *     (matched by id then recipient email) and persisted via objects_update;
 *   - empty edits ⇒ benign no-op; supplied edits with NO bundle ⇒ honest ok:false
 *     (never a phantom write); no verified run context ⇒ fail closed.
 *
 * Uses the REAL mcpRequestContextStorage ALS to establish the run-bound frame,
 * exactly as the deterministic passthrough seam does in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  applyEditsToBundleArray,
  normalizeEdits,
  renderReviewedDocument,
} from "../mcp/drafts-persist-handler";

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
  // referenced while the handler map is constructed (never called here)
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
// buildActorContextFromRun mock — the handler builds the run's OWNER
// ActorContext (full team/project authority, #1625 posture) to read/update the
// run's own objects, so a team/project-scoped pre-gate save stays visible.
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
    { id: "@cinatra-ai/email-drafting-agent:email-drafts-review", kind: "email-drafts-review", priority: 80, midRunHitl: true, declaredBy: "@cinatra-ai/email-artifacts" },
    { id: "@cinatra-ai/email-follow-up-agent:email-drafts-review", kind: "email-drafts-review", priority: 80, midRunHitl: true, declaredBy: "@cinatra-ai/email-artifacts" },
    // reviewer :output gate carries NO midRunHitl → its scope must NOT enter the set.
    { id: "@cinatra-ai/reviewer-agent:drafts-output", kind: "email-drafts-review", priority: 80, declaredBy: "@cinatra-ai/reviewer-agent" },
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

async function invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handleEmailOutreachInitialDraftsUpdate } = await import("../mcp/drafts-persist-handler");
  return (await handleEmailOutreachInitialDraftsUpdate({
    primitiveName: "email_outreach_initial_drafts_update",
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
  storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/email-drafting-agent", agentAuthPolicy: null });
  storeMock.readRunCoOwners.mockResolvedValue([]);
  authPolicyMock.enforceRunAccess.mockResolvedValue(undefined);
  objectsMock.client.list.mockResolvedValue({ items: [] });
  objectsMock.client.update.mockResolvedValue({ ok: true });
});

// ===========================================================================
// Pure merge logic — the persistence core (no mocks needed).
// ===========================================================================
describe("normalizeEdits", () => {
  it("keeps rows with a stable id OR an email and drops rows with neither", () => {
    const rows = normalizeEdits([
      { id: "a", subject: "s", body: "b" },
      { recipientEmail: "x@y.z", subject: "s2", body: "b2" },
      { subject: "orphan", body: "no-key" },
      "not-an-object",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "a", recipientEmail: null, subject: "s", body: "b" });
    expect(rows[1]).toEqual({ id: "", recipientEmail: "x@y.z", subject: "s2", body: "b2" });
  });
  it("returns [] for a non-array", () => {
    expect(normalizeEdits(undefined)).toEqual([]);
    expect(normalizeEdits({})).toEqual([]);
  });
});

describe("applyEditsToBundleArray", () => {
  const bundle = [
    { id: "d1", recipientEmail: "a@x.com", subject: "S1", body: "B1" },
    { id: "d2", recipientEmail: "b@x.com", subject: "S2", body: "B2" },
  ];
  it("matches by id and updates subject/body, counting only real changes", () => {
    const { nextArray, changed, matched } = applyEditsToBundleArray(bundle, [
      { id: "d1", recipientEmail: null, subject: "NEW", body: "B1" },
    ]);
    expect(matched).toBe(1);
    expect(changed).toBe(1);
    expect(nextArray[0]).toMatchObject({ id: "d1", subject: "NEW", body: "B1" });
    expect(nextArray[1]).toBe(bundle[1]); // untouched row kept by reference
  });
  it("falls back to email match when the id does not line up", () => {
    const { changed, nextArray } = applyEditsToBundleArray(bundle, [
      { id: "does-not-exist", recipientEmail: "b@x.com", subject: "S2", body: "EDITED" },
    ]);
    expect(changed).toBe(1);
    expect(nextArray[1]).toMatchObject({ subject: "S2", body: "EDITED" });
  });
  it("is a no-op (changed=0) when the edit equals the stored content", () => {
    const { changed, matched } = applyEditsToBundleArray(bundle, [
      { id: "d1", recipientEmail: null, subject: "S1", body: "B1" },
    ]);
    expect(matched).toBe(1);
    expect(changed).toBe(0);
  });
  it("reports 0 matches for an edit that hits no row", () => {
    const { changed, matched } = applyEditsToBundleArray(bundle, [
      { id: "zzz", recipientEmail: "none@x.com", subject: "x", body: "y" },
    ]);
    expect(matched).toBe(0);
    expect(changed).toBe(0);
  });

  it("is ONE-TO-ONE: a single edit never clobbers two rows sharing an email (matched stays 1)", () => {
    const dupEmail = [
      { id: "r1", recipientEmail: "same@x.com", subject: "S1", body: "B1" },
      { id: "r2", recipientEmail: "same@x.com", subject: "S2", body: "B2" },
    ];
    const { nextArray, changed, matched } = applyEditsToBundleArray(dupEmail, [
      // matches by id r1, and would ALSO match r2 by shared email — the consumed
      // set prevents the second application.
      { id: "r1", recipientEmail: "same@x.com", subject: "EDITED", body: "B1" },
    ]);
    expect(matched).toBe(1); // distinct edits consumed, never > edits.length
    expect(changed).toBe(1);
    expect(nextArray[0]).toMatchObject({ id: "r1", subject: "EDITED" });
    expect(nextArray[1]).toBe(dupEmail[1]); // second row untouched (no clobber)
  });
});

// ===========================================================================
// Server-side reviewed-document regeneration (nit #4) — the EndNode artifact
// content is regenerated from the authoritative post-update array, never a
// caller-supplied document, and is faithful to each agent's own prompt shape.
// ===========================================================================
describe("renderReviewedDocument", () => {
  it("renders the drafting-agent per-recipient document (one '## <recipientName>' section)", () => {
    const doc = renderReviewedDocument(
      [
        { recipientId: "c1", recipientName: "Ada Lovelace", recipientEmail: "ada@x.com", subject: "Hi Ada", body: "Body A" },
        { recipientId: "c2", recipientName: "Alan Turing", recipientEmail: "alan@x.com", subject: "Hi Alan", body: "Body B" },
      ],
      "@cinatra-ai/campaigns:email-draft-bundle",
    );
    expect(doc).toBe(
      "## Ada Lovelace\n**Subject:** Hi Ada\n\nBody A\n\n---\n" +
        "## Alan Turing\n**Subject:** Hi Alan\n\nBody B\n\n---\n",
    );
  });

  it("falls back to the recipient email then a positional heading when no name is present", () => {
    const doc = renderReviewedDocument(
      [
        { recipientEmail: "only@x.com", subject: "S", body: "B" },
        { subject: "S2", body: "B2" },
      ],
      "@cinatra-ai/campaigns:email-draft-bundle",
    );
    expect(doc).toContain("## only@x.com");
    expect(doc).toContain("## Recipient 2");
  });

  it("renders the follow-up-agent digest (one '## Follow-up <n> (day <day>)' section)", () => {
    const doc = renderReviewedDocument(
      [
        { recipientId: "follow-up-1", subject: "Bump 1", body: "FU A", followUpDay: 3 },
        { recipientId: "follow-up-2", subject: "Bump 2", body: "FU B", followUpDay: 7 },
      ],
      "@cinatra-ai/campaigns:email-followup-bundle",
    );
    expect(doc).toBe(
      "## Follow-up 1 (day 3)\n**Subject:** Bump 1\n\nFU A\n" +
        "\n## Follow-up 2 (day 7)\n**Subject:** Bump 2\n\nFU B\n",
    );
  });
});

// ===========================================================================
// Handler orchestration.
// ===========================================================================
describe("handleEmailOutreachInitialDraftsUpdate", () => {
  const editsInput = { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B1" }] };

  it("fails closed with NO verified run context", async () => {
    const res = await invoke(editsInput);
    expect(res.error).toMatch(/only callable within a VERIFIED agent run/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("ignores the forgeable ambient runId and scopes to verifiedRunScopeId", async () => {
    await withVerifiedRun(RUN_ID, () => invoke({ drafts: [] }));
    expect(storeMock.readAgentRunById).toHaveBeenCalledWith(RUN_ID, expect.anything(), undefined);
  });

  it("empty edits is a benign no-op that still returns the stored reviewed bundle (never a phantom write)", async () => {
    // Design (a): even an empty edit set loads the pre-gate bundle and returns
    // the authoritative reviewed content for the EndNode — it just never writes.
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-1",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: {
            cinatra_agent_run_id: RUN_ID,
            drafts: [{ id: "d1", recipientName: "Ada", recipientEmail: "a@x.com", subject: "S1", body: "B1" }],
            summary: "one draft",
          },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ drafts: [] }));
    expect(res).toMatchObject({ ok: true, runId: RUN_ID, updated: 0, matched: 0 });
    // Authoritative reviewed content is returned, provenance stripped, no write.
    expect((res as { reviewedBundle?: Record<string, unknown> }).reviewedBundle).toEqual({
      drafts: [{ id: "d1", recipientName: "Ada", recipientEmail: "a@x.com", subject: "S1", body: "B1" }],
      summary: "one draft",
    });
    expect((res as { reviewedDocument?: string }).reviewedDocument).toContain("## Ada");
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("rejects a run whose declaring package is NOT a drafts-review gate (registry-derived, not hardcoded)", async () => {
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/other-agent" });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res.error).toMatch(/serves an email-drafts-review mid-run HITL gate/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (error, not ok) when edits are supplied but the run has no draft-bundle row", async () => {
    objectsMock.client.list.mockResolvedValue({ items: [] });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res.error).toMatch(/no draft-bundle object/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when a submitted reviewed row matches no stored bundle row (finding 4)", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-1",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { drafts: [{ id: "OTHER", recipientEmail: "zzz@x.com", subject: "S", body: "B" }] },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res.error).toMatch(/did not map one-to-one onto a stored bundle row/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when a submitted row is un-keyable (dropped before matching) even if the rest match", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-1",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "S", body: "B" }] },
        },
      ],
    });
    // Two submitted rows: one keyed (d1) and one un-keyable (no id / no email).
    // normalizeEdits drops the un-keyable row, so edits.length (1) < rawRowCount
    // (2) — the handler refuses rather than silently persisting only the keyed one.
    const res = await withVerifiedRun(RUN_ID, () =>
      invoke({ drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B" }, { subject: "orphan", body: "no-key" }] }),
    );
    expect(res.error).toMatch(/did not map one-to-one/);
    expect(res.ok).toBeUndefined();
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("recognizes an existing but EMPTY pre-gate bundle by type (returns empty reviewed outputs, not 'missing')", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-empty",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { cinatra_agent_run_id: RUN_ID, draftedEmails: [], summary: "no recipients" },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ drafts: [] }));
    expect(res).toMatchObject({ ok: true, objectId: "obj-empty", matched: 0, updated: 0 });
    expect((res as { reviewedBundle?: Record<string, unknown> }).reviewedBundle).toEqual({
      draftedEmails: [],
      summary: "no recipients",
    });
    expect((res as { reviewedDocument?: string }).reviewedDocument).toBe("");
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on a registered-type object carrying NO per-recipient array key (malformed, not a phantom-empty ok)", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-malformed",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          // Registered bundle type but NO array key at all (draftedEmails/
          // sequence/followups/drafts/confirmedRecipients all absent). The
          // permissive z.record schema admits this shape; the handler must NOT
          // default it to an empty `draftedEmails` and return a phantom ok.
          data: { cinatra_agent_run_id: RUN_ID, summary: "no array key at all" },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke({ drafts: [] }));
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/no draft-bundle object/);
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("persists the reviewed edits onto the run's latest draft-bundle row", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-old",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-01T00:00:00.000Z",
          data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "OLD", body: "B1" }] },
        },
        {
          id: "obj-new",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "OLD", body: "B1" }] },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res).toMatchObject({ ok: true, runId: RUN_ID, objectId: "obj-new", matched: 1, updated: 1 });
    // Wrote onto the LATEST bundle, replacing exactly the drafts array.
    expect(objectsMock.client.update).toHaveBeenCalledWith({
      objectId: "obj-new",
      data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B1" }] },
    });
    // Returns the AUTHORITATIVE reviewed content for the EndNode (nit #4): the
    // stored bundle with the reviewed array spliced in + a regenerated document.
    expect((res as { reviewedBundle?: Record<string, unknown> }).reviewedBundle).toEqual({
      drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B1" }],
    });
    expect((res as { reviewedDocument?: string }).reviewedDocument).toBe(
      "## a@x.com\n**Subject:** NEW\n\nB1\n\n---\n",
    );
    expect(authPolicyMock.enforceRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, coOwnerUserIds: [] }),
      expect.anything(),
      "respondToHitl",
      undefined,
    );
  });

  it("does NOT write when the reviewed content equals the stored content", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-1",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B1" }] },
        },
      ],
    });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res).toMatchObject({ ok: true, matched: 1, updated: 0 });
    expect(objectsMock.client.update).not.toHaveBeenCalled();
  });

  it("selects a follow-up `sequence` bundle and persists via that key", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-fu",
          type: "@cinatra-ai/campaigns:email-followup-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { sequence: [{ recipientEmail: "a@x.com", subject: "OLD", body: "B1", step: 1 }] },
        },
      ],
    });
    storeMock.readAgentTemplateById.mockResolvedValue({ packageName: "@cinatra-ai/email-follow-up-agent" });
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    expect(res).toMatchObject({ ok: true, objectId: "obj-fu", updated: 1 });
    expect(objectsMock.client.update).toHaveBeenCalledWith({
      objectId: "obj-fu",
      data: { sequence: [{ recipientEmail: "a@x.com", subject: "NEW", body: "B1", step: 1 }] },
    });
  });

  it("reads/updates through the run's OWNER ActorContext so team/project-scoped bundles stay visible (#1959 finding 3)", async () => {
    objectsMock.client.list.mockResolvedValue({
      items: [
        {
          id: "obj-team",
          type: "@cinatra-ai/campaigns:email-draft-bundle",
          createdAt: "2026-07-20T00:00:00.000Z",
          data: { drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "OLD", body: "B1" }] },
        },
      ],
    });
    await withVerifiedRun(RUN_ID, () => invoke(editsInput));
    // The objects client is built from the run's OWNER ActorContext (carrying the
    // owner's team/project authority) — NOT the narrowed passthrough actor — so a
    // team/project-scoped pre-gate save is admitted by buildOwnershipFilter and
    // the runId-bounded read finds it (mirrors the #1625 test-delivery posture).
    expect(buildActorCtxMock.buildActorContextFromRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, runBy: OWNER_ID, orgId: ORG_ID }),
    );
    expect(objectsMock.createSessionObjectsClient).toHaveBeenCalled();
  });

  it("surfaces a run-access denial as a safe error", async () => {
    authPolicyMock.enforceRunAccess.mockRejectedValue(
      new authzMock.AuthzError({ statusCode: 403, reason: "denied", message: "no access" }),
    );
    const res = await withVerifiedRun(RUN_ID, () => invoke(editsInput));
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
    expect(typeof handlers["email_outreach_initial_drafts_update"]).toBe("function");
  });
});
