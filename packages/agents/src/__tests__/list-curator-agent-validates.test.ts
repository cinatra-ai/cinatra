/**
 * Hermetic regression gate for the list-curator-agent OAS.
 *
 * Loads `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson L1 validator
 *   - scanOasForLlmMetadata scanner — OAS-LLM-001..004
 *   - scanOasForStartNodeInputsWithoutRequired invariant
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5 LLM pair, that toolboxes is UNDEFINED (locked decision —
 * legacy MCP injection path), the 3 ApiNodes (propose, collect, create) each
 * targeting templated /api/llm-bridge with SKILL.md auto-discovery (no
 * skill_source_path field), correct StartNode required+hidden coverage
 * (required=[the 4 fields a person supplies] + hidden=['cinatra_run_id']),
 * the 2 hitlScreens (scrape-schema-review + final-list-review), and EndNode
 * shape with 7 outputs whose inputs equal its outputs (the L1 EndNode
 * invariant the pack's own fix restored).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-curator-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/list-curator-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("list-curator-agent OAS validates against L1 validator + LLM-metadata scanner + StartNode input coverage scan", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns [] (no OAS-LLM-001..004 findings)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] (required+hidden cover all StartNode inputs)", () => {
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
    expect(cinatra.packageName).toBe("@cinatra-ai/list-curator-agent");
  });

  it("metadata.cinatra.hitlScreens declares the 2 list-curator gate ids in the locked order", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/list-curator-agent:scrape-schema-review",
      "@cinatra-ai/list-curator-agent:final-list-review",
    ]);
  });

  it("metadata.cinatra.toolboxes is UNDEFINED — legacy MCP injection path (locked decision)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra).not.toHaveProperty("toolboxes");
    expect(cinatra.toolboxes).toBeUndefined();
  });

  it("the 3 ApiNodes (propose, collect, create) target {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='list-curator-agent' and no skill_source_path", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodeIds = Object.entries(refs)
      .filter(([, c]) => c.component_type === "ApiNode")
      .map(([id]) => id);
    expect(apiNodeIds).toEqual(["propose", "collect", "create"]);
    for (const id of apiNodeIds) {
      const apiNode = refs[id]!;
      expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
      expect(apiNode.http_method).toBe("POST");
      const data = apiNode.data as Record<string, unknown>;
      expect(data.agent_id).toBe("list-curator-agent");
      expect(data.skill_source_path).toBeUndefined();
    }
  });

  it("StartNode required=['intent','seedUrls','targetMemberType','listName'] AND hidden=['cinatra_run_id'] — covers all 5 inputs (the four a person supplies are named required, which is how the host makes a field visible)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["intent", "seedUrls", "targetMemberType", "listName"]);
    expect(meta?.hidden).toEqual(["cinatra_run_id"]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const requiredSet = new Set(meta?.required as string[]);
    const hiddenSet = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...requiredSet, ...hiddenSet]);
    expect(union).toEqual(inputTitles);
    expect(requiredSet.size + hiddenSet.size).toBe(5);
  });

  it("EndNode declares 7 outputs (listId/memberCount/accountsCreated/contactsCreated/failures/summary/dispatchedRuns) with inputs EQUAL to outputs (the L1 EndNode invariant) AND data_flow_connections.length === 32 AND control_flow_connections.length === 7", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o]));
    expect(byTitle.get("listId")?.type).toBe("string");
    expect(byTitle.get("memberCount")?.type).toBe("integer");
    expect(byTitle.get("accountsCreated")?.type).toBe("integer");
    expect(byTitle.get("contactsCreated")?.type).toBe("integer");
    expect(byTitle.get("failures")?.type).toBe("array");
    expect(byTitle.get("summary")?.type).toBe("string");
    expect(byTitle.get("dispatchedRuns")?.type).toBe("array");
    expect(outputs).toHaveLength(7);
    const inputs = end!.inputs as Array<Record<string, unknown>>;
    expect(inputs.map((i) => [i.title, i.type])).toEqual(outputs.map((o) => [o.title, o.type]));
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(32);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(7);
  });
});
