import { describe, expect, it, vi } from "vitest";

import { runBootPhase, type BootPhaseResult } from "@/lib/boot/boot-phase";

// ---------------------------------------------------------------------------
// Boot-phase policy runner (engineering #302). The runner records each outcome
// and applies the declared failure POLICY on a throw:
//   - fatal              -> record failed, RETHROW (aborts boot)
//   - retryable/degraded -> record failed, log, SWALLOW (boot continues)
//   - dev-only           -> record failed, log, SWALLOW
// A returned `{ skipped }` is recorded as `skipped` (no error). The runner never
// decides dev-vs-prod fatality — a phase keeps that inside its `run` body.
// ---------------------------------------------------------------------------

function deps() {
  const records: BootPhaseResult[] = [];
  return {
    records,
    record: (r: BootPhaseResult) => records.push(r),
    logError: vi.fn(),
    now: () => 1000,
  };
}

describe("runBootPhase", () => {
  it("records 'ok' when the phase body resolves", async () => {
    const d = deps();
    const r = await runBootPhase({ name: "p", policy: "retryable", run: async () => {} }, d);
    expect(r.status).toBe("ok");
    expect(d.records).toHaveLength(1);
    expect(d.records[0]).toMatchObject({ name: "p", policy: "retryable", status: "ok" });
  });

  it("records 'skipped' with the reason when the body returns { skipped }", async () => {
    const d = deps();
    const r = await runBootPhase(
      { name: "p", policy: "retryable", run: () => ({ skipped: "disabled via KILL_SWITCH" }) },
      d,
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("disabled via KILL_SWITCH");
  });

  it("RETHROWS for a fatal phase that throws (aborts boot) and records failed", async () => {
    const d = deps();
    await expect(
      runBootPhase(
        { name: "core-migrations", policy: "fatal", run: async () => { throw new Error("half-migrated"); } },
        d,
      ),
    ).rejects.toThrow("half-migrated");
    expect(d.records[0]).toMatchObject({ name: "core-migrations", policy: "fatal", status: "failed", reason: "half-migrated" });
    expect(d.logError).toHaveBeenCalled();
  });

  it.each(["retryable", "degraded", "dev-only"] as const)(
    "SWALLOWS for a %s phase that throws (boot continues) and records failed",
    async (policy) => {
      const d = deps();
      const r = await runBootPhase(
        { name: "p", policy, run: async () => { throw new Error("redis down"); } },
        d,
      );
      expect(r.status).toBe("failed");
      expect(r.reason).toBe("redis down");
      expect(d.logError).toHaveBeenCalled();
    },
  );

  it("stringifies a non-Error throw reason", async () => {
    const d = deps();
    const r = await runBootPhase(
      { name: "p", policy: "retryable", run: async () => { throw "string boom"; } },
      d,
    );
    expect(r.reason).toBe("string boom");
  });
});
