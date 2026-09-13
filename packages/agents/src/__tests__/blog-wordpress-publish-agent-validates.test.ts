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
const packageJsonPath = path.join(agentDir, "package.json");

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
// cinatra#2090 (epic #2086 S3): this agent ships no skill bundle. Its
// instructions are the `publish` node's system prompt, so the contract
// assertions below read THAT — same bytes, new home.
const skill = [
  (oas as { description?: string }).description ?? "",
  (oas as { $referenced_components: Record<string, { data?: { system?: string } }> })
    .$referenced_components["publish"].data?.system ?? "",
].join("\n\n");
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
    // The flow takes an ARTIFACT REFERENCE, not a blog record: the pinned
    // package's own contract reads "The flow takes an artifact reference
    // (postArtifactId + postRepresentationRevisionId), never raw text and
    // never a blog record". The retired `projectId`/`postId` pair is what a
    // blog record was addressed by.
    expect(meta.required).toEqual([
      "postArtifactId",
      "postRepresentationRevisionId",
      "wordpressInstanceId",
    ]);
    expect(meta.hidden).toEqual(["cinatra_run_id"]);
  });

  it("Pin 7: EndNode outputs", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = components.end as Record<string, unknown>;
    const outputs = end.outputs as Array<{ title: string }>;
    const titles = outputs.map((o) => o.title).sort();
    expect(titles).toEqual([
      "addressWritten",
      "approved",
      "postArtifactId",
      "postRepresentationRevisionId",
      "publishedExternalId",
      "publishedUrl",
      "summary",
    ]);
  });
});

describe("blog-wordpress-publish-agent — inline instruction contract", () => {
  it("publishes an artifact revision — never raw text and never a blog record", () => {
    expect(skill).toContain("never raw text and never a blog record");
    expect(skill).toContain("postArtifactId");
    expect(skill).toContain("postRepresentationRevisionId");
    // The retired blog-record road is gone from the contract, not merely
    // unused: the draft-generation poll, its status primitive and the
    // draft-delete reject path were the shape of a blog record.
    expect(skill).not.toContain("blog_project_get");
    expect(skill).not.toContain("blog_post_publish_wordpress_status");
    expect(skill).not.toContain("blog_post_publish_wordpress_delete");
    expect(skill).not.toContain("wordpressDraftGeneration");
  });

  it("names exactly the two WordPress site primitives and forbids the rest", () => {
    expect(skill).toContain("wordpress_site_tools_list");
    expect(skill).toContain("wordpress_site_tool_call");
    expect(skill).toContain("Call NOTHING else.");
    // The reads and the write-back belong to the deterministic steps around
    // the orchestration step, not to it.
    expect(skill).toContain("artifacts_get");
    expect(skill).toContain("artifact_content_read");
    expect(skill).toContain("objects_update");
  });

  it("only a publicly published page carries an address worth writing back", () => {
    expect(skill).toContain("a draft has no public address");
    expect(skill).toContain("The publish returns a receipt, never a new artifact.");
    // On a decline nothing was created, so the retired delete-on-reject step
    // has no subject any more.
    expect(skill).toContain("there is nothing to remove");
  });

  it("the write-back patch key space is CLOSED at exactly three keys", () => {
    expect(skill).toContain("The patch's key space is CLOSED");
    expect(skill).toContain("wordpressPublishedUrl");
    expect(skill).toContain("wordpressPublishedExternalId");
    expect(skill).toContain("wordpressPublishedRevisionId");
    expect(skill).toMatch(/`addressPatch` is `\{\}` exactly/);
  });

  it("declares the HITL renderer key explicitly", () => {
    expect(skill).toContain("@cinatra-ai/blog-wordpress-publish-agent:draft-confirm");
  });
});
