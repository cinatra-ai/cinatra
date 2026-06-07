/**
 * Synthetic Gemini agent fixture validation.
 *
 * Asserts the fixture at packages/agents/src/__tests__/fixtures/synthetic-gemini-agent.json
 * passes validateOasAgentJson() with zero errors. This hermetic material
 * supports end-to-end telemetry assertions without coupling the test to
 * media-transcript-agent fixture readiness.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/synthetic-gemini-fixture-validates.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateOasAgentJson, scanOasForLlmMetadata } from "../validate-agent-json";

const FIXTURE_PATH = join(__dirname, "fixtures", "synthetic-gemini-agent.json");

describe("synthetic-gemini-agent fixture", () => {
  it("loads and parses as JSON", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.agentspec_version).toBe("26.1.0");
    expect(parsed.component_type).toBe("Flow");
    expect(parsed.id).toBe("synthetic-gemini-agent-flow");
  });

  it("declares metadata.cinatra.llm with preferredProvider=gemini + media_input", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    const llm = (parsed.metadata as { cinatra?: { llm?: Record<string, unknown> } })?.cinatra?.llm;
    expect(llm).toBeDefined();
    expect(llm?.preferredProvider).toBe("gemini");
    expect(llm?.preferredModel).toBe("gemini-2.5-flash");
    expect(llm?.capabilityRequired).toBe("media_input");
  });

  it("validates clean against validateOasAgentJson (zero errors)", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    const errors = validateOasAgentJson(parsed);
    // Strict assert: no errors at all. If the OAS shape adds a new required
    // field, this test fails loudly and the fixture must be updated in lockstep.
    expect(errors).toEqual([]);
  });

  it("emits no OAS-LLM-00X findings (the gemini/media_input combo is the canonical valid case)", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
    const findings = scanOasForLlmMetadata(parsed);
    expect(findings).toEqual([]);
  });
});
