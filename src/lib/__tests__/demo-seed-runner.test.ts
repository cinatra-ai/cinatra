/**
 * Pending-demo-seed boot runner (cinatra#1238 item 3). Proves the DI
 * orchestration around `shouldRunDemoSeed`: the cheap env pre-gate, the
 * fact-driven decision, the ATOMIC one-shot claim (exactly-once), the durable
 * completion marker, and net-safe soft-fail — all without a live DB or a child
 * process (the side-effecting deps are faked).
 */
import { describe, it, expect, vi } from "vitest";
import { runPendingDemoSeed, type DemoSeedDeps, type DemoSeedFacts } from "@/lib/demo-seed-runner";

const demoEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test", CINATRA_INSTALL_PROFILE: "demo", ...extra });

const facts = (f: Partial<DemoSeedFacts> = {}): DemoSeedFacts =>
  ({ humanAdminExists: false, alreadySeeded: false, ...f });

/** A deps bag with all side-effecting deps faked; overridable per test. */
const deps = (over: Partial<DemoSeedDeps> = {}): DemoSeedDeps => ({
  readFacts: () => facts({ humanAdminExists: true, alreadySeeded: false }),
  claim: () => true,
  runMonolithicSeed: vi.fn().mockResolvedValue(undefined),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  env: demoEnv(),
  ...over,
});

describe("runPendingDemoSeed — env pre-gate", () => {
  it("skips (no DB read) off a demo profile", async () => {
    const readFacts = vi.fn();
    const claim = vi.fn();
    const runMonolithicSeed = vi.fn();
    const out = await runPendingDemoSeed(deps({
      readFacts, claim, runMonolithicSeed,
      env: { CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test" }, // dev, not demo
    }));
    expect(out).toEqual({ status: "skipped", reason: "not a strict-development demo instance" });
    expect(readFacts).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(runMonolithicSeed).not.toHaveBeenCalled();
  });

  it("skips (no DB read) outside strict-development runtime even when demo", async () => {
    const readFacts = vi.fn();
    const out = await runPendingDemoSeed(deps({
      readFacts,
      env: { CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "demo" },
    }));
    expect(out.status).toBe("skipped");
    expect(readFacts).not.toHaveBeenCalled();
  });
});

describe("runPendingDemoSeed — fact-driven decision", () => {
  it("skips 'awaiting first-human admin' when no human admin exists yet (no claim)", async () => {
    const claim = vi.fn();
    const runMonolithicSeed = vi.fn();
    const out = await runPendingDemoSeed(deps({
      readFacts: () => facts({ humanAdminExists: false, alreadySeeded: false }),
      claim, runMonolithicSeed,
    }));
    expect(out).toEqual({ status: "skipped", reason: "awaiting first-human admin registration" });
    expect(claim).not.toHaveBeenCalled();
    expect(runMonolithicSeed).not.toHaveBeenCalled();
  });

  it("skips 'already seeded' when the completion marker is present (no claim)", async () => {
    const claim = vi.fn();
    const out = await runPendingDemoSeed(deps({
      readFacts: () => facts({ humanAdminExists: true, alreadySeeded: true }),
      claim,
    }));
    expect(out).toEqual({ status: "skipped", reason: "demo dataset already seeded" });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("runPendingDemoSeed — atomic one-shot claim", () => {
  it("seeds + marks completed exactly once when it wins the claim", async () => {
    const runMonolithicSeed = vi.fn().mockResolvedValue(undefined);
    const markCompleted = vi.fn();
    const markFailed = vi.fn();
    const out = await runPendingDemoSeed(deps({
      claim: () => true, runMonolithicSeed, markCompleted, markFailed,
    }));
    expect(out).toEqual({ status: "seeded" });
    expect(runMonolithicSeed).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("skips WITHOUT seeding when it loses the claim (a concurrent boot won)", async () => {
    const runMonolithicSeed = vi.fn();
    const markCompleted = vi.fn();
    const out = await runPendingDemoSeed(deps({
      claim: () => false, runMonolithicSeed, markCompleted,
    }));
    expect(out).toEqual({ status: "skipped", reason: "one-shot not claimable (another boot won, or completed/failed)" });
    expect(runMonolithicSeed).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });
});

describe("runPendingDemoSeed — net-safe soft-fail", () => {
  it("returns an error outcome (never throws) when readFacts throws", async () => {
    const out = await runPendingDemoSeed(deps({
      readFacts: () => { throw new Error("db down"); },
    }));
    expect(out.status).toBe("error");
    expect(out).toMatchObject({ reason: expect.stringContaining("db down") });
  });

  it("returns an error outcome when the claim itself throws", async () => {
    const out = await runPendingDemoSeed(deps({
      claim: () => { throw new Error("claim boom"); },
    }));
    expect(out.status).toBe("error");
    expect(out).toMatchObject({ reason: expect.stringContaining("claim boom") });
  });

  it("releases the claim (markFailed) and errors when the seed dispatch fails", async () => {
    const markFailed = vi.fn();
    const markCompleted = vi.fn();
    const out = await runPendingDemoSeed(deps({
      claim: () => true,
      runMonolithicSeed: () => Promise.reject(new Error("exit 1")),
      markFailed, markCompleted,
    }));
    expect(out.status).toBe("error");
    expect(out).toMatchObject({ reason: expect.stringContaining("exit 1") });
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markCompleted).not.toHaveBeenCalled();
  });
});
