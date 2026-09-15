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
const LINKEDIN = "@cinatra-ai/linkedin-artifacts";

const IDEA_TYPE = "@cinatra-ai/blog-idea-artifact:blog-idea";
const POST_TYPE = "@cinatra-ai/blog-post-artifact:post";
const IMAGE_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";
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
    // The picture it settles has no write road an agent can take: the three
    // roads the fleet's blocking adoption gate recognises — an EndNode output
    // binding, an `artifact_materialize` node, an `artifact_authoring_emit`
    // claim — are each scoped to text-authorable MIMEs, and the gate refuses a
    // produces entry no recognised road reaches. (The host does file picture
    // bytes on its own campaigns road; that road is neither recognised by the
    // gate nor reachable from an agent.) Its entry waits with the pipeline's
    // two. BOTH EDGES stay: they say what the run touches, which is true today.
    produces: [],
    edges: [IMAGE, POST].sort(),
  },
  {
    agent: "blog-linkedin-writer-agent",
    produces: [{ extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE }],
    edges: [POST, LINKEDIN].sort(),
  },
  {
    agent: "blog-linkedin-publish-agent",
    // A KNOWN NON-PRODUCER, and its pinned head says so explicitly. The
    // publisher is handed a draft that already exists, writes the published
    // address back onto that same artifact and persists no revision, so no
    // recognised write road reaches a new artifact: the pack declares an empty
    // produces set in both its manifest and its flow document, and the fleet's
    // adoption gate reads that emptiness directly. Its EDGE stays: it says what
    // the run touches, which is true either way.
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
    // A produces entry is a promise the run keeps: the pipeline files its draft
    // and its LinkedIn post through terminal bindings today. Its ideas and its
    // pictures go through mid-run write roads that are not built yet, so those
    // two entries wait for them — the fleet's adoption gate refuses a declared
    // production nothing materializes. All four EDGES stay: they say what the
    // run touches, which is true either way.
    produces: [
      { extension: POST, objectTypeId: POST_TYPE },
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

  it("declares the fourteen dependency edges section 5.3.2 counts", () => {
    // All fourteen. The last two arrived with the image agent's own package,
    // which replaces the retired prompt writer.
    const total = TABLE.reduce((n, row) => n + row.edges.length, 0);
    expect(total).toBe(14);
  });

  it("declares five of the eight typed produces entries", () => {
    // Eight after the prototype, not nine: the publisher's entry is RETIRED
    // rather than waiting, because its flow files nothing of its own. Three of
    // the eight wait for their write roads, not for their packages: the image
    // agent's own entry and the pipeline's idea and picture entries. No road an
    // agent can take reaches a picture today.
    const total = TABLE.reduce((n, row) => n + row.produces.length, 0);
    expect(total).toBe(5);
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
