/**
 * THE BINDER ACTUALLY READS THE PINNED REVISION (enabler 0.3 of
 * `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023; cinatra#3047).
 *
 * WHY THIS FILE EXISTS — the same reason its sibling
 * `review-binder-historical-ports.test.ts` exists, and the same failure it
 * guards against one rung further in. The channel's builder, its caps and its
 * named absences were all proved over injected ports, and every one of those
 * proofs passed while the ONE consumer that draws a reviewed artifact passed
 * the named absence instead of a projection. The display then drew its own
 * "nothing is pinned" floor over a revision that held the agent's draft, on
 * both review surfaces, in both palettes.
 *
 * So this pins the WIRING, which no core fixture can stand in for: the props
 * the binder hands a reviewed target carry the revision's own substance when
 * the substrate has it, the channel's NAMED absence when it does not, and the
 * read is made under the bound the membership answer was made under.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const DRAFT = "# The draft\n\nWhat the agent wrote.\n";

const resolveArtifactVersionForServe = vi.fn();
const resolveNonFileArtifactRevision = vi.fn();
const openByStorageKey = vi.fn();

vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: (input: unknown) => resolveArtifactVersionForServe(input),
  resolveNonFileArtifactRevision: (input: unknown) => resolveNonFileArtifactRevision(input),
}));

vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ openByStorageKey: (i: unknown) => openByStorageKey(i) }),
}));

const { bindArtifactReviewPorts } = await import("../review-target-prepare");
// THE ROAD IS THE PORT THE DRAWING SURFACE SUPPLIES (cinatra#3029 W5): the
// binder is reached statically by four locked routes that never prepare a
// review, so the content channel lives in its own module and arrives here the
// way every drawing surface hands it over. What is pinned below is unchanged --
// the props a reviewed target is built with carry the revision's own substance.
const { buildReviewTargetContentProjection } = await import("../review-target-content");

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

const artifact = {
  artifactId: "art-1",
  title: "The draft",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  mime: "text/markdown",
  size: Buffer.byteLength(DRAFT, "utf8"),
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" },
  presentationIdentity: { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" },
} as unknown as ArtifactSummary;

function bytes(text: string) {
  return {
    stream: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}

beforeEach(() => {
  resolveArtifactVersionForServe.mockReset();
  resolveNonFileArtifactRevision.mockReset();
  openByStorageKey.mockReset();
});

describe("the review binder — the props it builds CARRY the pinned revision's content", () => {
  it("a pinned text revision reaches the display as its own substance, never the named absence", async () => {
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "org_3047/blob-1",
      mime: "text/markdown",
      sizeBytes: Buffer.byteLength(DRAFT, "utf8"),
      originKind: "upload",
    });
    openByStorageKey.mockResolvedValue(bytes(DRAFT));

    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });
    const props = await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "text/markdown",
      propsApiVersion: 1,
      member: { mime: "text/markdown", form: "file" },
    });

    // THE DEFECT, PINNED. This was `{ kind: "none", reason: "absent" }` for
    // every reviewed artifact in the tree, and the renderer drew its floor.
    expect(props.content.kind).toBe("text");
    expect(props.content).toMatchObject({
      representationRevisionId: "rev-1",
      truncated: false,
    });
    if (props.content.kind === "text") expect(props.content.text).toBe(DRAFT);
    // The bytes were read under the reviewed org and the PINNED revision.
    expect(resolveArtifactVersionForServe).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_3047", artifactId: "art-1", representationRevisionId: "rev-1" }),
    );
    expect(openByStorageKey).toHaveBeenCalledWith({ orgId: "org_3047", storageKey: "org_3047/blob-1" });
  });

  it("a revision the substrate cannot resolve is the channel's NAMED absence", async () => {
    resolveArtifactVersionForServe.mockReturnValue(null);
    resolveNonFileArtifactRevision.mockReturnValue(null);

    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });
    const props = await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "text/markdown",
      propsApiVersion: 1,
      member: { mime: "text/markdown", form: "file" },
    });

    expect(props.content).toEqual({
      kind: "none",
      channelVersion: 1,
      representationRevisionId: "rev-1",
      reason: "absent",
    });
  });

  it("a NON-text file form says `unsupported-form` — never a text-shaped absence", async () => {
    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });
    const props = await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "image/png",
      propsApiVersion: 1,
      member: { mime: "image/png", form: "file" },
    });

    expect(props.content).toMatchObject({ kind: "none", reason: "unsupported-form" });
    // Its bytes travel by the byte capability, so the channel never opens them.
    expect(openByStorageKey).not.toHaveBeenCalled();
  });

  it("a dashboard revision carries its PINNED configuration, and no byte address", async () => {
    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });
    const props = await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "application/vnd.cinatra.dashboard+json",
      propsApiVersion: 1,
      member: {
        mime: "application/vnd.cinatra.dashboard+json",
        form: "dashboard",
        configuration: { panels: [] },
        configurationDigest: "d".repeat(64),
      },
    });

    expect(props.content).toMatchObject({ kind: "configuration", configuration: { panels: [] } });
    expect(props.urls).toEqual({ preview: null, download: null });
  });

  it("the content read takes the SAME bound the membership answer was made under", async () => {
    resolveArtifactVersionForServe.mockReturnValue(null);
    resolveNonFileArtifactRevision.mockReturnValue(null);
    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });

    await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "text/markdown",
      propsApiVersion: 1,
      member: { mime: "text/markdown", form: "file" },
    });
    // A LIVE membership answer: the content read must not replay a tombstoned pin.
    expect(resolveArtifactVersionForServe).toHaveBeenLastCalledWith(
      expect.objectContaining({ liveOnly: true }),
    );

    await ports.buildProps({
      artifact,
      representationRevisionId: "rev-1",
      mime: "text/markdown",
      propsApiVersion: 1,
      // What `revisionMemberHistorical` stamps: the gate-authorized reading.
      member: { mime: "text/markdown", form: "file", historical: true },
    });
    // A SETTLED card that kept its work keeps its content too (enabler 0.9).
    expect(resolveArtifactVersionForServe).toHaveBeenLastCalledWith(
      expect.objectContaining({ liveOnly: false }),
    );
  });

  it("the historical reader STAMPS that bound onto the member it answers", () => {
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "org_3047/blob-1",
      mime: "text/markdown",
      sizeBytes: 1,
      originKind: "upload",
    });
    const ports = bindArtifactReviewPorts({
      orgId: "org_3047",
      actor,
      buildContent: buildReviewTargetContentProjection,
    });
    // Without the stamp the two readings are indistinguishable by the time the
    // props builder runs, and the settled card silently loses its content.
    expect(ports.revisionMember("art-1", "rev-1")).toMatchObject({ historical: false });
    expect(ports.revisionMemberHistorical!("art-1", "rev-1")).toMatchObject({ historical: true });
  });
});
