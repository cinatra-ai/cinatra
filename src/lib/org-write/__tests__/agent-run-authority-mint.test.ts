/**
 * cinatra#1939 wave 2 — the agent-run system-dispatch mint.
 *
 * Pins the EXACT capability surface of the mint (a widening — e.g. an
 * accidental membership/lifecycle grant — must turn this red) and the §5.6
 * `runId === undefined` invariant for every non-run authority mint: a run-scoped
 * authority carries a runId and is self-bound by the seam (§1a); a session /
 * system authority must NOT, or it would silently subject itself to that
 * self-binding.
 *
 * The authorized-non-member `runManagementAuthority` mint (and its pins) was
 * REMOVED — owner ruling 2026-07-26 (ruling 2): cross-org run management is
 * unsupported.
 */
import { describe, it, expect } from "vitest";
import { ORG_WRITE_CAPABILITIES } from "@cinatra-ai/org-write-kernel";
import type { OrgWriteAuthority, OrgWriteCapability } from "@cinatra-ai/org-write-kernel";
import {
  mintAgentRunExecutionAuthority,
  mintTriggerReleaseAuthority,
  mintContentEditorDispatchAuthority,
} from "../agent-run-authority-mint";
import {
  mintSystemWriteAuthority,
  sessionAuthorityFromResolvedRole,
} from "../authority";

const ORG = "org-1";
const RUN_CAPS: readonly OrgWriteCapability[] = ["run.execute", "run.complete"];

/** Assert `authority` grants EXACTLY `granted` and denies every other kernel
 *  capability — a full-surface pin, not a spot check. */
function expectExactGrant(
  authority: OrgWriteAuthority,
  granted: readonly OrgWriteCapability[],
) {
  for (const cap of ORG_WRITE_CAPABILITIES) {
    expect(authority.can(cap)).toBe(granted.includes(cap));
  }
}

describe("agent-run-dispatch mint wrappers (#1939 wave 2)", () => {
  const wrappers = {
    mintAgentRunExecutionAuthority,
    mintTriggerReleaseAuthority,
    mintContentEditorDispatchAuthority,
  };

  for (const [name, mint] of Object.entries(wrappers)) {
    it(`${name} grants EXACTLY {run.execute, run.complete} and nothing else`, () => {
      const authority = mint(ORG);
      expect(authority.orgId).toBe(ORG);
      expectExactGrant(authority, RUN_CAPS);
    });

    it(`${name} carries NO runId (§5.6 non-run-mint invariant)`, () => {
      expect(mint(ORG).runId).toBeUndefined();
    });
  }

  it("the wrappers mint the SAME purpose as mintSystemWriteAuthority('agent-run-dispatch')", () => {
    const direct = mintSystemWriteAuthority("agent-run-dispatch", ORG);
    expectExactGrant(direct, RUN_CAPS);
    expect(direct.runId).toBeUndefined();
  });
});

describe("§5.6 runId invariant across the non-run mints", () => {
  it("session and system mints all have runId === undefined", () => {
    expect(sessionAuthorityFromResolvedRole(ORG, "member").runId).toBeUndefined();
    expect(mintAgentRunExecutionAuthority(ORG).runId).toBeUndefined();
  });
});
