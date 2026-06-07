/**
 * Unit tests for the trigger service layer, MCP handlers, and
 * server-action wrapper.
 *
 * Architecture under test:
 *   - trigger-service.ts (actor-aware): single source of truth for auth +
 *     business logic. Server actions and MCP handlers both delegate here.
 *   - run-actions.ts wrappers: resolve Better Auth session into a
 *     TriggerActorContext envelope, then delegate.
 *   - mcp/handlers.ts wrappers: build TriggerActorContext from request.actor,
 *     then delegate (NO requireAuthSession call).
 *
 * Test split:
 *   1–9.  Service layer (no auth mock — pass actor envelopes directly).
 *   10–11. MCP handler shape (PrimitiveRequest envelope).
 *   12.   Server-action wrapper (auth mock active).
 *
 * Setup pattern follows trigger-store.test.ts: live DB connection via
 * SUPABASE_DB_URL/SUPABASE_SCHEMA from .env.local; unique runIds via
 * crypto.randomUUID(). The auth-session vi.mock at the top is only consumed
 * by test 12 — service-layer tests construct actor envelopes inline.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

// Mock auth-session ONLY for the server-action wrapper test. Service-layer
// tests do not need this — they pass actor envelopes directly.
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(),
}));

import { requireAuthSession } from "@/lib/auth-session";
import {
  setRunTriggerForActor,
  getRunTriggerForActor,
  deleteRunTriggerForActor,
} from "../trigger-service";
import {
  handleAgentRunTriggerSet,
  handleAgentRunTriggerGet,
  handleAgentRunTriggerDelete,
} from "../mcp/handlers";
import { setRunTrigger, deleteRunTrigger } from "../run-actions";
import { createAgentRun } from "../store";
import {
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
} from "../trigger-store";
import { db, agentBuilderPool } from "../db";
import { agentRuns } from "../schema";

// Every test fixture row carries an explicit orgId so the NOT NULL schema
// constraint does not break this suite.
const TEST_ORG_ID = "org-test";

// ---------------------------------------------------------------------------
// Helpers — create parent agent_runs row with given runBy so the trigger FK
// resolves and the ownership check has something to compare.
// ---------------------------------------------------------------------------

async function ensureParentRun(runBy: string | null = null): Promise<string> {
  const id = `test-trigger-handler-${randomUUID()}`;
  await createAgentRun({
    id,
    templateId: `tmpl-${randomUUID()}`,
    inputParams: {},
    runBy: runBy ?? undefined,
    orgId: TEST_ORG_ID,
  });
  return id;
}

const ownerActor = (userId: string) => ({
  userId,
  role: null,
  source: "ui" as const,
});

const mcpActor = (userId: string) => ({
  userId,
  role: null,
  source: "mcp" as const,
});

const adminActor = (userId: string) => ({
  userId,
  role: "admin",
  source: "ui" as const,
});

describe("trigger service + handlers + server-action wrapper", () => {
  const createdRunIds: string[] = [];

  beforeAll(() => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "trigger-handlers.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
      );
    }
  });

  afterAll(async () => {
    for (const id of createdRunIds) {
      try {
        await deleteRunTriggerByRunId(id);
      } catch {
        // ignore
      }
      try {
        await db.delete(agentRuns).where(eq(agentRuns.id, id));
      } catch {
        // ignore
      }
    }
    await agentBuilderPool.end().catch(() => {
      // pool may already be closed by another test; ignore
    });
  });

  // -------------------------------------------------------------------------
  // 1) Service layer — happy path: owner sets immediate trigger
  // -------------------------------------------------------------------------
  it("setRunTriggerForActor immediate as owner returns ok", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    expect(result).toEqual({
      ok: true,
      runId,
      jobSchedulerId: null, // immediate trigger has no BullMQ scheduler
    });

    // The trigger row should exist with releasedAt set (immediate marks released).
    const trigger = await readRunTriggerByRunId(runId);
    expect(trigger).not.toBeNull();
    expect(trigger?.triggerType).toBe("immediate");
  });

  // -------------------------------------------------------------------------
  // 2) Service layer — non-owner is rejected
  // -------------------------------------------------------------------------
  it("setRunTriggerForActor as non-owner returns forbidden", async () => {
    const ownerId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = await setRunTriggerForActor(ownerActor(otherUserId), {
      runId,
      triggerType: "immediate",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });

    // No trigger row should have been created.
    const trigger = await readRunTriggerByRunId(runId);
    expect(trigger).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3) Service layer — past scheduledAt rejected with friendly error
  // -------------------------------------------------------------------------
  it("setRunTriggerForActor scheduled in the past returns error", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "scheduled",
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("scheduledAt must be in the future");
    }
  });

  // -------------------------------------------------------------------------
  // 4) Service layer — invalid cron expression rejected
  // -------------------------------------------------------------------------
  it("setRunTriggerForActor recurring with invalid cron returns error", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "recurring",
      cronExpression: "not a cron expression",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^invalid cron expression/);
    }
  });

  // -------------------------------------------------------------------------
  // 5) Service layer — valid cron schedules JobScheduler
  // -------------------------------------------------------------------------
  it("setRunTriggerForActor recurring with valid cron schedules JobScheduler", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe(runId);
      expect(result.jobSchedulerId).toBe(`trigger-release-${runId}`);
    }
  });

  // -------------------------------------------------------------------------
  // 6) Service layer — owner reads back trigger after setting
  // -------------------------------------------------------------------------
  it("getRunTriggerForActor as owner returns trigger", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = await getRunTriggerForActor(ownerActor(ownerId), runId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trigger).not.toBeNull();
      expect(result.trigger?.runId).toBe(runId);
      expect(result.trigger?.triggerType).toBe("immediate");
    }
  });

  // -------------------------------------------------------------------------
  // 7) Service layer — non-owner cannot read trigger (info-disclosure mitigation)
  // -------------------------------------------------------------------------
  it("getRunTriggerForActor as non-owner returns forbidden (info-disclosure mitigation)", async () => {
    const ownerId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = await getRunTriggerForActor(ownerActor(otherUserId), runId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("forbidden");
    }
    // CRITICAL: ensure no trigger metadata leaked.
    expect((result as { trigger?: unknown }).trigger).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8) Service layer — admin can read someone else's trigger
  // -------------------------------------------------------------------------
  it("getRunTriggerForActor with admin role on someone else's run returns trigger", async () => {
    const ownerId = `user-${randomUUID()}`;
    const adminId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = await getRunTriggerForActor(adminActor(adminId), runId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trigger).not.toBeNull();
      expect(result.trigger?.runId).toBe(runId);
    }
  });

  // -------------------------------------------------------------------------
  // 9) Service layer — delete cancels + removes; subsequent get returns null
  // -------------------------------------------------------------------------
  it("deleteRunTriggerForActor cancels + removes idempotently", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const deleteResult = await deleteRunTriggerForActor(ownerActor(ownerId), {
      runId,
    });
    expect(deleteResult).toEqual({ ok: true });

    const getResult = await getRunTriggerForActor(ownerActor(ownerId), runId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.trigger).toBeNull();
    }

    // Idempotent: deleting again returns ok (no row to delete).
    const deleteAgain = await deleteRunTriggerForActor(ownerActor(ownerId), {
      runId,
    });
    expect(deleteAgain).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // 10) MCP handler shape — valid actor returns runId + jobSchedulerId
  // -------------------------------------------------------------------------
  it("handleAgentRunTriggerSet with valid actor returns runId + jobSchedulerId", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = (await handleAgentRunTriggerSet({
      primitiveName: "agent_run_trigger_set",
      input: { runId, triggerType: "immediate" },
      actor: { actorType: "user", source: "mcp", userId: ownerId },
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerSet>[0])) as {
      runId?: string;
      jobSchedulerId?: string | null;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.runId).toBe(runId);
    expect(result.jobSchedulerId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 11) MCP handler shape — empty actor (no userId) returns unauthorized
  // -------------------------------------------------------------------------
  it("handleAgentRunTriggerSet with empty actor returns unauthorized", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    const result = (await handleAgentRunTriggerSet({
      primitiveName: "agent_run_trigger_set",
      input: { runId, triggerType: "immediate" },
      actor: { actorType: "user", source: "mcp" }, // no userId
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerSet>[0])) as {
      error?: string;
    };

    expect(result.error).toBe("unauthorized");
  });

  // -------------------------------------------------------------------------
  // 12) Server-action wrapper — resolves session into actor and delegates
  // -------------------------------------------------------------------------
  it("setRunTrigger (server action) resolves session into actor and delegates", async () => {
    const ownerId = `test-user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    vi.mocked(requireAuthSession).mockResolvedValueOnce({
      user: { id: ownerId },
    } as Awaited<ReturnType<typeof requireAuthSession>>);

    const result = await setRunTrigger({
      runId,
      triggerType: "immediate",
    });

    expect(result).toEqual({
      ok: true,
      runId,
      jobSchedulerId: null,
    });
  });

  // -------------------------------------------------------------------------
  // 13) MCP handler get — non-owner sees forbidden, no trigger metadata
  // -------------------------------------------------------------------------
  it("handleAgentRunTriggerGet as non-owner returns unauthorized/forbidden without trigger fields", async () => {
    const ownerId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = (await handleAgentRunTriggerGet({
      primitiveName: "agent_run_trigger_get",
      input: { runId },
      actor: { actorType: "user", source: "mcp", userId: otherUserId },
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerGet>[0])) as Record<
      string,
      unknown
    >;

    // Must contain an error and MUST NOT contain trigger metadata fields.
    expect(result.error).toBe("forbidden");
    expect(result.triggerType).toBeUndefined();
    expect(result.scheduledAt).toBeUndefined();
    expect(result.cronExpression).toBeUndefined();
    expect(result.timezone).toBeUndefined();
    expect(result.releasedAt).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 14) deleteRunTrigger server-action wrapper exists and delegates
  // -------------------------------------------------------------------------
  it("deleteRunTrigger (server action) resolves session into actor and delegates", async () => {
    const ownerId = `test-user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    vi.mocked(requireAuthSession).mockResolvedValueOnce({
      user: { id: ownerId },
    } as Awaited<ReturnType<typeof requireAuthSession>>);

    const result = await deleteRunTrigger({ runId });
    expect(result).toEqual({ ok: true });

    const trigger = await readRunTriggerByRunId(runId);
    expect(trigger).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 15) handleAgentRunTriggerDelete — empty actor returns unauthorized
  // -------------------------------------------------------------------------
  it("handleAgentRunTriggerDelete with empty actor returns unauthorized", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = (await handleAgentRunTriggerDelete({
      primitiveName: "agent_run_trigger_delete",
      input: { runId },
      actor: { actorType: "user", source: "mcp" }, // no userId
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerDelete>[0])) as {
      error?: string;
    };

    expect(result.error).toBe("unauthorized");
    // Trigger must still exist — the delete was rejected.
    const still = await readRunTriggerByRunId(runId);
    expect(still).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 16) handleAgentRunTriggerDelete — owner deletes their own trigger
  // -------------------------------------------------------------------------
  it("handleAgentRunTriggerDelete as owner removes the trigger row", async () => {
    const ownerId = `user-${randomUUID()}`;
    const runId = await ensureParentRun(ownerId);
    createdRunIds.push(runId);

    await setRunTriggerForActor(ownerActor(ownerId), {
      runId,
      triggerType: "immediate",
    });

    const result = (await handleAgentRunTriggerDelete({
      primitiveName: "agent_run_trigger_delete",
      input: { runId },
      actor: { actorType: "user", source: "mcp", userId: ownerId },
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerDelete>[0])) as {
      ok?: boolean;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const gone = await readRunTriggerByRunId(runId);
    expect(gone).toBeNull();
  });
});

// Touch the mcpActor helper so unused-export linters don't complain in the
// reduced test split (it remains useful for future MCP-shape tests).
void mcpActor;
