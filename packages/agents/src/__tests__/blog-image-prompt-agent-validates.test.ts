/**
 * Hermetic regression gate for the blog-image-prompt-agent OAS.
 *
 * Loads `extensions/cinatra-ai/blog-image-prompt-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode input coverage invariant)
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5.5 LLM pair, no toolboxes (legacy MCP injection path is not
 * needed — this agent calls no tools), hitlScreens declares the context-selector
 * HITL (from @cinatra-ai/context-selection-agent integration — leaves now ship
 * with 1 HITL by design), the single ApiNode targeting templated
 * /api/llm-bridge with SKILL.md auto-discovery (no skill_source_path field —
 * bridge auto-discovers from agent_id), correct StartNode required+hidden
 * coverage of all 10 inputs, and EndNode shape.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/blog-image-prompt-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/blog-image-prompt-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("blog-image-prompt-agent OAS validates against agent schema and metadata scans", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    // The OAS uses a flow-graph `contextSlotBindings` hidden input, so it is
    // fully clean (zero findings) AND mounts in WayFlow. The allowlist is empty;
    // expectMessagesMatchAllowlist therefore asserts the empty set here.
    expectMessagesMatchAllowlist("blog-image-prompt-agent", validateOasAgentJson(oas));
  });

  it("scanOasForLlmMetadata returns [] (no LLM metadata findings)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] (required+hidden cover all inputs)", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("declares metadata.cinatra.packageName matching the package.json name", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.packageName).toBe("@cinatra-ai/blog-image-prompt-agent");
  });

  it("declares metadata.cinatra.llm = { preferredProvider: 'openai', preferredModel: 'gpt-5.5' } with no extra keys", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    const llm = cinatra.llm as Record<string, unknown>;
    expect(llm).toEqual({
      preferredProvider: "openai",
      preferredModel: "gpt-5.5",
    });
  });

  it("omits metadata.cinatra.toolboxes (no toolboxes — agent calls no tools) and declares hitlScreens with context-selector HITL", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.toolboxes).toBeUndefined();
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/context-selection-agent:context-selector",
    ]);
  });

  it("has exactly one ApiNode targeting templated /api/llm-bridge with SKILL.md auto-discovery (no skill_source_path)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-image-prompt-agent");
    // skill_source_path MUST be omitted — bridge auto-discovers from agent_id
    // via autoDiscoverSkillPath() in src/app/api/llm-bridge/route.ts. Convention:
    //   <installDir>/cinatra/<agent_id>/skills/<agent_id>/SKILL.md
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=['draft'] + hidden covers 9 other inputs incl. cinatra_run_id, context-slot wiring, contextSlotBindings, and projectId; covers all 10 inputs", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["draft"]);
    expect(meta?.hidden).toEqual([
      "count",
      "placements",
      "style",
      "brandKeywords",
      "cinatra_run_id",
      "imagePromptContextParentPackageName",
      "imagePromptContextSlotId",
      "projectId",
    ]);
    const inputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(inputs.map((i) => i.title as string));
    const required = new Set(meta?.required as string[]);
    const hidden = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...required, ...hidden]);
    // required + hidden union covers every StartNode input title (set-equality)
    expect(union).toEqual(inputTitles);
    expect(union.size).toBe(9);
  });

  it("EndNode declares 2 expected outputs (prompts: array, notes: string)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o.type as string]));
    expect(byTitle.get("prompts")).toBe("array");
    expect(byTitle.get("notes")).toBe("string");
    expect(byTitle.size).toBe(2);
  });
});
