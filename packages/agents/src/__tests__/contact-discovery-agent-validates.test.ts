/**
 * Hermetic regression gate for the contact-discovery-agent OAS.
 *
 * Loads `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (OAS-LLM-001..004 scanner)
 *   - scanOasForStartNodeInputsWithoutRequired
 *
 * Additionally enforces: agentspec_version, component_type, packageName,
 * the OpenAI/gpt-5 LLM pair, that toolboxes is UNDEFINED (locked decision —
 * legacy MCP injection path), the single ApiNode targeting templated /api/llm-bridge
 * with SKILL.md auto-discovery (no skill_source_path field), correct StartNode
 * required+hidden coverage (required=['accountId'] + hidden=[3 others]), and
 * EndNode shape with contactIds.json_schema.items typing.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/contact-discovery-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(oasPath), "..", "package.json"), "utf8"),
) as Record<string, unknown>;

describe("contact-discovery-agent OAS validates against L1, LLM-metadata, and StartNode required-input scans", () => {
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
    expect(cinatra.packageName).toBe("@cinatra-ai/contact-discovery-agent");
    expect(cinatra.packageVersion).toBe(pkg.version);
  });

  it("metadata.cinatra.toolboxes is UNDEFINED — legacy MCP injection path (locked decision)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra).not.toHaveProperty("toolboxes");
    expect(cinatra.toolboxes).toBeUndefined();
  });

  it("ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='contact-discovery-agent' and no skill_source_path", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("contact-discovery-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("StartNode required=['accountId'] AND hidden covers titlePatterns/maxContacts/apolloFirst/cinatra_run_id (wayflow-apinode-loader-fix)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["accountId"]);
    expect(meta?.hidden).toEqual(["titlePatterns", "maxContacts", "apolloFirst", "cinatra_run_id"]);
    const startInputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(startInputs.map((i) => i.title as string));
    const requiredSet = new Set(meta?.required as string[]);
    const hiddenSet = new Set(meta?.hidden as string[]);
    const union = new Set<string>([...requiredSet, ...hiddenSet]);
    expect(union).toEqual(inputTitles);
  });

  it("EndNode declares 4 outputs (contactIds/apolloHitCount/webFallbackUsed/failures) with contactIds.json_schema.items.type='string' AND data_flow_connections.length === 9 (incl. cinatra_run_id DFE) AND control_flow_connections.length === 2", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o]));
    expect(byTitle.get("contactIds")?.type).toBe("array");
    const contactIdsSchema = byTitle.get("contactIds")?.json_schema as
      | Record<string, unknown>
      | undefined;
    const contactIdsItems = contactIdsSchema?.items as Record<string, unknown> | undefined;
    expect(contactIdsItems?.type).toBe("string");
    expect(byTitle.get("apolloHitCount")?.type).toBe("integer");
    expect(byTitle.get("webFallbackUsed")?.type).toBe("boolean");
    expect(byTitle.get("failures")?.type).toBe("array");
    const dfc = oas.data_flow_connections as unknown[];
    expect(dfc.length).toBe(9);
    const cfc = oas.control_flow_connections as unknown[];
    expect(cfc.length).toBe(2);
  });
});
