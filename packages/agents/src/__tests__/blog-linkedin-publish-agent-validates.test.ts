/**
 * Hermetic regression gate for blog-linkedin-publish-agent.
 *
 * OAS validator gates + 7 structural pins + SKILL contract assertions
 * (SKILL MUST NOT mention "completed" or "linkedinPublishGeneration";
 * MUST mention "succeeded" and the linkedinDrafts extraction path).
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
  "../../../../extensions/cinatra-ai/blog-linkedin-publish-agent",
);
const oasPath = path.join(agentDir, "cinatra/oas.json");
const skillPath = path.join(agentDir, "skills/blog-linkedin-publish-agent/SKILL.md");
const packageJsonPath = path.join(agentDir, "package.json");

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const skill = fs.readFileSync(skillPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;

describe("blog-linkedin-publish-agent OAS validates", () => {
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

describe("blog-linkedin-publish-agent — 7 structural pins", () => {
  it("Pin 1: agentspec_version + component_type", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("Pin 2: packageName matches package.json", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.packageName).toBe(pkg.name);
    expect(meta.packageName).toBe("@cinatra-ai/blog-linkedin-publish-agent");
    expect(meta.packageVersion).toBe(pkg.version);
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
      "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
    ]);
    expect(meta.toolboxes).toBeUndefined();
  });

  it("Pin 5: single ApiNode targeting templated /api/llm-bridge, agent_id, no skill_source_path", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const publish = components.publish as Record<string, unknown>;
    expect(publish.component_type).toBe("ApiNode");
    expect(publish.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const data = publish.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-linkedin-publish-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("Pin 6: StartNode required + hidden cover", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = components.start as Record<string, unknown>;
    const meta = (start.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.required).toEqual([
      "projectId",
      "postId",
      "linkedinAccountId",
      "destinationType",
      "destinationId",
      "destinationName",
      "blogPostUrl",
    ]);
    expect(meta.hidden).toEqual(["linkedinAccountName"]);
  });

  it("Pin 7: EndNode outputs", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = components.end as Record<string, unknown>;
    const outputs = end.outputs as Array<{ title: string }>;
    const titles = outputs.map((o) => o.title).sort();
    expect(titles).toEqual([
      "approved",
      "linkedinDraftId",
      "linkedinPostUrl",
      "postId",
      "projectId",
      "summary",
    ]);
  });
});

describe("blog-linkedin-publish-agent — SKILL.md contract", () => {
  it("uses status string 'succeeded' (NOT 'completed')", () => {
    expect(skill).toMatch(/status === "succeeded"|status === \\"succeeded\\"/);
    // Defensive: NEGATIVE assert on the obsolete "completed" string for
    // BackgroundProcessRunStatus. Other "completed" matches (e.g. in
    // free-text English) are OK, but the runtime status check must use
    // the right enum value.
    const wrongMatches = skill.match(/status === "completed"/g);
    expect(wrongMatches ?? []).toEqual([]);
  });

  it("polls blog_project_get (not the non-existent linkedinPublishGeneration)", () => {
    expect(skill).toContain("blog_project_get");
    // The publish flow REUSES linkedinDraftGeneration with operation === "publish".
    // There is no separate linkedinPublishGeneration field. Negative-assert.
    expect(skill).not.toContain("linkedinPublishGeneration");
  });

  it("extracts drafts from post.linkedinDrafts[]", () => {
    expect(skill).toMatch(/post\.linkedinDrafts/);
  });

  it("filters drafts by all 4 keys (linkedinAccountId, destinationId, blogPostUrl, status='draft')", () => {
    expect(skill).toContain("linkedinAccountId");
    expect(skill).toContain("destinationId");
    expect(skill).toContain("blogPostUrl");
    // The draft entry's status field is the operative filter.
    expect(skill).toMatch(/status === "draft"/);
  });

  it("calls blog_post_publish_linkedin_update before _publish on operator edits", () => {
    expect(skill).toContain("blog_post_publish_linkedin_update");
    // The SKILL must invoke update BEFORE publish — assert ordering via
    // string-index comparison.
    const idxUpdate = skill.indexOf("blog_post_publish_linkedin_update");
    const idxPublish = skill.indexOf("blog_post_publish_linkedin_publish");
    expect(idxUpdate).toBeGreaterThan(-1);
    expect(idxPublish).toBeGreaterThan(-1);
    expect(idxUpdate).toBeLessThan(idxPublish);
  });

  it("declares the HITL renderer key explicitly", () => {
    expect(skill).toContain("@cinatra-ai/blog-linkedin-publish-agent:draft-review");
  });
});
