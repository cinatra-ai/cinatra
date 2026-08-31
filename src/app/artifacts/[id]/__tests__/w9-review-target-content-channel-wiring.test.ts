/**
 * THE REVIEW TARGET'S PROPS CARRY THE POST'S TEXT (lifecycle-c W9, cinatra#3033
 * acceptance 2).
 *
 * The ratified drawing, §I.3 verbatim: "On the post's review the target is the
 * post drawn by the markdown display ... and what that display renders is the
 * post itself: its title and its body text."
 *
 * WHY A WIRING TEST AND NOT A CHANNEL TEST. The channel's own matrix was already
 * green: `file` + `text/markdown` resolves to the text class, and the projection
 * builder does the right thing with the bytes it is handed. What was broken was
 * that this binder never handed it any — `buildProps` passed
 * `absentArtifactContent(...)` by construction, so the reviewer was shown a
 * content-absent floor over a stored draft. No pure-core fixture can catch that;
 * only the binder itself can be asked what it actually builds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveArtifactVersionForServe = vi.fn();
const resolveNonFileArtifactRevision = vi.fn();
const openByStorageKey = vi.fn();

vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: (i: unknown) => resolveArtifactVersionForServe(i),
  resolveNonFileArtifactRevision: (i: unknown) => resolveNonFileArtifactRevision(i),
}));

vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: (i: unknown) => openByStorageKey(i),
  }),
}));

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { RevisionMemberOutcome } from "@/lib/artifacts/artifact-review-preparation";

import { bindArtifactReviewPorts } from "../review-target-prepare";

const ORG = "org_3033";
const ARTIFACT = "47a94084-9b83-469f-9e27-c34d8244faee";
const REVISION = "4c99fdc3-3799-42de-b4a7-1b97d994c8b4";
const POST = "# Why migrations are the hardest part\n\nTeams pick a stack in an afternoon.\n";

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

const artifact = {
  artifactId: ARTIFACT,
  title: "Why migrations are the hardest part",
  objectType: "@cinatra-ai/blog:post",
  mime: "text/markdown",
  size: POST.length,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/blog-post-artifact" },
} as unknown as ArtifactSummary;

function streamOf(text: string) {
  return {
    stream: (async function* () {
      yield Buffer.from(text, "utf8");
    })(),
  };
}

describe("the review binder — the content channel reaches the review target", () => {
  beforeEach(() => {
    resolveArtifactVersionForServe.mockReset();
    resolveNonFileArtifactRevision.mockReset();
    openByStorageKey.mockReset();
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "blobs/47/a9",
      mime: "text/markdown",
      sizeBytes: Buffer.byteLength(POST, "utf8"),
    });
    openByStorageKey.mockResolvedValue(streamOf(POST));
  });

  it("builds a TEXT projection for a file-form markdown revision, never an absence", async () => {
    const ports = bindArtifactReviewPorts({ orgId: ORG, actor });
    const member = (await ports.revisionMember!(ARTIFACT, REVISION)) as NonNullable<RevisionMemberOutcome>;
    expect(member).toMatchObject({ form: "file", mime: "text/markdown" });
    const props = await ports.buildProps!({
      artifact,
      representationRevisionId: REVISION,
      mime: "text/markdown",
      propsApiVersion: 1,
      member,
    });
    expect(props.content.kind).toBe("text");
    if (props.content.kind !== "text") return;
    expect(props.content.text).toBe(POST);
    expect(props.content.representationRevisionId).toBe(REVISION);
    // The bytes came from the location the member resolution authorized — the
    // binder does not re-resolve and cannot widen its own read.
    expect(openByStorageKey).toHaveBeenCalledWith({ orgId: ORG, storageKey: "blobs/47/a9" });
  });

  it("keeps a NON-file revision's props free of any byte read", async () => {
    resolveArtifactVersionForServe.mockReturnValue(null);
    resolveNonFileArtifactRevision.mockReturnValue({
      mime: "application/vnd.cinatra.dashboard+json",
      form: "dashboard",
      configuration: { tiles: [] },
      configurationDigest: "sha256:abc",
    });
    const ports = bindArtifactReviewPorts({ orgId: ORG, actor });
    const member = (await ports.revisionMember!(ARTIFACT, REVISION)) as NonNullable<RevisionMemberOutcome>;
    const props = await ports.buildProps!({
      artifact,
      representationRevisionId: REVISION,
      mime: "application/vnd.cinatra.dashboard+json",
      propsApiVersion: 1,
      member,
    });
    expect(openByStorageKey).not.toHaveBeenCalled();
    expect(props.urls).toEqual({ preview: null, download: null });
  });

  it("degrades to the NAMED absence when the pinned bytes cannot be read", async () => {
    openByStorageKey.mockRejectedValue(new Error("gone"));
    const ports = bindArtifactReviewPorts({ orgId: ORG, actor });
    const member = (await ports.revisionMember!(ARTIFACT, REVISION)) as NonNullable<RevisionMemberOutcome>;
    const props = await ports.buildProps!({
      artifact,
      representationRevisionId: REVISION,
      mime: "text/markdown",
      propsApiVersion: 1,
      member,
    });
    expect(props.content).toMatchObject({ kind: "none", reason: "absent" });
  });
});

/**
 * THE ARTIFACT PAGE IS THE SECOND CONSUMER, and it carried the
 * SAME defect: the post's own page drew the content-absent floor too. The
 * page is a large async server component with a full authorization prologue, so
 * it is pinned here the way this repo pins its other server surfaces — at its
 * source — for the one property that was wrong: it must no longer hand the props
 * builder a hard-coded absence, and it must build the projection through the
 * channel's own server read.
 */
describe("the artifact page — the second consumer of the same channel", () => {
  it("no longer passes a hard-coded absence, and builds through the channel", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const page = readFileSync(path.resolve(__dirname, "..", "page.tsx"), "utf8");
    const body = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(body).not.toMatch(/content:\s*absentArtifactContent\(/);
    expect(body).toMatch(/buildArtifactContentProjection/);
    expect(body).toMatch(/createArtifactContentChannelServerPorts/);
  });

  // THE FORM IS THE SUBSTRATE'S, NEVER THE PAGE'S CLAIM (lifecycle-c W9
  // convergence). The serve resolver admits a row on `resource.kind = 'blob'`
  // and does not constrain `representation.form`, so a page that hard-coded
  // "file" on a successful resolution was inferring the form rather than
  // reading it — and the channel's own rule is that it is told the substrate's
  // form and never a caller claim. A blob-backed non-file representation would
  // otherwise have been classified as text.
  it("tells the channel the SUBSTRATE's recorded form, never a hard-coded file claim", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const page = readFileSync(path.resolve(__dirname, "..", "page.tsx"), "utf8");
    const body = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(body).not.toMatch(/form:\s*resolved\s*\?\s*"file"/);
    expect(body).toMatch(/form:\s*toRepresentationForm\(/);
    // And the narrowing refuses anything outside the channel's closed set.
    expect(body).toMatch(/form === "file" \|\| form === "connectorRef" \|\| form === "dashboard"/);
  });
});
