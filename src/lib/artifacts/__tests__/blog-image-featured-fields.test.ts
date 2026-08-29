// ---------------------------------------------------------------------------
// THE FEATURED IMAGE'S TWO DECLARED FIELDS, READ BY THE HOST (lifecycle-c W9,
// the re-pin half — the compatibility item the picture extension's own record
// named).
//
// The blog-image type's schema was a bare object with no properties. At the
// pinned revision it declares two REQUIRED fields — `post` (the post artifact
// the picture belongs to) and `placement` (`"featured"`, the one placement the
// pipeline makes) — and that is a compatibility item for the host, not a
// cosmetic one:
//
//   1. the host writes an artifact row's `objects.data` as a FIXED file
//      envelope and validates it against the declared schema before any blob
//      IO. With the two fields required and no road to supply them, creating a
//      picture through the host would be REFUSED at that check;
//   2. the surfaces that draw the featured image (the review, and the run
//      page's outputs list when it lands) need to READ the two fields back off
//      that row.
//
// So the host gains both halves here: a declared-fields road into the envelope,
// and a reader that narrows the row's data to the two fields or names why it
// cannot. Both are proved against the REAL registered type from the LIVE pinned
// tree — never a fixture schema.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import {
  buildArtifactObjectEnvelope,
  RESERVED_ARTIFACT_ENVELOPE_KEYS,
  snapshotDeclaredObjectFields,
} from "../artifact-object-envelope";
import {
  FEATURED_PLACEMENT,
  buildFeaturedImageFields,
  readFeaturedImageFields,
} from "../featured-image-fields";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");
const BLOG_IMAGE_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";
const POST_ID = "3f1f8a1e-0000-4000-8000-000000000001";

const fileEnvelope = {
  artifactType: "file",
  latestRepresentationRevisionId: "rev-1",
  latestDigest: "sha256-abc",
  mime: "image/png",
  size: 1234,
  originKind: "agent_generated" as const,
  viewerHint: "mime",
  title: "The featured image",
};

beforeAll(() => {
  objectTypeRegistry._clearForTests();
  registerArtifactExtensions(EXT_ROOT);
});

describe("the picture type's two declared fields, against the live pinned tree", () => {
  it("declares post and placement as REQUIRED — the plain file envelope no longer satisfies it", () => {
    const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
    expect(def, BLOG_IMAGE_TYPE).not.toBeNull();
    expect(def!.schema.safeParse(fileEnvelope).success).toBe(false);
  });

  it("accepts the envelope once the host supplies the two declared fields", () => {
    const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
    const envelope = buildArtifactObjectEnvelope(
      fileEnvelope,
      buildFeaturedImageFields({ post: POST_ID }),
    );
    expect(def!.schema.safeParse(envelope).success).toBe(true);
  });

  it("refuses a placement the type does not declare", () => {
    const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
    const envelope = buildArtifactObjectEnvelope(fileEnvelope, {
      post: POST_ID,
      placement: "body",
    });
    expect(def!.schema.safeParse(envelope).success).toBe(false);
  });
});

describe("the declared-fields road into the object envelope", () => {
  it("carries the declared fields alongside the envelope, changing nothing else", () => {
    const envelope = buildArtifactObjectEnvelope(fileEnvelope, { post: POST_ID, placement: FEATURED_PLACEMENT });
    expect(envelope).toMatchObject(fileEnvelope);
    expect(envelope).toMatchObject({ post: POST_ID, placement: "featured" });
  });

  it("is a no-op when a caller declares no fields", () => {
    expect(buildArtifactObjectEnvelope(fileEnvelope)).toEqual(fileEnvelope);
    expect(buildArtifactObjectEnvelope(fileEnvelope, {})).toEqual(fileEnvelope);
  });

  it("REFUSES a declared field that would overwrite the host's own envelope key", () => {
    for (const reserved of RESERVED_ARTIFACT_ENVELOPE_KEYS) {
      expect(() => buildArtifactObjectEnvelope(fileEnvelope, { [reserved]: "x" })).toThrow(
        /reserved/i,
      );
    }
  });
});

describe("the host reads the featured image's fields back", () => {
  it("reads the post it belongs to and its placement", () => {
    const envelope = buildArtifactObjectEnvelope(
      fileEnvelope,
      buildFeaturedImageFields({ post: POST_ID }),
    );
    expect(readFeaturedImageFields(envelope)).toEqual({
      ok: true,
      post: POST_ID,
      placement: "featured",
    });
  });

  it("names why it cannot read them, instead of guessing", () => {
    expect(readFeaturedImageFields(fileEnvelope)).toEqual({ ok: false, reason: "no-post" });
    expect(readFeaturedImageFields({ ...fileEnvelope, post: POST_ID })).toEqual({
      ok: false,
      reason: "no-placement",
    });
    expect(
      readFeaturedImageFields({ ...fileEnvelope, post: POST_ID, placement: "body" }),
    ).toEqual({ ok: false, reason: "unknown-placement" });
    expect(readFeaturedImageFields(null)).toEqual({ ok: false, reason: "no-data" });
    expect(readFeaturedImageFields("not an object")).toEqual({ ok: false, reason: "no-data" });
    expect(readFeaturedImageFields({ ...fileEnvelope, post: "", placement: "featured" })).toEqual({
      ok: false,
      reason: "no-post",
    });
  });
});

describe("the declared fields are materialized ONCE (the snapshot)", () => {
  // The composer reads a caller's object exactly once into a frozen snapshot,
  // and the creation road builds BOTH envelopes -- the one validated before the
  // write and the one persisted -- from that single snapshot, so the persisted
  // row cannot differ from the row that passed the declared-schema check.
  it("the snapshot is frozen, plain, and stable across repeated envelope builds", () => {
    const source = { post: "art-1", placement: "featured" } as Record<string, unknown>;
    const snapshot = snapshotDeclaredObjectFields(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    source.post = "art-MUTATED";
    const envelope = {
      artifactType: "file",
      latestRepresentationRevisionId: "rev-1",
      latestDigest: "d",
      mime: "image/png",
      size: 1,
      originKind: "agent_generated",
      viewerHint: "mime",
    } as never;
    const first = buildArtifactObjectEnvelope(envelope, snapshot);
    const second = buildArtifactObjectEnvelope(envelope, snapshot);
    // The row that is persisted is byte-identical to the row that was validated.
    expect(second).toEqual(first);
    expect((first as Record<string, unknown>).post).toBe("art-1");
  });
});
