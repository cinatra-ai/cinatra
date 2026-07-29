/**
 * End-to-End Round-Trip Integration Test
 *
 * Verifies a full `message/send` round-trip works in-process against a real
 * published Cinatra virtual agent, using the stack:
 *
 *   InProcessTransport
 *     → JsonRpcTransportHandler (from createA2AServerForAgent)
 *     → DefaultRequestHandler
 *     → InProcessAgentExecutor
 *     → Cinatra `agent_runs` table + BullMQ AGENT_BUILDER_EXECUTION worker
 *
 * **REQUIREMENTS TO RUN**
 *   - PostgreSQL reachable via `SUPABASE_DB_URL` (agent_runs, agent_templates).
 *   - Redis reachable via `REDIS_URL` (default redis://127.0.0.1:6379).
 *   - At least one published agent template (packageName set, status='published').
 *   - The Cinatra dev server OR another process running the background worker
 *     for `AGENT_BUILDER_EXECUTION` — this test only *enqueues* jobs; the run
 *     will hang in `queued` indefinitely without a worker.
 *
 * If `SUPABASE_DB_URL` is unset, the entire suite is skipped with a
 * descriptive message. If no published agents exist, individual tests skip.
 *
 * The BullMQ + poll loop + DB round-trip adds latency (500–5000ms typical),
 * so timeouts here are generous.
 */
import { describe, it, expect } from "vitest";
import type { Task } from "@a2a-js/sdk";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { InProcessTransport } from "../in-process-transport";
import {
  createA2AServerForAgent,
  resolveFirstPublishedAgent,
} from "../server";
import type { EnqueueJobFn } from "../agent-executor";
// cinatra#1940 P3: the creation perimeter is now guarded — createAgentRun
// requires a real authority against a real org-write-kernel-managed org row.
// This suite tests A2A protocol round-trip mechanics, not org-write security,
// so a permissive authority preserves this test's pre-existing behavior.
import { createAgentRun } from "@cinatra-ai/agents";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

