import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// WHAT THE VERSION MOVE MUST NOT BREAK, AND WHAT THE ROADS MUST NOT WIDEN.
//
// Moving the host's props ceiling is only safe because the window admits a
// display AT ITS OWN VERSION and the host then hands it a snapshot of that
// shape: "a v1 display admitted under a v2 host must be handed a v1 snapshot,
// not a v2 one it cannot read". A ceiling that moves without the second half is
// the flag day the window exists to prevent, and every display in the fleet
// declares v1 today — so this file pins the second half by behaviour, not by a
// mention of it in a comment.

import {
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
  absentArtifactContent,
  artifactRendererPropsAtVersion,
  buildArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";
import {
  buildArtifactContentProjection,
  type ArtifactContentChannelPorts,
  type PinnedRevisionSubstance,
} from "@/lib/artifacts/artifact-content-channel";
import {
  hostSupportedPropsApiVersions,
  negotiatePropsApiVersion,
} from "@/lib/artifacts/props-version-negotiation";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const ARTIFACT = {
  artifactId: "art_c",
  title: "Checkout — step 2",
  objectType: "@cinatra-ai/image-artifact:artifact",
  mime: "image/png",
  size: 4096,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/image-artifact" },
} as unknown as ArtifactSummary;

const FILE_BASE = {
  artifact: ARTIFACT,
  representation: { revisionId: "rev_c", mime: "image/png" },
  previewHref: "/api/artifacts/art_c/versions/rev_c/preview",
  downloadHref: "/api/artifacts/art_c/versions/rev_c/content",
  content: absentArtifactContent("rev_c", "unsupported-form"),
};

const repoFile = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("wave 3 — a display still on v1 mounts, it does not go dark", () => {
  it("narrows a v2 snapshot to the version the display negotiated", () => {
    const built = buildArtifactRendererProps({
      ...FILE_BASE,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    });
    expect(built.bytes).toBeDefined();

    const negotiated = negotiatePropsApiVersion(1);
    expect(negotiated).toEqual({ ok: true, version: 1 });

    const narrowed = artifactRendererPropsAtVersion(built, 1);
    expect(narrowed.propsApiVersion).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(narrowed, "bytes")).toBe(false);
    // Everything a v1 display already read is untouched.
    expect(narrowed.urls).toEqual(built.urls);
    expect(narrowed.content).toEqual(built.content);
    expect(narrowed.actions).toEqual(built.actions);
  });

  it("never widens: a request at or above the snapshot's own version is the snapshot", () => {
    const built = buildArtifactRendererProps({ ...FILE_BASE, propsApiVersion: 1 });
    expect(artifactRendererPropsAtVersion(built, 1)).toBe(built);
    expect(
      artifactRendererPropsAtVersion(built, ARTIFACT_RENDERER_PROPS_API_VERSION),
    ).toBe(built);
    expect(
      artifactRendererPropsAtVersion(built, ARTIFACT_RENDERER_PROPS_API_VERSION).propsApiVersion,
    ).toBe(1);
  });

  it("holds for every version in the host's window", () => {
    const built = buildArtifactRendererProps({
      ...FILE_BASE,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION,
    });
    for (const version of hostSupportedPropsApiVersions()) {
      const narrowed = artifactRendererPropsAtVersion(built, version);
      expect(narrowed.propsApiVersion).toBe(version);
      expect(Object.prototype.hasOwnProperty.call(narrowed, "bytes")).toBe(
        version >= ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
      );
    }
  });

  it("every build-map display the host ships negotiates inside the window", () => {
    // Read as text: importing the generated map would pull every display's
    // loader. The declaration is what the negotiation reads, and every entry's
    // must be admissible — a ceiling move that leaves one outside the window is
    // the fleet going dark, and it must fail HERE.
    const source = repoFile("src/lib/generated/artifact-renderers.ts");
    const declared = [...source.matchAll(/"propsApiVersion":(\d+)/g)].map((m) => Number(m[1]));
    expect(declared.length).toBeGreaterThan(0);
    for (const version of declared) {
      expect(negotiatePropsApiVersion(version).ok, String(version)).toBe(true);
    }
  });

  it("the mount seam narrows rather than refusing an older negotiated version", () => {
    // The regression this file exists for: an equality test at the seam degrades
    // EVERY display whose declared version is below the ceiling.
    const seam = repoFile("src/app/artifacts/[id]/extension-renderer-slot.tsx");
    expect(seam).not.toContain("result.negotiatedPropsApiVersion !== props.propsApiVersion");
    expect(seam).toContain("result.negotiatedPropsApiVersion > props.propsApiVersion");
    expect(seam).toContain("artifactRendererPropsAtVersion");
  });
});

describe("wave 3 — a revision with no bytes is given no byte road", () => {
  it("omits the field entirely for a non-file revision, at the byte-reference version", () => {
    const props = buildArtifactRendererProps({
      artifact: ARTIFACT,
      representation: { revisionId: "rev_dash", mime: "application/json" },
      previewHref: null,
      downloadHref: null,
      content: absentArtifactContent("rev_dash", "unsupported-form"),
      propsApiVersion: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    });
    // Enabler 0.10 governs this field as it governs `urls`: absent, never a
    // road named over nothing.
    expect(Object.prototype.hasOwnProperty.call(props, "bytes")).toBe(false);
    expect(props.urls).toEqual({ preview: null, download: null });
  });

  it("still names the session road for a file revision on a cookie surface", () => {
    const props = buildArtifactRendererProps({
      ...FILE_BASE,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION,
    });
    expect(props.bytes).toEqual({
      road: "session",
      preview: FILE_BASE.previewHref,
      download: FILE_BASE.downloadHref,
    });
  });
});

describe("wave 3 — a capped read must not lie about the work's size", () => {
  const project = (substance: PinnedRevisionSubstance) => {
    const ports: ArtifactContentChannelPorts = {
      readPinnedSubstance: () => substance,
    };
    return buildArtifactContentProjection(
      {
        orgId: "org_c",
        artifactId: "art_c",
        representationRevisionId: "rev_c",
        form: "file",
        mime: "application/json",
      },
      ports,
    );
  };

  it("reports the revision's FULL length when the reader knows it", async () => {
    const projection = await project({
      class: "text",
      text: "abcdefghij",
      totalByteLength: 9_000_000,
    });
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    // "showing the first N of M" — M is the work's, not the prefix's.
    expect(projection.byteLength).toBe(9_000_000);
    expect(projection.projectedByteLength).toBe(10);
  });

  it("falls back to measuring the text when the reader does not know it", async () => {
    const projection = await project({ class: "text", text: "abcdefghij" });
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    expect(projection.byteLength).toBe(10);
    expect(projection.truncated).toBe(false);
  });
});

describe("wave 3 — the reviewed comparison is never replaced by a per-target pair", () => {
  it("asks the surface's own pair builder only where the pair is one target's", () => {
    // A repair reading compares the BASE gate's current picture with the
    // successor's repaired one. A per-target minter can only mint the
    // successor's two, so answering there would swap the comparison the
    // reviewer is being asked about for a different one.
    const source = repoFile("src/app/artifacts/[id]/review-gate-ports.ts");
    const repairFirst = source.indexOf("const pair = repairSuccessorGateId");
    expect(repairFirst).toBeGreaterThan(-1);
    const roadsAt = source.indexOf("roads?.capturePair", repairFirst);
    const repairAt = source.indexOf("loadPinnedRepairPair(orgId, repairSuccessorGateId", repairFirst);
    expect(repairAt).toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(roadsAt);
  });
});
