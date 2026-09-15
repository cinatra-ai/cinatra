/**
 * Hermetic regression gate for the blog-image-generator-agent OAS.
 *
 * Loads `extensions/cinatra-ai/blog-image-generator-agent/cinatra/oas.json` from
 * disk and asserts that the authored OAS validates clean against:
 *   - validateOasAgentJson (L1 validator)
 *   - scanOasForLlmMetadata (LLM metadata scanner)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode input coverage invariant)
 *
 * Additionally enforces the shape wave P3 of cinatra#3034 gives this agent: it
 * takes the draft post and nothing that asks for more than one picture, its
 * placement is the featured image and is fixed by schema, it returns ONE image
 * record rather than a list, and its bridge node attaches no toolbox. The
 * predecessor of this package — `blog-image-prompt-agent` — wrote LISTS of
 * prompts; it is retired from the blog flow, and stays pinned only until the
 * pipeline package that still requires it is re-pinned.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/blog-image-generator-agent-validates.test.ts
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
  "../../../../extensions/cinatra-ai/blog-image-generator-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;

describe("blog-image-generator-agent OAS validates against agent schema and metadata scans", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    // The OAS uses a flow-graph `contextSlotBindings` hidden input, so it is
    // fully clean (zero findings) AND mounts in WayFlow. The allowlist is empty;
    // expectMessagesMatchAllowlist therefore asserts the empty set here.
    expectMessagesMatchAllowlist("blog-image-generator-agent", validateOasAgentJson(oas));
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
    expect(cinatra.packageName).toBe("@cinatra-ai/blog-image-generator-agent");
  });

  it("names the retired prompt-writing package nowhere", () => {
    expect(JSON.stringify(oas)).not.toContain("blog-image-prompt-agent");
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

  it("omits metadata.cinatra.toolboxes and declares hitlScreens with context-selector HITL", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.toolboxes).toBeUndefined();
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/context-selection-agent:context-selector",
    ]);
  });

  it("has exactly one ApiNode targeting templated /api/llm-bridge, with an empty toolbox list", () => {
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-image-generator-agent");
    // No toolbox joins the turn, and the node says so rather than leaving the
    // claim to its prose (the W10 leaf-parity rule).
    expect(data.toolbox_ids).toEqual([]);
    // skill_source_path MUST be omitted — the bridge auto-discovers from agent_id.
    expect(data.skill_source_path).toBeUndefined();
  });

  it("takes the post, and nothing that asks for more than one picture", () => {
    const start = refs.start;
    expect(start).toBeDefined();
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["post"]);
    expect(meta?.hidden).toEqual([
      "placement",
      "postArtifactId",
      "cinatra_run_id",
      "imagePromptContextParentPackageName",
      "imagePromptContextSlotId",
      "projectId",
    ]);
    const inputs = start!.inputs as Array<Record<string, unknown>>;
    const inputTitles = new Set(inputs.map((i) => i.title as string));
    // The prompt writer's fields — a draft object, a picture count, a list of
    // placements, a style and brand keywords — are gone with it.
    for (const retired of ["draft", "count", "placements", "style", "brandKeywords"]) {
      expect(inputTitles.has(retired)).toBe(false);
    }
    const union = new Set<string>([
      ...(meta?.required as string[]),
      ...(meta?.hidden as string[]),
    ]);
    expect(union).toEqual(inputTitles);
    expect(union.size).toBe(7);
  });

  it("fixes the placement at the featured image", () => {
    const inputs = oas.inputs as Array<Record<string, unknown>>;
    const placement = inputs.find((i) => i.title === "placement");
    expect(placement).toBeDefined();
    expect(placement!.type).toBe("string");
    expect(placement!.default).toBe("featured");
    // The default is what a caller gets; the schema is what a caller CANNOT
    // get around. Both the bridge node's answer schema and the EndNode's admit
    // the featured placement only.
    for (const node of ["generate", "end"]) {
      const outputs = refs[node]!.outputs as Array<Record<string, unknown>>;
      const image = outputs.find((o) => o.title === "image")!;
      const schema = image.json_schema as {
        properties: { placement: { enum?: string[] } };
      };
      expect(schema.properties.placement.enum).toEqual(["featured"]);
    }
  });

  it("EndNode declares one picture (image: object) and notes, and binds nothing", () => {
    const end = refs.end;
    expect(end).toBeDefined();
    const outputs = end!.outputs as Array<Record<string, unknown>>;
    const byTitle = new Map(outputs.map((o) => [o.title as string, o.type as string]));
    // One object, never a list: a list would be more than one picture.
    expect(byTitle.get("image")).toBe("object");
    expect(byTitle.get("notes")).toBe("string");
    expect(byTitle.size).toBe(2);
    // The picture is a mid-run write, so no terminal binding files it.
    for (const output of outputs) {
      expect((output as { cinatra?: unknown }).cinatra).toBeUndefined();
    }
  });

  it("carries the post and the placement with the picture it returns", () => {
    const outputs = oas.outputs as Array<Record<string, unknown>>;
    const image = outputs.find((o) => o.title === "image")!;
    const schema = image.json_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "altText",
      "placement",
      "post",
      "prompt",
    ]);
    // All four are required: a picture nobody can describe to a reader who
    // cannot see it is not finished, and the placement is the featured one by
    // schema rather than by a default a caller could override.
    expect([...schema.required].sort()).toEqual([
      "altText",
      "placement",
      "post",
      "prompt",
    ]);
    const placement = schema.properties.placement as { enum?: string[] };
    expect(placement.enum).toEqual(["featured"]);
  });
});
