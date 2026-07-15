/**
 * Regression tests for addRunCoOwner effective-policy resolution.
 *
 * Bug: addRunCoOwner read `run.effectivePolicy` off the record returned by
 * readAgentRunById, but readAgentRunById never ATTACHES effectivePolicy to the
 * returned run — it only threads a resolved policy into enforceRunAccess on the
 * actor path, and this action calls readAgentRunById WITHOUT an actor. So
 * `run.effectivePolicy` was always `undefined`, `allowRunSharing !== true` was
 * always true, and the direct-add path returned "sharing_disabled" for EVERY
 * run regardless of its real policy.
 *
 * Fix: resolve the effective policy in the action the same way the store's
 * actor path does — run override wins, else template default, else the locked
 * DEFAULT_AGENT_AUTH_POLICY floor (allowRunSharing: false).
 *
 * These tests pin both success branches (policy from the run override AND from
 * the template default), both disabled branches, and the locked-default floor.
 * The run fixtures deliberately carry NO `effectivePolicy` field, so a test
 * passing proves the action no longer relies on that phantom attribute.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const OWNER_ID = "owner-1";
const TARGET_ID = "target-2";

// Locked default mirrors DEFAULT_AGENT_AUTH_POLICY (auth-policy-types.ts):
// owner-only visibility, sharing OFF.
const LOCKED_DEFAULT = Object.freeze({
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
});

const SHARING_ON = Object.freeze({
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: true,
});

const SHARING_OFF = Object.freeze({
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
});

const h = vi.hoisted(() => {
  // Shared, per-test-mutable holder for the target-user existence query result.
  const dbState = { targetRows: [] as Array<{ id: string }> };

  // Chainable stub for the drizzle query builder used by the target-eligibility
  // lookup: betterAuthDb.select(...).from(...).where(...).limit(1) -> Promise.
  const betterAuthDb: Record<string, unknown> = {};
  betterAuthDb.select = vi.fn(() => betterAuthDb);
  betterAuthDb.from = vi.fn(() => betterAuthDb);
  betterAuthDb.where = vi.fn(() => betterAuthDb);
  betterAuthDb.limit = vi.fn(async () => dbState.targetRows);

  return {
    dbState,
    betterAuthDb,
    betterAuthUsers: {
      id: "id",
      userType: "userType",
      name: "name",
      email: "email",
      image: "image",
    },
    requireAuthSession: vi.fn(),
    isPlatformAdmin: vi.fn(() => false),
    readAgentRunById: vi.fn(),
    readAgentTemplateById: vi.fn(),
    readRunCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
    addRunCoOwnerStore: vi.fn(async () => undefined),
    removeRunCoOwnerStore: vi.fn(async () => undefined),
    clearRunRunByStore: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: h.requireAuthSession,
  isPlatformAdmin: h.isPlatformAdmin,
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  betterAuthDb: h.betterAuthDb,
  betterAuthUsers: h.betterAuthUsers,
}));

vi.mock("../store", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentTemplateById: h.readAgentTemplateById,
  readRunCoOwners: h.readRunCoOwners,
  addRunCoOwner: h.addRunCoOwnerStore,
  removeRunCoOwner: h.removeRunCoOwnerStore,
  clearRunRunBy: h.clearRunRunByStore,
}));

// Faithful re-implementation of the real resolveEffectivePolicy resolution
// order (run override -> template default -> locked default). Mocked to keep
// this unit test off the server-only auth-policy kernel graph, exactly as the
// sibling mcp-run-read-policy.test.ts does.
vi.mock("../auth-policy", () => ({
  resolveEffectivePolicy: (
    run: { authPolicy?: unknown } | null | undefined,
    template: { agentAuthPolicy?: unknown } | null | undefined,
  ) => run?.authPolicy ?? template?.agentAuthPolicy ?? LOCKED_DEFAULT,
}));

// deliberately WITHOUT an effectivePolicy field — the real deserializeRun shape.
function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    templateId: "tpl-1",
    versionId: null,
    runBy: OWNER_ID,
    status: "completed",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date(),
    sourceType: "internal",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    ...overrides,
  };
}

async function callAddRunCoOwner() {
  const mod = await import("../run-sharing-actions");
  return mod.addRunCoOwner("run-1", TARGET_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAuthSession.mockResolvedValue({
    user: { id: OWNER_ID },
    session: { activeOrganizationId: "org-1" },
  });
  h.isPlatformAdmin.mockReturnValue(false);
  h.readRunCoOwners.mockResolvedValue([]);
  // Default: the target user exists and is eligible.
  h.dbState.targetRows = [{ id: TARGET_ID }];
});

describe("addRunCoOwner effective-policy resolution (#1133)", () => {
  it("succeeds when the RUN OVERRIDE policy allows sharing", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: SHARING_ON }));

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: true });
    expect(h.addRunCoOwnerStore).toHaveBeenCalledWith("run-1", TARGET_ID, OWNER_ID);
    // Run override short-circuits — the template is never read.
    expect(h.readAgentTemplateById).not.toHaveBeenCalled();
  });

  it("succeeds when no run override and the TEMPLATE DEFAULT policy allows sharing", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: null }));
    h.readAgentTemplateById.mockResolvedValue({
      id: "tpl-1",
      agentAuthPolicy: SHARING_ON,
    });

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: true });
    expect(h.readAgentTemplateById).toHaveBeenCalledWith("tpl-1");
    expect(h.addRunCoOwnerStore).toHaveBeenCalledWith("run-1", TARGET_ID, OWNER_ID);
  });

  it("returns sharing_disabled when the RUN OVERRIDE policy disallows sharing", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: SHARING_OFF }));

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: false, error: "sharing_disabled" });
    // Denied before the co-owner write and before the target-eligibility query.
    expect(h.addRunCoOwnerStore).not.toHaveBeenCalled();
    expect(h.betterAuthDb.select).not.toHaveBeenCalled();
  });

  it("returns sharing_disabled when no run override and the TEMPLATE DEFAULT disallows sharing", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: null }));
    h.readAgentTemplateById.mockResolvedValue({
      id: "tpl-1",
      agentAuthPolicy: SHARING_OFF,
    });

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: false, error: "sharing_disabled" });
    expect(h.addRunCoOwnerStore).not.toHaveBeenCalled();
  });

  it("returns sharing_disabled when neither run nor template set a policy (locked default floor)", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: null }));
    h.readAgentTemplateById.mockResolvedValue({
      id: "tpl-1",
      agentAuthPolicy: null,
    });

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: false, error: "sharing_disabled" });
  });

  it("still enforces target eligibility AFTER the sharing gate passes", async () => {
    h.readAgentRunById.mockResolvedValue(makeRun({ authPolicy: SHARING_ON }));
    // Sharing is allowed, but the target user does not exist / is ineligible.
    h.dbState.targetRows = [];

    const result = await callAddRunCoOwner();

    expect(result).toEqual({ ok: false, error: "user_not_found" });
    expect(h.betterAuthDb.select).toHaveBeenCalled();
    expect(h.addRunCoOwnerStore).not.toHaveBeenCalled();
  });
});
