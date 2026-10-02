/**
 * THE OWNER ON THE ARTIFACT PAGE'S HEADER, AND ON THE DASHBOARD'S (cinatra#3475).
 *
 * The issue's fourth build item is over EVERY place that printed the owner level
 * or the visibility raw on the library row, the dashboard row or the artifact
 * page header. The library row is pinned by
 * `src/components/artifacts/__tests__/library-row-meta-and-glyph.test.tsx`; this
 * file pins the page header, which drew those two facts through a local
 * `capitalized()` over the STORED value — so one artifact read "Organization:
 * Acme Corp" on its library row and "Organization" on its own page, and a
 * personal row read "User" here against the drawn word "Personal" there.
 *
 * ONE COMPOSER, EVERY SURFACE: the header reads its owner and visibility words
 * from `@/lib/artifacts/artifact-owner-label`, the same composer the library row
 * and the dashboard row read, so the same row can never be worded two ways.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import { buildArtifactDetailHeader } from "../artifact-detail-header";

const NOW = new Date("2026-09-02T18:00:00.000Z");

function row(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a",
    latestRepresentationRevisionId: null,
    objectType: "@cinatra-ai/blog-idea:idea",
    artifactType: "data",
    title: "Ten blog ideas",
    mime: "application/json",
    size: 1_200,
    originKind: "agent",
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    ownerId: null,
    organizationId: "org_1",
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: null,
    effectiveIdentity: { kind: "no-primary" },
    presentationIdentity: { kind: "no-primary" },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

function header(over: Partial<ArtifactSummary>, ownerName?: string | null) {
  return buildArtifactDetailHeader({
    artifact: row(over),
    mime: "application/json",
    revisionId: null,
    ownerName,
    now: NOW,
  });
}

describe("the artifact page header names its owner, as the library row does", () => {
  it("draws an organization-owned row as the level word and the organization's NAME", () => {
    expect(header({ ownerLevel: "organization" }, "Acme Corp").metaCells).toContain(
      "Organization: Acme Corp",
    );
  });

  it("draws a team-owned row as the level word and the team's NAME", () => {
    expect(
      header({ ownerLevel: "team", ownerId: "team_1" }, "Growth").metaCells,
    ).toContain("Team: Growth");
  });

  it("draws a personal row with the DRAWN word, never the capitalized stored value", () => {
    const cells = header({ ownerLevel: "user", ownerId: "user_1" }, null).metaCells;
    expect(cells).toContain("Personal");
    expect(cells).not.toContain("User");
    expect(cells).not.toContain("user");
  });

  it("floors to the level word alone where the owner's name did not resolve", () => {
    const cells = header({ ownerLevel: "team", ownerId: "team_1" }, null).metaCells;
    expect(cells).toContain("Team");
    expect(cells).not.toContain("team");
  });

  it("draws the visibility as a drawn word too, never the stored value", () => {
    const cells = header({ visibility: "organization" }, "Acme Corp").metaCells;
    expect(cells).toContain("Organization");
    expect(cells).not.toContain("organization");
  });
});

describe("no surface keeps a private capitalize over a stored owner level", () => {
  const HEADER = path.join(__dirname, "..", "artifact-detail-header.ts");
  const PAGE = path.join(__dirname, "..", "page.tsx");
  const DASHBOARD_SCREEN = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "dashboards",
    "[id]",
    "dashboard-detail-screen.tsx",
  );

  it("builds the header's owner and visibility cells through the shared composer", () => {
    const source = readFileSync(HEADER, "utf8");
    expect(source).toContain("artifactOwnerLabel");
    expect(source).toContain("artifactVisibilityLabel");
    expect(source).not.toContain("capitalized(artifact.ownerLevel)");
    expect(source).not.toContain("capitalized(artifact.visibility)");
  });

  it("hands the header the owner's resolved name from the page", () => {
    const source = readFileSync(PAGE, "utf8");
    expect(source).toContain("readOwnerDisplayName");
    expect(source).toMatch(/const header = buildArtifactDetailHeader\(\{[\s\S]*?ownerName[\s\S]*?\}\);/);
  });

  it("never interpolates the dashboard row's stored owner level into its header", () => {
    const source = readFileSync(DASHBOARD_SCREEN, "utf8");
    expect(source).not.toContain("${row.ownerLevel}");
    expect(source).toContain("artifactOwnerLabel");
  });
});
