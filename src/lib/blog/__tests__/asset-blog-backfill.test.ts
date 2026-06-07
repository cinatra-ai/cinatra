// ---------------------------------------------------------------------------
// Backfill transform parity tests.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  transformAssetBlogBlobToObjectRows,
  isSafeReconcileType,
  deepSubsetMismatch,
  jsonRoundTrip,
  ASSETS_BLOG_PROJECT_TYPE,
  ASSETS_BLOG_IDEA_TYPE,
  ASSETS_BLOG_POST_TYPE,
} from "../integration/asset-blog-backfill";

const sampleBlob = {
  projects: [
    {
      id: "proj-1",
      name: "Acme blog",
      companyUrl: "https://acme.example",
      ideasPerTranscript: 2,
      transcriptIds: ["t-1", "t-2"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      ideaGeneration: { status: "succeeded", totalCount: 2, completedCount: 2 },
      postGeneration: { status: "idle" },
      imageGeneration: { status: "idle" },
      wordpressDraftGeneration: { status: "idle" },
      linkedinDraftGeneration: { status: "idle" },
      ideas: [
        {
          id: "idea-1",
          transcriptId: "t-1",
          transcriptTitle: "T1",
          title: "Idea one",
          summaryArtifactId: "art-sum-1",
          summaryRepresentationRevisionId: "rev-sum-1",
          createdAt: "2026-01-01T01:00:00.000Z",
        },
      ],
      posts: [
        {
          id: "post-1",
          ideaId: "idea-1",
          title: "Post one",
          excerpt: "Excerpt",
          postArtifactId: "art-body-1",
          postRepresentationRevisionId: "rev-body-1",
          imageArtifactId: "art-img-1",
          imageRepresentationRevisionId: "rev-img-1",
          createdAt: "2026-01-01T02:00:00.000Z",
          updatedAt: "2026-01-01T03:00:00.000Z",
        },
      ],
    },
  ],
  media: [{ id: "media-1", kind: "image", title: "Legacy media" }],
};

describe("transformAssetBlogBlobToObjectRows", () => {
  it("emits one project row (parent null), with generation state, ideas/posts stripped", () => {
    const { rows } = transformAssetBlogBlobToObjectRows(sampleBlob);
    const project = rows.find((r) => r.type === ASSETS_BLOG_PROJECT_TYPE);
    expect(project).toBeDefined();
    expect(project!.id).toBe("proj-1");
    expect(project!.parentId).toBeNull();
    expect(project!.parentType).toBeNull();
    // generation state rides on the project object
    expect((project!.data.ideaGeneration as { status: string }).status).toBe("succeeded");
    // nested arrays are NOT duplicated onto the project row
    expect(project!.data.ideas).toBeUndefined();
    expect(project!.data.posts).toBeUndefined();
    // id stamped into data (envelope-id contract)
    expect(project!.data.id).toBe("proj-1");
  });

  it("emits idea rows parented to the project with projectId stamped + id preserved", () => {
    const { rows } = transformAssetBlogBlobToObjectRows(sampleBlob);
    const idea = rows.find((r) => r.type === ASSETS_BLOG_IDEA_TYPE);
    expect(idea).toBeDefined();
    expect(idea!.id).toBe("idea-1"); // id preserved
    expect(idea!.parentId).toBe("proj-1");
    expect(idea!.parentType).toBe(ASSETS_BLOG_PROJECT_TYPE);
    expect(idea!.data.projectId).toBe("proj-1");
    expect(idea!.data.summaryArtifactId).toBe("art-sum-1");
  });

  it("emits post rows parented to the idea, artifact refs + projectId preserved", () => {
    const { rows } = transformAssetBlogBlobToObjectRows(sampleBlob);
    const post = rows.find((r) => r.type === ASSETS_BLOG_POST_TYPE);
    expect(post).toBeDefined();
    expect(post!.id).toBe("post-1");
    expect(post!.parentId).toBe("idea-1");
    expect(post!.parentType).toBe(ASSETS_BLOG_IDEA_TYPE);
    expect(post!.data.projectId).toBe("proj-1");
    expect(post!.data.postArtifactId).toBe("art-body-1");
    expect(post!.data.imageArtifactId).toBe("art-img-1");
  });

  it("does NOT backfill saved-media but counts it skipped", () => {
    const { rows, counts } = transformAssetBlogBlobToObjectRows(sampleBlob);
    expect(rows.some((r) => String(r.type).includes("saved-media"))).toBe(false);
    expect(counts.skippedMedia).toBe(1);
    expect(counts).toMatchObject({ projects: 1, ideas: 1, posts: 1 });
  });

  it("warns on a post referencing a missing idea (dangling parent)", () => {
    const { warnings, rows } = transformAssetBlogBlobToObjectRows({
      projects: [
        {
          id: "p",
          ideas: [],
          posts: [{ id: "post-x", ideaId: "ghost-idea", title: "x", excerpt: "" }],
        },
      ],
    });
    expect(warnings.some((w) => w.includes("ghost-idea"))).toBe(true);
    const post = rows.find((r) => r.id === "post-x");
    expect(post!.parentId).toBe("ghost-idea"); // still emitted; parent left as-is
  });

  it("is deterministic / idempotent in shape (same input → identical output)", () => {
    const a = transformAssetBlogBlobToObjectRows(sampleBlob);
    const b = transformAssetBlogBlobToObjectRows(sampleBlob);
    expect(a).toEqual(b);
  });

  it("handles an empty / missing blob without throwing", () => {
    expect(transformAssetBlogBlobToObjectRows({}).rows).toEqual([]);
    expect(transformAssetBlogBlobToObjectRows({ projects: [] }).counts.projects).toBe(0);
  });
});

describe("isSafeReconcileType (backfill collision guard)", () => {
  it("allows idempotent re-run (existing already the target type)", () => {
    expect(isSafeReconcileType(ASSETS_BLOG_IDEA_TYPE, ASSETS_BLOG_IDEA_TYPE)).toBe(true);
    expect(isSafeReconcileType(ASSETS_BLOG_POST_TYPE, ASSETS_BLOG_POST_TYPE)).toBe(true);
    expect(isSafeReconcileType(ASSETS_BLOG_PROJECT_TYPE, ASSETS_BLOG_PROJECT_TYPE)).toBe(true);
  });

  it("allows the exact legacy predecessor of each target", () => {
    expect(isSafeReconcileType(ASSETS_BLOG_IDEA_TYPE, "@cinatra-ai/asset-blog:blog-post-idea")).toBe(true);
    expect(isSafeReconcileType(ASSETS_BLOG_POST_TYPE, "@cinatra-ai/asset-blog:blog-post")).toBe(true);
  });

  it("REJECTS cross-type legacy collisions", () => {
    // saved-media id clashing with a target idea/post/project is a real clash
    expect(isSafeReconcileType(ASSETS_BLOG_IDEA_TYPE, "@cinatra-ai/asset-blog:saved-media")).toBe(false);
    expect(isSafeReconcileType(ASSETS_BLOG_POST_TYPE, "@cinatra-ai/asset-blog:blog-post-idea")).toBe(false);
    // a project (no legacy predecessor) must not collide with ANY existing row
    expect(isSafeReconcileType(ASSETS_BLOG_PROJECT_TYPE, "@cinatra-ai/asset-blog:blog-post")).toBe(false);
    // an unrelated foreign type is never a safe reconcile
    expect(isSafeReconcileType(ASSETS_BLOG_IDEA_TYPE, "@cinatra-ai/entity-accounts:account")).toBe(false);
  });
});

describe("deepSubsetMismatch (full-payload parity comparator)", () => {
  it("passes when actual deep-equals expected", () => {
    const v = { id: "p1", title: "T", refs: ["a", "b"], meta: { k: 1 } };
    expect(deepSubsetMismatch(v, structuredClone(v))).toBeNull();
  });

  it("passes when actual is a SUPERSET (canonical row added fields)", () => {
    const expected = { id: "p1", title: "T", meta: { k: 1 } };
    const actual = { id: "p1", title: "T", meta: { k: 1, normalized: true }, addedAt: "2026-01-01" };
    expect(deepSubsetMismatch(expected, actual)).toBeNull();
  });

  it("FAILS when a top-level legacy field is missing", () => {
    const expected = { id: "p1", postArtifactId: "art-1" };
    const actual = { id: "p1" };
    expect(deepSubsetMismatch(expected, actual)).toBe("postArtifactId: missing in actual");
  });

  it("FAILS when a nested legacy field is missing", () => {
    const expected = { gen: { status: "succeeded", count: 2 } };
    const actual = { gen: { status: "succeeded" } };
    expect(deepSubsetMismatch(expected, actual)).toBe("gen.count: missing in actual");
  });

  it("FAILS when a primitive value diverges", () => {
    const expected = { title: "Real title" };
    const actual = { title: "" };
    expect(deepSubsetMismatch(expected, actual)).toBe('title: "Real title" != ""');
  });

  it("FAILS when an array element is dropped (length mismatch)", () => {
    const expected = { drafts: ["d1", "d2"] };
    const actual = { drafts: ["d1"] };
    expect(deepSubsetMismatch(expected, actual)).toBe("drafts: array length 2 != 1");
  });

  it("allows extra keys inside array elements (element-wise superset)", () => {
    const expected = { drafts: [{ id: "d1" }] };
    const actual = { drafts: [{ id: "d1", status: "published" }] };
    expect(deepSubsetMismatch(expected, actual)).toBeNull();
  });

  it("FAILS on a type divergence (object vs array)", () => {
    expect(deepSubsetMismatch({ x: { a: 1 } }, { x: [1] })).toBe("x: type object != array");
  });

  it("treats null distinctly from object/primitive", () => {
    expect(deepSubsetMismatch({ x: null }, { x: null })).toBeNull();
    expect(deepSubsetMismatch({ x: null }, { x: 0 })).toBe("x: type null != primitive");
  });

  it("jsonRoundTrip drops undefined values so they are not required in actual", () => {
    // The backfill writes JSON.stringify(data), which omits undefined values —
    // the gate round-trips expected so it does not demand a field the DB never stored.
    const expected = { id: "p1", maybe: undefined as unknown };
    const rt = jsonRoundTrip(expected);
    expect(rt).toEqual({ id: "p1" });
    expect(deepSubsetMismatch(rt, { id: "p1" })).toBeNull();
  });

  it("uses OWN-key semantics — an expected key shadowing a prototype member (e.g. constructor) that actual lacks FAILS", () => {
    // `"constructor" in actual` is TRUE via the prototype chain; a naive `in`
    // check would false-pass and silently accept the lost legacy field.
    const expected = { constructor: "legacy-value" };
    const actual: Record<string, unknown> = {};
    expect(deepSubsetMismatch(expected, actual)).toBe("constructor: missing in actual");
  });

  it("an actual blog-post row missing wordpress draft state FAILS the gate", () => {
    // Realistic regression: a truncated canonical row that the old id/title-only
    // critical-field check would have passed.
    const { rows } = transformAssetBlogBlobToObjectRows({
      projects: [
        {
          id: "proj-1",
          name: "Acme",
          posts: [
            {
              id: "post-1",
              ideaId: "idea-1",
              title: "Post one",
              wordpressDraft: { draftId: "wp-9", status: "draft" },
            },
          ],
          ideas: [{ id: "idea-1", title: "Idea one" }],
        },
      ],
    });
    const post = rows.find((r) => r.id === "post-1")!;
    const truncatedActual = { id: "post-1", title: "Post one", projectId: "proj-1", ideaId: "idea-1" };
    expect(deepSubsetMismatch(jsonRoundTrip(post.data), truncatedActual)).toBe(
      "wordpressDraft: missing in actual",
    );
  });
});
