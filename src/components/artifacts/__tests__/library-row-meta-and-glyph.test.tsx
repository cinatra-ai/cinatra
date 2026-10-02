/**
 * THE LIBRARY ROW'S META LINE AND ITS GLYPH (cinatra#3475).
 *
 * MEASURED on a real Blog Idea Generator run: every row read
 * "Organization · organization · updated N minutes ago" — the owner level once
 * as a label and once as the raw stored value, no owner NAME — and the renderer
 * glyph was identical on the JSON row and the Blog Idea rows.
 *
 * THE DRAWING (`specs/app-artifacts.html`, the library row) writes that line
 * with the owner NAMED:
 *
 *     Team: Growth · Draft · updated 8 minutes ago
 *     Organization: Acme Corp · updated 2 hours ago
 *
 * and §III gives the row's renderer THREE dispatch cases — a typed-data
 * artifact through its type's registered renderer, a file-form representation
 * through the MIME viewer handler, and the generic (structured-data) fallback
 * for anything with neither. The glyph follows that dispatch, so a row whose
 * type ships a renderer, a row that opens through a MIME handler, and a row
 * that falls back cannot all carry one icon.
 *
 * ONE ROW PER OWNER LEVEL AND TWO KINDS, rendered, pinning both.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  artifactOwnerLabel,
  artifactRowMetaLine,
  artifactVisibilityLabel,
} from "@/lib/artifacts/artifact-owner-label";
import { _resetFirstPartySeedForTests } from "@/app/artifacts/[id]/renderer-resolution";
import { _resetArtifactRendererQuarantineForTests } from "@/lib/artifacts/artifact-renderer-loader";
import { LibraryRow } from "../library-mode";

const ORG = "org_1";

function summaryOf(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "art_1",
    latestRepresentationRevisionId: null,
    objectType: "@cinatra-ai/assets:blog-idea",
    artifactType: "structured",
    title: "Why migrations are the hardest part",
    mime: "application/octet-stream",
    size: 0,
    originKind: "agent",
    createdAt: "2026-09-14T09:00:00.000Z",
    updatedAt: "2026-09-14T09:52:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    ownerId: null,
    organizationId: ORG,
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: "@cinatra-ai/blog-idea-artifact",
    effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/blog-idea-artifact" },
    presentationIdentity: { kind: "extension", extension: "@cinatra-ai/blog-idea-artifact" },
    presentationSuggestions: [],
    sourceUrl: null,
    ...overrides,
  } as ArtifactSummary;
}

async function renderRow(
  summary: ArtifactSummary,
  ownerName: string | null,
): Promise<string> {
  return renderToStaticMarkup(
    <>{await LibraryRow({ summary, ownerName, isLast: true })}</>,
  );
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
  _resetArtifactRendererQuarantineForTests();
});

// ---------------------------------------------------------------------------
// THE META LINE — one row per owner level, rendered.
// ---------------------------------------------------------------------------

describe("the library row's meta line names the owner, as the drawing writes it", () => {
  it("names the owning TEAM — 'Team: Growth'", async () => {
    const html = await renderRow(
      summaryOf({ ownerLevel: "team", ownerId: "team_growth", visibility: "private" }),
      "Growth",
    );
    expect(html).toContain("Team: Growth · Private · updated");
    expect(html).not.toContain("· team ·");
    expect(html).not.toContain("· private ·");
  });

  it("names the owning ORGANIZATION — 'Organization: Acme Corp'", async () => {
    const html = await renderRow(summaryOf(), "Acme Corp");
    expect(html).toContain("Organization: Acme Corp · Organization · updated");
    // The measured defect: the level printed once as a label and once raw.
    expect(html).not.toContain("Organization · organization");
    expect(html).not.toContain("· organization ·");
  });

  it("draws the drawn word for a USER-owned row, never the stored value", async () => {
    const html = await renderRow(
      summaryOf({ ownerLevel: "user", ownerId: "user_1", visibility: "private" }),
      null,
    );
    expect(html).toContain("Personal · Private · updated");
    expect(html).not.toContain("User · private");
    expect(html).not.toContain("· user ·");
  });

  it("draws the drawn word for a WORKSPACE-owned row, never the stored value", async () => {
    const html = await renderRow(
      summaryOf({ ownerLevel: "workspace", visibility: "public" }),
      null,
    );
    expect(html).toContain("Workspace · Public · updated");
    expect(html).not.toContain("· workspace ·");
  });

  it("falls back to the drawn level word when the owner's name is unavailable", () => {
    expect(artifactOwnerLabel("team", null)).toBe("Team");
    expect(artifactOwnerLabel("team", "   ")).toBe("Team");
    expect(artifactOwnerLabel("organization", "Acme Corp")).toBe("Organization: Acme Corp");
    expect(artifactOwnerLabel("user", "Sandro")).toBe("Personal");
  });

  it("draws the visibility as a word, never the stored value", () => {
    expect(artifactVisibilityLabel("private")).toBe("Private");
    expect(artifactVisibilityLabel("team")).toBe("Team");
    expect(artifactVisibilityLabel("organization")).toBe("Organization");
    expect(artifactVisibilityLabel("public")).toBe("Public");
  });

  it("composes the drawn line — owner, visibility, relative updated time", () => {
    expect(
      artifactRowMetaLine({
        ownerLevel: "team",
        ownerName: "Growth",
        visibility: "private",
        relativeUpdated: "8 minutes ago",
      }),
    ).toBe("Team: Growth · Private · updated 8 minutes ago");
  });
});

// ---------------------------------------------------------------------------
// THE GLYPH — two kinds, rendered, on the same list.
// ---------------------------------------------------------------------------

describe("the library row's glyph follows the artifact's kind, not one icon for every row", () => {
  // Kind 1 — a typed-data artifact whose type's defining extension registered a
  // renderer (§III, first dispatch case).
  const typed = summaryOf({
    artifactId: "art_typed",
    objectType: "@cinatra-ai/json-artifact:artifact",
    title: "Support case",
    mime: "application/json",
    primaryExtension: "@cinatra-ai/json-artifact",
    effectiveIdentity: { kind: "extension", extension: "@cinatra-ai/json-artifact" },
    presentationIdentity: { kind: "extension", extension: "@cinatra-ai/json-artifact" },
  });
  // Kind 2 — a Blog Idea row: claimed, but its type ships no renderer at all, so
  // it opens through the generic structured-data fallback (§III, third case).
  const fallback = summaryOf();

  it("draws a DIFFERENT glyph for a renderer-backed kind than for a fallback kind", async () => {
    semanticRendererRegistry.register({
      objectTypeId: "@cinatra-ai/json-artifact:artifact",
      packageName: "@cinatra-ai/json-artifact",
    });
    const typedHtml = await renderRow(typed, "Acme Corp");
    const fallbackHtml = await renderRow(fallback, "Acme Corp");

    const typedCase = typedHtml.match(/data-glyph-case="([a-z-]+)"/)?.[1];
    const fallbackCase = fallbackHtml.match(/data-glyph-case="([a-z-]+)"/)?.[1];
    expect(typedCase).toBe("typed-data");
    expect(fallbackCase).toBe("generic-fallback");
    expect(typedCase).not.toBe(fallbackCase);
  });

  it("both rows still carry the owner's NAME on their meta line", async () => {
    const typedHtml = await renderRow(typed, "Acme Corp");
    const fallbackHtml = await renderRow(fallback, "Acme Corp");
    expect(typedHtml).toContain("Organization: Acme Corp");
    expect(fallbackHtml).toContain("Organization: Acme Corp");
  });
});
