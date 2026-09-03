/**
 * `produces:` plumbing path (not OAS-cosmetic).
 *
 * The `produces:` source-of-truth path must be tested, not just present as OAS
 * metadata: package manifest (`package.json` `cinatra.produces`) →
 * `readAgentProducesFromPackageManifest` → the producer-assertion plan. This
 * asserts the published blog agents expose `produces:` in their manifest AND
 * resolve to the expected artifact type, and that the image generator resolves
 * to none because a picture has no write road yet.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/blog-agent-produces-plumbing.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentProducesFromPackageManifest } from "../agent-produces-reader";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");

function manifest(agent: string): unknown {
  return JSON.parse(readFileSync(join(EXT, agent, "package.json"), "utf8"));
}

// cinatra#3034 re-ratification: every blog producer's entry is now TYPED — it
// names the exact object type the production lands on, not just the extension —
// and the LinkedIn writer, which used to declare nothing, produces a LinkedIn
// post draft.
describe("produces: plumbing — package.json → readAgentProducesFromPackageManifest", () => {
  it("blog-idea-generator-agent → the blog-idea type", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-idea-generator-agent"));
    expect(out).toEqual([
      {
        extension: "@cinatra-ai/blog-idea-artifact",
        objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
      },
    ]);
  });

  it("blog-draft-writer-agent → the blog-post type", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-draft-writer-agent"));
    expect(out).toEqual([
      {
        extension: "@cinatra-ai/blog-post-artifact",
        objectTypeId: "@cinatra-ai/blog-post-artifact:post",
      },
    ]);
  });

  it("blog-image-generator-agent → NONE (the picture's write road is not built)", () => {
    // The prompt writer this package replaces declared nothing because it made
    // nothing. This one MAKES a picture, and still declares nothing: a produces
    // entry is a promise a run keeps, and the fleet's blocking adoption gate
    // refuses one no materialization road reaches. The three roads it
    // recognises — an EndNode output binding, an `artifact_materialize` node,
    // an `artifact_authoring_emit` claim — are each scoped to text-authorable
    // MIMEs, so a picture has none an agent can take. The entry arrives with
    // the road; the EDGE is already declared, and
    // `blog-agent-declarations.test.ts` pins it.
    const out = readAgentProducesFromPackageManifest(manifest("blog-image-generator-agent"));
    expect(out).toEqual([]);
    const pkg = manifest("blog-image-generator-agent") as {
      cinatra: { produces?: unknown };
    };
    expect(pkg.cinatra.produces).toBeUndefined();
  });

  it("blog-linkedin-writer-agent → the LinkedIn post-draft type", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-linkedin-writer-agent"));
    expect(out).toEqual([
      {
        extension: "@cinatra-ai/linkedin-artifacts",
        objectTypeId: "@cinatra-ai/linkedin:post-draft",
      },
    ]);
  });

  it("the OAS metadata.cinatra.produces mirrors the manifest array shape (consistency, not the source of truth)", () => {
    for (const agent of [
      "blog-idea-generator-agent",
      "blog-draft-writer-agent",
      "blog-linkedin-writer-agent",
    ] as const) {
      const oas = JSON.parse(readFileSync(join(EXT, agent, "cinatra", "oas.json"), "utf8"));
      const pkg = manifest(agent) as { cinatra: { produces: unknown } };
      expect(oas.metadata.cinatra.produces).toEqual(pkg.cinatra.produces);
    }
  });
});
