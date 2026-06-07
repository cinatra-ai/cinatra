/**
 * /api/review/merge route tests.
 *
 * Tests the canonical aggregation boundary used by
 * `@cinatra/agent-creation-finalizer`'s merge_review ApiNode. Verifies:
 *
 *   - bridge-token auth (401 on missing/wrong)
 *   - empty / missing inputs handled gracefully (no crash)
 *   - normalizeReviewFindings is applied (LLM blockers downgraded)
 *   - bucket partitioning (blockers / warnings / suggestions)
 *   - response shape: { ok: true, merged: string (JSON) }
 *   - malformed JSON in any lane → synthetic `review_parse_error` warning, no crash
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: vi.fn(),
}));

// Mock @cinatra-ai/agents to avoid pulling in the full barrel (which imports
// @cinatra-ai/objects and other workspace packages not available in the
// host-app vitest runtime). Re-implement `normalizeReviewFindings`,
// `mergeReviewLanes`, and `restampLaneSource` with the same contract so
// the route's normalization is exercised here.
vi.mock("@cinatra-ai/agents", () => {
  const BLOCKER_AUTHORIZED_SOURCES = new Set([
    "agent-lint-policy",
    "deterministic",
  ]);
  const normalizeReviewFindings = (
    findings: Array<{ severity: string; source: string; [k: string]: unknown }>,
  ) =>
    findings.map((f) => {
      if (f.severity === "blocker" && !BLOCKER_AUTHORIZED_SOURCES.has(f.source)) {
        return { ...f, severity: "warning" };
      }
      return f;
    });
  // Mirror the shared helper contract here so the test's mock matches the
  // source-of-truth behavior.
  const restampLaneSource = (
    findings: Array<{ [k: string]: unknown }>,
    laneSource: string,
  ) => findings.map((f) => ({ ...f, source: laneSource }));
  const mergeReviewLanes = (perLane: {
    lintFindings: Array<{ severity: string; source: string; [k: string]: unknown }>;
    securityFindings: Array<{ severity: string; source: string; [k: string]: unknown }>;
    codeFindings: Array<{ severity: string; source: string; [k: string]: unknown }>;
    plannerFindings: Array<{ severity: string; source: string; [k: string]: unknown }>;
  }) => {
    const combined = [
      ...perLane.lintFindings,
      ...perLane.securityFindings,
      ...perLane.codeFindings,
      ...perLane.plannerFindings,
    ];
    const normalized = normalizeReviewFindings(combined);
    const blockers: typeof normalized = [];
    const warnings: typeof normalized = [];
    const suggestions: typeof normalized = [];
    for (const f of normalized) {
      if (f.severity === "blocker") blockers.push(f);
      else if (f.severity === "warning") warnings.push(f);
      else suggestions.push(f);
    }
    return { blockers, warnings, suggestions, findings: normalized };
  };
  return {
    normalizeReviewFindings,
    mergeReviewLanes,
    restampLaneSource,
  };
});

import { POST } from "../route";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";

// Local type alias — avoids pulling the heavy @cinatra-ai/agents barrel into
// the host-app test runtime.
type ReviewFinding = {
  code: string;
  severity: "blocker" | "warning" | "suggestion";
  message: string;
  source: string;
};

const isAuthMock = vi.mocked(isAuthorizedBridgeRequest);

function makeReq(body: unknown): Request {
  return new Request("http://localhost:3000/api/review/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthMock.mockReturnValue(true);
});

describe("POST /api/review/merge — auth", () => {
  it("returns 401 when bridge token check fails", async () => {
    isAuthMock.mockReturnValue(false);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/review/merge — happy path", () => {
  it("returns ok=true + empty bucketed merged for all-empty inputs", async () => {
    const res = await POST(
      makeReq({
        lintFindings: "[]",
        securityFindings: "[]",
        codeFindings: "[]",
        plannerFindings: "[]",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; merged: string };
    expect(body.ok).toBe(true);
    const merged = JSON.parse(body.merged) as {
      blockers: ReviewFinding[];
      warnings: ReviewFinding[];
      suggestions: ReviewFinding[];
      findings: ReviewFinding[];
    };
    expect(merged.blockers).toEqual([]);
    expect(merged.warnings).toEqual([]);
    expect(merged.suggestions).toEqual([]);
    expect(merged.findings).toEqual([]);
  });

  it("partitions findings into blockers/warnings/suggestions buckets", async () => {
    const lintFinding: ReviewFinding = {
      code: "literal_secrets_in_oas",
      severity: "blocker",
      message: "x",
      source: "agent-lint-policy",
    };
    const securityWarning: ReviewFinding = {
      code: "security_x",
      severity: "warning",
      message: "y",
      source: "agent-security-reviewer",
    };
    const codeSuggestion: ReviewFinding = {
      code: "code_x",
      severity: "suggestion",
      message: "z",
      source: "agent-code-reviewer",
    };

    const res = await POST(
      makeReq({
        lintFindings: JSON.stringify([lintFinding]),
        securityFindings: JSON.stringify([securityWarning]),
        codeFindings: JSON.stringify([codeSuggestion]),
        plannerFindings: "[]",
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as {
      blockers: ReviewFinding[];
      warnings: ReviewFinding[];
      suggestions: ReviewFinding[];
    };
    expect(merged.blockers).toEqual([lintFinding]);
    expect(merged.warnings).toEqual([securityWarning]);
    expect(merged.suggestions).toEqual([codeSuggestion]);
  });
});

describe("POST /api/review/merge — blocker-authority enforcement", () => {
  it("DOWNGRADES an LLM helper's blocker to warning (defense-in-depth)", async () => {
    // agent-code-reviewer emits a blocker — but it's NOT in
    // BLOCKER_AUTHORIZED_SOURCES, so normalizeReviewFindings downgrades it.
    const llmBlocker: ReviewFinding = {
      code: "i_decided_this_is_bad",
      severity: "blocker",
      message: "code reviewer was opinionated",
      source: "agent-code-reviewer",
    };
    const res = await POST(
      makeReq({
        lintFindings: "[]",
        securityFindings: "[]",
        codeFindings: JSON.stringify([llmBlocker]),
        plannerFindings: "[]",
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as {
      blockers: ReviewFinding[];
      warnings: ReviewFinding[];
    };
    expect(merged.blockers).toEqual([]);
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0].severity).toBe("warning");
    expect(merged.warnings[0].source).toBe("agent-code-reviewer");
    expect(merged.warnings[0].message).toBe("code reviewer was opinionated");
  });

  it("PRESERVES blockers from agent-lint-policy (authorized source)", async () => {
    const policyBlocker: ReviewFinding = {
      code: "literal_secrets_in_oas",
      severity: "blocker",
      message: "secret",
      source: "agent-lint-policy",
    };
    const res = await POST(
      makeReq({
        lintFindings: JSON.stringify([policyBlocker]),
        securityFindings: "[]",
        codeFindings: "[]",
        plannerFindings: "[]",
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as { blockers: ReviewFinding[] };
    expect(merged.blockers).toEqual([policyBlocker]);
  });

  it("REJECTS source spoofing: a security-lane finding claiming source: 'agent-lint-policy' is re-stamped + downgraded", async () => {
    // A non-policy lane could claim agent-lint-policy authority and emit
    // blockers.
    // The merge endpoint re-stamps source from the LANE identity before
    // normalization, so the spoofed source is overwritten back to
    // 'agent-security-reviewer' and the blocker gets downgraded.
    const spoofed: ReviewFinding = {
      code: "i_pretend_to_be_policy",
      severity: "blocker",
      message: "spoofing attempt",
      source: "agent-lint-policy", // <-- LIE; this is in the security lane
    };
    const res = await POST(
      makeReq({
        lintFindings: "[]",
        securityFindings: JSON.stringify([spoofed]),
        codeFindings: "[]",
        plannerFindings: "[]",
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as {
      blockers: ReviewFinding[];
      warnings: ReviewFinding[];
    };
    // The blocker is downgraded because the lane-stamped source is
    // 'agent-security-reviewer', not 'agent-lint-policy'.
    expect(merged.blockers).toEqual([]);
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0].source).toBe("agent-security-reviewer");
    expect(merged.warnings[0].severity).toBe("warning");
    expect(merged.warnings[0].message).toBe("spoofing attempt");
  });
});

describe("POST /api/review/merge — malformed input handling", () => {
  it("emits a synthetic `review_parse_error` warning when a lane returns non-JSON", async () => {
    const res = await POST(
      makeReq({
        lintFindings: "{ broken json",
        securityFindings: "[]",
        codeFindings: "[]",
        plannerFindings: "[]",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as { warnings: ReviewFinding[] };
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0].code).toBe("review_parse_error");
    expect(merged.warnings[0].source).toBe("agent-lint-policy");
  });

  it("emits a synthetic `review_parse_error` warning when a lane returns a non-array JSON", async () => {
    const res = await POST(
      makeReq({
        lintFindings: "[]",
        securityFindings: '{"not":"an array"}',
        codeFindings: "[]",
        plannerFindings: "[]",
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as { warnings: ReviewFinding[] };
    expect(merged.warnings.some((f) => f.code === "review_parse_error" && f.source === "agent-security-reviewer")).toBe(true);
  });

  it("treats missing lane inputs as empty arrays", async () => {
    // No fields supplied at all — should not crash; merged is fully empty.
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as { findings: ReviewFinding[] };
    expect(merged.findings).toEqual([]);
  });
});

describe("POST /api/review/merge — ordering", () => {
  it("preserves canonical helper order in `findings`: lint, security, code, planner", async () => {
    const lint: ReviewFinding = { code: "a", severity: "suggestion", message: "lint", source: "agent-lint-policy" };
    const security: ReviewFinding = { code: "b", severity: "suggestion", message: "security", source: "agent-security-reviewer" };
    const code: ReviewFinding = { code: "c", severity: "suggestion", message: "code", source: "agent-code-reviewer" };
    const planner: ReviewFinding = { code: "d", severity: "suggestion", message: "planner", source: "agent-planner" };
    const res = await POST(
      makeReq({
        lintFindings: JSON.stringify([lint]),
        securityFindings: JSON.stringify([security]),
        codeFindings: JSON.stringify([code]),
        plannerFindings: JSON.stringify([planner]),
      }),
    );
    const body = (await res.json()) as { merged: string };
    const merged = JSON.parse(body.merged) as { findings: ReviewFinding[] };
    expect(merged.findings).toEqual([lint, security, code, planner]);
  });
});
