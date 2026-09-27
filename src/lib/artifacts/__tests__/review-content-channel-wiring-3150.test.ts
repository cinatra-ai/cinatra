/**
 * cinatra#3150 — A SAVED MARKDOWN REVISION WITH CONTENT DRAWS ITS CONTENT.
 *
 * Acceptance, verbatim: "A saved markdown revision with content on a review
 * target draws its content; the content-absent floor is drawn only when the
 * revision truly carries no content."
 *
 * Driven through the review preparation core with a props builder bound to the
 * host's own content channel and pinned-substance reader (the injected
 * resolve / open seams stand in for the store). The markdown display draws
 * `content-absent` exactly when the projection it is handed is the named
 * absence, and draws the document when it is a text projection of the SAME
 * revision the snapshot names — so both halves are asserted on the props.
 */
import { describe, expect, it } from "vitest";

import { prepareReviewTargetsCore, type PrepareReviewPorts } from "../artifact-review-preparation";
import { readOnlyArtifactEdit, type ArtifactRendererProps } from "../artifact-renderer-props";
import type { ArtifactSummary } from "../artifact-service";
import { buildArtifactContentProjection } from "../artifact-content-channel";
import { createPinnedSubstanceReader, type PinnedSubstanceReaderDeps } from "../artifact-content-substance-reader";

const REVISION = "rev-3150-md";
const SAVED = "# Launch notes\n\nThe run wrote and finalized this paragraph.\n";

function deps(bytes: string | null): PinnedSubstanceReaderDeps {
  return {
    resolveFileRevision: () =>
      bytes === null
        ? null
        : { storageKey: "org-1/blob-3150", mime: "text/markdown", sizeBytes: Buffer.byteLength(bytes, "utf8"), originKind: "upload" },
    resolveNonFileRevision: () => null,
    openBytes: async () => ({
      stream: (async function* () {
        if (bytes !== null) yield new TextEncoder().encode(bytes);
      })(),
    }),
  };
}

function portsFor(bytes: string | null): PrepareReviewPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    readGatePinnedTargets: async () => ({
      status: "pending",
      targets: [{ artifactId: "art-3150", representationRevisionId: REVISION }],
    }),
    readArtifact: (id) => ({
      kind: "ok",
      artifact: { artifactId: id, objectType: "@cinatra-ai/markdown-artifact:document" } as unknown as ArtifactSummary,
    }),
    revisionMember: () => ({ mime: "text/markdown", form: "file" }),
    resolveMount: () => ({
      kind: "build-map",
      packageName: "@cinatra-ai/markdown-artifact",
      generatedKey: "@cinatra-ai/markdown-artifact::detail",
    }),
    buildProps: async (input) => {
      const content = await buildArtifactContentProjection(
        {
          orgId: "org-1",
          artifactId: input.artifact.artifactId,
          representationRevisionId: input.representationRevisionId,
          form: input.member.form ?? "file",
          mime: input.mime,
        },
        createPinnedSubstanceReader({ liveOnly: true }, deps(bytes)),
      );
      return {
        propsApiVersion: 1,
        edit: readOnlyArtifactEdit("read-only-surface"),
        artifact: {
          id: input.artifact.artifactId,
          title: "Launch notes",
          objectType: "@cinatra-ai/markdown-artifact:document",
          mime: "text/markdown",
          size: SAVED.length,
          createdAt: "",
          updatedAt: "",
          ownerLevel: "organization",
          visibility: "organization",
          sourceUrl: null,
        },
        representation: { revisionId: input.representationRevisionId, mime: input.mime },
        urls: { preview: null, download: null },
        identity: { kind: "extension", extension: "@cinatra-ai/markdown-artifact" },
        actions: { download: null, openInSource: null },
        content,
      } as unknown as ArtifactRendererProps;
    },
  };
}

async function preparedProps(bytes: string | null): Promise<ArtifactRendererProps> {
  const result = await prepareReviewTargetsCore(
    { runId: "run-3150", reviewTaskId: "task-3150", targets: [{ artifactId: "art-3150", representationRevisionId: REVISION }] },
    portsFor(bytes),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("preparation refused");
  const props = result.prepared[0]!.props;
  expect(props).not.toBeNull();
  return props!;
}

describe("cinatra#3150 R2 — a saved markdown revision on a review target draws its content", () => {
  it("projects the saved text through to the display's props, and the display draws it rather than content-absent", async () => {
    const props = await preparedProps(SAVED);
    expect(props.content).toMatchObject({ kind: "text", text: SAVED, representationRevisionId: REVISION });
    expect(props.representation?.revisionId).toBe(REVISION);
  });

  it("draws the content-absent floor only when the revision truly carries no content", async () => {
    const props = await preparedProps(null);
    expect(props.content).toMatchObject({ kind: "none", reason: "absent", representationRevisionId: REVISION });
  });
});
