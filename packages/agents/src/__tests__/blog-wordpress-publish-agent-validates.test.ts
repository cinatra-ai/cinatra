/**
 * Hermetic regression gate for blog-wordpress-publish-agent.
 *
 * OAS validator gates + 7 structural pins + SKILL contract assertions
 * including deleteInWordPress: true on reject path.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";

const agentDir = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/blog-wordpress-publish-agent",
);
const oasPath = path.join(agentDir, "cinatra/oas.json");
const skillPath = path.join(agentDir, "skills/blog-wordpress-publish-agent/SKILL.md");
const packageJsonPath = path.join(agentDir, "package.json");

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const skill = fs.readFileSync(skillPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;

describe("blog-wordpress-publish-agent OAS validates", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns []", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns []", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });
});

describe("blog-wordpress-publish-agent — 7 structural pins", () => {
  it("Pin 1: agentspec_version + component_type", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("Pin 2: packageName matches package.json", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.packageName).toBe(pkg.name);
    expect(meta.packageName).toBe("@cinatra-ai/blog-wordpress-publish-agent");
  });

  it("Pin 3: openai/gpt-5.5 LLM pair, no capabilityRequired", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    const llm = meta.llm as Record<string, unknown>;
    expect(llm.preferredProvider).toBe("openai");
    expect(llm.preferredModel).toBe("gpt-5.5");
    expect(llm.capabilityRequired).toBeUndefined();
  });

  it("Pin 4: hitlScreens has exactly one renderer key + toolboxes OMITTED", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.hitlScreens).toEqual([
      "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
    ]);
    expect(meta.toolboxes).toBeUndefined();
  });

  it("Pin 5: single ApiNode targeting templated /api/llm-bridge, agent_id, no skill_source_path", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const publish = components.publish as Record<string, unknown>;
    expect(publish.component_type).toBe("ApiNode");
    expect(publish.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const data = publish.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-wordpress-publish-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("Pin 6: StartNode required + hidden cover", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = components.start as Record<string, unknown>;
    const meta = (start.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.required).toEqual(["projectId", "postId", "wordpressInstanceId"]);
    expect(meta.hidden).toEqual([]);
  });

  it("Pin 7: EndNode outputs", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = components.end as Record<string, unknown>;
    const outputs = end.outputs as Array<{ title: string }>;
    const titles = outputs.map((o) => o.title).sort();
    expect(titles).toEqual([
      "approved",
      "postId",
      "projectId",
      "summary",
      "wordpressAdminUrl",
      "wordpressDraftId",
    ]);
  });
});

describe("blog-wordpress-publish-agent — SKILL.md contract", () => {
  it("uses status string 'succeeded' (NOT 'completed')", () => {
    expect(skill).toContain('status === "succeeded"');
    const wrongMatches = skill.match(/status === "completed"/g);
    expect(wrongMatches ?? []).toEqual([]);
  });

  it("polls blog_project_get (NOT blog_post_publish_wordpress_status)", () => {
    expect(skill).toContain("blog_project_get");
    // The status primitive needs a draftId we don't have yet; SKILL must
    // explicitly avoid recommending it for polling.
    expect(skill).toMatch(
      /Do not call.*blog_post_publish_wordpress_status|do not.*blog_post_publish_wordpress_status/i,
    );
  });

  it("extracts adminUrl from wordpressDraftGeneration + wordpressDraftId from post.wordpressDrafts[]", () => {
    expect(skill).toContain("wordpressDraftGeneration");
    expect(skill).toContain("adminUrl");
    expect(skill).toMatch(/post\.wordpressDrafts/);
  });

  it("calls blog_post_publish_wordpress_delete with deleteInWordPress: true on reject", () => {
    expect(skill).toContain("blog_post_publish_wordpress_delete");
    expect(skill).toContain("deleteInWordPress: true");
  });

  it("declares the HITL renderer key explicitly", () => {
    expect(skill).toContain("@cinatra-ai/blog-wordpress-publish-agent:draft-confirm");
  });
});
