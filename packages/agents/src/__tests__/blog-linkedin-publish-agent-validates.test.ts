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
    // The flow takes an ARTIFACT REFERENCE, not a blog record: the pinned
    // package's own contract reads "The flow takes an artifact reference
    // (linkedinArtifactId + linkedinRepresentationRevisionId), never raw text
    // and never a blog record". `blogPostUrl` moved off the required cover
    // because the contract now fills it "at the publishing step from the
    // WordPress publisher's own output, never guessed at the start".
    expect(meta.required).toEqual([
      "linkedinArtifactId",
      "linkedinRepresentationRevisionId",
      "linkedinAccountId",
      "destinationType",
      "destinationId",
      "destinationName",
    ]);
    expect(meta.hidden).toEqual([
      "linkedinAccountName",
      "blogPostUrl",
      "cinatra_run_id",
    ]);
  });

  it("Pin 7: EndNode outputs", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = components.end as Record<string, unknown>;
    const outputs = end.outputs as Array<{ title: string }>;
    const titles = outputs.map((o) => o.title).sort();
    expect(titles).toEqual([
      "addressWritten",
      "approved",
      "linkedinArtifactId",
      "linkedinPostExternalId",
      "linkedinPostUrl",
      "linkedinRepresentationRevisionId",
      "summary",
    ]);
  });
});

describe("blog-linkedin-publish-agent — inline instruction contract", () => {
  it("publishes an artifact revision — never raw text and never a blog record", () => {
    expect(skill).toContain("never raw text and never a blog record");
    expect(skill).toContain("linkedinArtifactId");
    expect(skill).toContain("linkedinRepresentationRevisionId");
    // The retired blog-record road is gone from the contract, not merely
    // unused: the draft roster, its poll and the update-before-publish edit
    // step were the shape of a blog record.
    expect(skill).not.toContain("blog_project_get");
    expect(skill).not.toContain("blog_post_publish_linkedin_update");
    expect(skill).not.toContain("blog_post_publish_linkedin_publish");
    expect(skill).not.toContain("linkedinDrafts");
  });

  it("names exactly one publish primitive and forbids the rest", () => {
    expect(skill).toContain("You may call exactly this 1 primitive");
    expect(skill).toContain("linkedin_post_publish");
    expect(skill).toContain("Call NOTHING else.");
    // The reads and the write-back belong to the deterministic steps around
    // the orchestration step, not to it.
    expect(skill).toContain("artifacts_get");
    expect(skill).toContain("artifact_content_read");
    expect(skill).toContain("objects_update");
  });

  it("the pinned revision is what goes out — the screen never edits it", () => {
    expect(skill).toContain("YOU DO NOT WRITE.");
    expect(skill).toContain("The screen shows the copy; it does not edit it.");
    expect(skill).toContain(
      "Ignore any `content` that comes back on the answer",
    );
    expect(skill).toContain(
      "The publish returns a receipt, never a new artifact",
    );
  });

  it("the write-back patch key space is CLOSED at exactly three keys", () => {
    expect(skill).toContain("The patch's key space is CLOSED");
    expect(skill).toContain("linkedinPublishedUrl");
    expect(skill).toContain("linkedinPublishedExternalId");
    expect(skill).toContain("linkedinPublishedRevisionId");
    expect(skill).toMatch(/`addressPatch` is `\{\}` exactly/);
  });

  it("declares the HITL renderer key explicitly", () => {
    expect(skill).toContain("@cinatra-ai/blog-linkedin-publish-agent:draft-review");
  });
});
