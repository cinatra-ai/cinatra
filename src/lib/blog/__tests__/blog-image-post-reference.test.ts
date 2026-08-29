// ---------------------------------------------------------------------------
// THE PICTURE NAMES ITS POST AT THE CALL SITE (lifecycle-c W9, the re-pin half).
//
// The picture type declares `post` and `placement` as REQUIRED fields at the
// new pin, so the host's fixed file envelope alone no longer satisfies the
// type's schema. The materializer carries the pair, but only when its CALLER
// names the post — and the image-regeneration job is the one production caller.
// Without the reference every picture materialization would be refused by the
// declared-schema check, so the call site is pinned here in source, the way the
// publish-side artifact-read contract is pinned.
//
//   pnpm exec vitest run src/lib/blog/__tests__/blog-image-post-reference.test.ts
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildFeaturedImageFields, readFeaturedImageFields } from "@/lib/artifacts/featured-image-fields";

const GENERATION_SRC = readFileSync(
  path.resolve(__dirname, "..", "generation.ts"),
  "utf8",
);

describe("the image-regeneration job names the post its picture belongs to", () => {
  it("the materializeBlogImage call site passes a post reference", () => {
    const call = GENERATION_SRC.slice(GENERATION_SRC.indexOf("materializeBlogImage({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("post:");
    // The post's own artifact is the reference when it exists; a draft whose
    // body is not materialized yet is named by its durable draft id, so the
    // call can never reach the creation road without naming its post.
    expect(args).toContain("post.postArtifactId");
  });

  it("what the call site passes satisfies the host's reader", () => {
    const fields = buildFeaturedImageFields({ post: "art-1" });
    expect(readFeaturedImageFields(fields)).toEqual({
      ok: true,
      post: "art-1",
      placement: "featured",
    });
  });

  it("a picture that names no post is READ as such rather than drawn wrong", () => {
    expect(readFeaturedImageFields({ mime: "image/png" })).toEqual({
      ok: false,
      reason: "no-post",
    });
  });
});
