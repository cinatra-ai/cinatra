/**
 * ENABLER 0.10 — the non-file revision reader. The contract-level acceptance
 * test for the preparation half (cinatra#3027 / epic #3023). The store half —
 * the real (organization, artifact, representation-revision) tuple check and the
 * pinned configuration record — is proved against a real Postgres in
 * `lifecycle-c-w3-non-file-reader.integration.test.ts`.
 *
 * THE ENABLER'S OWN SENTENCE: "The non-file revision reader: a
 * membership-and-projection reader for resources that are not files verifies the
 * exact organization, artifact and representation-revision tuple and returns its
 * form and the pinned configuration record; the file-serving read stays
 * file-only, and NON-FILE PROPS CARRY NO PREVIEW OR DOWNLOAD ADDRESS."
 *
 * FIXING: "the review path serves file-backed resources only, so a non-file
 * artifact floors before any renderer runs, however good the renderer, and a
 * revision of it carries nothing pinned to draw."
 */
import { describe, expect, it } from "vitest";

import {
  isFileFormMember,
  prepareReviewTargetsCore,
  type PrepareReviewPorts,
  type RevisionMemberOutcome,
} from "@/lib/artifacts/artifact-review-preparation";
import {
  absentArtifactContent,
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const RUN = "run-3027";
const GATE = "wayflow-task-3027";
const TARGET = { artifactId: "dashboard-1", representationRevisionId: "rev-dash-1" };
const CONFIG = { portlets: [{ id: "p1" }] };

const DASHBOARD = {
  artifactId: TARGET.artifactId,
  title: "Revenue",
  objectType: "@cinatra-ai/dashboard-artifact:dashboard",
  mime: "application/vnd.cinatra.dashboard+json",
  size: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ownerLevel: "organization",
  visibility: "organization",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/dashboard-artifact" },
  presentationIdentity: { kind: "extension", extension: "@cinatra-ai/dashboard-artifact" },
} as unknown as ArtifactSummary;

const NON_FILE_MEMBER: RevisionMemberOutcome = {
  mime: "application/vnd.cinatra.dashboard+json",
  form: "dashboard",
  configuration: CONFIG,
  configurationDigest: "abc",
};

describe("enabler 0.10 — a non-file revision is a MEMBER, not a floor", () => {
  it("classifies the forms the way every pre-0.10 caller meant", () => {
    expect(isFileFormMember({ mime: "text/markdown" })).toBe(true);
    expect(isFileFormMember({ mime: "text/markdown", form: "file" })).toBe(true);
    expect(isFileFormMember({ mime: "x", form: "dashboard" })).toBe(false);
    expect(isFileFormMember({ mime: "x", form: "connectorRef" })).toBe(false);
  });

  it("reaches the renderer instead of flooring before one runs", async () => {
    const seen: Array<{ mime: string }> = [];
    const ports: PrepareReviewPorts = {
      verifyRunAccess: () => ({ ok: true }),
      readGatePinnedTargets: () => ({ status: "pending", targets: [TARGET] }),
      readArtifact: () => ({ kind: "ok", artifact: DASHBOARD }),
      revisionMember: () => NON_FILE_MEMBER,
      resolveMount: (input) => {
        seen.push({ mime: input.mime });
        return { kind: "build-map", packageName: "@cinatra-ai/dashboard-artifact", generatedKey: "k" };
      },
      buildProps: (input) =>
        buildArtifactRendererProps({
          artifact: input.artifact,
          representation: { revisionId: input.representationRevisionId, mime: input.mime },
          // What the real binder does for a non-file member (asserted below).
          previewHref: isFileFormMember(input.member) ? "/preview" : null,
          downloadHref: isFileFormMember(input.member) ? "/content" : null,
          propsApiVersion: input.propsApiVersion,
          content: absentArtifactContent(input.representationRevisionId),
        }),
    };
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A renderer WAS resolved for it — the whole point of the enabler.
    expect(seen).toEqual([{ mime: "application/vnd.cinatra.dashboard+json" }]);
    expect(result.prepared[0].mount).toMatchObject({ kind: "build-map" });
    // AND ITS PROPS CARRY NO BYTE ADDRESS. A dashboard has no bytes, so an href
    // at the byte routes would 404 from the moment it was drawn.
    expect(result.prepared[0].props?.urls).toEqual({ preview: null, download: null });
    expect(result.prepared[0].props?.actions.download).toBeNull();
  });

  it("still carries the byte addresses for a FILE revision — nothing about a file review moved", async () => {
    const ports: PrepareReviewPorts = {
      verifyRunAccess: () => ({ ok: true }),
      readGatePinnedTargets: () => ({ status: "pending", targets: [TARGET] }),
      readArtifact: () => ({ kind: "ok", artifact: DASHBOARD }),
      revisionMember: () => ({ mime: "text/markdown", form: "file" }),
      resolveMount: () => ({ kind: "form", arm: "first-party", form: "markdown" }),
      buildProps: (input) =>
        buildArtifactRendererProps({
          artifact: input.artifact,
          representation: { revisionId: input.representationRevisionId, mime: input.mime },
          previewHref: isFileFormMember(input.member) ? "/preview" : null,
          downloadHref: isFileFormMember(input.member) ? "/content" : null,
          propsApiVersion: input.propsApiVersion,
          content: absentArtifactContent(input.representationRevisionId),
        }),
    };
    const result = await prepareReviewTargetsCore(
      { runId: RUN, reviewTaskId: GATE, targets: [TARGET] },
      ports,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared[0].props?.urls).toEqual({ preview: "/preview", download: "/content" });
  });
});
