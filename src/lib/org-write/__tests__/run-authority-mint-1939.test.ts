/**
 * cinatra#1939 S3 — the production run-authority mint for the MCP transport.
 *
 * Pins the fail-closed envelope around `verifyRunAuthority`: a live attempt
 * with a matching claimed id mints a run-scoped authority; EVERY refusal
 * (stale attempt, wrong org, missing run, parked state) and every infra
 * failure reads as `undefined` — an unstamped frame — never a throw that
 * could take the transport down. The agents store is mocked at the module
 * boundary; the deps seam is exercised directly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunRowForOrgWriteAuthority: vi.fn(async () => null),
}));

import { mintRunWriteAuthorityForMcp } from "../run-authority-mint";
import type { RunRowForAuthority, VerifyRunAuthorityDeps } from "../authority";

const NOW = Date.parse("2026-07-24T00:00:00Z");
const FUTURE = new Date(NOW + 60_000).toISOString();

const LIVE_ROW: RunRowForAuthority = {
  orgId: "org-1",
  status: "running",
  executionAttemptId: "attempt-7",
  executionDeadlineAt: FUTURE,
  humanWaitAttemptId: null,
};

function depsFor(row: RunRowForAuthority | null): VerifyRunAuthorityDeps {
  return { readRunRow: async () => row, nowMs: () => NOW };
}

const INPUT = { runId: "run-1", orgId: "org-1", executionAttemptId: "attempt-7" };

describe("mintRunWriteAuthorityForMcp (#1939 S3)", () => {
  it("mints a run-scoped authority for a live attempt with a matching claimed id", async () => {
    const authority = await mintRunWriteAuthorityForMcp(INPUT, depsFor(LIVE_ROW));
    expect(authority).toBeDefined();
    expect(authority?.orgId).toBe("org-1");
    expect(authority?.can("content.write")).toBe(true);
    expect(authority?.can("run.complete")).toBe(true);
    // Run authority NEVER holds management/lifecycle capabilities.
    expect(authority?.can("membership.write")).toBe(false);
    expect(authority?.can("org.lifecycle")).toBe(false);
  });

  it("a STALE claimed attempt reads as undefined (the design-review refusal)", async () => {
    const authority = await mintRunWriteAuthorityForMcp(
      { ...INPUT, executionAttemptId: "attempt-6-stale" },
      depsFor(LIVE_ROW),
    );
    expect(authority).toBeUndefined();
  });

  it("wrong org, missing run, and parked state all read as undefined", async () => {
    expect(
      await mintRunWriteAuthorityForMcp({ ...INPUT, orgId: "org-OTHER" }, depsFor(LIVE_ROW)),
    ).toBeUndefined();
    expect(await mintRunWriteAuthorityForMcp(INPUT, depsFor(null))).toBeUndefined();
    expect(
      await mintRunWriteAuthorityForMcp(
        INPUT,
        depsFor({ ...LIVE_ROW, status: "pending_input" }),
      ),
    ).toBeUndefined();
  });

  it("an infra failure in the row read is fail-closed undefined, never a throw", async () => {
    const deps: VerifyRunAuthorityDeps = {
      readRunRow: async () => {
        throw new Error("connection reset");
      },
      nowMs: () => NOW,
    };
    await expect(mintRunWriteAuthorityForMcp(INPUT, deps)).resolves.toBeUndefined();
  });
});
