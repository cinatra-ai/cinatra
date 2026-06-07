/**
 * auditor-agent oas.json structural contract.
 *
 * This test ensures the auditor agent publishes the canonical OAS shape and
 * mirrors the expected sibling agent layout.
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/auditor-agent-oas.test.ts
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const OAS_PATH = path.join(
  REPO_ROOT,
  "extensions/cinatra-ai/auditor-agent/cinatra/oas.json",
);

describe("auditor-agent oas.json", () => {
  it("oas.json exists at canonical sibling-mirror path", () => {
    expect(fs.existsSync(OAS_PATH)).toBe(true);
  });

  it("parses as JSON", () => {
    const raw = fs.readFileSync(OAS_PATH, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("metadata.cinatra is { type:'flow', packageName:'@cinatra-ai/auditor-agent', hitlScreens:['@cinatra-ai/auditor-agent:review'] }", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      metadata?: { cinatra?: Record<string, unknown> };
    };
    const c = oas.metadata?.cinatra ?? {};
    expect(c.type).toBe("flow");
    expect(c.packageName).toBe("@cinatra-ai/auditor-agent");
    expect(c.hitlScreens).toEqual(["@cinatra-ai/auditor-agent:review"]);
  });

  it("$referenced_components defines start, resolve_skills, run_skills, review_gate, apply_patches, end", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      $referenced_components?: Record<string, unknown>;
    };
    const refs = oas.$referenced_components ?? {};
    for (const key of [
      "start",
      "resolve_skills",
      "run_skills",
      "review_gate",
      "apply_patches",
      "end",
    ]) {
      expect(refs, `expected node ${key}`).toHaveProperty(key);
    }
  });

  it("review_gate is an InputMessageNode with x-renderer='@cinatra-ai/auditor-agent:review'", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      $referenced_components?: Record<string, {
        component_type?: string;
        metadata?: { cinatra?: { inputMessageSchema?: { "x-renderer"?: string } } };
      }>;
    };
    const gate = oas.$referenced_components?.review_gate;
    expect(gate?.component_type).toBe("InputMessageNode");
    expect(
      gate?.metadata?.cinatra?.inputMessageSchema?.["x-renderer"],
    ).toBe("@cinatra-ai/auditor-agent:review");
  });

  it("control_flow_connections form a linear chain start -> resolve_skills -> run_skills -> review_gate -> apply_patches -> end", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      control_flow_connections?: Array<{
        from_node?: { $component_ref?: string };
        to_node?: { $component_ref?: string };
      }>;
    };
    const edges = (oas.control_flow_connections ?? []).map((e) => [
      e.from_node?.$component_ref,
      e.to_node?.$component_ref,
    ]);
    const expected: Array<[string, string]> = [
      ["start", "resolve_skills"],
      ["resolve_skills", "run_skills"],
      ["run_skills", "review_gate"],
      ["review_gate", "apply_patches"],
      ["apply_patches", "end"],
    ];
    for (const pair of expected) {
      expect(edges).toContainEqual(pair);
    }
  });
});
