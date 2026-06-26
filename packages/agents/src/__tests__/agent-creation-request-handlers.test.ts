import { describe, it, expect, vi, beforeEach } from "vitest";

// Agent-Creation Approval Workflow — focused unit tests for the
// proposal + decide primitives. Mocks the store + audit so the test runs
// without a live DB. Covers the security-critical paths:
//   - decide is admin-gated.
//   - self-approval is rejected by default.
//   - CAS stale-snapshot rejection.
//   - propose NEVER calls the live agent_source_* tools.
//   - author decision notifications (issue #79): gated by the decide CAS
//     (winning it IS the notification claim), both decisions, best-effort
//     (a notify failure never fails the decide).

const storeMock = vi.hoisted(() => ({
  createAgentCreationRequest: vi.fn(),
  readAgentCreationRequestById: vi.fn(),
  listAgentCreationRequests: vi.fn(() => []),
  editRejectedRequest: vi.fn(),
  decideAgentCreationRequestCas: vi.fn(),
  markAgentCreationRequestPublished: vi.fn(),
  markAgentCreationRequestNotificationSent: vi.fn(),
  computeSnapshotHash: vi.fn(() => "fakehash"),
  AgentCreationRequestNotFoundError: class extends Error {},
  StaleProposalError: class extends Error {
    constructor() {
      super("stale");
    }
  },
  InvalidStateTransitionError: class extends Error {},
}));
vi.mock("@/lib/agent-creation-requests-store", () => storeMock);

const auditMock = vi.hoisted(() => ({ logAuditEventStrict: vi.fn(async () => ({ id: "audit-1" })) }));
vi.mock("@/lib/authz/audit", () => auditMock);

const dbMock = vi.hoisted(() => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({ allowSelfApproval: false })),
  writeConnectorConfigToDatabase: vi.fn(),
  readMetadataValueFromDatabase: vi.fn((_k: string, d: unknown) => d),
  writeMetadataValueToDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => "postgres://test"),
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  isAgentCreationPinActive: vi.fn(() => false),
  runPostgresQueriesSync: vi.fn(() => [{ rows: [] }]),
}));
vi.mock("@/lib/database", () => dbMock);

// Better-auth-db: the decide path counts OTHER platform admins (issue #392)
// to decide whether the self-approval SoD guard applies. Default to 1 (another
// admin exists → guard stays on / SoD preserved); single-admin tests override
// to 0.
const betterAuthDbMock = vi.hoisted(() => ({
  countOtherPlatformAdmins: vi.fn(async () => 1),
}));
vi.mock("@/lib/better-auth-db", () => betterAuthDbMock);

// Mock the handlers.ts circular target (materializeAndPublish lazy-imports it).
const innerHandlersMock = vi.hoisted(() => ({
  createAgentBuilderPrimitiveHandlers: vi.fn(() => ({
    agent_source_write: vi.fn(async () => ({ written: true })),
    agent_source_write_files: vi.fn(async () => ({ written: true })),
    agent_source_compile: vi.fn(async () => ({ compiled: true })),
    agent_source_publish: vi.fn(async () => ({ published: true })),
  })),
}));
vi.mock("../mcp/handlers", () => innerHandlersMock);

