/**
 * THE REVIEW SURFACE'S CONTENT CHANNEL, WIRED (enabler 0.3 of
 * `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023; cinatra#3047).
 *
 * The channel was defined and never bound: the review preparation core declared
 * a SYNCHRONOUS props builder, so no builder that reads the pinned revision on
 * the server could be plugged into it, and every consumer therefore passed the
 * named absence. A display that draws from `props.content` — the renderer a
 * text artifact resolves to — was handed "nothing is pinned" for a revision
 * holding a real draft, and drew its own floor over it.
 *
 * Two halves are proved here, in the order they run:
 *   (1) the core AWAITS its props builder, so an asynchronous one reaches the
 *       prepared target as props rather than as a pending promise;
 *   (2) the server read behind the channel answers with the pinned substance
 *       when the revision has one, and with a NAMED absence when it has none —
 *       never a fabricated empty body.
 */
import { describe, expect, it } from "vitest";

import {
  prepareReviewTargetsCore,
  type PrepareReviewPorts,
  type ResolvedRendererMount,
} from "../artifact-review-preparation";
import type { ArtifactRendererProps } from "../artifact-renderer-props";
import type { ArtifactSummary } from "../artifact-service";
import type { ArtifactReviewTarget } from "../artifact-review-target";
import { buildArtifactContentProjection } from "../artifact-content-channel";
import {
  createPinnedSubstanceReader,
  PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES,
  type PinnedSubstanceReaderDeps,
} from "../artifact-content-substance-reader";

const t = (a: string, r: string): ArtifactReviewTarget => ({
  artifactId: a,
  representationRevisionId: r,
});

const DRAFT = "# The draft\n\nA paragraph the agent wrote.\n";

function fakeArtifact(id: string): ArtifactSummary {
  return {
    artifactId: id,
    objectType: "@cinatra-ai/blog-post-artifact:post",
    effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" },
  } as unknown as ArtifactSummary;
}

function propsWith(content: ArtifactRendererProps["content"]): ArtifactRendererProps {
  return {
    propsApiVersion: 1,
    artifact: {
      id: "art",
      title: "The draft",
      objectType: "@cinatra-ai/blog-post-artifact:post",
      mime: "text/markdown",
      size: DRAFT.length,
      createdAt: "",
      updatedAt: "",
      ownerLevel: "organization",
      visibility: "organization",
      sourceUrl: null,
    },
    representation: { revisionId: "rev-1", mime: "text/markdown" },
    urls: { preview: "/p", download: "/d" },
    identity: { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" },
    actions: { download: "/d", openInSource: null },
    content,
  };
}

function ports(over: Partial<PrepareReviewPorts> = {}): PrepareReviewPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    readGatePinnedTargets: async () => ({ status: "pending", targets: [t("a", "rev-1")] }),
    readArtifact: (id) => ({ kind: "ok", artifact: fakeArtifact(id) }),
    revisionMember: () => ({ mime: "text/markdown", form: "file" }),
    resolveMount: (): ResolvedRendererMount => ({
      kind: "build-map",
      packageName: "@cinatra-ai/markdown-artifact",
      generatedKey: "@cinatra-ai/markdown-artifact::detail",
    }),
    buildProps: () => propsWith({ kind: "none", channelVersion: 1, representationRevisionId: "rev-1", reason: "absent" }),
    ...over,
  };
}

/** Substrate + storage seams, all answering for ONE pinned text revision. */
function deps(over: Partial<PinnedSubstanceReaderDeps> = {}): PinnedSubstanceReaderDeps {
  return {
    resolveFileRevision: () => ({
      storageKey: "org-1/blob",
      mime: "text/markdown",
      sizeBytes: Buffer.byteLength(DRAFT, "utf8"),
      originKind: "upload",
      // The form the SUBSTRATE recorded (lifecycle-c W9, cinatra#3033): the
      // resolver reports it rather than letting a caller infer "it resolved,
      // therefore it is a file".
      form: "file",
    }),
    resolveNonFileRevision: () => null,
    openBytes: async () => ({
      stream: (async function* () {
        yield new TextEncoder().encode(DRAFT);
      })(),
    }),
    ...over,
  };
}

