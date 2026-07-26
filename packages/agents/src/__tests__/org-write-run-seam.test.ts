/**
 * cinatra#1939 wave 2 — the agent-run org-write seam.
 *
 * Pins the fail-closed envelope of `guardedRunWrite` BEFORE the run-status
 * writer converts onto it (Commit A is dark): no authority, an org mismatch, or
 * a run-scoped authority bound to a DIFFERENT run each refuse before any
 * transaction is opened; a well-formed call opens the kernel guard and runs the
 * body on the guarded tx. The guard's own kernel queries are answered by the
 * kernel test fakes via the seam's TEST-ONLY `db` option (no module mock, no
 * live Postgres).
 */
import { describe, it, expect, vi } from "vitest";
import { fakeOrgWriteDb } from "@cinatra-ai/org-write-kernel/testing";
import {
  AgentRunOrgWriteAuthorityError,
  guardedRunWrite,
} from "../org-write-run-seam";

const ORG = "org-1";
const RUN = "run-1";

/** An active-org fake db whose kernel queries answer "not archived". */
function activeDb() {
  return fakeOrgWriteDb({ organization: { archivedAt: null } });
}

describe("guardedRunWrite fail-closed envelope (#1939 wave 2)", () => {
  it("refuses with reason 'missing' when no authority is threaded", async () => {
    const fn = vi.fn(async () => "unreached");
    await expect(
      guardedRunWrite(
        undefined,
        { orgId: ORG, runId: RUN, capability: "run.execute", db: activeDb().db },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "AgentRunOrgWriteAuthorityError",
      reason: "missing",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses with reason 'org-mismatch' when the authority is for another org", async () => {
    const fn = vi.fn(async () => "unreached");
    const authority = { orgId: "org-OTHER", can: () => true };
    await expect(
      guardedRunWrite(
        authority,
        { orgId: ORG, runId: RUN, capability: "run.execute", db: activeDb().db },
        fn,
      ),
    ).rejects.toMatchObject({ reason: "org-mismatch" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses with reason 'run-mismatch' when a run-scoped authority targets another run", async () => {
    const fn = vi.fn(async () => "unreached");
    // A run/OBO authority carries a runId; it is BOUND to its own run (§1a).
    const authority = { orgId: ORG, runId: "run-OTHER", can: () => true };
    await expect(
      guardedRunWrite(
        authority,
        { orgId: ORG, runId: RUN, capability: "run.complete", db: activeDb().db },
        fn,
      ),
    ).rejects.toMatchObject({ reason: "run-mismatch" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("opens the kernel guard and runs the body on the guarded tx (session/system: no runId)", async () => {
    const fake = activeDb();
    const authority = { orgId: ORG, can: () => true };
    const received: unknown[] = [];
    const result = await guardedRunWrite(
      authority,
      { orgId: ORG, runId: RUN, capability: "run.execute", db: fake.db },
      async (tx) => {
        received.push(tx);
        await tx.execute({ text: "UPDATE agent_runs SET status = 'queued'" });
        return "ok";
      },
    );
    expect(result).toBe("ok");
    expect(received).toHaveLength(1);
    // The writer's own statement landed on the guarded tx (recorded by the fake).
    expect(fake.executed.length).toBeGreaterThan(0);
  });

  it("a run-scoped authority may transition its OWN run (self-binding passes)", async () => {
    const fake = activeDb();
    const authority = { orgId: ORG, runId: RUN, can: () => true };
    const result = await guardedRunWrite(
      authority,
      { orgId: ORG, runId: RUN, capability: "run.complete", db: fake.db },
      async () => "landed",
    );
    expect(result).toBe("landed");
  });

  it("the error class exposes a typed reason", () => {
    expect(new AgentRunOrgWriteAuthorityError("missing").reason).toBe("missing");
    expect(new AgentRunOrgWriteAuthorityError("run-mismatch")).toBeInstanceOf(Error);
  });
});
