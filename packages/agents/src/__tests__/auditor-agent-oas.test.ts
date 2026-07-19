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

  it("control_flow_connections wire the conditional-trigger graph: start -> resolve_skills -> run_skills -> edited_gate; edited_gate branches review -> prep_list ... apply_patches -> end and default -> end", () => {
    // cinatra#1625 (owner ruled flow entry 109, 2026-07-19): run_skills feeds
    // an `edited_gate` BranchingNode; the review path (prep_list -> review_gate
    // -> apply_exclusions -> apply_patches) fires only when the user applied
    // changes (edited="edited"), and a "clean" run routes default -> end.
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      control_flow_connections?: Array<{
        from_node?: { $component_ref?: string };
        to_node?: { $component_ref?: string };
        from_branch?: string;
      }>;
    };
    const edges = (oas.control_flow_connections ?? []).map((e) => [
      e.from_node?.$component_ref,
      e.to_node?.$component_ref,
    ]);
    const expected: Array<[string, string]> = [
      ["start", "resolve_skills"],
      ["resolve_skills", "run_skills"],
      ["run_skills", "edited_gate"],
      ["edited_gate", "prep_list"],
      ["edited_gate", "end"],
      ["prep_list", "review_gate"],
      ["review_gate", "apply_exclusions"],
      ["apply_exclusions", "apply_patches"],
      ["apply_patches", "end"],
    ];
    for (const pair of expected) {
      expect(edges).toContainEqual(pair);
    }
  });

  it("edited_gate is a BranchingNode routing edited->review, else default (clean skips the audit HITL)", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      $referenced_components?: Record<
        string,
        { component_type?: string; branches?: string[]; mapping?: Record<string, string> }
      >;
    };
    const gate = oas.$referenced_components?.edited_gate;
    expect(gate?.component_type).toBe("BranchingNode");
    expect(gate?.branches).toContain("default");
    expect(gate?.branches).toContain("review");
    expect(gate?.mapping?.edited).toBe("review");
  });

  it("apply_patches carries parentPackageName for the per-item skill persist", () => {
    const oas = JSON.parse(fs.readFileSync(OAS_PATH, "utf8")) as {
      $referenced_components?: Record<string, { data?: Record<string, unknown> }>;
    };
    const apply = oas.$referenced_components?.apply_patches;
    expect(apply?.data).toHaveProperty("parentPackageName");
  });
});
