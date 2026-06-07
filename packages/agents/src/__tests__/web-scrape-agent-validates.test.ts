/**
 * Hermetic regression gate for the web-scrape-agent OAS.
 *
 * Loads `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode required-input invariant)
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5 LLM pair, the web_search-only toolbox declaration, the
 * single ApiNode targeting templated /api/llm-bridge with SKILL.md auto-discovery
 * (no skill_source_path field — bridge auto-discovers from agent_id), correct
 * StartNode required+hidden coverage, and EndNode shape.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/web-scrape-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("web-scrape-agent OAS validates against L1, LLM-metadata, and StartNode input scans", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns [] (no OAS-LLM-001..004 findings)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] (invariant covered by required+hidden)", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("declares metadata.cinatra.packageName matching the package.json name", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.packageName).toBe("@cinatra-ai/web-scrape-agent");
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

  it("has exactly one ApiNode targeting templated /api/llm-bridge with SKILL.md auto-discovery (no skill_source_path)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("web-scrape-agent");
    // skill_source_path MUST be omitted — bridge auto-discovers from agent_id
    // via autoDiscoverSkillPath() in src/app/api/llm-bridge/route.ts. Convention:
    //   <installDir>/cinatra/<agent_id>/skills/<agent_id>/SKILL.md
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode declares required=[seedUrls,outputSchema,instructions] + hidden=[maxUrls,followLinks,maxDepth]", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["seedUrls", "outputSchema", "instructions"]);
    expect(meta?.hidden).toEqual(["maxUrls", "followLinks", "maxDepth"]);
  });

  it("EndNode declares the 4 expected outputs (items, sourceUrls, extractionNotes, failures) with correct types", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o.type as string]));
    expect(byTitle.get("items")).toBe("array");
    expect(byTitle.get("sourceUrls")).toBe("array");
    expect(byTitle.get("extractionNotes")).toBe("string");
    expect(byTitle.get("failures")).toBe("array");
  });
});
