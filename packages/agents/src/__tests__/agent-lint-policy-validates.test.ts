/**
 * Hermetic regression gate for the agent-lint-policy OAS.
 *
 * Loads `extensions/cinatra-ai/lint-policy-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against the L1 validator
 * and start-node input invariants. Also pins agent-specific contract:
 *
 *   - The agent is type=node (single ApiNode flow, no LLM step)
 *   - The single ApiNode targets `/api/oas-lint/scan-all`, NOT /api/llm-bridge
 *   - StartNode declares the 5 inputs (1 required + 4 hidden) with
 *     metadata.cinatra.required + metadata.cinatra.hidden coverage
 *   - Output is a single `findings: string` field
 *   - metadata.cinatra.packageName matches @cinatra-ai/lint-policy-agent
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-lint-policy-validates.test.ts
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
  "../../../../extensions/cinatra-ai/lint-policy-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("agent-lint-policy OAS validates against L1 + start-node input invariants", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns [] (no llm-bridge ApiNodes — agent has no LLM step)", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] for required metadata", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("metadata.cinatra.packageName matches package.json#name", () => {
    const metadata = oas.metadata as { cinatra?: Record<string, unknown> };
    expect(metadata?.cinatra?.packageName).toBe("@cinatra-ai/lint-policy-agent");
  });

  it("type=node (single ApiNode flow, no LLM step)", () => {
    const metadata = oas.metadata as { cinatra?: Record<string, unknown> };
    expect(metadata?.cinatra?.type).toBe("node");
  });

  it("the single ApiNode targets /api/oas-lint/scan-all (NOT /api/llm-bridge)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const scanNode = refs?.scan_all as { url?: string; http_method?: string };
    expect(scanNode?.url).toBe("{{CINATRA_BASE_URL}}/api/oas-lint/scan-all");
    expect(scanNode?.http_method).toBe("POST");
  });

  it("StartNode declares 1 required + 4 hidden inputs (5 total)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs?.start as {
      metadata?: { cinatra?: { required?: string[]; hidden?: string[] } };
      inputs?: Array<{ title: string }>;
    };
    expect(start?.metadata?.cinatra?.required).toEqual(["oasJson"]);
    expect(start?.metadata?.cinatra?.hidden?.sort()).toEqual(
      ["agent_run_id", "packageJson", "packageSlug", "policyVersion"].sort(),
    );
    expect(start?.inputs?.length).toBe(5);
  });

  it("EndNode emits a single `findings: string` output", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = refs?.end as { outputs?: Array<{ title: string; type: string }> };
    expect(end?.outputs).toEqual([{ title: "findings", type: "string" }]);
  });

  it("includes an OutputMessageNode between scan_all and end so A2A callers see the result", () => {
    // ApiNode-only flows produce empty task.history; A2A callers can't
    // read the result. The
    // OutputMessageNode renders the findings into a conversation message
    // so A2A consumers, including parent agents, get it via the standard
    // task.history mechanism.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const emit = refs?.emit_output as {
      component_type?: string;
      inputs?: Array<{ title: string }>;
      message?: string;
    };
    expect(emit?.component_type).toBe("OutputMessageNode");
    expect(emit?.inputs?.map((i) => i.title)).toContain("findings");
    expect(emit?.message).toContain("findings");
    expect(emit?.message).toContain("{{ findings }}");

    // Control flow goes scan_all → emit_output → end (not scan_all → end directly)
    const cfes = oas.control_flow_connections as Array<{
      from_node?: { $component_ref?: string };
      to_node?: { $component_ref?: string };
    }>;
    const hasScanToEmit = cfes.some(
      (e) => e.from_node?.$component_ref === "scan_all" && e.to_node?.$component_ref === "emit_output",
    );
    const hasEmitToEnd = cfes.some(
      (e) => e.from_node?.$component_ref === "emit_output" && e.to_node?.$component_ref === "end",
    );
    expect(hasScanToEmit).toBe(true);
    expect(hasEmitToEnd).toBe(true);
  });

  it("DataFlowEdge wires scan_all.findings → emit_output.findings", () => {
    const dfes = oas.data_flow_connections as Array<{
      source_node?: { $component_ref?: string };
      source_output?: string;
      destination_node?: { $component_ref?: string };
      destination_input?: string;
    }>;
    const finding = dfes.find(
      (e) =>
        e.source_node?.$component_ref === "scan_all" &&
        e.source_output === "findings" &&
        e.destination_node?.$component_ref === "emit_output" &&
        e.destination_input === "findings",
    );
    expect(finding).toBeDefined();
  });
});
