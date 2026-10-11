import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALLOWED_MODEL_IDS, BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS } from "../llm-provider-policy";
import { scanOasForLlmMetadata, validateOasAgentJson } from "../validate-agent-json";

const extensions = path.resolve(__dirname, "../../../../extensions/cinatra-ai");
const connector = JSON.parse(readFileSync(path.join(extensions, "gemini-connector/package.json"), "utf8"));
const transcript = JSON.parse(readFileSync(path.join(extensions, "media-transcript-agent/cinatra/oas.json"), "utf8"));

describe("Gemini development train (#1714)", () => {
  it("keeps the pinned connector and core declaration identical", () => {
    expect(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.gemini).toEqual(connector.cinatra.llmProvider);
    expect(ALLOWED_MODEL_IDS.gemini).toEqual(["gemini-3.5-flash"]);
  });

  it("accepts the pinned media agent and its bridge request on the same sole model", () => {
    expect(validateOasAgentJson(transcript)).toEqual([]);
    const requirement = {
      preferredProvider: "gemini", preferredModel: "gemini-3.5-flash", capabilityRequired: "media_input",
    };
    expect(transcript.metadata.cinatra.llm).toEqual(requirement);
    const nodes = Object.values(transcript.$referenced_components) as Array<{
      component_type: string; data?: { cinatra_llm?: unknown };
    }>;
    const calls = nodes.filter((node) => node.component_type === "ApiNode");
    expect(calls).toHaveLength(1);
    expect(calls[0].data?.cinatra_llm).toEqual(requirement);
  });

  it.each(["gemini-1.5-pro", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"])(
    "rejects a removed model (%s) with the supported replacement in the error", (model) => {
      const retired = structuredClone(transcript);
      retired.metadata.cinatra.llm.preferredModel = model;
      const finding = scanOasForLlmMetadata(retired).find((item) => item.code === "OAS-LLM-002");
      expect(finding?.message).toContain(model);
      expect(finding?.message).toContain("Allowed: gemini-3.5-flash");
    },
  );
});
