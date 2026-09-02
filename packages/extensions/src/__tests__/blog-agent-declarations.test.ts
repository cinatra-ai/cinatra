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

// The table of section 5.3.2, minus the image agent, which arrives with its own
// package. Each row is an agent, what it produces (typed), and every artifact
// kind it declares an edge to — written, read, or both.
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
    agent: "blog-linkedin-writer-agent",
    produces: [{ extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE }],
    edges: [POST, LINKEDIN].sort(),
  },
  {
    agent: "blog-linkedin-publish-agent",
    produces: [{ extension: LINKEDIN, objectTypeId: LINKEDIN_TYPE }],
    edges: [LINKEDIN],
  },
  {
    agent: "blog-wordpress-publish-agent",
    produces: [],
    edges: [IMAGE, POST].sort(),
  },
  {
    agent: "blog-pipeline-agent",
    produces: [
      { extension: IDEA, objectTypeId: IDEA_TYPE },
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

  it("declares the dependency edges section 5.3.2 counts, for the agents that exist", () => {
    // Twelve of the fourteen. The remaining two are the image agent's, which
    // arrives with its own package.
    const total = TABLE.reduce((n, row) => n + row.edges.length, 0);
    expect(total).toBe(12);
  });

  it("declares eight of the nine typed produces entries", () => {
    const total = TABLE.reduce((n, row) => n + row.produces.length, 0);
    expect(total).toBe(8);
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