// ---------------------------------------------------------------------------
// Env guards
// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.SUPABASE_DB_URL);
const QUEUE_NAME = "cinatra-background-jobs";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// cinatra#1940 P3: permissive test authority — this suite's real Postgres
// org row is whatever ambient context resolveFirstPublishedAgent's org ends
// up being; `can: () => true` preserves this test's pre-existing behavior
// (it asserts A2A protocol mechanics, not org-write capability rulings).
async function createRunWithAuthority(
  input: Parameters<typeof createAgentRun>[0],
) {
  const authority: OrgWriteAuthority = { orgId: input.orgId, can: () => true };
  return createAgentRun(input, authority);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTestEnqueueJob(): {
  enqueueJob: EnqueueJobFn;
  close: () => Promise<void>;
} {
  // Use a dedicated IORedis connection configured the way BullMQ requires
  // (maxRetriesPerRequest: null, enableReadyCheck: false).
  const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const queue = new Queue(QUEUE_NAME, { connection });

  const enqueueJob: EnqueueJobFn = async (jobName, data) => {
    await queue.add(jobName, data as Record<string, unknown>);
  };

  const close = async () => {
    await queue.close();
    await connection.quit().catch(() => connection.disconnect());
  };

  return { enqueueJob, close };
}

async function pollUntilTerminal(
  transport: InProcessTransport,
  taskId: string,
  timeoutMs: number,
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const task = await transport.getTask({ id: taskId });
    const state = task.status.state;
    if (
      state === "completed" ||
      state === "failed" ||
      state === "canceled" ||
      state === "rejected"
    ) {
      return task;
    }
    if (Date.now() > deadline) {
      return task;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(
  "A2A round-trip against a real virtual agent",
  () => {
    it("end-to-end: sendMessage → working → terminal lifecycle", async () => {
      let templateId: string;
      let packageName: string;
      try {
        ({ templateId, packageName } = await resolveFirstPublishedAgent());
      } catch (err) {
        console.warn(
          `Skipping — no published agent template: ${(err as Error).message}`,
        );
        return;
      }

      const { enqueueJob, close } = buildTestEnqueueJob();
      try {
        const bundle = createA2AServerForAgent({
          templateId,
          packageName,
          enqueueJob,
          createRunWithAuthority,
          pollIntervalMs: 500,
          pollTimeoutMs: 60_000,
        });
        const transport = new InProcessTransport(
          bundle.handler,
          bundle.agentCard,
        );

        // Fire-and-retrieve — use blocking=false so sendMessage returns on the
        // initial Task (working/submitted) without waiting for the whole run.
        const initial = (await transport.sendMessage({
          message: {
            kind: "message",
            role: "user",
            messageId: crypto.randomUUID(),
            parts: [
              { kind: "text", text: JSON.stringify({ prompt: "test ping" }) },
            ],
          },
          configuration: { blocking: false } as never,
        })) as Task;

        expect(initial).toBeDefined();
        expect((initial as { kind: string }).kind).toBe("task");
        expect(initial.id).toBeTruthy();
        expect(
          ["submitted", "working", "completed", "failed"].includes(
            initial.status.state,
          ),
        ).toBe(true);

        // (Lifecycle) immediately after sendMessage, a getTask must return a
        // valid task in a known state — working, submitted, or terminal.
        const immediate = await transport.getTask({ id: initial.id });
        expect(
          ["submitted", "working", "completed", "failed", "canceled"].includes(
            immediate.status.state,
          ),
        ).toBe(true);

        // Poll to a terminal state (or time out at 60s).
        const terminal = await pollUntilTerminal(transport, initial.id, 60_000);

        // The run must reach a terminal state. `completed` with artifacts is
        // the happy path; `failed` is acceptable here because the agent may
        // not have a valid config — what we're asserting is that the A2A
        // lifecycle *completed*, not that the agent succeeded.
        expect(
          ["completed", "failed", "canceled"].includes(terminal.status.state),
        ).toBe(true);

        if (terminal.status.state === "completed") {
          // Artifacts should have been published.
          expect(terminal.artifacts?.length ?? 0).toBeGreaterThan(0);
        }
      } finally {
        await close();
      }
    }, 90_000);

    it("concurrent soak: 10 parallel tasks all reach terminal state", async () => {
      let templateId: string;
      let packageName: string;
      try {
        ({ templateId, packageName } = await resolveFirstPublishedAgent());
      } catch {
        return;
      }

      const { enqueueJob, close } = buildTestEnqueueJob();
      try {
        const bundle = createA2AServerForAgent({
          templateId,
          packageName,
          enqueueJob,
          createRunWithAuthority,
          pollIntervalMs: 500,
          pollTimeoutMs: 120_000,
        });
        const transport = new InProcessTransport(
          bundle.handler,
          bundle.agentCard,
        );

        // Basic leak-check prelude
        if (global.gc) global.gc();
        const heapBefore = process.memoryUsage().heapUsed;

        // Fire 10 parallel sendMessage calls.
        const sends = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            transport.sendMessage({
              message: {
                kind: "message",
                role: "user",
                messageId: crypto.randomUUID(),
                parts: [
                  {
                    kind: "text",
                    text: JSON.stringify({ prompt: `soak test ${i}` }),
                  },
                ],
              },
              configuration: { blocking: false } as never,
            }),
          ),
        );

        const tasks = sends.map((r) => r as Task);
        const taskIds = tasks.map((t) => t.id);

        // No duplicates.
        expect(new Set(taskIds).size).toBe(taskIds.length);

        // Poll each to terminal state with a 120s overall cap.
        const terminals = await Promise.all(
          taskIds.map((id) => pollUntilTerminal(transport, id, 120_000)),
        );

        // All 10 must reach a terminal state — no stuck tasks.
        for (const t of terminals) {
          expect(
            ["completed", "failed", "canceled", "rejected"].includes(
              t.status.state,
            ),
          ).toBe(true);
        }

        // Leak-check postlude.
        if (global.gc) global.gc();
        const heapAfter = process.memoryUsage().heapUsed;
        const deltaMb = (heapAfter - heapBefore) / 1024 / 1024;
        console.log(
          `heap delta after 10-task soak: ${deltaMb.toFixed(2)} MB`,
        );
        // Generous threshold — this is a smoke check, not a hard gate.
        expect(deltaMb).toBeLessThan(50);

        // Task store sanity — we enqueued exactly 10 tasks, the in-memory
        // store should hold at most 10 entries for this bundle.
        // (DefaultRequestHandler drives InMemoryTaskStore, which keeps one
        // entry per taskId.) Verify no runaway growth.
        const storeSize = await (async () => {
          // InMemoryTaskStore exposes `save`/`load` but not size; probe by
          // loading each taskId and counting hits.
          let hits = 0;
          for (const id of taskIds) {
            const loaded = await bundle.taskStore.load(id);
            if (loaded) hits += 1;
          }
          return hits;
        })();
        expect(storeSize).toBe(taskIds.length);
      } finally {
        await close();
      }
    }, 180_000);
  },
);
