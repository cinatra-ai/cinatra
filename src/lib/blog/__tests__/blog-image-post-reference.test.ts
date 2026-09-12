// ---------------------------------------------------------------------------
// THE PICTURE NAMES ITS POST (lifecycle-c W9, the re-pin half).
//
// The picture type declares `post` and `placement` as REQUIRED fields at the
// new pin, so the host's fixed file envelope alone no longer satisfies the
// type's schema. Without the reference every picture materialization would be
// refused by the declared-schema check.
//
// WHERE THE REFERENCE IS DECIDED MOVED, AND THE PROPERTY DID NOT. It used to be
// decided at the call site inside `src/lib/blog` — the pack-shaped core domain
// the core/extension border baseline holds SHRINK-ONLY — which is the one place
// a fact about an artifact type's declared field should not live. The call site
// now hands the host module the draft it already has, and
// `postReferenceForDraft` in `src/lib/blog-image-materializer.ts` decides which
// id names the post. So this file pins the property in BOTH halves: the caller
// hands the draft over, and the host resolves it the way the type requires.
//
//   pnpm exec vitest run src/lib/blog/__tests__/blog-image-post-reference.test.ts
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildFeaturedImageFields, readFeaturedImageFields } from "@/lib/artifacts/featured-image-fields";
import { postReferenceForDraft } from "@/lib/blog-image-materializer";

const GENERATION_SRC = readFileSync(
  path.resolve(__dirname, "..", "generation.ts"),
  "utf8",
);

describe("the image-regeneration job names the post its picture belongs to", () => {
  it("the materializeBlogImage call site hands the draft to the host module", () => {
    const call = GENERATION_SRC.slice(GENERATION_SRC.indexOf("materializeBlogImage({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("draft: post");
    // ...and it does NOT decide the reference itself: that decision is a fact
    // about the picture type's declared field and lives in the host module, so
    // the shrink-only pack-shaped domain never carries it.
    expect(args).not.toContain("postArtifactId");
  });

  it("the host resolves the POST'S OWN ARTIFACT when the body is materialized", () => {
    expect(
      postReferenceForDraft({ id: "draft-1", title: "T", postArtifactId: "art-post-1" }),
    ).toBe("art-post-1");
  });

  it("a draft with no materialized body is named by its durable draft id", () => {
    expect(postReferenceForDraft({ id: "draft-1", title: "T", postArtifactId: null })).toBe(
      "draft-1",
    );
  });

  it("a draft naming neither is answered null — never an invented reference", () => {
    expect(postReferenceForDraft({ id: "   ", title: "T", postArtifactId: "  " })).toBeNull();
    expect(postReferenceForDraft(undefined)).toBeNull();
  });

  it("what the host resolves satisfies the host's reader", () => {
    const fields = buildFeaturedImageFields({
      post: postReferenceForDraft({ id: "draft-1", postArtifactId: "art-1" }) as string,
    });
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
