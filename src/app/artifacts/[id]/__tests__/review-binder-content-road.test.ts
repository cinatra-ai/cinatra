/**
 * THE REVIEW BINDER'S OWN CONTENT ROAD (cinatra#3098, issue #3026, W2).
 *
 * The card drew "no markdown is available to show" over a revision whose text
 * was in the store all along, because this binder handed the display a hardcoded
 * absence. Wiring the real projection put a SERVER READ on the review path, and
 * a server read can fail — so this suite pins BOTH halves of that road through
 * the binder itself rather than through the projection helper underneath it:
 *
 *   1. the builder carries the PINNED revision's text into the props;
 *   2. a read that FAILS degrades to the channel's own named absence for that
 *      one target, and never rejects — a rejection would escape the preparation
 *      core, which floors every other failure class per target, and blank the
 *      whole card;
 *   3. the card stays read-only whichever way the read went.
 *
 * The suite calls `bindArtifactReviewPorts(...).buildProps(...)`. A test against
 * `buildArtifactContentProjection` directly would pass even with the hardcoded
 * absence still in place, so it could never have caught the defect this leg
 * exists to fix.
 *
 * The read port itself is STUBBED at the module the binder binds — the pinned
 * substance reader — because what is pinned here is the BINDER's road, not the
 * reader's own matrix, which carries its own suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const { readPinnedSubstance } = vi.hoisted(() => ({ readPinnedSubstance: vi.fn() }));

vi.mock("@/lib/artifacts/artifact-content-substance-reader", () => ({
  createPinnedSubstanceReader: () => ({ readPinnedSubstance }),
}));

import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_3098_conv";
const ARTIFACT = "art_3098_conv";
const REVISION = "rev_pinned_3098";
const MARKDOWN = "text/markdown";

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

const identity = { kind: "no-primary" } as const;
const artifact = {
  artifactId: ARTIFACT,
  objectType: "document",
  effectiveIdentity: identity,
  presentationIdentity: identity,
} as unknown as ArtifactSummary;

function build() {
  const { buildProps } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return buildProps({
    artifact,
    representationRevisionId: REVISION,
    mime: MARKDOWN,
    propsApiVersion: 1,
    member: { mime: MARKDOWN, form: "file" },
  });
}

beforeEach(() => {
  readPinnedSubstance.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the review binder's content road", () => {
  it("carries the PINNED revision's text into the card's props", async () => {
    const read = readPinnedSubstance.mockResolvedValue({
      class: "text",
      text: "# Pinned\n\nthe approved words",
    });

    const props = await build();

    expect(props.content.kind).toBe("text");
    expect(props.content).toMatchObject({
      representationRevisionId: REVISION,
      text: "# Pinned\n\nthe approved words",
    });
    // READ AT THE PINNED REVISION, never at a latest.
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      orgId: ORG,
      artifactId: ARTIFACT,
      representationRevisionId: REVISION,
      contentClass: "text",
    });
  });

  it("degrades a FAILED read to the named absence instead of rejecting", async () => {
    readPinnedSubstance.mockRejectedValue(new Error("blob store unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const props = await build();

    expect(props.content).toMatchObject({
      kind: "none",
      reason: "absent",
      representationRevisionId: REVISION,
    });
    // The operator can tell a store fault from a revision that holds nothing.
    expect(logged).toHaveBeenCalled();
  });

  it("does not let a failed read reach the preparation core as a rejection", async () => {
    readPinnedSubstance.mockRejectedValue(new Error("blob store unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A rejection here would escape `prepareOneTarget` and blank EVERY target on
    // the card, not only this one.
    await expect(build()).resolves.toBeDefined();
  });

  it("stays read-only by construction whichever way the read went", async () => {
    readPinnedSubstance.mockRejectedValue(new Error("x"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await build();

    readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
    const read = await build();

    for (const props of [failed, read]) {
      expect(props.edit).toMatchObject({ kind: "read-only", reason: "read-only-surface" });
    }
  });
});

// cinatra#4129 — THE PINNED IDS TRAVEL AS EXACT PATH SEGMENTS. The session
// preview and download addresses carry the pinned artifact and revision ids to
// the version routes, which read them back out of the path.
describe("the pinned revision's session addresses carry each id as one exact path segment", () => {
  function buildWith(artifactId: string, revisionId: string) {
    const { buildProps } = bindArtifactReviewPorts({ orgId: ORG, actor });
    return buildProps({
      artifact: { ...artifact, artifactId } as ArtifactSummary,
      representationRevisionId: revisionId,
      mime: MARKDOWN,
      propsApiVersion: 1,
      member: { mime: MARKDOWN, form: "file" },
    });
  }

  it("encodes an id that would otherwise address another path, and reads a plain id exactly as before", async () => {
    readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
    const odd = await buildWith("art/../x", "rev?a#b%c é");
    expect(odd.urls).toEqual({
      preview: "/api/artifacts/art%2F..%2Fx/versions/rev%3Fa%23b%25c%20%C3%A9/preview",
      download: "/api/artifacts/art%2F..%2Fx/versions/rev%3Fa%23b%25c%20%C3%A9/content",
    });
    const plain = await buildWith(ARTIFACT, REVISION);
    expect(plain.urls).toEqual({
      preview: `/api/artifacts/${ARTIFACT}/versions/${REVISION}/preview`,
      download: `/api/artifacts/${ARTIFACT}/versions/${REVISION}/content`,
    });
  });

  it("hands out NO address for an id that is not well-formed text, never a rewritten one", async () => {
    readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
    const props = await buildWith(ARTIFACT, "rev-\uD800-a");
    expect(props.urls).toEqual({ preview: null, download: null });
  });

  // A DOT SEGMENT IS REMOVED BY URL RESOLUTION and an empty id is no segment at
  // all, so neither can address its pinned revision: each gets NO address. The
  // addresses that ARE handed out are read back through URL resolution, the
  // way the browser resolves a link, as the very ids that were pinned.
  it("hands out NO address for an empty id or a dot segment, in either place", async () => {
    readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
    for (const [artifactId, revisionId] of [
      [ARTIFACT, "."],
      [ARTIFACT, ".."],
      [ARTIFACT, ""],
      [".", REVISION],
      ["..", REVISION],
    ]) {
      const props = await buildWith(artifactId!, revisionId!);
      expect(props.urls).toEqual({ preview: null, download: null });
    }
  });

  it("every address handed out resolves to the very ids that were pinned", async () => {
    readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
    for (const [artifactId, revisionId] of [
      ["art/../x", "rev?a#b%c é"],
      [ARTIFACT, "..."],
      [ARTIFACT, "%2e%2e"],
      [".a", "a."],
    ]) {
      const props = await buildWith(artifactId!, revisionId!);
      for (const [leaf, url] of [
        ["preview", props.urls?.preview],
        ["content", props.urls?.download],
      ]) {
        const segments = new URL(url as string, "https://app.example").pathname.split("/");
        expect(segments).toHaveLength(7);
        expect(decodeURIComponent(segments[3]!)).toBe(artifactId);
        expect(decodeURIComponent(segments[5]!)).toBe(revisionId);
        expect(segments[6]).toBe(leaf);
      }
    }
  });
});
