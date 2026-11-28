/**
 * Hermetic regression gate for blog-wordpress-publish-agent.
 *
 * OAS validator gates + 7 structural pins + instruction-contract assertions.
 *
 * At this pin the flow is the ARTIFACT-REFERENCE road: it is handed one pinned
 * artifact revision (postArtifactId + postRepresentationRevisionId), the steps
 * around it read and write the artifact through the host's own primitives, and
 * it reaches no blog record at all. Nothing is created before the person
 * confirms, so the blog-record road's facts (a generation poll, the
 * post.wordpressDrafts[] extraction, the delete-on-reject call) are
 * negative-asserted rather than required — they are what this pin removed.
 *
 * The pack ships NO screen of its own (cinatra#3650, #4313, #4150): the run
 * parks on the host's review of the pinned revision (gather_review_target ->
 * review_post, marked cinatra.artifactReview) before the words are read, and
 * the publish node is the declared publishing step (publishes: true +
 * publishRows), so the host's publish card is the one stop in front of the
 * outward call. The post's record is read after the review (read_post_record,
 * from the start input) and the read step behind it answers the page's title as
 * plain text. The HTML of the page is written by a model step that
 * follows a skill (write_post_html, cinatra#4893): the card shows the title and
 * the HTML, and the publish step sends that HTML unchanged.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";
import { expectMessagesMatchAllowlist } from "./__fixtures__/known-broken-agents";

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

// The runtime surfaces whatever data edge feeds a step's input, so a test that
// only checks an input's NAME, or that some edge exists, lets a retargeted
// edge through. These read every data edge into one step, with its source node
// and output, as an exact set.
type FlowRef = { $component_ref: string };
type DataEdge = {
  source_node: FlowRef;
  source_output: string;
  destination_node: FlowRef;
  destination_input: string;
};
const dataEdges = oas.data_flow_connections as DataEdge[];
const stepOf = (id: string) =>
  (oas.$referenced_components as Record<string, Record<string, unknown>>)[id];
/** Every data edge into `id` as `source.output->input`, sorted. */
const edgesInto = (id: string): string[] =>
  dataEdges
    .filter((e) => e.destination_node.$component_ref === id)
    .map((e) => `${e.source_node.$component_ref}.${e.source_output}->${e.destination_input}`)
    .sort();
const titlesOf = (list: unknown): string[] =>
  (list as Array<{ title: string }>).map((i) => i.title).sort();

