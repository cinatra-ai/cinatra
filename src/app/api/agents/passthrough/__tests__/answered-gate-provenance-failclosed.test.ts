/**
 * #1987 AC7 — the run-scoped PERSIST seam FAILS CLOSED when the answered-gate
 * provenance store is unreadable (a Redis error), never falling back to a
 * run-frame-only allow.
 *
 * Isolated in its own single-test file: a rejecting mock alongside a prior
 * resolving mock call in the SAME file trips vitest 4's rejection tracker even
 * though the helper's try/catch handles the error — so this one throwing case is
 * kept alone (the resolving/mismatch/absent/frame cases live in
 * ./answered-gate-provenance.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

const consumeMock = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", () => ({ consumeAnsweredGateSubmission: consumeMock }));

import { enforceAnsweredGateProvenance } from "@/app/api/agents/passthrough/answered-gate-provenance";

describe("enforceAnsweredGateProvenance — substrate error (AC7)", () => {
  it("FAILS CLOSED (denies, never a run-frame-only decision) when the provenance store throws", async () => {
    consumeMock.mockRejectedValue(new Error("redis unreadable"));
    let threw: unknown = null;
    let decision: Awaited<ReturnType<typeof enforceAnsweredGateProvenance>> | undefined;
    try {
      decision = await enforceAnsweredGateProvenance({
        tool: "email_outreach_recipients_update",
        runId: "run-1",
        verifiedSubmissionId: "gate-task-1",
        resumePayloadJson: JSON.stringify({ removedRecipients: [{ contactId: "c-1" }] }),
      });
    } catch (e) {
      threw = e;
    }
    // The substrate error is converted to a deny, never propagated.
    expect(threw).toBeNull();
    expect(decision?.ok).toBe(false);
    if (decision && !decision.ok) {
      expect(decision.status).toBe(403);
      expect(decision.error).toMatch(/provenance store is unreadable/i);
    }
  });
});
