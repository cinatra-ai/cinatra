/**
 * Hermetic regression gate for the blog-idea-generator-agent OAS.
 *
 * Loads `extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner — OAS-LLM-001..004)
 *   - scanOasForStartNodeInputsWithoutRequired (required+hidden invariant)
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5.5 LLM pair, that toolboxes is UNDEFINED and hitlScreens
 * declares the context-selector HITL (from @cinatra-ai/context-selection-agent
 * integration — leaves now ship with 1 HITL by design), the single ApiNode
 * targeting templated /api/llm-bridge with SKILL.md auto-discovery (no
 * skill_source_path field), correct StartNode required+hidden coverage
 * (required=['brief'] + hidden=[10 others]), and EndNode shape with 2 outputs
 * (ideas array<object> + notes string) plus correct edge counts (10 DFE + 2 CFE).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/blog-idea-generator-agent-validates.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";
import { expectMessagesMatchAllowlist } from "./__fixtures__/known-broken-agents";

import {
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";

const oasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(oasPath), "..", "package.json"), "utf8"),
) as Record<string, unknown>;

describe("blog-idea-generator-agent OAS validates against L1, LLM-metadata, and required+hidden scanners", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    // The OAS uses a flow-graph `contextSlotBindings` hidden input, so it is
    // fully clean (zero findings) AND mounts in WayFlow. The allowlist is empty;
    // expectMessagesMatchAllowlist therefore asserts the empty set here.
    expectMessagesMatchAllowlist("blog-idea-generator-agent", validateOasAgentJson(oas));
  });

  it("scanOasForLlmMetadata returns [] (no OAS-LLM-001..004 findings)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] (required+hidden invariant covered)", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("declares the locked OpenAI/gpt-5.5 LLM pair in metadata.cinatra.llm (no capabilityRequired)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    const llm = cinatra.llm as Record<string, unknown>;
    expect(llm.preferredProvider).toBe("openai");
    expect(llm.preferredModel).toBe("gpt-5.5");
    expect(llm.capabilityRequired).toBeUndefined();
  });

  it("metadata.cinatra.packageName matches package.json name", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.packageName).toBe("@cinatra-ai/blog-idea-generator-agent");
    expect(cinatra.packageVersion).toBe(pkg.version);
  });

  it("metadata.cinatra.toolboxes is UNDEFINED — legacy MCP injection path (locked decision)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra).not.toHaveProperty("toolboxes");
    expect(cinatra.toolboxes).toBeUndefined();
  });

  it("metadata.cinatra.hitlScreens declares context-selector HITL (from context-selection-agent integration)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/context-selection-agent:context-selector",
    ]);
  });

  it("ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='blog-idea-generator-agent' and no skill_source_path", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-idea-generator-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=['brief'] AND hidden covers 10 other inputs incl. cinatra_run_id, context-slot wiring, contextSlotBindings, and projectId; EndNode declares 2 outputs; 10 DFE + 2 CFE", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["brief"]);
    expect(meta?.hidden).toEqual([
      "audience",
      "count",
      "tone",
      "existingIdeasContext",
      "referenceContent",
      "cinatra_run_id",
      "ideaContextParentPackageName",
      "ideaContextSlotId",
      "projectId",
    ]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const requiredSet = new Set(meta?.required as string[]);
    const hiddenSet = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...requiredSet, ...hiddenSet]);
    expect(union).toEqual(inputTitles);

    // EndNode shape
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o]));
    expect(byTitle.get("ideas")?.type).toBe("array");
    expect(byTitle.get("notes")?.type).toBe("string");

    // Edge counts
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(14);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(3);
  });
});