describe("blog-wordpress-publish-agent OAS validates", () => {
  it("validateOasAgentJson returns only the findings the allowlist records (cinatra#4150)", () => {
    expectMessagesMatchAllowlist("blog-wordpress-publish-agent", validateOasAgentJson(oas));
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

  it("Pin 4: no pack screen (no hitlScreens) + toolboxes OMITTED; the publish node is the publishing step", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.hitlScreens).toBeUndefined();
    expect(meta.toolboxes).toBeUndefined();
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const publishMeta = (components.publish.metadata as Record<string, unknown>).cinatra as Record<
      string,
      unknown
    >;
    expect(publishMeta.publishes).toBe(true);
    // The card shows the title and the HTML that goes out. The approved words
    // are not a second row: the publish step takes only the HTML, so the
    // approval record carries the body once.
    expect(publishMeta.publishRows).toEqual([
      { label: "Title", input: "postTitle" },
      { label: "Post HTML", input: "postHtml" },
    ]);
    // The write-back is NOT a publishing step: one publish card per run.
    const writeMeta = (components.write_address.metadata as Record<string, unknown>).cinatra as Record<
      string,
      unknown
    >;
    expect(writeMeta.publishes).toBe(false);
  });

  it("Pin 4b: the host review of the pinned revision comes before anything is read for publishing", () => {
    type Ref = { $component_ref: string };
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const gather = components.gather_review_target;
    expect(gather.component_type).toBe("ApiNode");
    const gatherData = gather.data as { tool?: string; input?: Record<string, unknown> };
    expect(gatherData.tool).toBe("artifacts_get");
    expect(gatherData.input?.reviewTargets).toBe(
      '[{"artifactId": "{{ postArtifactId }}", "representationRevisionId": "{{ postRepresentationRevisionId }}"}]',
    );
    const gate = components.review_post;
    expect(gate.component_type).toBe("InputMessageNode");
    const gateMeta = (gate.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(gateMeta.artifactReview).toEqual({ targetsInput: "reviewTargets" });
    expect(gateMeta.requiresApproval).toBe(true);
    // The runtime writes the value of the marked input into the pause's message
    // only for a gate that sets this flag; without it the application reads no
    // target set and the review never opens.
    expect(gateMeta.surfaceGateInputs).toBe(true);
    // artifacts_get answers only `{ artifact }`. The target set reaches the gate
    // only because the host echoes the call's input back on this flag, so the
    // gather step's declared output and its edge into the gate's marked input
    // are what carry it. The real echo is driven with this node in
    // src/__tests__/passthrough-wordpress-review-gate-gets-its-targets.test.ts.
    expect((gatherData as { result_input_passthrough?: unknown }).result_input_passthrough).toBe(true);
    expect((gather.outputs as Array<{ title: string }>).map((o) => o.title)).toContain("reviewTargets");
    const targetEdges = (
      oas.data_flow_connections as Array<{
        source_node: Ref;
        source_output: string;
        destination_node: Ref;
        destination_input: string;
      }>
    ).filter((e) => e.destination_node.$component_ref === "review_post");
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
      "gather_review_target->review_post",
      "review_post->read_post_record",
      "read_post_record->read_post_text",
      "read_post_text->write_post_html",
      "write_post_html->publish",
      "publish->write_address",
      "write_address->end",
    ]);
    // The one record read behind the review takes the artifact under review
    // from the start input, and only the read step behind it takes that record.
    const recordData = components.read_post_record.data as Record<string, unknown>;
    expect(components.read_post_record.component_type).toBe("ApiNode");
    expect(recordData).toEqual({
      tool: "artifacts_get",
      input: { artifactId: "{{ postArtifactId }}" },
      agent_run_id: "{{ cinatra_run_id }}",
    });
    expect(titlesOf(components.read_post_record.inputs)).toEqual(["cinatra_run_id", "postArtifactId"]);
    expect(edgesInto("read_post_record")).toEqual([
      "start.cinatra_run_id->cinatra_run_id",
      "start.postArtifactId->postArtifactId",
    ]);
    // The first read of the artifact, in front of the review, takes the same
    // start inputs and nothing else.
    expect(edgesInto("gather_review_target")).toEqual([
      "start.cinatra_run_id->cinatra_run_id",
      "start.postArtifactId->postArtifactId",
      "start.postRepresentationRevisionId->postRepresentationRevisionId",
    ]);
    // No second step runs the pack's tool: the flow has one extension_tool step.
    expect(components.check_review).toBeUndefined();
  });

  it("Pin 4c: the words read for publishing are the revision the review approved, not the one the run started with", () => {
    // A person can choose Regenerate on the review and approve the successor.
    // The review step answers with the approved target, so the read step takes
    // its revision from that answer (the pack's declared approved_post_text
    // tool), and the publish step gets the approved artifact and revision from
    // the read step. The start revision feeds only the review itself.
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const readData = components.read_post_text.data as {
      tool?: string;
      input?: { name?: string; input?: Record<string, unknown> };
    };
    expect(readData.tool).toBe("extension_tool");
    expect(readData.input?.name).toBe("approved_post_text");
    expect(readData.input?.input).toEqual({
      reviewDecision: "{{ reviewDecision }}",
      artifactId: "{{ postArtifactId }}",
      postRecord: "{# pyagentspec-input-hint: {{ postRecord }} #}{{ postRecord | tojson }}",
    });
    // The one tool the pack declares, and the only one the read step can name.
    const tools = ((pkg.cinatra ?? {}) as { tools?: unknown }).tools;
    expect(tools).toEqual([
      { name: "approved_post_text", module: "./cinatra/tools/approved-post-text.mjs" },
    ]);
    // The read step takes the review's answer from the review, the record from
    // the record read, and the artifact from the start input: exactly these.
    expect(edgesInto("read_post_text")).toEqual([
      "read_post_record.artifact->postRecord",
      "review_post.reviewDecision->reviewDecision",
      "start.cinatra_run_id->cinatra_run_id",
      "start.postArtifactId->postArtifactId",
    ]);
    // The publish step takes the approved artifact and revision, the title and
    // the truncation flag from the read step, the HTML from the HTML step and
    // the site from the start input: one edge for each input, from exactly
    // that source, and no other edge into the step (not the words a second
    // time). The runtime surfaces whatever feeds an input, so the title and
    // the HTML on the card and in the site write are the ones named here.
    expect(edgesInto("publish")).toEqual([
      "read_post_text.artifactId->postArtifactId",
      "read_post_text.representationRevisionId->postRepresentationRevisionId",
      "read_post_text.title->postTitle",
      "read_post_text.truncated->truncated",
      "start.instanceId->instanceId",
      "write_post_html.postHtml->postHtml",
    ]);
    expect(titlesOf(stepOf("publish").inputs)).toEqual([
      "instanceId",
      "postArtifactId",
      "postHtml",
      "postRepresentationRevisionId",
      "postTitle",
      "truncated",
    ]);
    // The HTML the person sees on the card is the HTML the publish step sends:
    // it is written from the approved words (and from nothing else).
    expect(edgesInto("write_post_html")).toEqual(["read_post_text.text->postText"]);
    // The write-back writes onto the approved artifact, the run's own receipt
    // ends the flow, and the review's start revision feeds only the review.
    expect(edgesInto("write_address")).toEqual([
      "publish.addressPatch->addressPatch",
      "read_post_text.artifactId->postArtifactId",
      "start.cinatra_run_id->cinatra_run_id",
    ]);
    expect(edgesInto("end")).toEqual([
      "publish.addressWritten->addressWritten",
      "publish.approved->approved",
      "publish.postArtifactId->postArtifactId",
      "publish.postRepresentationRevisionId->postRepresentationRevisionId",
      "publish.publishedExternalId->publishedExternalId",
      "publish.publishedUrl->publishedUrl",
      "publish.summary->summary",
    ]);
    const edges = dataEdges.map(
      (e) =>
        `${e.source_node.$component_ref}.${e.source_output}->${e.destination_node.$component_ref}.${e.destination_input}`,
    );
    expect(edges.filter((e) => e.startsWith("start.postRepresentationRevisionId->"))).toEqual([
      "start.postRepresentationRevisionId->gather_review_target.postRepresentationRevisionId",
    ]);
  });

  it("Pin 5: single ApiNode targeting templated /api/llm-bridge, agent_id, no skill_source_path", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const publish = components.publish as Record<string, unknown>;
    expect(publish.component_type).toBe("ApiNode");
    expect(publish.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const data = publish.data as Record<string, unknown>;
    expect(data.agent_id).toBe("blog-wordpress-publish-agent");
    expect(data.skill_source_path).toBeUndefined();
    // The step's tool ceiling is exactly the two site tools: a step that
    // declares a list is offered those and nothing else.
    const publishMeta = (publish.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(publishMeta.tools).toEqual(["wordpress_site_tools_list", "wordpress_site_tool_write"]);
  });

  // THE HTML STEP FOLLOWS THE SKILL THE PACK DECLARES (cinatra#4893). The bridge
  // does not read a skill name from the step. It reads `agent_id`, which is the
  // package DIRECTORY of the consumer, resolves the consumer's one role-less,
  // required, runtime dependency of kind skill (the declared edge,
  // packages/skills/src/extension-skill-resolver.ts), and mounts that provider's
  // one bundle, only when the step names no `skill_source_path` and the
  // consumer ships no bundle of its own (src/app/api/llm-bridge/route.ts). A
  // step that declares a tool list, even an empty one, is not offered the
  // skill. So every one of those facts is pinned here, and the provider is
  // checked by what the bridge needs of it (a pinned one-bundle skill pack),
  // not by a package name: a core test does not name a pinned pack (the
  // core-pack-pin check), and the pack's own tests name it.
  it("Pin 5b: the HTML step is the one the bridge resolves the declared skill for", () => {
    const html = stepOf("write_post_html");
    expect(html, "the flow carries the write_post_html step").toBeTruthy();
    expect(html.component_type).toBe("ApiNode");
    expect(html.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const data = html.data as Record<string, unknown>;
    // The identity the bridge reads: the agent's own directory name, and no
    // explicit skill path (that would skip the declared edge).
    expect(data.agent_id).toBe(path.basename(agentDir));
    expect(data.agent_id).toBe((stepOf("publish").data as Record<string, unknown>).agent_id);
    expect(Object.hasOwn(data, "skill_source_path")).toBe(false);
    // No tool ceiling on the step (a ceiling removes the skill tool), and no
    // toolbox: the skill is the only thing the model is offered.
    const meta = (html.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(Object.hasOwn(meta, "tools")).toBe(false);
    expect(data.toolbox_ids).toEqual([]);
    // The approved words are the model's only input, and the HTML its only output.
    expect(titlesOf(html.inputs)).toEqual(["postText"]);
    expect(titlesOf(html.outputs)).toEqual(["postHtml"]);
    expect(String(data.user)).toContain("{{ postText }}");
    // The pack ships no bundle of its own: the bridge consults the declared
    // edge only when the co-located bundle is missing.
    expect(fs.existsSync(path.join(agentDir, "skills"))).toBe(false);

    // The declared edge: exactly one dependency of kind skill, a required
    // runtime edge with no role, so the resolver finds a single edge.
    const dependencies = ((pkg.cinatra ?? {}) as { dependencies?: Array<Record<string, unknown>> })
      .dependencies ?? [];
    const skillEdges = dependencies.filter((d) => d.kind === "skill");
    expect(skillEdges).toEqual([
      {
        packageName: expect.any(String),
        edgeType: "runtime",
        versionConstraint: { kind: "semver-range", range: "*" },
        requirement: "required",
        kind: "skill",
      },
    ]);
    expect(Object.hasOwn(skillEdges[0], "role")).toBe(false);
    const providerName = skillEdges[0].packageName as string;

    // The provider is pinned by core, is a pack of kind skill that carries that
    // name, and ships exactly one bundle: the one the step tells the model to read.
    const repoRoot = path.resolve(agentDir, "../../..");
    const lock = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "cinatra-dev-extensions.lock.json"), "utf8"),
    ) as { packages: Array<{ packageName: string }> };
    expect(lock.packages.map((p) => p.packageName)).toContain(providerName);
    const providerDir = path.join(repoRoot, "extensions", providerName.replace(/^@/, ""));
    const providerPkg = JSON.parse(fs.readFileSync(path.join(providerDir, "package.json"), "utf8")) as {
      name?: string;
      cinatra?: { kind?: string };
    };
    expect(providerPkg.name).toBe(providerName);
    expect(providerPkg.cinatra?.kind).toBe("skill");
    const bundles = fs
      .readdirSync(path.join(providerDir, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(providerDir, "skills", d.name, "SKILL.md")))
      .map((d) => d.name);
    expect(bundles).toHaveLength(1);
    const named = /Your skill, ([a-z0-9]+(?:-[a-z0-9]+)*), holds the rules/.exec(String(data.system));
    expect(named, "the step's instruction names the skill it follows").toBeTruthy();
    expect(named![1]).toBe(bundles[0]);
  });

  it("Pin 6: StartNode required + hidden cover", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = components.start as Record<string, unknown>;
    const meta = (start.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    // cinatra#4313: the connected site is the start input `instanceId`, the one
    // name the run's connector-instance binding (cinatra#4220) is derived from.
    expect(meta.required).toEqual([
      "postArtifactId",
      "postRepresentationRevisionId",
      "instanceId",
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
  it("takes an artifact reference, never raw text and never a blog record", () => {
    expect(skill).toContain("never raw text and never a blog record");
    expect(skill).toContain("the review's projection step reads the artifact's record (artifacts_get)");
    expect(skill).toContain(
      "a step reads the approved revision's words (artifact_content_read, through the tool this package declares)",
    );
    // Defensive: the blog-record road's obsolete BackgroundProcessRunStatus
    // string must not come back with it.
    const wrongMatches = skill.match(/status === ["']completed["']/g);
    expect(wrongMatches ?? []).toEqual([]);
  });

  it("reaches no blog record and polls no generation", () => {
    expect(skill).toContain("you never reach a blog record");
    expect(skill).not.toContain("blog_project_get");
    expect(skill).not.toContain("blog_post_publish_wordpress_status");
  });

  it("publishes the approved revision's words, not a draft row's", () => {
    expect(skill).toContain("THE REVISION THE REVIEW APPROVED");
    expect(skill).toContain("postRepresentationRevisionId");
    expect(skill).not.toContain("wordpressDraftGeneration");
    expect(skill).not.toMatch(/post\.wordpressDrafts/);
  });

  it("publishes through the site's own catalogue, and only a publicly published page", () => {
    expect(skill).toContain("wordpress_site_tools_list");
    expect(skill).toContain("wordpress_site_tool_write");
    expect(skill).not.toContain("wordpress_site_tool_call");
    expect(skill).toContain("PUBLICLY VISIBLE");
    // Nothing reaches the site before the person's decision on the host's
    // publish card, so a decline has nothing to remove and the delete-on-reject
    // call is gone.
    expect(skill).toContain("you run only after the person chose Publish there");
    expect(skill).not.toContain("blog_post_publish_wordpress_delete");
    // The body is the HTML the skill step wrote, sent unchanged.
    expect(skill).toContain("`postHtml: string` — THE BODY YOU PUBLISH");
    expect(skill).toContain("you convert nothing yourself");
    expect(skill).toContain("When `postHtml` is empty, there is no body the person saw");
  });

  it("takes the page's title only from the title the publish card shows, never from the artifact's current state", () => {
    expect(skill).toContain("The page's title is `postTitle`, exactly as given");
    expect(skill).toContain("never take one from a section heading inside `postHtml`");
    // No title on the card: nothing is published.
    expect(skill).toContain("An empty `postTitle` means there is no title the person saw");
    // The publish step is handed no record of the artifact at all, only the
    // title and the HTML the card shows (not the words a second time).
    expect(titlesOf(stepOf("publish").inputs)).toEqual([
      "instanceId",
      "postArtifactId",
      "postHtml",
      "postRepresentationRevisionId",
      "postTitle",
      "truncated",
    ]);
    // The title that goes out is the one the card shows: the one edge into the
    // title input comes from the read step's title output.
    expect(edgesInto("publish").filter((e) => e.endsWith("->postTitle"))).toEqual([
      "read_post_text.title->postTitle",
    ]);
  });

  it("names no pack renderer key: the host's review and publish cards replace the pack screen", () => {
    expect(skill).not.toContain("@cinatra-ai/blog-wordpress-publish-agent:draft-confirm");
    expect(skill).not.toContain("x-renderer");
  });

  it("declares no field renderer: a run never stops on a pack screen", () => {
    const cinatra = (pkg.cinatra ?? {}) as Record<string, unknown>;
    expect(cinatra.fieldRenderers).toBeUndefined();
  });

  it("the failure envelope carries exactly the declared output keys, approved, and the empty patch", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const declared = (components.publish.outputs as Array<{ title: string }>).map((o) => o.title).sort();
    const tail = skill.slice(
      skill.indexOf("The failure envelope, with a one-line `summary` that names the cause"),
    );
    const block = /```json\n([\s\S]*?)\n```/.exec(tail);
    expect(block, "the recipe spells out its failure envelope").toBeTruthy();
    const envelope = JSON.parse(block![1]) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(declared);
    expect(envelope.approved).toBe(true);
    expect(envelope.addressWritten).toBe(false);
    expect(envelope.publishedUrl).toBe("");
    expect(envelope.publishedExternalId).toBe("");
    expect(envelope.addressPatch).toEqual({
      wordpressPublishedUrl: "",
      wordpressPublishedExternalId: "",
      wordpressPublishedRevisionId: "",
    });
    // The partial envelope (the site returned only an address or only an id)
    // carries the same empty patch, so its write-back writes nothing either.
    const partialTail = skill.slice(skill.indexOf("The partial envelope"));
    const partialBlock = /```json\n([\s\S]*?)\n```/.exec(partialTail);
    expect(partialBlock, "the recipe spells out its partial envelope").toBeTruthy();
    const partial = JSON.parse(partialBlock![1]) as Record<string, unknown>;
    expect(Object.keys(partial).sort()).toEqual(declared);
    expect(partial.addressWritten).toBe(false);
    expect(partial.addressPatch).toEqual(envelope.addressPatch);
  });
});

// cinatra#3564 — THE POINT OF THIS PIN, pinned positively so it cannot quietly
// go away: after the post is published the run writes the published address
// BACK onto the post's artifact. The declaration is what makes it reach the
// artifact at all — an object level with no declared members is asked for
// closed and empty — so the declaration AND the write-back road it feeds are
// both pinned here. Without these three cases the write_address node could be
// deleted and every other case in this file would still pass.
describe("blog-wordpress-publish-agent — the published address reaches the artifact (#3564)", () => {
  type Ref = { $component_ref: string };
  const components = () => oas.$referenced_components as Record<string, Record<string, unknown>>;
  const MEMBERS = [
    "wordpressPublishedExternalId",
    "wordpressPublishedRevisionId",
    "wordpressPublishedUrl",
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
    expect(data.input?.objectId).toBe("{{ postArtifactId }}");
    // The leaf writes the patch only when each of its three members is
    // present and non-empty. A run that published nothing renders the empty
    // patch {}, and that patch still reaches objects_update. objects_update
    // writes nothing for an empty patch (no new version, no history or outbox
    // row) once the host's empty-patch fix is on main; this pin merges after it.
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
