/**
 * Hermetic regression gate for the company-discovery-agent OAS.
 *
 * Loads `extensions/cinatra-ai/company-discovery-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner — OAS-LLM-001..004)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode visibility invariant)
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5 LLM pair, that toolboxes is UNDEFINED (locked decision —
 * MCP injection path), the single ApiNode targeting templated /api/llm-bridge
 * with SKILL.md auto-discovery (no skill_source_path field — bridge auto-discovers
 * from agent_id), correct StartNode required+hidden coverage, and EndNode shape.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/company-discovery-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/company-discovery-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("company-discovery-agent OAS validates against L1, LLM metadata, and StartNode visibility checks", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
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
    expect(cinatra.packageName).toBe("@cinatra-ai/company-discovery-agent");
  });

  it("metadata.cinatra.toolboxes is UNDEFINED — MCP injection path is disabled", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra).not.toHaveProperty("toolboxes");
    expect(cinatra.toolboxes).toBeUndefined();
  });

  it("ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='company-discovery-agent' and no skill_source_path", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("company-discovery-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=[] AND hidden covers companyName/domain/apolloLookup/cinatra_run_id (ApiNode loader invariant)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual([]);
    expect(meta?.hidden).toEqual(["companyName", "domain", "apolloLookup", "cinatra_run_id"]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const hiddenSet = new Set(meta?.hidden as string[]);
    expect(hiddenSet).toEqual(inputTitles);
  });

  it("EndNode declares 3 outputs (accountId/wasMerged/apolloOrganizationId) AND data_flow_connections.length === 7 (incl. cinatra_run_id DFE) AND control_flow_connections.length === 2", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o.type as string]));
    expect(byTitle.get("accountId")).toBe("string");
    expect(byTitle.get("wasMerged")).toBe("boolean");
    expect(byTitle.get("apolloOrganizationId")).toBe("string");
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(7);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(2);
  });
});
