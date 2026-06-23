/**
 * Hermetic regression gate for the apollo-prospecting-agent OAS.
 *
 * Loads `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json` from
 * disk and asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (OAS-LLM-001..004 scanner)
 *   - scanOasForStartNodeInputsWithoutRequired
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5.5 LLM pair, that toolboxes is UNDEFINED (legacy MCP
 * injection path — chat-allowlist-style), the single ApiNode targeting
 * templated /api/llm-bridge with SKILL.md auto-discovery (no
 * skill_source_path field), correct StartNode required+hidden coverage
 * (required=['organizationDomains'] + hidden=[4 others]), and EndNode shape.
 *
 * Modeled byte-equal on contact-discovery-agent-validates.test.ts; both
 * agents are pure leaf flows wrapping a single LLM-bridge ApiNode.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/apollo-prospecting-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("apollo-prospecting-agent OAS validates against L1, LLM-metadata, and StartNode required-input scans", () => {
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

  it("declares the OpenAI/gpt-5.5 LLM pair in metadata.cinatra.llm (no capabilityRequired)", () => {
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
    expect(cinatra.packageName).toBe("@cinatra-ai/apollo-prospecting-agent");
  });

  it("metadata.cinatra.toolboxes is UNDEFINED — legacy MCP injection path", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra).not.toHaveProperty("toolboxes");
    expect(cinatra.toolboxes).toBeUndefined();
  });

  it("ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='apollo-prospecting-agent' and no skill_source_path", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("apollo-prospecting-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=['organizationDomains'] AND hidden covers titlePatterns/maxPersons/listId/cinatra_run_id", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["organizationDomains"]);
    expect(meta?.hidden).toEqual([
      "titlePatterns",
      "maxPersons",
      "listId",
      "cinatra_run_id",
    ]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const requiredSet = new Set(meta?.required as string[]);
    const hiddenSet = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...requiredSet, ...hiddenSet]);
    expect(union).toEqual(inputTitles);
  });

  it("EndNode declares 5 outputs (accountIds/contactIds/apolloHitCount/addedToList/failures) with array.items typing + data_flow_connections.length === 10 (incl. cinatra_run_id DFE) AND control_flow_connections.length === 2", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o]));
    expect(byTitle.get("accountIds")?.type).toBe("array");
    expect(byTitle.get("contactIds")?.type).toBe("array");
    expect(byTitle.get("apolloHitCount")?.type).toBe("integer");
    expect(byTitle.get("addedToList")?.type).toBe("integer");
    expect(byTitle.get("failures")?.type).toBe("array");
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(10);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(2);
  });
});
