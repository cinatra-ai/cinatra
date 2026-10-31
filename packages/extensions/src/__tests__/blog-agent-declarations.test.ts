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
const IMAGE = "@cinatra-ai/blog-image-artifact";
const PICTURE = "@cinatra-ai/image-artifact";
const LINKEDIN = "@cinatra-ai/linkedin-artifacts";
const BRAND_VOICE = "@cinatra-ai/brand-voice-artifact";

const IDEA_TYPE = "@cinatra-ai/blog-idea-artifact:blog-idea";
const POST_TYPE = "@cinatra-ai/blog-post-artifact:post";
const IMAGE_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";
const PICTURE_TYPE = "@cinatra-ai/image-artifact:image";
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
    // blog-draft-writer-agent#50 added the brand-voice edge: the writer reads
    // the picked brand voice through its brand-voice context slot.
    produces: [{ extension: POST, objectTypeId: POST_TYPE }],
    edges: [IDEA, POST, BRAND_VOICE].sort(),
  },
  {
    agent: "blog-image-generator-agent",
    // The picture it settles has no write road an agent can take: the three
    // roads the fleet's blocking adoption gate recognises — an EndNode output
    // binding, an `artifact_materialize` node, an `artifact_authoring_emit`
    // claim — are each scoped to text-authorable MIMEs, and the gate refuses a
    // produces entry no recognised road reaches. (The host does file picture
    // bytes on its own campaigns road; that road is neither recognised by the
    // gate nor reachable from an agent.) Its entry waits with the pipeline's
    // two. blog-image-generator-agent#5 dropped the blog-image edge: the
    // pipeline that embeds this agent files the picture as
    // `@cinatra-ai/image-artifact:image`. blog-image-generator-agent#6 added
    // the brand-voice edge for the brand-voice context slot it reads.
    produces: [],
    edges: [POST, BRAND_VOICE].sort(),
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
    produces: [],
    edges: [IMAGE, POST].sort(),
  },
  {
    agent: "blog-pipeline-agent",
    // A produces entry is a promise the run keeps: the pipeline writes its draft
    // and its LinkedIn post mid-run through the host's materialize tool, and
    // files its featured image mid-run through the host's image tool as an
    // image artifact. Only its ideas entry still waits for a write road — the
    // fleet's adoption gate refuses a declared production nothing
    // materializes. All four EDGES stay: they say what the run touches.
    // blog-pipeline-agent#77 added a fifth, the brand-voice edge: the pipeline
    // asks once for one stored brand voice and hands it to the writer and the
    // image generator.
    produces: [
      { extension: POST, objectTypeId: POST_TYPE },
      { extension: PICTURE, objectTypeId: PICTURE_TYPE },
      { extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE },
    ],
    edges: [IDEA, POST, PICTURE, LINKEDIN, BRAND_VOICE].sort(),
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

  it("declares sixteen artifact-kind dependency edges, counted from the manifests", () => {
    // Section 5.3.2 counted fourteen; the image agent's own package, which
    // replaces the retired prompt writer, brought the last two of them. The
    // brand-voice slot (cinatra#4314) then added three brand-voice edges (the
    // writer, the image generator and the pipeline) and dropped the image
    // generator's blog-image edge. The total is read from the pinned manifests,
    // not summed from the table above, so a stale row cannot hide behind its
    // own sum.
    const total = TABLE.reduce((n, row) => n + edges(row.agent).length, 0);
    expect(total).toBe(16);
  });

  it("declares six of the nine typed produces entries", () => {
    // Nine after the prototype. Two wait, not for their packages: the image
    // agent's own entry (the pipeline files the picture through its own image
    // step) and the pipeline's ideas entry, which waits for its write road. The
    // third absence is different in kind: the LinkedIn PUBLISHER's entry is
    // RETIRED, not waiting — at its pin it writes an address onto the writer's
    // artifact instead of producing one, so it declares no produces entry at all.
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
