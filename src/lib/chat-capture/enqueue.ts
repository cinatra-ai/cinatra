import "server-only";

// Chat-capture detection ENQUEUE (cinatra#1367).
//
// Called fire-and-forget (dynamic import) from upsertChatThreadInDatabase —
// the single persistence chokepoint every chat entry point funnels through
// (browser POST /api/chat/save, packages/chat server actions, the MCP
// chat_thread_send handlers). Hooking beneath all of them gives the #1367
// identity contract for free: the thread id is the persisted row id and the
// turn id is the SAME deterministic injective id the structured
// assistant_turns mirror mints (buildLegacyMirrorTurnId), across every entry
// point, with no client-contract change.
//
// #1216 S2 cutover contract: the AG-UI structured-store persistence path
// REPLACING upsertChatThreadInDatabase must re-hook this enqueue at its own
// persistence chokepoint with a payload carrying the SAME semantics
// (a user turn is enqueued once its content is durably persisted, before or
// regardless of the assistant reply). chat-capture-enqueue-hook.test.ts trips
// if the current hook is dropped without a replacement.
//
// Detection then runs as a background job keyed (thread, turn) — the chat
// request cycle is never involved, so capture survives client disconnect by
// construction (the #1367 timing contract).

import { createHash } from "node:crypto";
import { buildLegacyMirrorTurnId } from "@/lib/project-inheritance";
import { readSkillAutosaveConfig } from "@/lib/skill-autosave";

export type ChatCaptureCandidate = {
  threadId: string;
  turnId: string;
  ownerUserId: string;
};

/**
 * Pure enqueue decision. A thread write yields at most ONE candidate: its
 * LATEST message, and only when that message is a non-empty user turn with a
 * stable id on a personally-owned thread.
 *
 *   - team-owned / unowned threads ⇒ null (no per-user capture target);
 *   - latest message from the assistant ⇒ null (each user turn is enqueued by
 *     the persist that ADDED it; the later assistant-reply persist of the same
 *     thread re-yields the same turn — the deterministic jobId + the ledger
 *     make that a no-op);
 *   - messages without a non-empty string id ⇒ null (the structured mirror
 *     skips them for the same reason — no stable turn identity).
 */
export function selectChatCaptureCandidate(
  thread: { id: string } & Record<string, unknown>,
): ChatCaptureCandidate | null {
  if (typeof thread.id !== "string" || thread.id.length === 0) return null;
  const ownerUserId = thread.ownerUserId;
  if (typeof ownerUserId !== "string" || ownerUserId.length === 0) return null;
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  if (typeof last !== "object" || last === null) return null;
  const msg = last as Record<string, unknown>;
  if (msg.role !== "user") return null;
  if (typeof msg.id !== "string" || msg.id.length === 0) return null;
  if (typeof msg.content !== "string" || msg.content.trim().length === 0) return null;
  return {
    threadId: thread.id,
    turnId: buildLegacyMirrorTurnId(thread.id, msg.id),
    ownerUserId,
  };
}

/** Deterministic BullMQ jobId. Hash-based (not a sanitized turnId) so two
 * DISTINCT turn ids can never collapse onto one jobId after charset
 * sanitization. */
export function buildChatCaptureJobId(candidate: Pick<ChatCaptureCandidate, "threadId" | "turnId">): string {
  const digest = createHash("sha256")
    .update(`${candidate.threadId}\n${candidate.turnId}`)
    .digest("hex")
    .slice(0, 32);
  return `chat-capture-${digest}`;
}

/**
 * Best-effort enqueue of the detection job for a just-persisted thread write.
 * EVERY failure degrades to a warn — the thread persist must never be
 * affected (same contract as the run-autosave arm). Cheap gates only; the
 * per-user preference and all content decisions live in the job handler.
 */
export async function maybeEnqueueChatCaptureForThread(
  thread: { id: string } & Record<string, unknown>,
): Promise<void> {
  try {
    const candidate = selectChatCaptureCandidate(thread);
    if (!candidate) return;

    // Master switch (sync config read; degrade-to-noop on any throw). The
    // handler re-checks — this gate just keeps disabled deployments from
    // paying any queue traffic.
    let enabled = false;
    try {
      enabled = readSkillAutosaveConfig().enabled === true;
    } catch {
      return;
    }
    if (!enabled) return;

    // Registry-free producer (./enqueue-queue) — NOT @/lib/background-jobs.
    // The generic runtime statically imports the background-jobs registry
    // (every job handler: agents/skills/llm/workflows/...); routing this
    // store-graph-reachable hook through it drags that mega-hub into the
    // first-party graph of every store route (/sign-in included) and blows the
    // route-graph ratchet + the Turbopack build memory. The producer lands the
    // job on the SAME queue by name; the boot-started worker drains it.
    const { enqueueChatCaptureDetectionJob } = await import("./enqueue-queue");
    await enqueueChatCaptureDetectionJob(
      {
        threadId: candidate.threadId,
        turnId: candidate.turnId,
        ownerUserId: candidate.ownerUserId,
      },
      {
        jobId: buildChatCaptureJobId(candidate),
        // Transient failures (LLM/provider/Redis hiccups) retry with backoff;
        // the ledger's terminal statuses keep retries idempotent.
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
  } catch (err) {
    console.warn(
      "[chat-capture] enqueue failed (degrading to no-op):",
      err instanceof Error ? err.message : err,
    );
  }
}
