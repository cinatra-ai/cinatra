/**
 * The blog agents' declaration gate (cinatra#3034, plan section 5.3.2).
 *
 * Every blog agent declares the extension of every artifact it PRODUCES and of
 * every artifact it READS, because the read road admits only declared kinds. A
 * producer edge resolves a produces entry through a terminal binding or a
 * mid-run write; a consumer edge resolves nothing and admits reads.
 *
 * This gate reads the PINNED trees under `extensions/cinatra-ai`, so it moves
 * only when the lock moves. Two of the packs below defer their own standalone
 * suite to this repository, so their declarations are pinned HERE rather than
 * in their own test folders.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");

const IDEA = "@cinatra-ai/blog-idea-artifact";
const POST = "@cinatra-ai/blog-post-artifact";
const IMAGE = "@cinatra-ai/image-artifact";
const LINKEDIN = "@cinatra-ai/linkedin-artifacts";

const IDEA_TYPE = "@cinatra-ai/blog-idea-artifact:blog-idea";
const POST_TYPE = "@cinatra-ai/blog-post-artifact:post";
const IMAGE_TYPE = "@cinatra-ai/image-artifact:image";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";

type Manifest = {
  cinatra: {
    produces?: Array<{ extension: string; objectTypeId?: string }> | null;
    dependencies?: Array<{ packageName: string; kind?: string }> | null;
  };
};

const manifest = (agent: string): Manifest =>
  JSON.parse(readFileSync(join(EXT, agent, "package.json"), "utf8")) as Manifest;

/** The artifact-kind dependency edges an agent declares, sorted. */
const edges = (agent: string): string[] =>
  (manifest(agent).cinatra.dependencies ?? [])
    .filter((d) => d.kind === "artifact")
    .map((d) => d.packageName)
    .sort();

const produces = (agent: string): Array<{ extension: string; objectTypeId?: string }> =>
  manifest(agent).cinatra.produces ?? [];

// The table of section 5.3.2, whole: the image agent's own package has arrived,
// so every row of the plan's table is here. Each row is an agent, what it
// produces (typed), and every artifact kind it declares an edge to — written,
// read, or both.
const TABLE: Array<{
  agent: string;
  produces: Array<{ extension: string; objectTypeId: string }>;
  edges: string[];
}> = [
  {
    agent: "blog-idea-generator-agent",
    produces: [{ extension: IDEA, objectTypeId: IDEA_TYPE }],
    edges: [IDEA],
  },
  {
    agent: "blog-draft-writer-agent",
    produces: [{ extension: POST, objectTypeId: POST_TYPE }],
    edges: [IDEA, POST].sort(),
  },
  {
    agent: "blog-image-generator-agent",
    // The picture it settles is filed by the pipeline's own step through the
    // host's image tool, mid-run, so the produces entry for that picture is the
    // pipeline's and this agent declares none. At its pin it declares one
    // artifact edge, the blog post it reads.
    produces: [],
    edges: [POST],
  },
  {
    agent: "blog-linkedin-writer-agent",
    produces: [{ extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE }],
    edges: [POST, LINKEDIN].sort(),
  },
  {
    agent: "blog-linkedin-publish-agent",
    // NOT a producer at this pin. The publisher takes the post-draft artifact
    // revision the person continued with, posts it, and merges the published
    // address onto THAT artifact through `objects_update`; the LinkedIn writer
    // is what authors the artifact. Its manifest declares `produces: []`
    // accordingly — a receipt, never a new artifact. The EDGE stays: it says
    // what the run touches, which is true either way.
    produces: [],
    edges: [LINKEDIN],
  },
  {
    agent: "blog-wordpress-publish-agent",
    // At its pin it declares one artifact edge, the blog post it publishes.
    produces: [],
    edges: [POST],
  },
  {
    agent: "blog-pipeline-agent",
    // A produces entry is a promise the run keeps: the pipeline writes its draft
    // and its LinkedIn post mid-run through the host's materialize tool, and
    // its picture mid-run by the pipeline's own image step through the host's
    // image tool. Only the ideas entry still waits for its write road — the fleet's
    // adoption gate refuses a declared production nothing materializes. All
    // four EDGES stay: they say what the run touches, which is true either way.
    // At its pin it files the picture as an image artifact and declares that edge.
    produces: [
      { extension: POST, objectTypeId: POST_TYPE },
      { extension: IMAGE, objectTypeId: IMAGE_TYPE },
      { extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE },
    ],
    edges: [IDEA, POST, IMAGE, LINKEDIN].sort(),
  },
];

describe("the blog agents' declarations (plan section 5.3.2)", () => {
  for (const row of TABLE) {
    describe(row.agent, () => {
      it("declares every artifact kind it writes or reads as an edge", () => {
        expect(edges(row.agent)).toEqual(row.edges);
      });

      it("declares what it produces, by exact type", () => {
        expect(produces(row.agent)).toEqual(row.produces);
      });
    });
  }

  it("declares the twelve dependency edges the pinned packs declare", () => {
    // Twelve at the current pins: the image agent and the publish agent no
    // longer declare the retired blog picture type.
    const total = TABLE.reduce((n, row) => n + row.edges.length, 0);
    expect(total).toBe(12);
  });

  it("declares six of the nine typed produces entries", () => {
    // Nine after the prototype. Two still wait, not for their packages: the
    // image agent's own entry (the picture is the pipeline's, filed by its own
    // image step) and the pipeline's ideas entry, which waits for its write
    // road. The third absence is different in kind: the LinkedIn PUBLISHER's
    // entry is RETIRED, not waiting — at its pin it writes an address onto the
    // writer's artifact instead of producing one, so it declares no produces
    // entry at all.
    const total = TABLE.reduce((n, row) => n + row.produces.length, 0);
    expect(total).toBe(6);
    for (const row of TABLE) {
      for (const entry of row.produces) {
        expect(entry.objectTypeId).toMatch(/^@[\w-]+\/[\w-]+:[\w-]+$/);
      }
    }
  });

  it("keeps the LinkedIn copy off the blog-post type, end to end", () => {
    // The one mis-targeted binding of section 5.3.1: the LinkedIn writer, the
    // LinkedIn publisher and the pipeline all filed LinkedIn copy as a second
    // blog post. None of them may name the blog-post extension for it now.
    for (const agent of [
      "blog-linkedin-writer-agent",
      "blog-linkedin-publish-agent",
    ]) {
      expect(produces(agent).map((p) => p.extension)).not.toContain(POST);
    }
    const publisherFlow = readFileSync(
      join(EXT, "blog-linkedin-publish-agent", "cinatra", "oas.json"),
      "utf8",
    );
    expect(publisherFlow).not.toContain(POST);
  });
});
