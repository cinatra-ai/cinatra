import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { handleEmailTestDeliveryParseAction } from "../mcp/test-delivery-handlers";
import {
  W9_CONTINUE_ENVELOPE,
  W9_ORG_ID,
  W9_OWNER_ID,
  W9_PERFORMED_SENDS,
  W9_RUN_AT_CAP,
  W9_RUN_BELOW_CAP,
  W9_SEND_ENVELOPE,
  W9_TEMPLATE_STAMPED_ABOVE_CEILING,
  W9_TEMPLATE_STAMPED_CAP_3,
  W9_TEMPLATE_UNSTAMPED,
} from "./__fixtures__/w9-test-delivery-at-cap";

// ---------------------------------------------------------------------------
// LIFECYCLE-D W9 — a test-delivery run at its cap. Each case sets up a run of
// one organisation, its template's cap and the run's ledger count, and reads the
// action, the cap and the count the parse action returns. The four modules the
// handler file takes from other places are supplied by vitest's module factory,
// so this file imports neither the handlers hub nor the store.
// ---------------------------------------------------------------------------

// The ledger count is answered per run id; the unit tier has no database, so the
// count query itself is not run here.
const ledgerMock = vi.hoisted(() => ({
  claimTestSend: vi.fn(),
  settleTestSend: vi.fn(),
  recordPreClaimFailure: vi.fn(),
  readTestSendBySubmission: vi.fn(),
  readSentCountForRun: vi.fn(),
  readUnacknowledgedDeliveredDraftIds: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("../agent-run-test-sends", () => ledgerMock);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
}));
vi.mock("../store", () => storeMock);

const authPolicyMock = vi.hoisted(() => ({
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../auth-policy", () => authPolicyMock);

const authzMock = vi.hoisted(() => ({
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

// The four helpers the handler module takes from the handlers hub. The run id is
// read from the frame's verified run scope, as the real helper reads it.
vi.mock("../mcp/handlers", () => ({
  resolveRunScopedRunId: (): { runId: string } | { error: string } => {
    const runId = mcpRequestContextStorage.getStore()?.verifiedRunScopeId;
    return typeof runId === "string" && runId.length > 0
      ? { runId }
      : { error: "no verified run scope on the frame" };
  },
  resolveRoleHintsFromSession: async (): Promise<undefined> => undefined,
  authzErrorToResponse: (err: Error, fallback: string) => ({ error: fallback, reason: err.message }),
  emitReadDenialAudit: (): void => undefined,
}));

type ParseRequest = Parameters<typeof handleEmailTestDeliveryParseAction>[0];

const ACTOR = { userId: W9_OWNER_ID, actorType: "human", source: "mcp" } as const;
const ALLOWED_SEND = {
  action: "send",
  recipientEmail: "to@example.com",
  selectionMode: "random_initial",
};

// The count table the ledger mock answers from: a per-case copy of the fixture.
let counts: Record<string, number>;
let template: unknown;

async function parseFor(run: { id: string }, userResponse: string): Promise<unknown> {
  return mcpRequestContextStorage.run(
    { verifiedRunScopeId: run.id, userId: W9_OWNER_ID, orgId: W9_ORG_ID },
    () =>
      handleEmailTestDeliveryParseAction({
        primitiveName: "email_test_delivery_parse_action",
        input: { userResponse },
        actor: ACTOR,
        mode: "deterministic",
      } as unknown as ParseRequest),
  );
}

beforeEach(() => {
  counts = { ...W9_PERFORMED_SENDS };
  template = W9_TEMPLATE_STAMPED_CAP_3;
  const runsById: Record<string, unknown> = {
    [W9_RUN_AT_CAP.id]: W9_RUN_AT_CAP,
    [W9_RUN_BELOW_CAP.id]: W9_RUN_BELOW_CAP,
  };
  storeMock.readAgentRunById.mockImplementation(async (id: string) => runsById[id] ?? null);
  storeMock.readAgentTemplateById.mockImplementation(async () => template);
  ledgerMock.readSentCountForRun.mockImplementation(async (runId: string) => counts[runId] ?? 0);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("../agent-run-test-sends");
  vi.doUnmock("../store");
  vi.doUnmock("../auth-policy");
  vi.doUnmock("@/lib/authz");
  vi.doUnmock("../mcp/handlers");
  vi.resetModules();
});

describe("a test-delivery run at its cap", () => {
  // Drives test-delivery-handlers.ts:615-623 (the count against the cap) and
  // :157-176 through :167 (the stamped cap of the template's step).
  it("a named test-delivery run at its template's stamped cap halts", async () => {
    const result = await parseFor(W9_RUN_AT_CAP, W9_SEND_ENVELOPE);
    expect(result).toEqual({ action: "halt", maxGateVisits: 3, sentCount: 3 });
  });

  // Drives :582-594 (the parsed send envelope) and :625 (returned as parsed).
  it("one send below the cap still allows the send", async () => {
    const result = await parseFor(W9_RUN_BELOW_CAP, W9_SEND_ENVELOPE);
    expect(result).toEqual(ALLOWED_SEND);
  });

  // Drives :580 (a continue is returned as it is) and :615 (the count is read
  // only for a send).
  it("a continue is never halted, however far past the cap", async () => {
    counts[W9_RUN_AT_CAP.id] = 99;
    const result = await parseFor(W9_RUN_AT_CAP, W9_CONTINUE_ENVELOPE);
    expect(result).toEqual({ action: "continue" });
    expect(ledgerMock.readSentCountForRun).not.toHaveBeenCalled();
    expect(storeMock.readAgentTemplateById).not.toHaveBeenCalled();
  });

  // Drives :131 (the default of 25), :175 (used when no step stamps a cap) and :621.
  it("a template that stamps no cap halts at the default cap of 25", async () => {
    template = W9_TEMPLATE_UNSTAMPED;
    counts[W9_RUN_AT_CAP.id] = 25;
    expect(await parseFor(W9_RUN_AT_CAP, W9_SEND_ENVELOPE)).toEqual({
      action: "halt",
      maxGateVisits: 25,
      sentCount: 25,
    });
    counts[W9_RUN_AT_CAP.id] = 24;
    expect(await parseFor(W9_RUN_AT_CAP, W9_SEND_ENVELOPE)).toEqual(ALLOWED_SEND);
  });

  // Drives :600 (the run id from the frame) and :618 (the count read by that run id).
  it("the count is read for the run in scope, never for its organisation", async () => {
    const atCap = await parseFor(W9_RUN_AT_CAP, W9_SEND_ENVELOPE);
    const belowCap = await parseFor(W9_RUN_BELOW_CAP, W9_SEND_ENVELOPE);
    expect(atCap).toEqual({ action: "halt", maxGateVisits: 3, sentCount: 3 });
    expect(belowCap).toEqual(ALLOWED_SEND);
    expect(ledgerMock.readSentCountForRun.mock.calls).toEqual([
      [W9_RUN_AT_CAP.id],
      [W9_RUN_BELOW_CAP.id],
    ]);
  });

  // Drives :132 (the ceiling of 100) and :172 (the stamped value is clamped to it).
  it("a stamped cap above the ceiling is held at 100", async () => {
    template = W9_TEMPLATE_STAMPED_ABOVE_CEILING;
    counts[W9_RUN_AT_CAP.id] = 100;
    const result = await parseFor(W9_RUN_AT_CAP, W9_SEND_ENVELOPE);
    expect(result).toEqual({ action: "halt", maxGateVisits: 100, sentCount: 100 });
  });
});
