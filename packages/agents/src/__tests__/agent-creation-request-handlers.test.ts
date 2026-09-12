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
  // Per-scope skill-assignment readers. `agents-store.getAssignedSkillIdsForAgent`
  // calls both whenever an ActorContext is in scope, and swallows a throw — so a
  // missing entry here is not a red test, only eight lines of logged noise each
  // and a silently empty skill union. Both return the real functions' EMPTY
  // shape (rows / ids), which is what an unconfigured workspace reads.
  readCustomSkillAssignmentsForAgent: vi.fn(() => []),
  readSystemGlobalSkillIdsForAgent: vi.fn(() => []),
  // Reached one level deeper, through skills-store's `syncInstalledSkillsToDatabase`,
  // once the two readers above stop throwing. Empty catalog = the two collections
  // its callers iterate, both empty.
  readSkillCatalogFromDatabase: vi.fn(() => ({ skills: [], skillPackages: [] })),
}));
vi.mock("@/lib/database", () => dbMock);

// Better-auth-db: the decide path counts OTHER platform admins (issue #392)
// to decide whether the self-approval SoD guard applies. Default to 1 (another
// admin exists → guard stays on / SoD preserved); single-admin tests override
// to 0.
//
// `readUserIsPlatformAdmin` answers the RECIPIENT question added by
// cinatra#2701 (epic #2699 S2): the decision notification's deep link addresses
// `/configuration/agents/approvals/<id>`, which is admin-only, so a NEW row
// carries the href only when the author who receives it is themselves an admin.
// Default false — the ordinary author is a member.
const betterAuthDbMock = vi.hoisted(() => ({
  countOtherPlatformAdmins: vi.fn(async () => 1),
  readUserIsPlatformAdmin: vi.fn(async () => false),
}));
vi.mock("@/lib/better-auth-db", () => betterAuthDbMock);

// The instance's operator-vendor segment. cinatra#2597: the REAL
// `agent_source_write_files` rewrites `package.json#name` UNCONDITIONALLY to
// `@<resolveInstanceVendorSegment()>/<packageSlug>`, and `agent_source_publish`
// reads the canonical name back off that same package.json — so the published
// identity is ALWAYS instance-scoped, whatever the author proposed. The mock
// below reproduces that rewrite instead of hiding it.
const INSTANCE_NS = "@instance-ns";

// Mock the handlers.ts circular target (materializeAndPublish lazy-imports it).
const innerHandlersMock = vi.hoisted(() => ({
  createAgentBuilderPrimitiveHandlers: vi.fn(() => ({
    agent_source_write: vi.fn(async () => ({ written: true })),
    agent_source_write_files: vi.fn(async () => ({ written: true })),
    agent_source_compile: vi.fn(async () => ({ compiled: true })),
    // cinatra#2597 — this used to return a bare `{ published: true }` with NO
    // packageName, which meant the namespace rewrite simply did not exist in
    // the test world. It now returns the namespace-rewritten canonical name the
    // real primitive returns. Every test that relies on THIS default uses
    // packageSlug "test-agent" (SAMPLE_INPUT), so the rewritten name is fixed;
    // the controlled-pair tests below install their own handler map and derive
    // it from the slug.
    //
    // The return type is annotated with every field OPTIONAL beyond `published`
    // so a per-test handler map that returns a narrower object stays assignable
    // to this mock — the real primitive can also return `{ error }` instead.
    agent_source_publish: vi.fn(
      async (): Promise<{
        published?: boolean;
        packageName?: string;
        packageVersion?: string;
        error?: string;
      }> => ({
        published: true,
        packageName: "@instance-ns/test-agent",
        packageVersion: "0.1.0",
      }),
    ),
  })),
}));
vi.mock("../mcp/handlers", () => innerHandlersMock);

