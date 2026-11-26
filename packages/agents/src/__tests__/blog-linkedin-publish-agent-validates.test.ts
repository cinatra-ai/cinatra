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
 *
 * The pack ships NO screen of its own (cinatra#4150): the run parks on the
 * host's review of the pinned revision (gather_review_target ->
 * post_review_gate, marked cinatra.artifactReview) before the words are read,
 * the words read are those of the revision the review approved, and the
 * publish node is the declared publishing step (publishes: true +
 * publishRows), so the host's publish card is the one stop in front of the
 * outward call.
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

  it("Pin 4: no pack screen (no hitlScreens) + toolboxes OMITTED; the publish node is the publishing step", () => {
    // red-first-expect: expected [ Array(1) ] to be undefined
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.hitlScreens).toBeUndefined();
    expect(meta.toolboxes).toBeUndefined();
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const publishMeta = (components.publish.metadata as Record<string, unknown>).cinatra as Record<
      string,
      unknown
    >;
    expect(publishMeta.publishes).toBe(true);
    // The card shows the words that go out and where they go.
    expect(publishMeta.publishRows).toEqual([
      { label: "Post", input: "postText" },
      { label: "Destination", input: "destinationName" },
    ]);
    // The write-back is NOT a publishing step: one publish card per run.
    const writeMeta = (components.write_address.metadata as Record<string, unknown>).cinatra as Record<
      string,
      unknown
    >;
    expect(writeMeta.publishes).toBe(false);
  });

  it("Pin 4b: the host review of the pinned revision comes before anything is read for publishing", () => {
    // red-first-expect: Cannot read properties of undefined (reading 'component_type')
    type Ref = { $component_ref: string };
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const gather = components.gather_review_target;
    expect(gather.component_type).toBe("ApiNode");
    const gatherData = gather.data as { tool?: string; input?: Record<string, unknown> };
    expect(gatherData.tool).toBe("artifacts_get");
    expect(gatherData.input?.reviewTargets).toBe(
      '[{"artifactId": "{{ linkedinArtifactId }}", "representationRevisionId": "{{ linkedinRepresentationRevisionId }}"}]',
    );
    const gate = components.post_review_gate;
    expect(gate.component_type).toBe("InputMessageNode");
    const gateMeta = (gate.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(gateMeta.artifactReview).toEqual({ targetsInput: "reviewTargets" });
    expect(gateMeta.requiresApproval).toBe(true);
    // artifacts_get answers only `{ artifact }`. The target set reaches the gate
    // only because the host echoes the call's input back on this flag, so the
    // gather step's declared output and its edge into the gate's marked input
    // are what carry it. The real echo is driven with this node in
    // src/__tests__/passthrough-linkedin-review-gate-gets-its-targets.test.ts.
    expect((gatherData as { result_input_passthrough?: unknown }).result_input_passthrough).toBe(true);
    expect((gather.outputs as Array<{ title: string }>).map((o) => o.title)).toContain("reviewTargets");
    const targetEdges = (
      oas.data_flow_connections as Array<{
        source_node: Ref;
        source_output: string;
        destination_node: Ref;
        destination_input: string;
      }>
    ).filter((e) => e.destination_node.$component_ref === "post_review_gate");
    expect(
      targetEdges.map(
        (e) => `${e.source_node.$component_ref}.${e.source_output}->${e.destination_input}`,
      ),
    ).toEqual(["gather_review_target.reviewTargets->reviewTargets"]);
    const control = (
      oas.control_flow_connections as Array<{ from_node: Ref; to_node: Ref }>
    ).map((e) => `${e.from_node.$component_ref}->${e.to_node.$component_ref}`);
    expect(control).toEqual([
      "start->gather_review_target",
      "gather_review_target->post_review_gate",
      "post_review_gate->read_post_record",
      "read_post_record->read_post_text",
      "read_post_text->publish",
      "publish->write_address",
      "write_address->end",
    ]);
  });

  it("Pin 4c: the words read for publishing are the revision the review approved, not the one the run started with", () => {
    // red-first-expect: expected 'artifact_content_read' to be 'extension_tool'
    // A person can choose Regenerate on the review and approve the successor.
    // The review step answers with the approved target, so the read step takes
    // its revision from that answer (the pack's declared approved_post_text
    // tool), and the publish step gets the approved artifact and revision from
    // the read step. The start revision feeds only the review itself.
    type Ref = { $component_ref: string };
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const readData = components.read_post_text.data as {
      tool?: string;
      input?: { name?: string; input?: Record<string, unknown> };
    };
    expect(readData.tool).toBe("extension_tool");
    expect(readData.input?.name).toBe("approved_post_text");
    expect(readData.input?.input).toEqual({
      reviewDecision: "{{ reviewApproval }}",
      artifactId: "{{ linkedinArtifactId }}",
    });
    const tools = ((pkg.cinatra ?? {}) as { tools?: unknown }).tools;
    expect(tools).toContainEqual({
      name: "approved_post_text",
      module: "./cinatra/tools/approved-post-text.mjs",
    });
    const edges = (
      oas.data_flow_connections as Array<{
        source_node: Ref;
        source_output: string;
        destination_node: Ref;
        destination_input: string;
      }>
    ).map(
      (e) =>
        `${e.source_node.$component_ref}.${e.source_output}->${e.destination_node.$component_ref}.${e.destination_input}`,
    );
    expect(edges).toContain("post_review_gate.reviewApproval->read_post_text.reviewApproval");
    expect(edges).toContain("read_post_text.artifactId->publish.linkedinArtifactId");
    expect(edges).toContain(
      "read_post_text.representationRevisionId->publish.linkedinRepresentationRevisionId",
    );
    expect(edges).toContain("read_post_text.artifactId->write_address.linkedinArtifactId");
    expect(edges.filter((e) => e.startsWith("start.linkedinRepresentationRevisionId->"))).toEqual([
      "start.linkedinRepresentationRevisionId->gather_review_target.linkedinRepresentationRevisionId",
    ]);
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

  it("publishes the revision the review approved, not a draft row", () => {
    // red-first-expect: to contain 'THE REVISION THE REVIEW APPROVED'
    expect(skill).toContain("THE REVISION THE REVIEW APPROVED");
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

  it("names the connector's publish primitive, and runs only behind the host's publish confirmation", () => {
    // red-first-expect: to contain 'the run stops in front of it on the h
    expect(skill).toContain("linkedin_post_publish");
    expect(skill).toContain("the run stops in front of it on the host's publish confirmation");
    // Copy changes belong to the review, not to this step.
    expect(skill).toContain("A person who wants different words changes them on the review, not here.");
    // The operator-edit road (update-then-publish on the blog record) is gone.
    expect(skill).not.toContain("blog_post_publish_linkedin_update");
    expect(skill).not.toContain("blog_post_publish_linkedin_publish");
  });

  it("names no pack renderer key: the host's review and publish cards replace the pack screen", () => {
    // red-first-expect: not to contain '@cinatra-ai/blog-linkedin-publish-age
    expect(skill).not.toContain("@cinatra-ai/blog-linkedin-publish-agent:draft-review");
    expect(skill).not.toContain("x-renderer");
  });

  it("declares no field renderer: a run never stops on a pack screen", () => {
    // red-first-expect: expected [ { …(5) } ] to be undefined
    const cinatra = (pkg.cinatra ?? {}) as Record<string, unknown>;
    expect(cinatra.fieldRenderers).toBeUndefined();
  });

  it("the failure and partial envelopes carry exactly the declared output keys, approved, and the empty patch", () => {
    // red-first-expect: expected -1 to be greater than -1
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const declared = (components.publish.outputs as Array<{ title: string }>).map((o) => o.title).sort();
    const envelopeAfter = (heading: string) => {
      const at = skill.indexOf(heading);
      expect(at, heading).toBeGreaterThan(-1);
      const block = /```json\n([\s\S]*?)\n```/.exec(skill.slice(at));
      expect(block, `the recipe spells out: ${heading}`).toBeTruthy();
      return JSON.parse(block![1]) as Record<string, unknown>;
    };
    const failure = envelopeAfter("The failure envelope, with a one-line `summary` that names the cause");
    expect(Object.keys(failure).sort()).toEqual(declared);
    expect(failure.approved).toBe(true);
    expect(failure.addressWritten).toBe(false);
    expect(failure.linkedinPostUrl).toBe("");
    expect(failure.linkedinPostExternalId).toBe("");
    expect(failure.addressPatch).toEqual({
      linkedinPublishedUrl: "",
      linkedinPublishedExternalId: "",
      linkedinPublishedRevisionId: "",
    });
    // The partial envelope (LinkedIn returned only an address or only an id)
    // carries the same empty patch, so its write-back writes nothing either.
    const partial = envelopeAfter("The partial envelope");
    expect(Object.keys(partial).sort()).toEqual(declared);
    expect(partial.addressWritten).toBe(false);
    expect(partial.addressPatch).toEqual(failure.addressPatch);
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
    // red-first-expect: to contain '(
    const write = components().write_address;
    expect(write, "the flow carries a write_address node").toBeTruthy();
    expect(write.component_type).toBe("ApiNode");
    expect(write.url).toBe("{{CINATRA_BASE_URL}}/api/agents/passthrough");
    expect(write.http_method).toBe("POST");
    const data = write.data as { tool?: string; input?: Record<string, unknown> };
    expect(data.tool).toBe("objects_update");
    // The artifact written to is the one this run was handed — never a new one.
    expect(data.input?.objectId).toBe("{{ linkedinArtifactId }}");
    // The leaf writes the patch only when each of its three members is present
    // and non-empty. A run that published nothing renders the empty patch {},
    // and objects_update writes nothing for an empty patch (no new version, no
    // history or outbox row).
    const leaf = String(data.input?.data ?? "");
    expect(leaf.startsWith("{# pyagentspec-input-hint: {{ addressPatch }} #}")).toBe(true);
    for (const member of MEMBERS) {
      expect(leaf).toContain(`('${member}' in addressPatch and addressPatch['${member}'])`);
    }
    expect(leaf.endsWith("%}{{ addressPatch | tojson }}{% else %}{}{% endif %}")).toBe(true);
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
