/**
 * THE CONTENT CHANNEL IS WIRED IN THE PRODUCTION BINDER, NOT ONLY IN THE SEAM
 * (cinatra#3080, PR #3100, fix leg 7, added at convergence).
 *
 * Fix leg 7's own tests call `buildReviewTargetContentProjection` directly, over
 * an injected substance read. That pins the projection but NOT the three things
 * the eighth proof round's empty panel actually turned on: that the shipped
 * `bindArtifactReviewPorts` calls the channel at all, that a read which THROWS
 * becomes the channel's named absence instead of taking the review surface down,
 * and that the read is bounded by the cap the projection is bounded by.
 *
 * Run:
 *   npx vitest run "src/app/artifacts/[id]/__tests__/review-target-content-wiring-converge.test.ts"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveVersion = vi.fn();
const openByStorageKey = vi.fn();

vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveArtifactVersionForServe: (input: unknown) => resolveVersion(input),
}));

vi.mock("@/lib/artifacts/local-disk-blob-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLocalDiskBlobStore: () => ({ openByStorageKey }),
}));

import { artifactContentCapFor } from "@/lib/artifacts/artifact-content-channel";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

import { bindArtifactReviewPorts } from "../review-target-prepare";
import { buildReviewTargetContentProjection } from "../review-target-content";

const ARTIFACT = {
  artifactId: "art_1",
  latestRepresentationRevisionId: "rev_4c21aa",
  objectType: "artifact",
  artifactType: "blog-post-artifact",
  title: "Why migrations are the hardest part",
  mime: "text/markdown",
  size: 42,
  originKind: "agent",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  ownerId: "team_1",
  organizationId: "org_1",
  projectId: null,
  effectiveIdentity: { kind: "no-primary" },
  presentationIdentity: { kind: "no-primary" },
  presentationSuggestions: [],
  eligibleExtensions: [],
  primaryExtension: null,
  sourceUrl: null,
} as unknown as ArtifactSummary;

const ports = () =>
  bindArtifactReviewPorts({
    orgId: "org_1",
    actor: {} as ActorContext,
    // The content road is the drawing surface's, handed in — exactly as the
    // two review pages hand it in (cinatra#3029: it stays out of the binder so
    // the four locked routes that reach the binder do not carry the channel).
    buildContent: buildReviewTargetContentProjection,
  });

const buildFor = (stream: AsyncIterable<Buffer>) => {
  resolveVersion.mockReturnValue({ storageKey: "key_1", mime: "text/markdown" });
  openByStorageKey.mockResolvedValue({ stream });
  return ports().buildProps({
    artifact: ARTIFACT,
    representationRevisionId: "rev_4c21aa",
    mime: "text/markdown",
    propsApiVersion: 1,
    member: { mime: "text/markdown", form: "file" },
  });
};

async function* once(text: string) {
  yield Buffer.from(text, "utf8");
}

beforeEach(() => {
  resolveVersion.mockReset();
  openByStorageKey.mockReset();
});

describe("the shipped review-target binder", () => {
  it("hands the display the pinned revision's TEXT — the empty panel's own defect", async () => {
    const props = await buildFor(once("# Why migrations are the hardest part\n"));

    expect(props.content).toMatchObject({
      kind: "text",
      representationRevisionId: "rev_4c21aa",
      text: "# Why migrations are the hardest part\n",
    });
    // And it read the revision the GATE pinned, never the artifact's latest.
    expect(resolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ representationRevisionId: "rev_4c21aa" }),
    );
  });

  it("answers asynchronously, and the preparation core awaits it", async () => {
    const pending = buildFor(once("# a post\n"));
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("FLOORS one target when the revision resolver throws, instead of taking the surface down", async () => {
    resolveVersion.mockImplementation(() => {
      throw new Error("the revision could not be resolved");
    });
    const props = await ports().buildProps({
      artifact: ARTIFACT,
      representationRevisionId: "rev_4c21aa",
      mime: "text/markdown",
      propsApiVersion: 1,
      member: { mime: "text/markdown", form: "file" },
    });

    expect(props.content).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("draws the channel's OWN named absence when no content road is supplied", async () => {
    // A caller that never draws a target (every locked route that reaches this
    // binder statically) supplies no port and pays no channel — and what it
    // gets back is the contract's absence, never an undefined content field.
    const props = await bindArtifactReviewPorts({
      orgId: "org_1",
      actor: {} as ActorContext,
    }).buildProps({
      artifact: ARTIFACT,
      representationRevisionId: "rev_4c21aa",
      mime: "text/markdown",
      propsApiVersion: 1,
      member: { mime: "text/markdown", form: "file" },
    });

    expect(props.content).toMatchObject({
      kind: "none",
      reason: "absent",
      representationRevisionId: "rev_4c21aa",
    });
    expect(resolveVersion).not.toHaveBeenCalled();
  });

  it("reads only as far as the cap the projection is bounded by", async () => {
    const cap = artifactContentCapFor("text");
    const chunkBytes = 64 * 1024;
    let pulled = 0;
    const endless = (async function* () {
      // Far more than any projection can carry: an unbounded read would buffer
      // every byte of it before the channel truncated the result.
      for (let i = 0; i < 512; i += 1) {
        pulled += 1;
        yield Buffer.alloc(chunkBytes, 0x61);
      }
    })();

    const props = await buildFor(endless);

    expect(props.content).toMatchObject({ kind: "text", truncated: true });
    expect(pulled).toBeLessThanOrEqual(Math.ceil((cap + 1) / chunkBytes) + 1);
    expect(pulled).toBeLessThan(512);
  });
});
