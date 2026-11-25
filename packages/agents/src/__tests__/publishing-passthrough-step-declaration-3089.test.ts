// cinatra#3089: a direct passthrough ApiNode that is a top-level publishing step (metadata.cinatra.publishes: true)
// declares exactly the tool its request names (its literal `data.tool`) to the shared step-tool reader
// (findStepToolDeclaration), so the single-use consumption of the person's decision can admit its call. A templated or
// malformed tool name, a passthrough node that does not publish and one that is not top-level declare nothing. And the
// run's bound source, not the live template, answers whether a step is a publishing step (isTopLevelPublishingStep).
// red-first-expect: isTopLevelPublishingStep is not a function
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import * as invariants from "../validate-oas-runtime-invariants";
import { collectPublishingSteps } from "../oas-compiler";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../../../scripts/ci/__tests__/__fixtures__/pin-advance-host-tools/publishing-step-declared-tool.oas.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown> & { $referenced_components: Record<string, Record<string, unknown>> };
const SEND = "email_outreach_send_initial_start";
const STEP = "send_campaign";

const withNode = (patch: (node: Record<string, unknown>) => void) => {
  const doc = structuredClone(FIXTURE);
  patch(doc.$referenced_components[STEP]!);
  return doc;
};
const isTopLevelPublishingStep = (doc: unknown, stepId: string): boolean =>
  (invariants as unknown as { isTopLevelPublishingStep: (d: unknown, s: string) => boolean }).isTopLevelPublishingStep(doc, stepId);

describe("a top-level publishing passthrough ApiNode", () => {
  it("declares exactly the tool its request names", () => {
    // red-first-expect: expected { kind: 'undeclared' } to deeply equal { kind: 'declared'
    expect(invariants.findStepToolDeclaration(FIXTURE, STEP)).toEqual({ kind: "declared", tools: [SEND] });
  });

  it.each([
    ["a templated tool name", (n: Record<string, unknown>) => { (n.data as Record<string, unknown>).tool = "{{ tool }}"; }],
    ["a tool name with upper-case letters", (n: Record<string, unknown>) => { (n.data as Record<string, unknown>).tool = "Email_send"; }],
    ["a tool name with whitespace", (n: Record<string, unknown>) => { (n.data as Record<string, unknown>).tool = "email send"; }],
    ["no tool name", (n: Record<string, unknown>) => { delete (n.data as Record<string, unknown>).tool; }],
    ["a node that does not publish", (n: Record<string, unknown>) => { n.metadata = { cinatra: { publishes: false } }; }],
    ["a node with no publishing flag", (n: Record<string, unknown>) => { delete n.metadata; }],
    ["a node of another route", (n: Record<string, unknown>) => { n.url = "{{CINATRA_BASE_URL}}/api/agents/other"; }],
    ["a node whose own id is not the step", (n: Record<string, unknown>) => { n.id = "another_id"; }],
  ])("declares nothing for %s", (_label, patch) => {
    expect(invariants.findStepToolDeclaration(withNode(patch), STEP)).toEqual({ kind: "undeclared" });
  });

  it("declares nothing when the node is not listed among the flow's top-level nodes", () => {
    const doc = structuredClone(FIXTURE);
    doc.nodes = [];
    expect(invariants.findStepToolDeclaration(doc, STEP)).toEqual({ kind: "undeclared" });
  });

  it("a model-bridge step's declaration is read as before", () => {
    const doc = structuredClone(FIXTURE);
    doc.$referenced_components.think = { component_type: "ApiNode", id: "think", url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      metadata: { cinatra: { tools: ["objects_list"] } } };
    (doc.nodes as unknown[]).push({ $component_ref: "think" });
    expect(invariants.findStepToolDeclaration(doc, "think")).toEqual({ kind: "declared", tools: ["objects_list"] });
  });
});

describe("isTopLevelPublishingStep", () => {
  it("is true for a top-level node of an action kind that declares publishes: true", () => {
    expect(isTopLevelPublishingStep(FIXTURE, STEP)).toBe(true);
  });

  it("is false for a node that does not publish, one not listed at the top level, an unknown step and no document", () => {
    expect(isTopLevelPublishingStep(withNode((n) => { n.metadata = { cinatra: { publishes: "true" } }; }), STEP)).toBe(false);
    expect(isTopLevelPublishingStep(withNode((n) => { n.component_type = "InputMessageNode"; }), STEP)).toBe(false);
    expect(isTopLevelPublishingStep({ ...structuredClone(FIXTURE), nodes: [] }, STEP)).toBe(false);
    expect(isTopLevelPublishingStep(FIXTURE, "renamed_step")).toBe(false);
    expect(isTopLevelPublishingStep(null, STEP)).toBe(false);
  });
});

// ONE table of cases for the three places that decide whether a node is a publishing step whose call the passthrough
// route serves: the run's source (isTopLevelPublishingStep, findStepToolDeclaration, here), the compile
// (collectPublishingSteps, here) and the pin check of the pack (scripts/ci/pin-advance-host-tools.mjs, which is a
// plain script and cannot import this module: scripts/ci/__tests__/pin-advance-host-tools.test.mjs runs the same table).
type StepCase = {
  name: string; stepId: string; isPublishingStep: boolean; servedTool: string | null;
  compile: "ok-step" | "ok-no-step" | "refused"; document: Record<string, unknown>;
};
const CASES = (JSON.parse(
  readFileSync(
    new URL("../../../../scripts/ci/__tests__/__fixtures__/pin-advance-host-tools/publishing-step-cases.json", import.meta.url),
    "utf8",
  ),
) as { cases: StepCase[] }).cases;

describe("the shared table of publishing-step cases", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("the run's source reads the step as the table says: %s", (_name, c) => {
    // red-first-expect: expected true to be false
    expect(isTopLevelPublishingStep(c.document, c.stepId)).toBe(c.isPublishingStep);
    expect(invariants.findStepToolDeclaration(c.document, c.stepId)).toEqual(
      c.servedTool === null ? { kind: "undeclared" } : { kind: "declared", tools: [c.servedTool] },
    );
  });

  it.each(CASES.map((c) => [c.name, c] as const))("the compile reads the step as the table says: %s", (_name, c) => {
    // red-first-expect: expected true to be false
    const read = collectPublishingSteps(c.document);
    expect(read.ok).toBe(c.compile !== "refused");
    if (read.ok) expect(read.steps).toEqual(c.compile === "ok-step" ? [c.stepId] : []);
  });

  it("the compile names the key and the id of a publishing node whose key is not its id", () => {
    // red-first-expect: expected true to be false
    const doc = CASES.find((c) => c.name === "a node whose component key differs from its id")!.document;
    const read = collectPublishingSteps(doc);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toMatch(/^PUBLISHES_ID_MISMATCH: /);
      expect(read.error).toContain('"key_a"');
      expect(read.error).toContain('"send"');
    }
  });
});
