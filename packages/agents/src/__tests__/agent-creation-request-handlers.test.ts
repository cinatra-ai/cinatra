import { describe, it, expect, vi, beforeEach } from "vitest";

// Agent-Creation Approval Workflow — focused unit tests for the
// proposal + decide primitives. Mocks the store + audit so the test runs
// without a live DB. Covers the security-critical paths:
//   - decide is admin-gated.
//   - self-approval is rejected by default.
//   - CAS stale-snapshot rejection.
//   - propose NEVER calls the live agent_source_* tools.

const storeMock = vi.hoisted(() => ({
  createAgentCreationRequest: vi.fn(),
  readAgentCreationRequestById: vi.fn(),
  listAgentCreationRequests: vi.fn(() => []),
  editRejectedRequest: vi.fn(),
  decideAgentCreationRequestCas: vi.fn(),
  markAgentCreationRequestPublished: vi.fn(),
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
    dbMock.readConnectorConfigFromDatabase.mockReturnValue({ allowSelfApproval: false });
    storeReadMock.readAgentTemplates.mockResolvedValue({ items: [], total: 0 });
  });

  describe("propose (ACAW-PROPOSE-01)", () => {
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
  });

  describe("decide (ACAW-PUBLISH-01 / ACAW-AUTHZ-01)", () => {
    it("rejects a non-admin caller with Unauthorized", async () => {
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/Unauthorized.*admin/i);
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
    });

    it("rejects self-approval by default", async () => {
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

    it("rejects stale snapshot hash (CAS, ACAW-STATE-01)", async () => {
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

    it("approve-path rejects on package-name collision (ACAW-COLLISION-01)", async () => {
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
});
