/**
 * `produces:` plumbing path (not OAS-cosmetic).
 *
 * The `produces:` source-of-truth path must be tested, not just present as OAS
 * metadata: package manifest (`package.json` `cinatra.produces`) →
 * `readAgentProducesFromPackageManifest` → the producer-assertion plan. This
 * asserts the published blog agents expose `produces:` in their manifest AND
 * resolve to the expected artifact type, and that the text-only image-prompt
 * agent resolves to none because it emits prompts, not artifacts.
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

describe("produces: plumbing — package.json → readAgentProducesFromPackageManifest", () => {
  it("blog-idea-generator-agent → @cinatra-ai/blog-idea-artifact", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-idea-generator-agent"));
    expect(out).toEqual([{ extension: "@cinatra-ai/blog-idea-artifact" }]);
  });

  it("blog-draft-writer-agent → @cinatra-ai/blog-post-artifact", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-draft-writer-agent"));
    expect(out).toEqual([{ extension: "@cinatra-ai/blog-post-artifact" }]);
  });

  it("blog-image-prompt-agent → NONE (text-only; no produces)", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-image-prompt-agent"));
    expect(out).toEqual([]);
    const pkg = manifest("blog-image-prompt-agent") as any;
    expect(pkg.cinatra.produces).toBeUndefined();
  });

  it("blog-linkedin-writer-agent → NONE (no produces)", () => {
    const out = readAgentProducesFromPackageManifest(manifest("blog-linkedin-writer-agent"));
    expect(out).toEqual([]);
  });

  it("the OAS metadata.cinatra.produces mirrors the manifest array shape (consistency, not the source of truth)", () => {
    for (const [agent, expected] of [
      ["blog-idea-generator-agent", "@cinatra-ai/blog-idea-artifact"],
      ["blog-draft-writer-agent", "@cinatra-ai/blog-post-artifact"],
    ] as const) {
      const oas = JSON.parse(readFileSync(join(EXT, agent, "cinatra", "oas.json"), "utf8"));
      expect(oas.metadata.cinatra.produces).toEqual([{ extension: expected }]);
    }
  });
});
