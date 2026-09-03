/**
 * THE ARTIFACT PAGE HEADER, CLOSED AT THE LINE THE DRAWING CLOSES IT AT — fix
 * leg 2 of wave 3 of `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091).
 *
 * The fourth proof round graded every one of twenty-six frames FAIL, and four
 * of the defects are this header's own. THE SENTENCES THIS FILE IS BUILT TO
 * (the ratified drawing, artifact-review §IV read with §XI):
 *
 *   "the artifact's display title over a mono meta line carrying its type, the
 *    pinned representation revision (shown as a mono revision id with a pinned
 *    marker), and the read-only row facts the host authorized — owner level /
 *    visibility, MIME, and updated time."
 *
 * THE LINE ENDS THERE. A size is not one of the facts that sentence names, and
 * §XI's own-page readings draw none:
 *
 *   "@cinatra-ai/screenshot-artifact:artifact · revision rev_66d0… · Team ·
 *    Private · image/png"
 *
 * THE REVISION IS THE DRAWN MONO FORM. Every drawn reading writes it the same
 * way — "revision rev_8f3a…", "revision rev_11b8…", "revision rev_9ac3…" — a
 * prefixed mono id and an ellipsis, never a bare run of hexadecimal.
 *
 * THE LABEL BESIDE THE TITLE IS THE KIND NAME. The drawing writes kind names —
 * "Screenshot", "Slide deck", "Brand voice", "Email" — never a title-cased
 * package id with the word Artifact left on the end of it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactKindLabel,
  artifactRevisionLabel,
  buildArtifactDetailHeader,
} from "../artifact-detail-header";
import { extensionDisplayName } from "@/lib/artifacts/extension-display-name";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const NOW = new Date("2026-09-02T18:00:00.000Z");

function row(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a",
    latestRepresentationRevisionId: "d2e62529a1b34c5d",
    objectType: "@cinatra-ai/image-artifact:image",
    artifactType: "file",
    title: "pipeline-chart.png",
    mime: "image/png",
    size: 2_400_000,
    originKind: "upload",
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    ownerLevel: "team",
    visibility: "private",
    ownerId: "team_1",
    organizationId: "org_1",
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: "@cinatra-ai/image-artifact",
    effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/image-artifact" },
    presentationIdentity: { kind: "extension", extension: "@cinatra-ai/image-artifact" },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

describe("the mono meta line closes where the drawing closes it", () => {
  const model = buildArtifactDetailHeader({
    artifact: row(),
    mime: "image/png",
    revisionId: "d2e62529a1b34c5d",
    now: NOW,
  });

  it("carries the six facts the drawing names, and no seventh", () => {
    expect(model.metaCells).toEqual([
      "@cinatra-ai/image-artifact:image",
      "revision rev_d2e6…",
      "Team",
      "Private",
      "image/png",
      "updated 8 minutes ago",
    ]);
  });

  it("draws no size at all — the drawing's line does not carry one", () => {
    for (const cell of model.metaCells) {
      expect(cell).not.toMatch(/\b\d+(\.\d+)?\s?(B|kB|MB|GB|TB|PB)\b/);
    }
  });
});

describe("the revision reads in the drawn mono form", () => {
  it("draws the prefixed mono id and its ellipsis, never a bare eight-hex id", () => {
    expect(artifactRevisionLabel("d2e62529a1b34c5d")).toBe("revision rev_d2e6…");
    expect(artifactRevisionLabel("d2e62529a1b34c5d")).not.toMatch(/revision [0-9a-f]{8}…/);
  });

  it("keeps an id that already names itself a revision, rather than prefixing twice", () => {
    expect(artifactRevisionLabel("rev_11b8c4d2-7a10")).toBe("revision rev_11b8…");
    expect(artifactRevisionLabel("rep_8f3a99c1d2")).toBe("revision rev_8f3a…");
  });

  // THE CONVERGENCE ROUND'S EDGES (fix leg 2). The drawn form is the same form
  // for every id the store can hold: the ellipsis is part of it, and the cut is
  // by character.
  it("draws the ellipsis even where the stored id is shorter than the cut", () => {
    expect(artifactRevisionLabel("abc")).toBe("revision rev_abc…");
    expect(artifactRevisionLabel("rev_7")).toBe("revision rev_7…");
  });

  it("cuts by character, so an astral character is never split in half", () => {
    const label = artifactRevisionLabel("ab\u{1F600}cdef")!;
    expect(label).toBe("revision rev_ab\u{1F600}c…");
    expect(label).not.toContain("\uFFFD");
    expect(label.includes("\uD83D") && !label.includes("\u{1F600}")).toBe(false);
  });

  it("draws no revision cell where the row has no representation", () => {
    expect(artifactRevisionLabel(null)).toBeNull();
    expect(artifactRevisionLabel("   ")).toBeNull();
  });
});

describe("the label beside the title is the kind name the drawing draws", () => {
  it("draws the kind names the drawing itself writes", () => {
    expect(extensionDisplayName("@cinatra-ai/screenshot-artifact:screenshot")).toBe("Screenshot");
    expect(extensionDisplayName("@cinatra-ai/slide-deck-artifact:artifact")).toBe("Slide deck");
    expect(extensionDisplayName("@cinatra-ai/brand-voice-artifact:artifact")).toBe("Brand voice");
    expect(extensionDisplayName("@cinatra-ai/email-artifacts:body")).toBe("Email");
    expect(extensionDisplayName("@acme/sales:pricing-sheet")).toBe("Sales");
  });

  it("leaves no title-cased package name on the page", () => {
    for (const pkg of [
      "@cinatra-ai/image-artifact",
      "@cinatra-ai/pdf-artifact",
      "@cinatra-ai/json-artifact",
      "@cinatra-ai/text-artifact",
      "@cinatra-ai/zip-artifact",
      "@cinatra-ai/document-artifact",
      "@cinatra-ai/markdown-artifact",
      "@cinatra-ai/video-artifact",
      "@cinatra-ai/audio-artifact",
    ]) {
      expect(extensionDisplayName(pkg)).not.toMatch(/Artifacts?\b/);
    }
  });

  it("keeps an initialism an initialism rather than a word", () => {
    expect(extensionDisplayName("@cinatra-ai/pdf-artifact:document")).toBe("PDF");
    expect(extensionDisplayName("@cinatra-ai/json-artifact:artifact")).toBe("JSON");
  });

  it("reads the kind from the row's presentation identity, so the chip and the display agree", () => {
    expect(
      artifactKindLabel({
        kind: "extension",
        extension: "@cinatra-ai/screenshot-artifact",
      } as ArtifactSummary["presentationIdentity"]),
    ).toBe("Screenshot");
  });
});

describe("the page draws the header the drawing closes", () => {
  const PAGE = path.join(__dirname, "..", "page.tsx");
  const source = readFileSync(PAGE, "utf8");

  it("puts no download control inside the header", () => {
    expect(source).not.toMatch(/<Download\b/);
    expect(source).not.toMatch(/href=\{downloadHref\}\s+download/);
  });

  it("draws the closing etched rule under the header on every artifact frame", () => {
    expect(source).not.toContain("divider={false}");
  });

  it("hands the header no size to draw", () => {
    expect(source).not.toContain("sizeBytes");
  });
});