describe("the review core AWAITS its props builder (an asynchronous server read can be bound)", () => {
  it("an asynchronous builder's props reach the prepared target, content and all", async () => {
    const r = await prepareReviewTargetsCore(
      { runId: "run-1", reviewTaskId: "setup-run-1", targets: [t("a", "rev-1")] },
      ports({
        buildProps: async () =>
          propsWith({
            kind: "text",
            channelVersion: 1,
            representationRevisionId: "rev-1",
            text: DRAFT,
            encoding: "utf-8",
            byteLength: Buffer.byteLength(DRAFT, "utf8"),
            projectedByteLength: Buffer.byteLength(DRAFT, "utf8"),
            cap: 256 * 1024,
            truncated: false,
          }),
      }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const props = r.prepared[0]!.props;
    // A core that did not await would put a PENDING PROMISE here, and every
    // reading below would be undefined — which is exactly how a real draft
    // reached the display as "nothing is pinned".
    expect(props).not.toBeNull();
    expect(props!.artifact.id).toBe("art");
    expect(props!.content.kind).toBe("text");
    expect(props!.content).toMatchObject({ text: DRAFT, representationRevisionId: "rev-1" });
  });
});

describe("the pinned-substance read behind the channel", () => {
  it("a revision that HAS the produced output projects it — never the named absence", async () => {
    const projection = await buildArtifactContentProjection(
      {
        orgId: "org-1",
        artifactId: "art",
        representationRevisionId: "rev-1",
        form: "file",
        mime: "text/markdown",
      },
      createPinnedSubstanceReader({}, deps()),
    );

    expect(projection.kind).toBe("text");
    expect(projection).toMatchObject({
      representationRevisionId: "rev-1",
      truncated: false,
    });
    if (projection.kind === "text") expect(projection.text).toBe(DRAFT);
  });

  it("a revision that has NONE is the channel's NAMED absence, never an empty body", async () => {
    const projection = await buildArtifactContentProjection(
      {
        orgId: "org-1",
        artifactId: "art",
        representationRevisionId: "rev-1",
        form: "file",
        mime: "text/markdown",
      },
      createPinnedSubstanceReader({}, deps({ resolveFileRevision: () => null })),
    );

    expect(projection).toEqual({
      kind: "none",
      channelVersion: 1,
      representationRevisionId: "rev-1",
      reason: "absent",
    });
  });

  it("bytes that cannot be opened degrade to the named absence, not a throw", async () => {
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        {},
        deps({
          openBytes: async () => {
            throw new Error("blob gone");
          },
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("a file over the READ CEILING is an absence rather than a read of the whole blob", async () => {
    let opened = false;
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        {},
        deps({
          resolveFileRevision: () => ({
            storageKey: "org-1/blob",
            mime: "text/markdown",
            sizeBytes: PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES + 1,
            originKind: "upload",
            form: "file",
          }),
          openBytes: async () => {
            opened = true;
            return { stream: (async function* () {})() };
          },
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
    expect(opened).toBe(false);
  });

  it("the STORE's own size over the ceiling is an absence, whatever the row claims", async () => {
    // The row and the bytes can disagree — a replaced or truncated blob, a row
    // written before its upload finished. The size check above reads the row;
    // this reads what the store says it actually holds.
    let consumed = 0;
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        {},
        deps({
          openBytes: async () => ({
            sizeBytes: PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES + 1,
            stream: (async function* () {
              consumed += 1;
              yield new TextEncoder().encode(DRAFT);
            })(),
          }),
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
    expect(consumed).toBe(0);
  });

  it("a STREAM that runs past the ceiling stops reading and is an absence", async () => {
    // Neither recorded size is a promise about the stream, so the ceiling is
    // counted on the bytes themselves: the read stops at it rather than pulling
    // an unbounded blob into memory behind a small row.
    const CHUNK = 1024 * 1024;
    let chunksPulled = 0;
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        {},
        deps({
          openBytes: async () => ({
            stream: (async function* () {
              // Twice the ceiling if it were ever read to the end.
              for (let i = 0; i < (PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES / CHUNK) * 2; i += 1) {
                chunksPulled += 1;
                yield new Uint8Array(CHUNK);
              }
            })(),
          }),
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
    // Stopped at the ceiling: the one chunk that crossed it, and nothing after.
    expect(chunksPulled).toBe(PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES / CHUNK + 1);
  });

  it("a NON-text file form is `unsupported-form`, never a markdown-shaped absence", async () => {
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "image/png" },
      createPinnedSubstanceReader({}, deps()),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "unsupported-form" });
  });

  it("a dashboard revision projects its PINNED configuration record", async () => {
    const projection = await buildArtifactContentProjection(
      {
        orgId: "org-1",
        artifactId: "art",
        representationRevisionId: "rev-1",
        form: "dashboard",
        mime: "application/vnd.cinatra.dashboard+json",
      },
      createPinnedSubstanceReader(
        {},
        deps({
          resolveNonFileRevision: () => ({
            form: "dashboard",
            mime: "application/vnd.cinatra.dashboard+json",
            configuration: { panels: [] },
            configurationDigest: "d".repeat(64),
          }),
        }),
      ),
    );
    expect(projection).toMatchObject({
      kind: "configuration",
      configuration: { panels: [] },
      digest: "d".repeat(64),
    });
  });

  it("the read is made under the bound the CALLER names (a live reading never replays a tombstoned pin)", async () => {
    const seen: Array<boolean | undefined> = [];
    const record = deps({
      resolveFileRevision: (input) => {
        seen.push(input.liveOnly);
        return null;
      },
    });
    await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader({ liveOnly: true }, record),
    );
    await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader({ liveOnly: false }, record),
    );
    expect(seen).toEqual([true, false]);
  });
});
