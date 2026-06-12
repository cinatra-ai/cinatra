import { describe, it, expect } from "vitest";
import { validateTemplate, validateDraft } from "../spec";
import { RELEASE_TEMPLATE_FIXTURE } from "./fixtures";

// Validation-contract pins over the TEST-OWNED release-template fixture
// (./fixtures). The host-side seed module this file used to exercise is
// retired (cinatra#151 Stage 6) — the extension-owned major-release template
// ships via the major-release-workflow extension's cinatra/workflow.bpmn
// through the workflow-extension install path, and the demo seed
// (scripts/seed.mjs) carries its own presence-conditional fixture copy.
describe("release workflow template fixture (validation contract)", () => {
  it("is template-valid (relative schedules + placeholders, no concrete release)", () => {
    const r = validateTemplate(RELEASE_TEMPLATE_FIXTURE);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it("is NOT draft-valid until instantiated (unfilled placeholder + no release date)", () => {
    const r = validateDraft(RELEASE_TEMPLATE_FIXTURE);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "UNRESOLVED_PLACEHOLDER")).toBe(true);
  });
});
