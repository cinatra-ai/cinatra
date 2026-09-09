/**
 * cinatra#3251 — THE FEATURED IMAGE'S FIELD NAMES ARE THE PICTURE TYPE'S OWN.
 *
 * Acceptance 2: `src/lib/artifacts/featured-image-fields.ts` reads the picture
 * type's required field names — the post reference, the placement, and the
 * placement's only declared value — from its REGISTERED SCHEMA instead of
 * holding them as local constants.
 *
 * The derivation is STRUCTURAL, so the host names neither field: of the type's
 * required properties, the one declaring a closed set of exactly one value IS
 * the placement (and that value is the placement's), and the other IS the post
 * reference. A schema that does not have that shape is refused by name — the
 * host does not guess which field means what.
 *
 * Proved against the REAL registered type from the LIVE pinned tree, never a
 * fixture schema, so a pack-side rename of either field is caught here.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import { buildArtifactObjectEnvelope } from "../artifact-object-envelope";
import {
  buildFeaturedImageFields,
  readFeaturedImageFieldContract,
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

function contractFromRegistry() {
  const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
  expect(def, BLOG_IMAGE_TYPE).not.toBeNull();
  const read = readFeaturedImageFieldContract(def!.declaredSchema);
  expect(read.ok, JSON.stringify(read)).toBe(true);
  if (!read.ok) throw new Error("unreachable");
  return read.contract;
}

describe("the picture type's declared schema travels onto its registration", () => {
  it("carries the pack's own declared JSON schema, which is what the reader reads", () => {
    const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
    expect(def, BLOG_IMAGE_TYPE).not.toBeNull();
    expect(def!.declaredSchema).toBeTruthy();
    expect((def!.declaredSchema as { required?: unknown }).required).toEqual(
      expect.arrayContaining(["post", "placement"]),
    );
  });
});

describe("the two field names and the placement value are READ, not held", () => {
  it("derives them from the registered schema of the live pinned picture type", () => {
    expect(contractFromRegistry()).toEqual({
      post: "post",
      placement: "placement",
      placementValue: "featured",
    });
  });

  it("writes the pair under the names the type itself declares", () => {
    const contract = contractFromRegistry();
    const def = objectTypeRegistry.resolve(BLOG_IMAGE_TYPE);
    const envelope = buildArtifactObjectEnvelope(
      fileEnvelope,
      buildFeaturedImageFields(contract, { post: POST_ID }),
    );
    expect(def!.schema.safeParse(envelope).success).toBe(true);
  });

  it("reads the pair back off a row through the same contract", () => {
    const contract = contractFromRegistry();
    const envelope = buildArtifactObjectEnvelope(
      fileEnvelope,
      buildFeaturedImageFields(contract, { post: POST_ID }),
    );
    expect(readFeaturedImageFields(contract, envelope)).toEqual({
      ok: true,
      post: POST_ID,
      placement: "featured",
    });
  });

  it("keeps every named read failure it had", () => {
    const contract = contractFromRegistry();
    expect(readFeaturedImageFields(contract, null)).toEqual({ ok: false, reason: "no-data" });
    expect(readFeaturedImageFields(contract, "not an object")).toEqual({
      ok: false,
      reason: "no-data",
    });
    expect(readFeaturedImageFields(contract, fileEnvelope)).toEqual({
      ok: false,
      reason: "no-post",
    });
    expect(readFeaturedImageFields(contract, { ...fileEnvelope, post: POST_ID })).toEqual({
      ok: false,
      reason: "no-placement",
    });
    expect(
      readFeaturedImageFields(contract, { ...fileEnvelope, post: POST_ID, placement: "body" }),
    ).toEqual({ ok: false, reason: "unknown-placement" });
  });
});

describe("a schema the contract cannot be read from is refused BY NAME", () => {
  it("names an absent declared schema instead of falling back to a host constant", () => {
    expect(readFeaturedImageFieldContract(undefined)).toEqual({
      ok: false,
      reason: "no-declared-schema",
    });
    expect(readFeaturedImageFieldContract({ type: "object" })).toEqual({
      ok: false,
      reason: "no-required-fields",
    });
  });

  it("names a schema whose placement is not a single declared value", () => {
    expect(
      readFeaturedImageFieldContract({
        type: "object",
        properties: { post: { type: "string" }, placement: { type: "string" } },
        required: ["post", "placement"],
      }),
    ).toEqual({ ok: false, reason: "no-single-valued-placement" });
    expect(
      readFeaturedImageFieldContract({
        type: "object",
        properties: {
          post: { type: "string" },
          placement: { type: "string", enum: ["featured", "body"] },
        },
        required: ["post", "placement"],
      }),
    ).toEqual({ ok: false, reason: "no-single-valued-placement" });
  });

  it("names a schema that has no single remaining post reference field", () => {
    expect(
      readFeaturedImageFieldContract({
        type: "object",
        properties: {
          post: { type: "string" },
          alsoPost: { type: "string" },
          placement: { type: "string", enum: ["featured"] },
        },
        required: ["post", "alsoPost", "placement"],
      }),
    ).toEqual({ ok: false, reason: "no-post-field" });
  });
});
