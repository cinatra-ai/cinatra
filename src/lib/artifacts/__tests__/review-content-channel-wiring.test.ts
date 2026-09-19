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
import { describe, expect, it, vi } from "vitest";

import {
  prepareReviewTargetsCore,
  type PrepareReviewPorts,
  type ResolvedRendererMount,
} from "../artifact-review-preparation";
import { readOnlyArtifactEdit, type ArtifactRendererProps } from "../artifact-renderer-props";
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
    // The review card is a READ-ONLY surface (enabler 0.20): every surface names
    // its edit answer, and this one refuses by construction.
    edit: readOnlyArtifactEdit("read-only-surface"),
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

  it("bytes that cannot be opened degrade to the named absence, and the failure is REPORTED", async () => {
    // NO SILENT CATCH. One unreadable blob still degrades ONE panel rather than
    // failing the whole prepared set — but a read that failed is written to the
    // server's own error channel, so an absence drawn over a revision that HAS
    // bytes can be told from one over a revision that has none.
    const reported: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
    try {
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
      expect(reported.length).toBe(1);
      expect(String(reported[0]?.[0])).toContain("could not be read");
      expect(reported[0]?.[1]).toMatchObject({
        artifactId: "art",
        representationRevisionId: "rev-1",
      });
    } finally {
      spy.mockRestore();
    }
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

  it("the READ CEILING is the shared reader's own PARAMETER — a caller's cap bounds the read", async () => {
    // ONE shared reader, and the ceiling it reads under is a parameter of it:
    // a surface that carries a tighter cap passes that cap here rather than
    // standing a second capped reader beside this one.
    let opened = false;
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        { readCeilingBytes: Buffer.byteLength(DRAFT, "utf8") - 1 },
        deps({
          openBytes: async () => {
            opened = true;
            return {
              stream: (async function* () {
                yield new TextEncoder().encode(DRAFT);
              })(),
            };
          },
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
    // The row already says it is over the caller's ceiling, so nothing is opened.
    expect(opened).toBe(false);
  });

  it("the caller's ceiling bounds the HANDLE's own size, not only the row's", async () => {
    // The convergence round's reading: a ceiling proved only on the recorded
    // row size would still pass if the two checks below kept the DEFAULT. Here
    // the row is under the caller's bound and the opened handle is over it.
    let pulled = 0;
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        { readCeilingBytes: 8 },
        deps({
          resolveFileRevision: () => ({
            storageKey: "org-1/blob",
            mime: "text/markdown",
            sizeBytes: 4,
            originKind: "upload",
          }),
          openBytes: async () => ({
            sizeBytes: 9,
            stream: (async function* () {
              pulled += 1;
              yield new TextEncoder().encode("123456789");
            })(),
          }),
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
    // The physical size answered the bound before one byte was pulled.
    expect(pulled).toBe(0);
  });

  it("the caller's ceiling bounds the STREAMED bytes when neither recorded size told the truth", async () => {
    const projection = await buildArtifactContentProjection(
      { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
      createPinnedSubstanceReader(
        { readCeilingBytes: 8 },
        deps({
          resolveFileRevision: () => ({
            storageKey: "org-1/blob",
            mime: "text/markdown",
            sizeBytes: 4,
            originKind: "upload",
          }),
          openBytes: async () => ({
            stream: (async function* () {
              yield new TextEncoder().encode("123456789012");
            })(),
          }),
        }),
      ),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("a SUPPLIED ceiling that is not a usable bound is REFUSED, never widened to the default", () => {
    // A caller asking for a tighter read must never be answered with a wider
    // one, so an unusable supplied bound fails at construction instead of
    // silently selecting the default ceiling.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPinnedSubstanceReader({ readCeilingBytes: bad }, deps())).toThrow(TypeError);
    }
    // An OMITTED option is not a refusal: the default ceiling stands.
    expect(() => createPinnedSubstanceReader({}, deps())).not.toThrow();
  });

  it("the reported failure is a BOUNDED reading, never the raw thrown payload", async () => {
    const thrown: unknown = { body: "x".repeat(5000), storagePath: "the-unredacted-payload-marker" };
    const reported: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
    try {
      const projection = await buildArtifactContentProjection(
        { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
        createPinnedSubstanceReader(
          {},
          deps({
            openBytes: async () => {
              throw thrown;
            },
          }),
        ),
      );
      expect(projection).toMatchObject({ kind: "none", reason: "absent" });
      expect(reported.length).toBe(1);
      const payload = reported[0]?.[2];
      expect(typeof payload).toBe("string");
      expect(String(payload)).not.toContain("the-unredacted-payload-marker");
      expect(String(payload).length).toBeLessThanOrEqual(201);
    } finally {
      spy.mockRestore();
    }
  });

  it("a very long failure message is CUT rather than written through whole", async () => {
    const reported: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
    try {
      await buildArtifactContentProjection(
        { orgId: "org-1", artifactId: "art", representationRevisionId: "rev-1", form: "file", mime: "text/markdown" },
        createPinnedSubstanceReader(
          {},
          deps({
            openBytes: async () => {
              throw new Error("y".repeat(5000));
            },
          }),
        ),
      );
      expect(reported.length).toBe(1);
      const payload = String(reported[0]?.[2]);
      expect(payload.length).toBeLessThanOrEqual(201);
      expect(payload.endsWith("\u2026")).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
