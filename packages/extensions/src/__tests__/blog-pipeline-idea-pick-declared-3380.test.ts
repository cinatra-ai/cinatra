/**
 * The blog pipeline's idea step declares its pick for the host's hold
 * (cinatra#3380).
 *
 * cinatra-ai/blog-pipeline-agent#80 declares `"x-required": true`, with no
 * `default`, on the idea gate's pick (`selectedIdeaJson`) in the step's
 * `inputMessageSchema`. A host that reads the hint keeps the step's Continue
 * unavailable until the step's renderer writes a value for the pick that is
 * not blank. The pick stays out of the schema's object-level `required` list,
 * so a list with nothing to pick is still a road out: the renderer answers it
 * with its no-pick value.
 *
 * This gate reads the PINNED tree under `extensions/cinatra-ai`, so it moves
 * only when the lock moves.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai", "blog-pipeline-agent");

type Schema = {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};
type Component = {
  component_type?: string;
  metadata?: { cinatra?: { inputMessageSchema?: Schema } };
};

const oas = JSON.parse(readFileSync(join(PACK, "cinatra", "oas.json"), "utf8")) as {
  $referenced_components?: Record<string, Component>;
};
const gate = oas.$referenced_components?.idea_selection_gate;
const schema = gate?.metadata?.cinatra?.inputMessageSchema;

describe("blog pipeline idea step: the pick is declared for the host's hold (cinatra#3380)", () => {
  it("the idea gate is an input step whose schema has the pick", () => {
    expect(gate?.component_type).toBe("InputMessageNode");
    expect(schema?.properties?.selectedIdeaJson).toBeDefined();
  });

  it('the pick declares "x-required": true and no default', () => {
    const pick = schema?.properties?.selectedIdeaJson ?? {};
    expect(pick["x-required"]).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(pick, "default")).toBe(false);
  });

  it("the pick is the only property of the gate that declares x-required", () => {
    const declared = Object.entries(schema?.properties ?? {})
      .filter(([, property]) => property["x-required"] === true)
      .map(([key]) => key);
    expect(declared).toEqual(["selectedIdeaJson"]);
  });

  it("the pick stays out of the object-level required list", () => {
    expect(schema?.required ?? []).not.toContain("selectedIdeaJson");
  });
});