// Mock the store import for the slug-collision check AND the post-publish
// template-id lookup (cinatra#1327 — approveAndPublishCreationRequest resolves
// the published template's id so the app layer can persist the access scope).
//
// cinatra#2597 — `readAgentTemplateByPackageName` used to resolve `{ id:
// "tmpl-1" }` for ANY key, so a lookup on the WRONG key still "found" a
// template and the mis-keying was invisible. The real store fn is an
// exact-match query with no alias resolution (store.ts), so the mock is now
// backed by a Map: only a row that was actually registered under that exact
// packageName resolves, and everything else is null.
// `orgId` is carried because the approve path refuses to scope a template that
// belongs to a DIFFERENT organization (package_name is globally unique, so a
// collision would otherwise hand back a foreign row's id).
const storeReadMock = vi.hoisted(() => {
  const templateRowsByPackageName = new Map<string, { id: string; orgId?: string | null }>();
  return {
    templateRowsByPackageName,
    readAgentTemplates: vi.fn(async () => ({ items: [], total: 0 })),
    readAgentTemplateByPackageName: vi.fn(
      async (packageName: string) => templateRowsByPackageName.get(packageName) ?? null,
    ),
    // The /agents installed-template reader. Same story as the two database
    // readers above: reached through a defensive catch, so its absence logged
    // rather than failed. Empty list = no installed templates, the default the
    // rest of this file already assumes.
    readInstalledAgentTemplates: vi.fn(async () => []),
  };
});
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
  handleAgentCreationRequestGet,
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
    // cinatra#2597 — no template row exists until a test registers one under an
    // EXACT packageName. `vi.clearAllMocks()` does not touch a Map.
    storeReadMock.templateRowsByPackageName.clear();
    betterAuthDbMock.countOtherPlatformAdmins.mockResolvedValue(1);
    // cinatra#2701 — the ordinary author is a MEMBER; the admin-recipient and
    // read-failure cases override this per test.
    betterAuthDbMock.readUserIsPlatformAdmin.mockResolvedValue(false);
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/Unauthorized.*admin/i);
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
    });

    it("cinatra#1327 — an approve WITHOUT an access scope is refused BEFORE any state read / CAS / publish (fail-closed, no-bypass)", async () => {
      // The structural guarantee: no approve-publish path can reach the CAS /
      // publish without the access decision. Enforced ahead of the state read,
      // so not even the DB row is loaded. (A reject needs no scope.)
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash" },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/access scope is required/i);
      expect(storeMock.readAgentCreationRequestById).not.toHaveBeenCalled();
      expect(storeMock.decideAgentCreationRequestCas).not.toHaveBeenCalled();
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
    // cinatra#2701 — the ordinary author is a MEMBER; the admin-recipient and
    // read-failure cases override this per test.
    betterAuthDbMock.readUserIsPlatformAdmin.mockResolvedValue(false);
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-admin", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "OLD-HASH", accessTarget: { level: "organization", id: "org-1" } },
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
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
      // cinatra#2597 — the gate is an EXACT lookup now, not a paginated scan, so
      // the fixture registers the colliding row by its exact key.
      storeReadMock.templateRowsByPackageName.set("@test/test-agent", {
        id: "tmpl-existing",
        orgId: "org-1",
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/package-name collision/i);
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
    });

    it("a collision-check READ FAILURE refuses the publish (fail-closed, not fail-open)", async () => {
      // cinatra#2597 — this gate used to swallow read errors ("the downstream
      // write will fail anyway"). It cannot: on a missed collision the publish
      // ADOPTS the existing row via upsert and stamps the approving org onto it,
      // which would also defeat the post-publish ownership guard. A gate that
      // cannot read must refuse. The row stays `approved` for retry_publish.
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
      });
      storeReadMock.readAgentTemplateByPackageName.mockRejectedValueOnce(new Error("db unreachable"));
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/collision check failed/i);
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
    });

    it("the collision gate is UNBOUNDED — it catches a row a 50-row page would miss", async () => {
      // cinatra#2597 — the old gate called `readAgentTemplates()` with no
      // options, which pages at a default limit of 50, so on any instance with
      // more than 50 templates it silently stopped covering the table. A missed
      // collision let publish ADOPT the existing row. `readAgentTemplates` is
      // left returning an empty page here precisely to prove the gate no longer
      // depends on it.
      storeReadMock.readAgentTemplates.mockResolvedValue({ items: [], total: 5000 });
      storeReadMock.templateRowsByPackageName.set("@test/test-agent", {
        id: "tmpl-row-9999",
        orgId: "org-other",
      });
      storeMock.readAgentCreationRequestById.mockReturnValue({
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: "@test/test-agent", packageSlug: "test-agent", packageVersion: "0.1.0",
        proposalSnapshot: SAMPLE_INPUT,
      });
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        id: "req-1", status: "approved", packageName: "@test/test-agent", packageSlug: "test-agent",
        packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
      });
      const out = (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/package-name collision/i);
      expect(storeMock.markAgentCreationRequestPublished).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // cinatra#2597 — POST-PUBLISH TEMPLATE RESOLUTION (the access-scope key).
  //
  // The approve envelope's `agentTemplateId` is the ONLY key the app layer has
  // to write the requested access scope (decision-helpers.ts →
  // setExtensionInstallAccess). Resolve it wrong and the agent publishes at its
  // restrictive default with the reviewer's chosen scope silently dropped —
  // which is exactly what the live UAT on PR #2602 caught.
  //
  // The controlled pair below is the whole point: the ONLY difference between
  // the two arms is whether the author's proposed scope happens to match the
  // instance vendor. Both must land the template id. Before the fix only the
  // matching arm did, and that arm passed by coincidence (the namespace rewrite
  // was a no-op there), not because the lookup was right.
  //
  // Each arm models publish faithfully: the real `agent_source_publish` CREATES
  // the agent_templates row (via installAgentFromPackage) keyed by the canonical
  // post-rewrite name, so the mock registers the row as a publish side effect
  // rather than pre-seeding it (pre-seeding would trip the collision check).
  // -------------------------------------------------------------------------
  describe("approve → agentTemplateId resolution (cinatra#2597)", () => {
    const PROPOSED_SLUG = "test-agent";
    const CANONICAL = `${INSTANCE_NS}/${PROPOSED_SLUG}`;

    /** How many `readAgentTemplateByPackageName` calls had happened when publish
     *  ran. The PRE-publish collision gates legitimately look names up too
     *  (including the proposed one), so assertions about the POST-publish
     *  resolution must ignore everything before this index. */
    let lookupsBeforePublish = 0;
    /** The lookup keys used AFTER publish — i.e. by the resolution under test. */
    const lookupsAfterPublish = () =>
      storeReadMock.readAgentTemplateByPackageName.mock.calls
        .slice(lookupsBeforePublish)
        .map((c) => c[0]);

    /** Wire the store rows for a proposal under `proposedName`, and make the
     *  publish primitive behave like the real one: rewrite the package name to
     *  the instance vendor segment, create the template row under THAT name, and
     *  return it. */
    function arrangeApprove(proposedName: string) {
      const row = {
        id: "req-1", authorId: "user-author", status: "proposed", snapshotHash: "fakehash",
        packageName: proposedName, packageSlug: PROPOSED_SLUG, packageVersion: "0.1.0",
        proposalSnapshot: { ...SAMPLE_INPUT, packageName: proposedName },
      };
      storeMock.readAgentCreationRequestById.mockReturnValue(row);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({ ...row, status: "approved" });
      storeMock.markAgentCreationRequestPublished.mockReturnValue({ id: "req-1", status: "published" });
      const handlerMap = {
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({
          written: true,
          nameNormalized: proposedName === CANONICAL ? null : { from: proposedName, to: CANONICAL },
        })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        // Return type kept wide (every field but `published` optional) so a
        // per-case `mockImplementation` can return a narrower shape — e.g. a
        // publish result carrying no packageName at all.
        agent_source_publish: vi.fn(
          async (): Promise<{
            published?: boolean;
            packageName?: string;
            packageVersion?: string;
            error?: string;
          }> => {
            lookupsBeforePublish = storeReadMock.readAgentTemplateByPackageName.mock.calls.length;
            // The publish is what materializes the agent_templates row, keyed by
            // the CANONICAL (instance-scoped) name — never the proposed one —
            // and owned by the publishing (approving) org.
            storeReadMock.templateRowsByPackageName.set(CANONICAL, {
              id: "tmpl-published",
              orgId: "org-1",
            });
            return { published: true, packageName: CANONICAL, packageVersion: "0.1.0" };
          },
        ),
      };
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue(handlerMap);
      return handlerMap;
    }

    async function approveScopedToTeam() {
      return (await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          {
            id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash",
            accessTarget: { level: "team", id: "team-7" },
          },
          ADMIN),
      )) as { error?: string; structuredContent?: { agentTemplateId?: string | null } };
    }

    it("NON-matching proposed namespace still resolves the template id (the regressed arm)", async () => {
      // The author proposed `@uat236/test-agent`; write_files rewrote it to
      // `@instance-ns/test-agent`, so the row exists ONLY under the canonical
      // name. Keying the lookup on the proposed name found nothing — the scope
      // was dropped. This is the DEFAULT case, not an edge case.
      arrangeApprove("@uat236/test-agent");
      const out = await approveScopedToTeam();
      expect(out.error).toBeUndefined();
      expect(out.structuredContent?.agentTemplateId).toBe("tmpl-published");
    });

    it("MATCHING proposed namespace resolves the template id (the arm that passed by coincidence)", async () => {
      // Identical flow, identical assertions — the ONLY difference is that the
      // rewrite is a no-op here. It must not be the only arm that works.
      arrangeApprove(CANONICAL);
      const out = await approveScopedToTeam();
      expect(out.error).toBeUndefined();
      expect(out.structuredContent?.agentTemplateId).toBe("tmpl-published");
    });

    it("NEVER falls back to the proposed name — a foreign row under it is not resolved", async () => {
      // Cross-tenant fail-closed guard. `readAgentTemplateByPackageName` filters
      // on package_name ALONE (no org predicate), so a proposed-name fallback
      // could resolve a template owned by a DIFFERENT organization and apply
      // this reviewer's scope to somebody else's agent. Here the canonical key
      // has no row and the PROPOSED key does — the answer must still be null.
      const proposed = "@someoneelse/test-agent";
      const handlerMap = arrangeApprove(proposed);
      handlerMap.agent_source_publish.mockImplementation(async () => {
        lookupsBeforePublish = storeReadMock.readAgentTemplateByPackageName.mock.calls.length;
        // A pre-existing, unrelated row sitting under the proposed name.
        storeReadMock.templateRowsByPackageName.set(proposed, { id: "tmpl-OTHER-ORG" });
        return { published: true, packageName: CANONICAL, packageVersion: "0.1.0" };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await approveScopedToTeam();
        expect(out.structuredContent?.agentTemplateId).toBeNull();
        expect(out.structuredContent?.agentTemplateId).not.toBe("tmpl-OTHER-ORG");
        // The resolution must never consult the proposed name. (The PRE-publish
        // collision gates do look it up — that is their job — so only the
        // post-publish lookups are inspected here.)
        expect(lookupsAfterPublish()).not.toContain(proposed);
      } finally {
        warn.mockRestore();
      }
    });

    it("refuses a CANONICAL row owned by another org (cross-tenant fail-closed)", async () => {
      // `package_name` is globally UNIQUE. If a foreign org already owned the
      // canonical name, publish would have adopted its row (upsert by package
      // name; an `alreadyPublished` result can skip the sync altogether) and the
      // lookup would hand back a FOREIGN template id. Applying the reviewer's
      // scope to it would be a cross-tenant access grant, so it fails closed.
      const handlerMap = arrangeApprove("@uat236/test-agent");
      handlerMap.agent_source_publish.mockImplementation(async () => {
        lookupsBeforePublish = storeReadMock.readAgentTemplateByPackageName.mock.calls.length;
        storeReadMock.templateRowsByPackageName.set(CANONICAL, {
          id: "tmpl-FOREIGN",
          orgId: "org-someone-else",
        });
        return { published: true, packageName: CANONICAL, packageVersion: "0.1.0" };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await approveScopedToTeam();
        expect(out.structuredContent?.agentTemplateId).toBeNull();
        expect(out.structuredContent?.agentTemplateId).not.toBe("tmpl-FOREIGN");
        const warned = warn.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warned).toContain("org-someone-else");
      } finally {
        warn.mockRestore();
      }
    });

    it("refuses a canonical row with NO owning org (fail-closed)", async () => {
      const handlerMap = arrangeApprove("@uat236/test-agent");
      handlerMap.agent_source_publish.mockImplementation(async () => {
        lookupsBeforePublish = storeReadMock.readAgentTemplateByPackageName.mock.calls.length;
        storeReadMock.templateRowsByPackageName.set(CANONICAL, { id: "tmpl-orgless", orgId: null });
        return { published: true, packageName: CANONICAL, packageVersion: "0.1.0" };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await approveScopedToTeam();
        expect(out.structuredContent?.agentTemplateId).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it("resolves to null when publish returns no packageName (fail-closed)", async () => {
      const handlerMap = arrangeApprove("@uat236/test-agent");
      handlerMap.agent_source_publish.mockImplementation(async () => {
        lookupsBeforePublish = storeReadMock.readAgentTemplateByPackageName.mock.calls.length;
        storeReadMock.templateRowsByPackageName.set(CANONICAL, { id: "tmpl-published" });
        return { published: true };
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await approveScopedToTeam();
        // No authoritative identity → no id, and no lookup at all afterwards
        // (in particular, no guessing from the proposal).
        expect(out.structuredContent?.agentTemplateId).toBeNull();
        expect(lookupsAfterPublish()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it("resolves to null — never a wrong id — when NO row matches either key", async () => {
      // Fail-closed. A wrong id here would write the reviewer's access scope
      // onto SOMEONE ELSE'S agent, which is worse than not writing it at all.
      const handlerMap = arrangeApprove("@uat236/test-agent");
      handlerMap.agent_source_publish.mockImplementation(async () => ({
        published: true, packageName: CANONICAL, packageVersion: "0.1.0",
      }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await approveScopedToTeam();
        expect(out.structuredContent?.agentTemplateId).toBeNull();
        // Both keys tried are named in the warning so an operator can see which
        // identity the row actually landed under.
        const warned = warn.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(warned).toContain(CANONICAL);
        expect(warned).toContain("@uat236/test-agent");
      } finally {
        warn.mockRestore();
      }
    });

    it("resolves using the PUBLISHED name, and ONLY that name", async () => {
      arrangeApprove("@uat236/test-agent");
      await approveScopedToTeam();
      // Exactly one post-publish lookup, on the canonical name.
      expect(lookupsAfterPublish()).toEqual([CANONICAL]);
    });
  });

  // -------------------------------------------------------------------------
  // Author-or-admin READ RULE (admin OR the row's own author may read —
  // `!admin && row.authorId !== userId`). #1552 brings the WEB detail route's
  // ACCESS RULE to this same predicate; that is the axis on which the two
  // surfaces are "at parity".
  //
  // They CURRENTLY DIVERGE on existence-hiding, and these tests CHARACTERIZE
  // (not endorse) that divergence: the web route 404-hides a non-author (a
  // missing id and an existing-but-not-yours id are byte-identical), whereas
  // this token-gated MCP handler returns a DISTINGUISHABLE "forbidden — not your
  // request" vs "not found" — i.e. the MCP surface is a weak existence oracle
  // for an org member who can already reach the (org-scoped) primitive. That is
  // a KNOWN, out-of-#1552-scope property of a platform-authz-reviewed carve-out
  // (see src/lib/authz/carve-out.ts → agent_creation_request_get, risk=low);
  // hardening the MCP surface to also 404-hide is a separate platform-authz
  // decision, deliberately NOT taken here (the handler source is untouched by
  // #1552). If it is later hardened, `non-author-deny` below flips from
  // "forbidden — not your request" to "not found" and must be updated with it —
  // this assertion is the tripwire, not a guarantee the leak is desirable.
  // -------------------------------------------------------------------------
  describe("get — author-or-admin read RULE (#1552 parity is on the RULE, not existence-hiding)", () => {
    const OWN_ROW = {
      id: "req-1", orgId: "org-1", authorId: "user-author", status: "proposed",
      snapshotHash: "fakehash", packageName: "@test/test-agent", packageSlug: "test-agent",
      packageVersion: "0.1.0", proposalSnapshot: SAMPLE_INPUT,
    };
    const OTHERS_ROW = { ...OWN_ROW, authorId: "user-other" };

    it("author-read-allow: a non-admin author reads THEIR OWN request (org-scoped read)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(OWN_ROW);
      const out = (await handleAgentCreationRequestGet(
        req("agent_creation_request_get", { id: "req-1" }, NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
      expect(storeMock.readAgentCreationRequestById).toHaveBeenCalledWith("req-1", "org-1");
    });

    it("non-author-deny: a non-admin who is not the author is refused (forbidden — not your request)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(OTHERS_ROW);
      const out = (await handleAgentCreationRequestGet(
        req("agent_creation_request_get", { id: "req-1" }, NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/forbidden.*not your request/i);
    });

    it("admin-reads-any: an admin reads a request authored by someone else", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(OTHERS_ROW);
      const out = (await handleAgentCreationRequestGet(
        req("agent_creation_request_get", { id: "req-1" }, ADMIN),
      )) as { error?: string };
      expect(out.error).toBeUndefined();
    });

    it("missing id → not found (never leaks another org's row)", async () => {
      storeMock.readAgentCreationRequestById.mockReturnValue(undefined);
      const out = (await handleAgentCreationRequestGet(
        req("agent_creation_request_get", { id: "nope" }, NON_ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/not found/i);
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
      // #1555 wrote a deep link to the request detail route for every author.
      // cinatra#2701 (epic #2699 S2) re-scoped it: that route is admin-only
      // again, and this author is a member — so the row carries NO href, and
      // the outcome + reason still reach them in the body above.
      expect(input.href).toBeUndefined();
      expect("href" in input).toBe(false);
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
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          ADMIN),
      )) as { error?: string };
      expect(out.error).toMatch(/compile/i);
      expect(notificationsMock.createNotificationForRecipient).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [recipient, input] = (notificationsMock.createNotificationForRecipient.mock.calls as any[])[0];
      expect(recipient).toEqual({ kind: "user", userId: "user-author" });
      expect(input.title).toMatch(/approved/i);
      expect(input.kind).toBe("success");
      // cinatra#2701: member author → no deep link into `/configuration`.
      expect(input.href).toBeUndefined();
      // approve persists no rejection reason — the body must not invent one
      // from raw caller input.
      expect(input.body).not.toMatch(/reason/i);
      expect(storeMock.markAgentCreationRequestNotificationSent).toHaveBeenCalledWith({
        id: "req-1", orgId: "org-1",
        decision: "approved", claimedAt: "2026-06-10T12:00:01.000Z",
      });
    });

    // ── cinatra#2701 (epic #2699 S2) — the recipient decides the href ──────
    it("an ADMIN author's notification KEEPS the deep link", async () => {
      betterAuthDbMock.readUserIsPlatformAdmin.mockResolvedValueOnce(true);
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...DECIDED_ROW, status: "rejected", rejectionReason: "stored reason",
      });
      await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "reject", expectedSnapshotHash: "fakehash" },
          ADMIN),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [, input] = (notificationsMock.createNotificationForRecipient.mock.calls as any[])[0];
      expect(input.href).toBe("/configuration/agents/approvals/req-1");
      // The recipient is asked about — never the DECIDER.
      expect(betterAuthDbMock.readUserIsPlatformAdmin).toHaveBeenCalledWith("user-author");
    });

    it("an unreadable recipient role fails CLOSED — notification sent, no href", async () => {
      betterAuthDbMock.readUserIsPlatformAdmin.mockRejectedValueOnce(new Error("db down"));
      storeMock.readAgentCreationRequestById.mockReturnValue(PROPOSED_ROW);
      storeMock.decideAgentCreationRequestCas.mockReturnValue({
        ...DECIDED_ROW, status: "approved",
      });
      innerHandlersMock.createAgentBuilderPrimitiveHandlers.mockReturnValue({
        agent_source_write: vi.fn(async () => ({ written: true })),
        agent_source_write_files: vi.fn(async () => ({ written: true })),
        agent_source_compile: vi.fn(async () => ({ compiled: true })),
        agent_source_publish: vi.fn(async () => ({ published: true })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      await handleAgentCreationRequestDecide(
        req("agent_creation_request_decide",
          { id: "req-1", decision: "approve", expectedSnapshotHash: "fakehash", accessTarget: { level: "organization", id: "org-1" } },
          ADMIN),
      );
      expect(notificationsMock.createNotificationForRecipient).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [, input] = (notificationsMock.createNotificationForRecipient.mock.calls as any[])[0];
      expect(input.href).toBeUndefined();
      expect(input.title).toMatch(/approved/i);
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
