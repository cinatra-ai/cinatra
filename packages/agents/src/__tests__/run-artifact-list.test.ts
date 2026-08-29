import { describe, expect, it } from "vitest";
import {
  RUN_MADE_NOTHING_READING,
  RUN_MADE_PANEL_TITLE,
  buildRunArtifactList,
  runArtifactListSummary,
  shortRevision,
  typeBadgeFor,
  type RunArtifactRecord,
} from "../run-artifact-list";

// ---------------------------------------------------------------------------
// Issue #3029 acceptance 5 — "the run page lists the run's artifacts" — at the
// reading level, against the ratified drawing's section on the run's last step.
// The captures are the coordinator's separate leg; what is pinned here is the
// reading the captures will be graded against.
// ---------------------------------------------------------------------------

const hrefFor = (id: string) => `/artifacts/${id}`;

/** The drawing's own example, row for row. */
const EXAMPLE: RunArtifactRecord[] = [
  {
    artifactId: "a-post",
    representationRevisionId: "rev_7f10aa11bb22",
    role: "wrote",
    title: "Why migrations are the hardest part of self-hosting",
    objectTypeId: "@cinatra-ai/blog:post",
    typeLabel: "Blog post",
    mime: "text/markdown",
  },
  {
    artifactId: "a-featured",
    representationRevisionId: "rev_a93400cc11dd",
    role: "wrote",
    title: "Featured image — the upgrade road",
    objectTypeId: "@cinatra-ai/blog:image",
    typeLabel: "Blog image",
    mime: "image/png",
    annotation: "featured",
  },
  {
    artifactId: "a-body",
    representationRevisionId: "rev_be2711aa22bb",
    role: "wrote",
    title: "Body picture — the two upgrade paths",
    objectTypeId: "@cinatra-ai/blog:image",
    typeLabel: "Blog image",
    mime: "image/png",
    annotation: "body · after §2",
  },
  {
    artifactId: "a-linkedin",
    representationRevisionId: "rev_31be44ff55aa",
    role: "wrote",
    title: "Announcing the Q3 upgrade road",
    objectTypeId: "@cinatra-ai/linkedin:post-draft",
    typeLabel: "LinkedIn post",
    mime: "text/markdown",
  },
  {
    artifactId: "a-bin",
    representationRevisionId: "rev_0c5866aa77bb",
    role: "wrote",
    title: "upgrade-road-notes.bin",
    objectTypeId: "@cinatra-ai/binary:file",
    typeLabel: "Binary",
    mime: "application/octet-stream",
  },
  {
    artifactId: "a-idea",
    representationRevisionId: "rev_2c7199aa88bb",
    role: "used",
    title: "Why migrations are the hardest part of self-hosting",
    objectTypeId: "@cinatra-ai/blog:idea",
    typeLabel: "Blog idea",
    mime: null,
    annotation: "read by this run · now drafted",
  },
];

