/**
 * Hermetic regression gate for blog-linkedin-publish-agent.
 *
 * OAS validator gates + 7 structural pins + instruction-contract assertions.
 *
 * At this pin the flow is the ARTIFACT-REFERENCE road: it is handed one pinned
 * artifact revision (linkedinArtifactId + linkedinRepresentationRevisionId),
 * the steps around it read and write the artifact through the host's own
 * primitives, and it reaches no blog record at all. The blog-record road's
 * facts (a generation poll, the post.linkedinDrafts[] extraction, the
 * update-then-publish pair) are therefore negative-asserted rather than
 * required — they are what this pin removed.
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
    expect(meta.required).toEqual([
      "linkedinArtifactId",
      "linkedinRepresentationRevisionId",
      "linkedinAccountId",
      "destinationType",
      "destinationId",
      "destinationName",
    ]);
    expect(meta.hidden).toEqual(["linkedinAccountName", "blogPostUrl", "cinatra_run_id"]);
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
  it("takes an artifact reference, never raw text and never a blog record", () => {
    expect(skill).toContain("never raw text and never a blog record");
    expect(skill).toContain("artifacts_get + artifact_content_read");
    // Defensive: the blog-record road's obsolete BackgroundProcessRunStatus
    // string must not come back with it.
    const wrongMatches = skill.match(/status === "completed"/g);
    expect(wrongMatches ?? []).toEqual([]);
  });

  it("reaches no blog record and polls no generation", () => {
    expect(skill).toContain("you never reach a blog record");
    expect(skill).not.toContain("blog_project_get");
    // There never was a linkedinPublishGeneration field, and the artifact road
    // polls no generation at all. Negative-assert both.
    expect(skill).not.toContain("linkedinPublishGeneration");
  });

  it("publishes the pinned revision the person continued with, not a draft row", () => {
    expect(skill).toContain("THE REVISION THE PERSON CONTINUED WITH");
    expect(skill).toContain("linkedinRepresentationRevisionId");
    expect(skill).not.toMatch(/post\.linkedinDrafts/);
  });

  it("names the destination cover it is given, with no draft-status filter", () => {
    expect(skill).toContain("linkedinAccountId");
    expect(skill).toContain("destinationId");
    expect(skill).toContain("blogPostUrl");
    // Nothing is filtered by a draft entry's status any more: the flow is handed
    // ONE pinned artifact revision, never a list of draft rows.
    expect(skill).not.toMatch(/status === "draft"/);
  });

  it("names the connector's publish primitive, and the review screen does not edit the copy", () => {
    expect(skill).toContain("linkedin_post_publish");
    expect(skill).toContain("The screen shows the copy; it does not edit it.");
    // The operator-edit road (update-then-publish on the blog record) is gone.
    expect(skill).not.toContain("blog_post_publish_linkedin_update");
    expect(skill).not.toContain("blog_post_publish_linkedin_publish");
  });

  it("declares the HITL renderer key explicitly", () => {
    expect(skill).toContain("@cinatra-ai/blog-linkedin-publish-agent:draft-review");
  });
});

// cinatra#3564 — THE POINT OF THIS PIN, pinned positively so it cannot quietly
// go away: after the post is published the run writes the published address
// BACK onto the post's artifact. The declaration is what makes it reach the
// artifact at all — an object level with no declared members is asked for
// closed and empty — so the declaration AND the write-back road it feeds are
// both pinned here. Without these three cases the write_address node could be
// deleted and every other case in this file would still pass.
describe("blog-linkedin-publish-agent — the published address reaches the artifact (#3564)", () => {
  type Ref = { $component_ref: string };
  const components = () => oas.$referenced_components as Record<string, Record<string, unknown>>;
  const MEMBERS = [
    "linkedinPublishedExternalId",
    "linkedinPublishedRevisionId",
    "linkedinPublishedUrl",
  ];

  it("the publish step declares its address patch with exactly its three members, all required", () => {
    const outputs = components().publish.outputs as Array<Record<string, unknown>>;
    const patch = outputs.find((o) => o.title === "addressPatch");
    expect(patch, "the publish step declares an addressPatch output").toBeTruthy();
    expect(patch?.type).toBe("object");
    const schema = (patch?.json_schema ?? {}) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(MEMBERS);
    expect([...(schema.required ?? [])].sort()).toEqual(MEMBERS);
  });

  it("a write-back node merges that patch onto the SAME artifact through objects_update", () => {
    const write = components().write_address;
    expect(write, "the flow carries a write_address node").toBeTruthy();
    expect(write.component_type).toBe("ApiNode");
    expect(write.url).toBe("{{CINATRA_BASE_URL}}/api/agents/passthrough");
    expect(write.http_method).toBe("POST");
    const data = write.data as { tool?: string; input?: Record<string, unknown> };
    expect(data.tool).toBe("objects_update");
    // The artifact written to is the one this run was handed — never a new one.
    expect(data.input?.objectId).toBe("{{ linkedinArtifactId }}");
    expect(data.input?.data).toBe("{{ addressPatch }}");
  });

  it("the write-back runs after the publish step, before the end, on the publish step's patch", () => {
    const control = (
      oas.control_flow_connections as Array<{ from_node: Ref; to_node: Ref }>
    ).map((e) => `${e.from_node.$component_ref}->${e.to_node.$component_ref}`);
    expect(control).toContain("publish->write_address");
    expect(control).toContain("write_address->end");
    const flows = oas.data_flow_connections as Array<{
      source_node: Ref;
      source_output: string;
      destination_node: Ref;
      destination_input: string;
    }>;
    const patchEdge = flows.find(
      (e) =>
        e.source_node.$component_ref === "publish" &&
        e.source_output === "addressPatch" &&
        e.destination_node.$component_ref === "write_address" &&
        e.destination_input === "addressPatch",
    );
    expect(patchEdge, "the publish step's addressPatch feeds the write-back").toBeTruthy();
  });
});
