/**
 * Blocker-authority schema enforcement.
 *
 * `normalizeReviewFindings` downgrades `severity: "blocker"` to "warning"
 * for any finding whose `source` is not in `BLOCKER_AUTHORIZED_SOURCES`.
 * Per the all-agents review architecture: only `agent-lint-policy` (and
 * the legacy `deterministic` source it subsumes during migration) is
 * authorized to hard-gate publish. LLM helpers (`agent-planner`,
 * `agent-security-reviewer`, `agent-code-reviewer`) are advisory.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeReviewFindings,
  BLOCKER_AUTHORIZED_SOURCES,
  type ReviewFinding,
} from "../validate-agent-json";

const policyBlocker: ReviewFinding = {
  code: "literal_secrets_in_oas",
  severity: "blocker",
  message: "Literal API key in ApiNode.data.headers.Authorization",
  source: "agent-lint-policy",
};

const deterministicBlocker: ReviewFinding = {
  code: "untrusted_external_url",
  severity: "blocker",
  message: "http:// URL on MCPToolBox.transport_url",
  source: "deterministic",
};

const codeReviewerBlocker: ReviewFinding = {
  code: "i_decided_this_is_bad",
  severity: "blocker",
  message: "Code reviewer LLM emitted a blocker on subjective grounds",
  source: "agent-code-reviewer",
};

const codeReviewerWarning: ReviewFinding = {
  code: "consider_renaming",
  severity: "warning",
  message: "Code reviewer suggests rename",
  source: "agent-code-reviewer",
};

describe("normalizeReviewFindings — blocker authority enforcement", () => {
  it("preserves blocker severity for agent-lint-policy source", () => {
    const result = normalizeReviewFindings([policyBlocker]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
    expect(result[0].source).toBe("agent-lint-policy");
  });

  it("preserves blocker severity for legacy deterministic source", () => {
    // Migration: until publish/compile inline-lint is fully moved into the
    // policy agent, "deterministic" remains authorized to emit blockers.
    const result = normalizeReviewFindings([deterministicBlocker]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("blocker");
  });

  it("DOWNGRADES blocker severity for LLM helper source (agent-code-reviewer)", () => {
    const result = normalizeReviewFindings([codeReviewerBlocker]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("warning");
    expect(result[0].source).toBe("agent-code-reviewer");
    // Other fields preserved
    expect(result[0].code).toBe("i_decided_this_is_bad");
    expect(result[0].message).toBe(codeReviewerBlocker.message);
  });

  it("DOWNGRADES blocker severity for agent-planner / agent-security-reviewer sources", () => {
    const findings: ReviewFinding[] = [
      { code: "x", severity: "blocker", message: "planner block", source: "agent-planner" },
      { code: "y", severity: "blocker", message: "security block", source: "agent-security-reviewer" },
    ];
    const result = normalizeReviewFindings(findings);
    expect(result[0].severity).toBe("warning");
    expect(result[1].severity).toBe("warning");
  });

  it("does not touch warning/suggestion severity regardless of source", () => {
    const result = normalizeReviewFindings([
      codeReviewerWarning,
      { code: "x", severity: "suggestion", message: "x", source: "agent-security-reviewer" },
    ]);
    expect(result[0].severity).toBe("warning");
    expect(result[1].severity).toBe("suggestion");
  });

  it("preserves mixed-source ordering and unchanged findings", () => {
    const findings: ReviewFinding[] = [
      policyBlocker,
      codeReviewerBlocker, // → warning
      codeReviewerWarning, // unchanged
      deterministicBlocker, // preserved
    ];
    const result = normalizeReviewFindings(findings);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(policyBlocker);
    expect(result[1].severity).toBe("warning"); // downgraded
    expect(result[2]).toEqual(codeReviewerWarning);
    expect(result[3]).toEqual(deterministicBlocker);
  });

  it("BLOCKER_AUTHORIZED_SOURCES exports the canonical allowlist", () => {
    expect(BLOCKER_AUTHORIZED_SOURCES.has("agent-lint-policy")).toBe(true);
    expect(BLOCKER_AUTHORIZED_SOURCES.has("deterministic")).toBe(true);
    expect(BLOCKER_AUTHORIZED_SOURCES.has("agent-code-reviewer")).toBe(false);
    expect(BLOCKER_AUTHORIZED_SOURCES.has("agent-security-reviewer")).toBe(false);
    expect(BLOCKER_AUTHORIZED_SOURCES.has("agent-planner")).toBe(false);
  });

  it("returns an empty array unchanged", () => {
    expect(normalizeReviewFindings([])).toEqual([]);
  });
});
