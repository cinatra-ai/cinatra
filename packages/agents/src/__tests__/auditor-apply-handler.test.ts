/**
 * Handler tests for `POST /api/auditor/apply`.
 *
 * Locks the contract:
 *
 *   1. Body is `{ agent_run_id, data, reviewResult: <json-string> }`.
 *   2. Route JSON.parses `reviewResult` and reads `acceptedIds` from the
 *      decoded shape.
 *   3. The `acceptedIds ⊆ persisted-suggestions` invariant must hold:
 *      an id not in audit_events still 400s.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Auth mock — owner identity matches run.runBy.
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/a2a", () => ({}));
vi.mock("@cinatra-ai/a2a/server", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => {
    throw new Error("not used");
  },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({ user: { id: "u1" } }),
  isPlatformAdmin: () => false,
}));

// ---------------------------------------------------------------------------
// Data-layer mock — readAgentRunById + readRunCoOwners.
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/agents", async () => {
  return {
    readAgentRunById: vi.fn(async () => ({ id: "run1", runBy: "u1" })),
    readRunCoOwners: vi.fn(async () => []),
  };
});
// Relative specifiers — vitest resolves these against this test file, which
// intercepts the route's `@cinatra-ai/agents` barrel import. (A `vi.mock`
// factory cannot reference an imported `path` binding: vi.mock is hoisted above
// imports, so `path` would be uninitialized at factory-eval time.)
vi.mock("../index.ts", () => ({
  readAgentRunById: vi.fn(async () => ({ id: "run1", runBy: "u1" })),
  readRunCoOwners: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// Drizzle DB mock — chainable select().from().where() that resolves to
// audit_event rows. Each test overrides `currentRows` to drive the
// suggestion-set used by the invariant check.
// ---------------------------------------------------------------------------
let currentRows: Array<{ payload: string }> = [];
vi.mock("@cinatra-ai/agents/db", () => {
  const where = vi.fn(() => Promise.resolve(currentRows));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } };
});
vi.mock("../db.ts", () => {
  const where = vi.fn(() => Promise.resolve(currentRows));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } };
});
vi.mock("@cinatra-ai/agents/schema", () => ({
  auditEvents: { payload: "payload", reviewTaskId: "review_task_id", eventType: "event_type" },
}));
vi.mock("../schema.ts", () => ({
  auditEvents: { payload: "payload", reviewTaskId: "review_task_id", eventType: "event_type" },
}));

// ---------------------------------------------------------------------------
// Pure transform mock — succeed-by-default; any thrown AuditorApplyError
// would otherwise need its own export.
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/agents/auditor-apply", async () => {
  const { z } = await import("zod");
  return {
    applyAuditorPatches: vi.fn((data: unknown) => data),
    AuditorApplyError: class extends Error {},
    SuggestionPatchSchema: z.object({
      id: z.string(),
      fieldPath: z.string(),
      op: z.string(),
      value: z.unknown(),
      message: z.string().optional(),
    }),
  };
});
vi.mock("../auditor-apply.ts", async () => {
  const { z } = await import("zod");
  return {
    applyAuditorPatches: vi.fn((data: unknown) => data),
    AuditorApplyError: class extends Error {},
    SuggestionPatchSchema: z.object({
      id: z.string(),
      fieldPath: z.string(),
      op: z.string(),
      value: z.unknown(),
      message: z.string().optional(),
    }),
  };
});

// Production import (AFTER mocks).
import { POST } from "@/app/api/auditor/apply/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/auditor/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auditor/apply — single string-input contract", () => {
  beforeEach(() => {
    currentRows = [
      {
        payload: JSON.stringify({
          suggestions: [
            { id: "s1", fieldPath: "$.x", op: "replace", value: 1, message: "" },
          ],
        }),
      },
    ];
  });

  it("accepts a body with `reviewResult` JSON-string and applies the parsed acceptedIds", async () => {
    const reviewResult = JSON.stringify({ acceptedIds: ["s1"], dismissedIds: [] });
    const res = await POST(
      makeRequest({ agent_run_id: "run1", data: { x: 0 }, reviewResult }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mutatedData?: unknown };
    expect(body).toHaveProperty("mutatedData");
  });

  it("400s when an acceptedId is not in the persisted suggestion set (invariant check)", async () => {
    const reviewResult = JSON.stringify({
      acceptedIds: ["not-in-persisted"],
      dismissedIds: [],
    });
    const res = await POST(
      makeRequest({ agent_run_id: "run1", data: {}, reviewResult }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; offendingId?: string };
    expect(body.offendingId).toBe("not-in-persisted");
  });
});
