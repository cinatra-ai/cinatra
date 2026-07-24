/**
 * REAL-STORE integration test for the #1987 answered-gate-submission provenance
 * substrate (F1 deferred from #1960): the single-use, atomically-consumed
 * binding that ties a run-scoped PERSIST primitive's write to the operator's
 * ANSWERED approval-gate submission.
 *
 * Runs against a REAL Redis (REDIS_URL, default the verify-stack 127.0.0.1:6579)
 * — the same substrate the passthrough seam stamps `verifiedSubmissionId` from —
 * so the atomicity/single-use/replay/mismatch guarantees are proven on the store,
 * not a mock. Invoke via `pnpm --filter @cinatra-ai/a2a test:integration`.
 *
 * Coverage maps to the issue ACs:
 *   - AC2 reject arm     : no minted answer ⇒ consume === "absent" (deny).
 *   - AC2 pass arm       : mint(answer) ⇒ consume(same payload) === "consumed".
 *   - AC3 replay         : a second consume of a consumed record === "absent".
 *   - AC3 mutated payload : consume(mutated) === "mismatch" and does NOT burn the
 *                          record — the genuine payload still consumes.
 *   - AC3 different gate  : a record minted for gate T1 is "absent" under gate T2.
 *   - AC3 different run   : a record minted for run A is "absent" under run B.
 *   - AC4                : exercised against BOTH a DESTRUCTIVE (recipient removal)
 *                          and a RECOVERABLE (draft edit) payload shape — the
 *                          binding is payload-agnostic (a shared-seam property).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import {
  rememberAnsweredGateSubmission,
  consumeAnsweredGateSubmission,
  answeredGatePayloadDigest,
} from "../event-log";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6579";

// A raw operator resume payload string, faithful to what the persist seams
// forward VERBATIM as `resumePayloadJson`. Two shapes: RECOVERABLE (#1959 draft
// edit) and DESTRUCTIVE (#1960 recipient removal).
const DRAFT_EDIT_PAYLOAD = JSON.stringify({
  campaignId: "camp-1",
  editedIds: ["d1"],
  drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "REVIEWED SUBJECT", body: "reviewed body" }],
});
const RECIPIENT_REMOVAL_PAYLOAD = JSON.stringify({
  campaignId: "camp-1",
  approvedRecipientIds: ["c-keep"],
  removedRecipients: [{ contactId: "c-drop" }],
});

let redis: IORedis;
let reachable = false;

beforeAll(async () => {
  redis = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.ping();
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
});

// Skip (with a descriptive message) if no Redis is reachable — the integration
// convention. Against the verify stack this always runs.
const d = describe;

d("#1987 answered-gate provenance substrate (real Redis)", () => {
  it("digest is deterministic and payload-sensitive", () => {
    expect(answeredGatePayloadDigest(DRAFT_EDIT_PAYLOAD)).toBe(
      answeredGatePayloadDigest(DRAFT_EDIT_PAYLOAD),
    );
    expect(answeredGatePayloadDigest(DRAFT_EDIT_PAYLOAD)).not.toBe(
      answeredGatePayloadDigest(RECIPIENT_REMOVAL_PAYLOAD),
    );
    // A single-character mutation flips the digest (AC3 mutated-payload basis).
    expect(answeredGatePayloadDigest(DRAFT_EDIT_PAYLOAD)).not.toBe(
      answeredGatePayloadDigest(DRAFT_EDIT_PAYLOAD.replace("reviewed body", "reviewed body!")),
    );
  });

  for (const [shape, payload] of [
    ["RECOVERABLE draft edit (#1959)", DRAFT_EDIT_PAYLOAD],
    ["DESTRUCTIVE recipient removal (#1960)", RECIPIENT_REMOVAL_PAYLOAD],
  ] as const) {
    describe(shape, () => {
      it("rejects a persist with NO minted answer (AC2 reject arm)", async () => {
        if (!reachable) return;
        const runId = `run_${randomUUID()}`;
        const taskId = `task_${randomUUID()}`;
        // Never minted — the gate was not answered.
        expect(await consumeAnsweredGateSubmission(runId, taskId, payload)).toBe("absent");
      });

      it("PASSES the genuine answered path, then REJECTS the replay (AC2 pass + AC3 replay/single-use)", async () => {
        if (!reachable) return;
        const runId = `run_${randomUUID()}`;
        const taskId = `task_${randomUUID()}`;
        await rememberAnsweredGateSubmission(runId, taskId, payload);
        // First consume: the operator answered, the resume carries the exact
        // payload ⇒ authorized exactly once.
        expect(await consumeAnsweredGateSubmission(runId, taskId, payload)).toBe("consumed");
        // Second consume of the same record ⇒ single-use / atomic ⇒ replay denied.
        expect(await consumeAnsweredGateSubmission(runId, taskId, payload)).toBe("absent");
      });

      it("REJECTS a mutated payload WITHOUT burning the genuine answer (AC3 substitution/mutation)", async () => {
        if (!reachable) return;
        const runId = `run_${randomUUID()}`;
        const taskId = `task_${randomUUID()}`;
        await rememberAnsweredGateSubmission(runId, taskId, payload);
        const mutated = payload.replace(/"c(amp)?-?/i, '"TAMPERED-');
        expect(mutated).not.toBe(payload);
        // A tampered payload does not match the operator's answer ⇒ mismatch,
        // and it must NOT consume the record (no DoS on the genuine apply).
        expect(await consumeAnsweredGateSubmission(runId, taskId, mutated)).toBe("mismatch");
        // The genuine payload still consumes exactly once.
        expect(await consumeAnsweredGateSubmission(runId, taskId, payload)).toBe("consumed");
      });

      it("REJECTS provenance presented for a DIFFERENT gate (AC3 non-transferable across gates)", async () => {
        if (!reachable) return;
        const runId = `run_${randomUUID()}`;
        const answeredTask = `task_${randomUUID()}`;
        const otherTask = `task_${randomUUID()}`;
        await rememberAnsweredGateSubmission(runId, answeredTask, payload);
        expect(await consumeAnsweredGateSubmission(runId, otherTask, payload)).toBe("absent");
        // The genuine gate's record is untouched.
        expect(await consumeAnsweredGateSubmission(runId, answeredTask, payload)).toBe("consumed");
      });

      it("REJECTS provenance presented for a DIFFERENT run (AC3 non-transferable across runs)", async () => {
        if (!reachable) return;
        const answeredRun = `run_${randomUUID()}`;
        const otherRun = `run_${randomUUID()}`;
        const taskId = `task_${randomUUID()}`;
        await rememberAnsweredGateSubmission(answeredRun, taskId, payload);
        expect(await consumeAnsweredGateSubmission(otherRun, taskId, payload)).toBe("absent");
        expect(await consumeAnsweredGateSubmission(answeredRun, taskId, payload)).toBe("consumed");
      });
    });
  }
});