describe("the run's last step — what the run made", () => {
  it("draws one row per artifact the run wrote, and the artifact it used, marked used", () => {
    const list = buildRunArtifactList(EXAMPLE, hrefFor);
    expect(list.kind).toBe("rows");
    if (list.kind !== "rows") throw new Error("unreachable");
    expect(list.rows).toHaveLength(6);
    expect(list.wrote).toBe(5);
    expect(list.used).toBe(1);
    // The used artifact TRAILS the written ones and carries the mark.
    expect(list.rows[5].role).toBe("used");
    expect(list.rows[5].usedMark).toBe(true);
    expect(list.rows.slice(0, 5).every((r) => r.usedMark === false)).toBe(true);
  });

  it("every row carries the title, the type that owns it, the revision, and Open", () => {
    const list = buildRunArtifactList(EXAMPLE, hrefFor);
    if (list.kind !== "rows") throw new Error("unreachable");
    const post = list.rows[0];
    expect(post.title).toBe("Why migrations are the hardest part of self-hosting");
    expect(post.typeBadge).toBe("Blog post");
    expect(post.detail).toBe("@cinatra-ai/blog:post · revision rev_7f10… · text/markdown");
    expect(post.openLabel).toBe("Open");
    // A row is a POINTER, never a copy — it links to the artifact's own page.
    expect(post.href).toBe("/artifacts/a-post");
  });

  it("carries a placement annotation where the type's data has one", () => {
    const list = buildRunArtifactList(EXAMPLE, hrefFor);
    if (list.kind !== "rows") throw new Error("unreachable");
    expect(list.rows[1].detail).toContain("· featured");
    expect(list.rows[2].detail).toContain("· body · after §2");
    expect(list.rows[5].detail).toContain("read by this run · now drafted");
  });

  it("does NOT rank or grade — a file that could only be typed as bytes is a row like any other", () => {
    const list = buildRunArtifactList(EXAMPLE, hrefFor);
    if (list.kind !== "rows") throw new Error("unreachable");
    const binary = list.rows.find((r) => r.href === "/artifacts/a-bin")!;
    expect(binary.typeBadge).toBe("Binary");
    expect(binary.detail).toContain("application/octet-stream");
    // Nothing on the row says "failure", "fallback" or "unknown".
    expect(JSON.stringify(binary).toLowerCase()).not.toMatch(/fail|fallback|unknown|could not/);
  });

  it("a run that wrote nothing and used nothing draws the EMPTY reading, not an empty panel", () => {
    const list = buildRunArtifactList([], hrefFor);
    expect(list).toEqual({ kind: "empty", reading: RUN_MADE_NOTHING_READING });
    expect(runArtifactListSummary(list)).toBe(RUN_MADE_NOTHING_READING);
    expect(RUN_MADE_NOTHING_READING).toContain("wrote no artifact and used none");
  });

  it("summarises by COUNTING the rows, never by a claim the run made about itself", () => {
    expect(runArtifactListSummary(buildRunArtifactList(EXAMPLE, hrefFor))).toBe(
      "5 artifacts written, and the artifact it came from. Each opens on its own page; " +
        "the run keeps the revision it filed or read.",
    );
    expect(
      runArtifactListSummary(buildRunArtifactList([EXAMPLE[0]], hrefFor)),
    ).toContain("One artifact written.");
  });

  it("never draws a blank heading: an untitled artifact reads as its type", () => {
    const list = buildRunArtifactList(
      [{ ...EXAMPLE[0], title: null }, { ...EXAMPLE[1], title: "   " }],
      hrefFor,
    );
    if (list.kind !== "rows") throw new Error("unreachable");
    expect(list.rows[0].title).toBe("Blog post");
    expect(list.rows[1].title).toBe("Blog image");
  });

  it("names the panel the way the drawing does", () => {
    expect(RUN_MADE_PANEL_TITLE).toBe("What this run made");
  });
});

describe("the row's small renderings", () => {
  it("shortens a revision id without hiding which artifact the row points at", () => {
    expect(shortRevision("rev_7f10aa11bb22")).toBe("rev_7f10…");
    expect(shortRevision("rev_1")).toBe("rev_1");
    const list = buildRunArtifactList([EXAMPLE[0]], hrefFor);
    if (list.kind !== "rows") throw new Error("unreachable");
    // The FULL revision stays on the row's identity.
    expect(list.rows[0].key).toContain("rev_7f10aa11bb22");
  });

  it("derives a readable badge from the type's own identity when it declares no label", () => {
    expect(typeBadgeFor("@cinatra-ai/blog:post")).toBe("Post");
    expect(typeBadgeFor("@cinatra-ai/binary:file")).toBe("File");
    expect(typeBadgeFor("@cinatra-ai/blog:post", "Blog post")).toBe("Blog post");
    expect(typeBadgeFor("@cinatra-ai/blog:post", "   ")).toBe("Post");
  });
});
