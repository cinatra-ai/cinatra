// Per-agent execution-config VIEW MODEL (exec-plane S3 slice B, cinatra#1708).
//
// The rules under test are the ones a surface gets silently wrong: whether the
// editor is live, and whether the surface tells the truth about a plane that is
// switched OFF today.

import { describe, it, expect } from "vitest";

import {
  buildAgentExecutionConfigView,
  describeExecutionPlaneDormancy,
  postureFromStored,
  EXECUTION_MANAGER_FIELDS,
} from "@/lib/execution/agent-execution-config-view";

const base = {
  packageName: "@cinatra-ai/some-agent",
  displayName: "Some Agent",
  templateId: "t_1",
  serviceState: "disabled" as const,
};

describe("dormancy is stated, never faked", () => {
  it("marks the DEFAULT posture (plane off) dormant and matches the run seam's REFUSAL, not a downgrade", () => {
    const d = describeExecutionPlaneDormancy("disabled");
    expect(d.dormant).toBe(true);
    expect(d.headline).toMatch(/off on this instance/i);
    // The run seam REFUSES a declared-env run while the plane is disabled
    // (resolveRunExecutionBinding), so the copy must say so — an earlier
    // "runs continue on the base image" line contradicted the code (codex
    // round-1 finding c1).
    expect(d.detail).toMatch(/refused/i);
    expect(d.detail).toMatch(/declare none are unaffected/i);
    expect(d.detail).not.toMatch(/runs continue on the platform base image/i);
  });

  it("marks an opted-in-but-broken plane dormant AND says a declared-env run is refused, not downgraded", () => {
    const d = describeExecutionPlaneDormancy("unavailable");
    expect(d.dormant).toBe(true);
    expect(d.detail).toMatch(/refused/i);
  });

  it("only `ready` is non-dormant", () => {
    expect(describeExecutionPlaneDormancy("ready").dormant).toBe(false);
  });

  it("a dormant plane still SHOWS the declared config — it never hides it", () => {
    const view = buildAgentExecutionConfigView({
      ...base,
      templateEnvironment: { pip: ["pandas"] },
    });
    expect(view.dormancy.dormant).toBe(true);
    expect(view.entryCount).toBe(1);
    expect(view.editorText.pip).toBe("pandas");
    expect(view.editable).toBe(true);
  });
});

describe("editability follows authority (epic D8)", () => {
  it("a manifest-declared environment is READ-ONLY and names the review path", () => {
    const view = buildAgentExecutionConfigView({
      ...base,
      manifestEnvironment: { os: ["pandoc"] },
    });
    expect(view.authority).toBe("manifest");
    expect(view.editable).toBe(false);
    expect(view.readOnlyReason).toMatch(/review and lock choreography/i);
  });

  it("an unreadable manifest fails CLOSED to read-only AND to an UNKNOWN (not empty) declaration", () => {
    const view = buildAgentExecutionConfigView({ ...base, manifestReadFailed: true });
    expect(view.editable).toBe(false);
    expect(view.readOnlyReason).toMatch(/could not be read/i);
    expect(view.spec).toBeNull();
    expect(view.empty).toBe(false);
    expect(view.errors.join(" ")).toMatch(/UNKNOWN/);
  });

  it("no template row ⇒ nothing editable here", () => {
    const view = buildAgentExecutionConfigView({ ...base, templateId: null });
    expect(view.editable).toBe(false);
    expect(view.readOnlyReason).toMatch(/no editable configuration record/i);
  });

  it("an INVALID declaration surfaces its parser errors instead of a salvaged recipe", () => {
    const view = buildAgentExecutionConfigView({
      ...base,
      templateEnvironment: { pip: ["pandas"], nope: [] },
    });
    expect(view.spec).toBeNull();
    expect(view.errors.join(" ")).toMatch(/unknown key "nope"/);
    expect(view.entryCount).toBe(0);
  });
});

describe("posture", () => {
  it("maps the three-valued column onto the three-valued control", () => {
    expect(postureFromStored(null)).toBe("inherit");
    expect(postureFromStored(undefined)).toBe("inherit");
    expect(postureFromStored(true)).toBe("on");
    expect(postureFromStored(false)).toBe("off");
  });

  it("says a dormant plane defers the posture rather than claiming it is live", () => {
    const view = buildAgentExecutionConfigView({ ...base, executionEnabled: true });
    expect(view.posture).toBe("on");
    expect(view.postureSummary).toMatch(/plane is off today/i);
  });

  it("an OFF agent is told it cannot declare an environment", () => {
    const view = buildAgentExecutionConfigView({ ...base, executionEnabled: false });
    expect(view.postureSummary).toMatch(/cannot declare an environment/i);
  });
});

describe("promotion affordance", () => {
  it("renders an honest empty state that BLAMES THE DORMANT PLANE, not the agent", () => {
    const view = buildAgentExecutionConfigView(base);
    expect(view.promotionCandidates).toEqual([]);
    expect(view.promotionEmptyNote).toMatch(/execution plane is off/i);
  });

  it("with the plane ready but nothing observed, the empty note is about frequency", () => {
    const view = buildAgentExecutionConfigView({ ...base, serviceState: "ready" });
    expect(view.promotionEmptyNote).toMatch(/often enough/i);
  });

  it("passes candidates through and drops the empty note", () => {
    const view = buildAgentExecutionConfigView({
      ...base,
      serviceState: "ready",
      promotionCandidates: [
        { manager: "os", packageName: "pandoc", runCount: 6, windowRuns: 10 },
      ],
    });
    expect(view.promotionEmptyNote).toBeNull();
    expect(view.promotionCandidates[0].packageName).toBe("pandoc");
  });
});

describe("manager fields", () => {
  it("covers every manager exactly once, in canonical order", () => {
    expect(EXECUTION_MANAGER_FIELDS.map((f) => f.manager)).toEqual(["npm", "os", "pip"]);
  });

  it("offers starter templates for a fresh declaration", () => {
    const view = buildAgentExecutionConfigView(base);
    expect(view.starterTemplates.length).toBeGreaterThan(1);
  });
});

describe("instance-local declarations are labelled as such", () => {
  it("a PACKAGED agent whose manifest declares none is editable, with the local-addition note", () => {
    const view = buildAgentExecutionConfigView({ ...base, packaged: true });
    expect(view.editable).toBe(true);
    expect(view.localDeclarationNote).toMatch(/instance-local addition/i);
    expect(view.localDeclarationNote).toMatch(/takes over/i);
  });

  it("an in-app (unpackaged) agent carries no local-addition note — the config IS the source", () => {
    const view = buildAgentExecutionConfigView({ ...base, packaged: false });
    expect(view.editable).toBe(true);
    expect(view.localDeclarationNote).toBeNull();
  });

  it("a manifest-declared (read-only) agent never carries the note", () => {
    const view = buildAgentExecutionConfigView({
      ...base,
      packaged: true,
      manifestEnvironment: { os: ["pandoc"] },
    });
    expect(view.localDeclarationNote).toBeNull();
  });
});
