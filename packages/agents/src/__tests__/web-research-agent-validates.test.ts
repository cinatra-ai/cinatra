/**
 * Hermetic regression gate for the web-research-agent OAS.
 *
 * Loads `extensions/cinatra-ai/web-research-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode input coverage invariant)
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5 LLM pair, the web_search-only toolbox declaration, the
 * empty hitlScreens (stateless — no operator gates), the single ApiNode
 * targeting templated /api/llm-bridge with SKILL.md auto-discovery
 * (no skill_source_path field — bridge auto-discovers from agent_id),
 * correct StartNode required+hidden coverage (required=['rows','prompt'] +
 * hidden=['sources','outputSchema']), and EndNode shape with 4 outputs
 * (enrichedRows/extractionNotes/failures/webChecks).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/web-research-agent-validates.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";

const oasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/web-research-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(oasPath), "..", "package.json"), "utf8"),
) as Record<string, unknown>;

describe("web-research-agent OAS validates against L1, LLM-metadata, and StartNode input scans", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns [] (no LLM metadata findings)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] (invariant covered by required+hidden)", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("metadata.cinatra.packageName matches package.json name + packageVersion matches package.json", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.packageName).toBe("@cinatra-ai/web-research-agent");
    expect(cinatra.packageVersion).toBe(pkg.version);
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

  it("declares metadata.cinatra.toolboxes = ['web_search'] (exactly one entry, no MCP server ids)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.toolboxes).toEqual(["web_search"]);
  });

  it("declares metadata.cinatra.hitlScreens = [] (stateless — no operator gates)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.hitlScreens).toEqual([]);
  });

  it("has exactly one ApiNode targeting templated /api/llm-bridge with SKILL.md auto-discovery (no skill_source_path)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("web-research-agent");
    // skill_source_path MUST be omitted — bridge auto-discovers from agent_id
    // via autoDiscoverSkillPath() in src/app/api/llm-bridge/route.ts. Convention:
    //   <installDir>/cinatra/<agent_id>/skills/<agent_id>/SKILL.md
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=['rows','prompt'] AND hidden=['sources','outputSchema'] — covers all 4 inputs", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["rows", "prompt"]);
    expect(meta?.hidden).toEqual(["sources", "outputSchema"]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const requiredSet = new Set(meta?.required as string[]);
    const hiddenSet = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...requiredSet, ...hiddenSet]);
    expect(union).toEqual(inputTitles);
  });

  it("EndNode declares 4 outputs (enrichedRows/extractionNotes/failures/webChecks) AND data_flow_connections.length === 8 AND control_flow_connections.length === 2", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o.type as string]));
    expect(byTitle.get("enrichedRows")).toBe("array");
    expect(byTitle.get("extractionNotes")).toBe("string");
    expect(byTitle.get("failures")).toBe("array");
    expect(byTitle.get("webChecks")).toBe("array");
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(8);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(2);
  });
});
