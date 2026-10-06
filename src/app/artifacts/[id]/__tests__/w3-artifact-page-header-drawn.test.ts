/**
 * THE ARTIFACT PAGE HEADER, AS THE RATIFIED DRAWING GIVES IT — the fix leg of
 * wave 3 of `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087).
 *
 * The third proof round graded all sixteen delivered frames FAIL on one shared
 * cause: "one header component draws them all", and it drew a title over
 * `<mime> · <n> bytes` and nothing else. Six systematic defects were measured,
 * five of them this page's own: no artifact-type name, no revision, no owner
 * level or visibility, no kind label beside the title, and a size drawn as a
 * raw byte count.
 *
 * THE SENTENCES THIS FILE IS BUILT TO (ratified drawing, artifact-review §IV):
 *
 *   "Every target opens with a header that names what is under review and fixes
 *    it in place: the artifact's display title over a mono meta line carrying
 *    its type, the pinned representation revision (shown as a mono revision id
 *    with a pinned marker), and the read-only row facts the host authorized —
 *    owner level / visibility, MIME, and updated time."
 *
 * and §XI's own-page readings, whose meta line is drawn without the pinned
 * marker because the artifact's own page pins nothing:
 *
 *   "@cinatra-ai/email-artifacts:body · revision rev_4c21… · Team · Private ·
 *    text/markdown"
 *
 * FIX LEG 2 closed the line where the drawing closes it: the size cell and the
 * header's own Download control are gone, because the sentence above names
 * neither, and the revision is drawn in the drawing's own mono form.
 *
 * and the Breadcrumb section of the components drawing, which the artifact
 * page's title feeds through `PageHeaderTitleSync`:
 *
 *   "While a name is genuinely unavailable, the crumb shows the id's first
 *    eight characters plus an ellipsis ("9c0dfce6…") — never a title-cased raw
 *    id."
 *
 * PURE, so it is measured and not described: the model is built from a row and
 * an injected clock, and the page draws exactly what it returns.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactDisplayTitle,
  buildArtifactDetailHeader,
  artifactRevisionLabel,
} from "../artifact-detail-header";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const NOW = new Date("2026-09-02T18:00:00.000Z");

function row(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a",
    latestRepresentationRevisionId: "rev_11b8c4d2-7a10-4d1f-9a02-2f4b6c8d0e11",
    objectType: "@cinatra-ai/image-artifact:image",
    artifactType: "file",
    title: "quarterly-chart.png",
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
    effectiveIdentity: {
      kind: "extension",
      extension: "@cinatra-ai/image-artifact",
    },
    presentationIdentity: {
      kind: "extension",
      extension: "@cinatra-ai/image-artifact",
    },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

// Convergence finding (codex, this leg): a stored title that is empty or is
// nothing but whitespace is a name genuinely unavailable, and the Breadcrumb
// rule leaves no room for the blank crumb it would otherwise draw.
describe("a name genuinely unavailable is an absent name, not an empty one", () => {
  it("falls to eight characters and an ellipsis for an empty stored title", () => {
    expect(artifactDisplayTitle(row({ title: "" }))).toBe("9c0dfce6…");
    expect(artifactDisplayTitle(row({ title: "   " }))).toBe("9c0dfce6…");
  });

  it("draws the stored name, trimmed, wherever there is one", () => {
    expect(artifactDisplayTitle(row({ title: "  quarterly-chart.png  " }))).toBe(
      "quarterly-chart.png",
    );
  });

  it("carries that same rule into the drawn header the page reads", () => {
    const model = buildArtifactDetailHeader({
      artifact: row({ title: "" }),
      mime: "image/png",
      revisionId: null,
      now: NOW,
    });
    expect(model.title).toBe("9c0dfce6…");
    expect(model.title.trim()).not.toBe("");
  });
});

describe("the revision is a mono revision id, shortened as the drawing shortens it", () => {
  it("draws the drawing's own prefixed mono id behind the word revision", () => {
    expect(artifactRevisionLabel("rev_11b8c4d2-7a10-4d1f")).toBe(
      "revision rev_11b8…",
    );
  });

  it("draws no revision cell where the row has no representation", () => {
    expect(artifactRevisionLabel(null)).toBeNull();
  });
});

describe("the header model the artifact's own page draws", () => {
  it("carries the type, the revision, owner level, visibility, the MIME and the updated time", () => {
    const model = buildArtifactDetailHeader({
      artifact: row(),
      mime: "image/png",
      revisionId: "rev_11b8c4d2-7a10-4d1f",
      now: NOW,
    });

    expect(model.metaCells).toEqual([
      "@cinatra-ai/image-artifact:image",
      "revision rev_11b8…",
      "Team",
      "Private",
      "image/png",
      "updated 8 minutes ago",
    ]);
  });

  it("draws the kind beside the title, resolved from the row's presentation identity", () => {
    const model = buildArtifactDetailHeader({
      artifact: row(),
      mime: "image/png",
      revisionId: "rev_11b8c4d2",
      now: NOW,
    });
    expect(model.kindLabel).toBe("Image");
  });

  it("names the floor rather than an extension where the row has no defining extension", () => {
    const model = buildArtifactDetailHeader({
      artifact: row({
        presentationIdentity: { kind: "no-primary" } as ArtifactSummary["presentationIdentity"],
      }),
      mime: "image/png",
      revisionId: "rev_11b8c4d2",
      now: NOW,
    });
    expect(model.kindLabel).toBe("Default artifact");
  });

  it("carries NO pinned marker: the artifact's own page pins nothing", () => {
    const model = buildArtifactDetailHeader({
      artifact: row(),
      mime: "image/png",
      revisionId: "rev_11b8c4d2",
      now: NOW,
    });
    expect(model.metaCells).not.toContain("pinned");
  });

  it("titles the page with the artifact's own title", () => {
    const model = buildArtifactDetailHeader({
      artifact: row(),
      mime: "image/png",
      revisionId: null,
      now: NOW,
    });
    expect(model.title).toBe("quarterly-chart.png");
  });

  it("never puts a raw id where a name belongs — the trail leaf reads this title", () => {
    const model = buildArtifactDetailHeader({
      artifact: row({ title: null }),
      mime: "image/png",
      revisionId: null,
      now: NOW,
    });
    expect(model.title).toBe("9c0dfce6…");
    expect(model.title).not.toContain("661ca3288b9a");
  });

  it("says unknown for a media type the row does not carry, and still draws every other cell", () => {
    const model = buildArtifactDetailHeader({
      artifact: row(),
      mime: "",
      revisionId: null,
      now: NOW,
    });
    expect(model.metaCells).toEqual([
      "@cinatra-ai/image-artifact:image",
      "Team",
      "Private",
      "unknown",
      "updated 8 minutes ago",
    ]);
  });
});

describe("the page draws the model, and nothing of the old header survives", () => {
  const PAGE = path.join(__dirname, "..", "page.tsx");
  const source = readFileSync(PAGE, "utf8");

  it("no longer counts the size out in bytes in the header", () => {
    expect(source).not.toMatch(/\$\{[^}]*\bsize\b[^}]*\}\s*bytes/);
    expect(source).not.toMatch(/description=\{`/);
  });

  it("builds the drawn header model and hands the page header its meta line", () => {
    expect(source).toContain("buildArtifactDetailHeader");
    expect(source).toContain("meta={");
  });

  // cinatra#3092 (acceptance 2, "the page's pre-dispatch interception of the
  // dashboard row is gone"): no surface of this page returns before the drawn
  // header any more, so every row, the dashboard row included, is titled by
  // the ONE header the page draws. The Breadcrumb rule is over EVERY frame: the
  // page draws exactly one header, its title is the drawn model's, the model is
  // built before that header, and the model titles a row of any type with the
  // artifact's display name, never a kind word.
  it("titles every row, whatever its type, with the artifact's name through the one drawn header", () => {
    expect(source.match(/<PageHeader\b/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/const title = header\.title;/);
    expect(source).toMatch(/<PageHeader\s+title=\{title\}/);
    const modelAt = source.indexOf("const header = buildArtifactDetailHeader(");
    expect(modelAt).toBeGreaterThan(-1);
    expect(modelAt).toBeLessThan(source.indexOf("<PageHeader"));
    expect(source).not.toContain('title="Dashboard"');
    for (const objectType of [
      "@cinatra-ai/image-artifact:image",
      "@cinatra-ai/dashboard-artifact:dashboard",
      "@fixture/notes:note",
    ]) {
      const extension = objectType.slice(0, objectType.indexOf(":"));
      for (const title of ["Quarterly revenue", null]) {
        const artifact = row({
          objectType,
          title,
          presentationIdentity: { kind: "extension", extension } as ArtifactSummary["presentationIdentity"],
        });
        const model = buildArtifactDetailHeader({ artifact, mime: "", revisionId: null, now: NOW });
        expect(model.title, objectType).toBe(artifactDisplayTitle(artifact));
        expect(model.title, objectType).toBe(title ?? "9c0dfce6…");
      }
    }
  });
});