// Mock the store import for slug-collision check.
const storeReadMock = vi.hoisted(() => ({
  readAgentTemplates: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("../store", () => storeReadMock);

// Mock the lazily-imported notifications server surface (issue #79 emits).
// `hostState.loaded` flips when the "@/lib/notifications-host" adapter
// registration side-effect module is imported — the emit path must import it
// before the /server writers so the adapters are registered on EVERY call
// path (not just ones that already loaded the facade/boot graph).
const hostState = vi.hoisted(() => ({ loaded: false }));
vi.mock("@/lib/notifications-host", () => {
  hostState.loaded = true;
  return {};
});
const notificationsMock = vi.hoisted(() => ({
  createNotificationForRecipient: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/notifications/server", () => notificationsMock);

import {
  handleAgentCreationRequestPropose,
  handleAgentCreationRequestDecide,
} from "../mcp/agent-creation-request-handlers";

function req(name: string, input: Record<string, unknown>, actor: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    primitiveName: name,
    input,
    actor,
    mode: "deterministic",
  } as any;
}

const NON_ADMIN = {
  actorType: "human" as const,
  source: "ui",
  userId: "user-author",
  organizationId: "org-1",
};
const ADMIN = {
  actorType: "human" as const,
  source: "ui",
  userId: "user-admin",
  organizationId: "org-1",
  platformRole: "platform_admin",
};
// A platform_admin authoring via the DELEGATED-CHAT surface (the chat model
// acting on the user's behalf). `delegatedRestricted` is stamped by
// buildActorFromMcpContext for chat delegation. cinatra#538: the admin
// instant-grant must be withheld here so the chat model can't auto-publish
// N versions per turn.
const DELEGATED_CHAT_ADMIN = {
  actorType: "model" as const,
  source: "agent",
  userId: "user-admin",
  organizationId: "org-1",
  platformRole: "platform_admin",
  delegatedRestricted: true,
};

const SAMPLE_INPUT = {
  packageSlug: "test-agent",
  packageName: "@test/test-agent",
  packageVersion: "0.1.0",
  oas: { agentspec_version: "26.1.0", component_type: "Flow" },
  packageJson: { name: "@test/test-agent", version: "0.1.0" },
  skillMd: "# test\n",
};

describe("agent_creation_request handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.computeSnapshotHash.mockReturnValue("fakehash");
    notificationsMock.createNotificationForRecipient.mockResolvedValue([]);
    dbMock.readConnectorConfigFromDatabase.mockReturnValue({ allowSelfApproval: false });
    storeReadMock.readAgentTemplates.mockResolvedValue({ items: [], total: 0 });
    betterAuthDbMock.countOtherPlatformAdmins.mockResolvedValue(1);
  });

  describe("propose", () => {
    it("creates a request without calling any live agent_source_* tool", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue({ id: "req-1", packageName: "@test/test-agent" });
      await handleAgentCreationRequestPropose(req("agent_creation_request_propose", SAMPLE_INPUT, NON_ADMIN));
      // The propose handler does NOT call the live createAgentBuilderPrimitiveHandlers
      // (verified by absence of any invocation on innerHandlersMock.createAgentBuilderPrimitiveHandlers).
      expect(innerHandlersMock.createAgentBuilderPrimitiveHandlers).not.toHaveBeenCalled();
      expect(storeMock.createAgentCreationRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          authorId: "user-author",
          packageName: "@test/test-agent",
        }),
      );
    });

    it("surfaces a collisionWarning when an agent_template already uses the packageName", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storeReadMock.readAgentTemplates.mockResolvedValue({
        items: [{ packageName: "@test/test-agent" }],
        total: 1,
      } as any);
      storeMock.createAgentCreationRequest.mockReturnValue({ id: "req-1", packageName: "@test/test-agent" });
      const out = (await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, NON_ADMIN),
      )) as { structuredContent: { collisionWarning?: string } };
      expect(out.structuredContent.collisionWarning).toMatch(/already exists/i);
    });

    it("withholds the admin instant-grant for delegated-chat callers — proposal-only, no publish (#538)", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue({
        id: "req-1", status: "proposed", authorId: "user-admin", packageName: "@test/test-agent",
        packageSlug: "test-agent", packageVersion: "0.1.0", snapshotHash: "fakehash",
        proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, DELEGATED_CHAT_ADMIN),
      )) as { instantGrant?: boolean };
      // No auto-approve, no materialize/publish pipeline — the chat proposal
      // queues for a deliberate decision via the Approvals UI.
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
      expect(innerHandlersMock.createAgentBuilderPrimitiveHandlers).not.toHaveBeenCalled();
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
      expect(out.instantGrant).not.toBe(true);
    });

    it("keeps the admin instant-grant for non-delegated (UI) authoring (#382)", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue({
        id: "req-1", status: "proposed", authorId: "user-admin", packageName: "@test/test-agent",
        packageSlug: "test-agent", packageVersion: "0.1.0", snapshotHash: "fakehash",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });
      const handlerMap = {
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        agent_source_publish: vi.fn(async () => ({ published: true, packageName: "@test/test-agent" })),
      };
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue(handlerMap);

      await handleAgentCreationRequestPropose(req("agent_creation_request_propose", SAMPLE_INPUT, ADMIN));
      // Non-delegated admin authoring still publishes directly (the #382 design).
      expect(storeMock.decideAgentCreationRequestCas).toHaveBeenCalled();
      expect(handlerMap.agent_source_publish).toHaveBeenCalled();
    });
  });

  describe("decide", () => {
    it("rejects a non-admin caller with Unauthorized", async () => {
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/Unauthorized.*admin/i);
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
    });

    it("rejects self-approval by default when another admin exists (SoD)", async () => {
      // Default mock: countOtherPlatformAdmins → 1, so segregation of duties
      // applies and the self-approval guard fires.
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-admin", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/self-approval is disallowed/i);
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
      expect(betterAuthDbMock.countOtherPlatformAdmins).toHaveBeenCalledWith("user-admin");
    });

    it("allows self-approval on a single-admin instance (issue #392 deadlock fix)", async () => {
      // No OTHER platform_admin exists → SoD is impossible, so the only admin
      // must be able to clear their own pre-existing `proposed` request.
      betterAuthDbMock.countOtherPlatformAdmins.mockResolvedValue(0);
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-admin", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
      expect(storeMock.decideAgentCreationRequestCas).toHaveBeenCalled();
      expect(betterAuthDbMock.countOtherPlatformAdmins).toHaveBeenCalledWith("user-admin");
    });

    it("keeps the guard when the admin-count read fails closed (returns >=1)", async () => {
      // countOtherPlatformAdmins fails CLOSED at the source; here we simulate a
      // resolved value of 1 (its error fallback) and assert the guard holds.
      betterAuthDbMock.countOtherPlatformAdmins.mockResolvedValue(1);
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-admin", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/self-approval is disallowed/i);
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
    });

    it("does NOT count admins for a cross-author approval (no self-approval)", async () => {
      // Admin approving someone ELSE's proposal never touches the SoD guard.
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-other", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
      expect(betterAuthDbMock.countOtherPlatformAdmins).not.toHaveBeenCalled();
    });

    it("allows self-approval when connector_config flag is set", async () => {
      dbMock.readConnectorConfigFromDatabase.mockReturnValue({ allowSelfApproval: true });
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-admin", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
      expect(storeMock.decideAgentCreationRequestCas).toHaveBeenCalled();
    });

    it("rejects stale snapshot hash (CAS)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockImplementation(() => {
        throw new storeMock.StaleProposalError();
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "OLD-HASH" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/stale/i);
    });

    it("audits the decision via logAuditEventStrict (privileged-mutation gate)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "rejected", packageName: "@test/test-agent", packageSlug: "test-agent",
        proposalSnapshot: SAMPLE_INPUT,
      });
      await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "reject", reason: "missing tests", expectedSnapshotHash: "fakehash" },
          ADMIN),
      );
      expect(auditMock.logAuditEventStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: "agent_creation_request",
          resourceId: "req-1",
          operation: "reject",
          decision: "allowed",
        }),
      );
    });

    it("approve-path materializes via the live agent_source_* handlers under the admin actor", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });

      const handlerMap = {
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        agent_source_publish: vi.fn(async () => ({ published: true, packageName: "@test/test-agent" })),
      };
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue(handlerMap);

      await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      );
      expect(handlerMap.agent_source_write).toHaveBeenCalled();
      expect(handlerMap.agent_source_write_files).toHaveBeenCalled();
      expect(handlerMap.agent_source_compile).toHaveBeenCalled();
      expect(handlerMap.agent_source_publish).toHaveBeenCalled();
      // Each call carries admin actor (platformRole: platform_admin).
      for (const fn of [handlerMap.agent_source_write, handlerMap.agent_source_write_files, handlerMap.agent_source_compile, handlerMap.agent_source_publish]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callArg = (fn.mock.calls as any[])[0][0] as { actor: { platformRole?: string } };
        expect(callArg.actor.platformRole).toBe("platform_admin");
      }
      // publish destination is hardcoded "private".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pubCallArg = (handlerMap.agent_source_publish.mock.calls as any[])[0][0] as { input: { destination?: string } };
      expect(pubCallArg.input.destination).toBe("private");
      expect(storeMock.markAgentCreationRequestPublished).toHaveBeenCalled();
    });

    it("approve-path rejects on package-name collision", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storeReadMock.readAgentTemplates.mockResolvedValue({
        items: [{ packageName: "@test/test-agent" }],
        total: 1,
      } as any);
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/package-name collision/i);
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
    });
  });

  describe("author decision notifications (issue #79)", () => {
    const DECIDED_ROW = {
      id: "req-1",
      orgId: "org-1",
      authorId: "user-author",
      snapshotHash: "fakehash",
      decidedAt: "2026-06-10T12:00:00.000Z",
      packageName: "@test/test-agent",
      packageSlug: "test-agent",
      packageVersion: "0.1.0",
      proposalSnapshot: SAMPLE_INPUT,
    };
    const PROPOSED_ROW = {
      ...DECIDED_ROW,
      status: "proposed",
      decidedAt: null,
    };

    it("reject notifies the author with the COMMITTED rejection reason (never raw caller input)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      // The committed row's reason intentionally differs from the caller's
      // raw input — the notification must render the persisted value.
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...DECIDED_ROW, status: "rejected", rejectionReason: "stored reason",
        notificationState: { decision: "rejected", claimedAt: "2026-06-10T12:00:01.000Z" },
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "reject", reason: "caller raw reason", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
      expect(notificationsMock.createNotificationForRecipient).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [recipient, input] = (notificationsMock.createNotificationForRecipient.mock.calls as any[])[0];
      expect(recipient).toEqual({ kind: "user", userId: "user-author" });
      expect(input.title).toMatch(/rejected/i);
      expect(input.kind).toBe("warning");
      expect(input.body).toContain("@test/test-agent");
      expect(input.body).toContain("stored reason");
      expect(input.body).not.toContain("caller raw reason");
      // Dedupe key is decision-cycle-stable: decidedAt is part of the key, so
      // a later re-decision (after an author edit) mints a fresh key.
      expect(input.dedupeKey).toBe(
        "agent-creation-request:req-1:rejected:2026-06-10T12:00:00.000Z",
      );
      // The notifications-host adapter registration side-effect module was
      // imported on the emit path (every call path, not just boot-loaded ones).
      expect(hostState.loaded).toBe(true);
      // The sentAt stamp is scoped to the EXACT claim the decide CAS minted —
      // a stalled notifier can never acknowledge a later cycle's claim.
      expect(storeMock.markAgentCreationRequestNotificationSent).toHaveBeenCalledWith({
        id: "req-1", orgId: "org-1",
        decision: "rejected", claimedAt: "2026-06-10T12:00:01.000Z",
      });
    });

    it("approve notifies the author even when the downstream publish fails (decision stands)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...DECIDED_ROW, status: "approved",
        notificationState: { decision: "approved", claimedAt: "2026-06-10T12:00:01.000Z" },
      });
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue({
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ error: "compile blew up" })),
        agent_source_publish: vi.fn(async () => ({ published: true })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/compile/i);
      expect(notificationsMock.createNotificationForRecipient).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [recipient, input] = (notificationsMock.createNotificationForRecipient.mock.calls as any[])[0];
      expect(recipient).toEqual({ kind: "user", userId: "user-author" });
      expect(input.title).toMatch(/approved/i);
      expect(input.kind).toBe("success");
      // approve persists no rejection reason — the body must not invent one
      // from raw caller input.
      expect(input.body).not.toMatch(/reason/i);
      expect(storeMock.markAgentCreationRequestNotificationSent).toHaveBeenCalledWith({
        id: "req-1", orgId: "org-1",
        decision: "approved", claimedAt: "2026-06-10T12:00:01.000Z",
      });
    });

    it("a notification write failure never fails the decide (best-effort)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...DECIDED_ROW, status: "rejected",
      });
      notificationsMock.createNotificationForRecipient.mockRejectedValueOnce(
        new Error("notifications table on fire"),
      );
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "reject", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string; structuredContent?: { request?: { status?: string } } };
      expect(out.error).toBeUndefined();
      expect(out.structuredContent?.request?.status).toBe("rejected");
      // sentAt is only stamped after a SUCCESSFUL write.
      expect(storeMock.markAgentCreationRequestNotificationSent).not.toHaveBeenCalled();
    });

    it("does not attempt any notification when the CAS decide fails (stale snapshot)", async () => {
      // Losing the decide CAS IS losing the notification claim — the claim is
      // stamped by the same atomic UPDATE, so a loser must emit nothing.
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      storeMock.decideAgentCreationRequestCas.mockImplementation(() => {
        throw new storeMock.StaleProposalError();
      });
      await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "reject", expectedSnapshotHash: "OLD-HASH" },
          ADMIN),
      );
      expect(notificationsMock.createNotificationForRecipient).not.toHaveBeenCalled();
      expect(storeMock.markAgentCreationRequestNotificationSent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Admin "instant grant" (issue #382): a platform_admin authoring via chat
  // publishes DIRECTLY — propose auto-approves + publishes the freshly-created
  // proposal under the admin actor, reusing the gated approve→publish pipeline.
  // A NON-admin author STILL queues at 'proposed' (unchanged).
  // -------------------------------------------------------------------------
  describe("propose admin instant-grant (#382)", () => {
    const PROPOSED_ADMIN_ROW = {
      id: "req-1",
      orgId: "org-1",
      authorId: "user-admin",
      status: "proposed",
      snapshotHash: "fakehash",
      packageName: "@test/test-agent",
      packageSlug: "test-agent",
      packageVersion: "0.1.0",
      proposalSnapshot: SAMPLE_INPUT,
    };

    it("auto-approves + publishes when the author is a platform_admin (instant grant)", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue(PROPOSED_ADMIN_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...PROPOSED_ADMIN_ROW, status: "approved",
        notificationState: { decision: "approved", claimedAt: "2026-06-10T12:00:01.000Z" },
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({
        ...PROPOSED_ADMIN_ROW, status: "published",
      });
      const handlerMap = {
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        agent_source_publish: vi.fn(async () => ({ published: true, packageName: "@test/test-agent" })),
      };
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue(handlerMap);

      const out = (await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, ADMIN),
      )) as { error?: string; structuredContent?: { request?: { status?: string } } };

      // No error; the proposal was approved (CAS) and published end-to-end.
      expect(out.error).toBeUndefined();
      expect(storeMock.decideAgentCreationRequestCas).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "req-1",
          decision: "approve",
          decidedBy: "user-admin",
          expectedSnapshotHash: "fakehash",
        }),
      );
      // The gated publish pipeline ran under the admin actor.
      expect(handlerMap.agent_source_write).toHaveBeenCalled();
      expect(handlerMap.agent_source_publish).toHaveBeenCalled();
      for (const fn of [handlerMap.agent_source_write, handlerMap.agent_source_publish]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callArg = (fn.mock.calls as any[])[0][0] as { actor: { platformRole?: string } };
        expect(callArg.actor.platformRole).toBe("platform_admin");
      }
      expect(storeMock.markAgentCreationRequestPublished).toHaveBeenCalled();
      expect(out.structuredContent?.request?.status).toBe("published");
    });

    it("audits the instant grant as operation:approve with admin_authoring_instant_grant origin", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue(PROPOSED_ADMIN_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...PROPOSED_ADMIN_ROW, status: "approved",
      });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({
        ...PROPOSED_ADMIN_ROW, status: "published",
      });
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue({
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        agent_source_publish: vi.fn(async () => ({ published: true })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, ADMIN),
      );
      expect(auditMock.logAuditEventStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: "agent_creation_request",
          resourceId: "req-1",
          operation: "approve",
          decision: "allowed",
          metadata: expect.objectContaining({
            decisionOrigin: "admin_authoring_instant_grant",
          }),
        }),
      );
    });

    it("does NOT auto-approve a NON-admin author — proposal stays at 'proposed'", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue({
        id: "req-1", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, NON_ADMIN),
      )) as { error?: string; structuredContent?: { request?: { status?: string } } };

      // No decide, no publish pipeline, no audit — the proposal queues.
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
      expect(innerHandlersMock.createAgentBuilderPrimitiveHandlers).not.toHaveBeenCalled();
      expect(auditMock.logAuditEventStrict).not.toHaveBeenCalled();
      expect(out.structuredContent?.request?.status).toBe("proposed");
    });

    it("surfaces a publish failure (row stays 'approved'; admin can retry) without throwing", async () => {
      storeMock.createAgentCreationRequest.mockReturnValue(PROPOSED_ADMIN_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...PROPOSED_ADMIN_ROW, status: "approved",
      });
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue({
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ error: "compile blew up" })),
        agent_source_publish: vi.fn(async () => ({ published: true })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const out = (await handleAgentCreationRequestPropose(
        req("agent_creation_request_propose", SAMPLE_INPUT, ADMIN),
      )) as { error?: string; instantGrant?: boolean };
      expect(out.error).toMatch(/compile/i);
      expect(out.instantGrant).toBe(true);
      // Publish never succeeded → markPublished not called (row stays approved).
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
    });
  });
});
