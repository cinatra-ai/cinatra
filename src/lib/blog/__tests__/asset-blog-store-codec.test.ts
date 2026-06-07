// Codec parity tests for asset blog object row conversion.
import { describe, it, expect } from "vitest";
import {
  assembleStoreFromObjectRows,
  decomposeStoreToObjectRows,
  type CodecObjectRow,
} from "../integration/asset-blog-store-codec";

const ROWS: CodecObjectRow[] = [
  {
    id: "p1",
    type: "@cinatra-ai/assets:blog-project",
    parentId: null,
    parentType: null,
    data: {
      name: "Proj",
      companyUrl: "https://x",
      ideasPerTranscript: 1,
      transcriptIds: ["t"],
      ideaGeneration: { status: "succeeded" },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    },
  },
  {
    id: "i1",
    type: "@cinatra-ai/assets:blog-idea",
    parentId: "p1",
    parentType: "@cinatra-ai/assets:blog-project",
    data: { projectId: "p1", transcriptId: "t", transcriptTitle: "T", title: "Idea", createdAt: "2026-01-01" },
  },
  {
    id: "po1",
    type: "@cinatra-ai/assets:blog-post",
    parentId: "i1",
    parentType: "@cinatra-ai/assets:blog-idea",
    data: { projectId: "p1", ideaId: "i1", title: "Post", excerpt: "x", createdAt: "2026-01-01", updatedAt: "2026-01-02" },
  },
];

describe("assembleStoreFromObjectRows", () => {
  it("buckets ideas + posts under their project, media is always empty", () => {
    const { store, warnings } = assembleStoreFromObjectRows(ROWS);
    expect(warnings).toEqual([]);
    expect(store.media).toEqual([]);
    expect(store.projects).toHaveLength(1);
    const p = store.projects[0];
    expect(p.id).toBe("p1");
    expect(p.name).toBe("Proj");
    expect((p.ideas as unknown[])).toHaveLength(1);
    expect(((p.ideas as Array<{ id: string }>)[0]).id).toBe("i1");
    expect((p.posts as unknown[])).toHaveLength(1);
    expect(((p.posts as Array<{ id: string }>)[0]).id).toBe("po1");
  });

  it("warns on orphan idea (references missing project)", () => {
    const { warnings } = assembleStoreFromObjectRows([
      {
        id: "i-orphan",
        type: "@cinatra-ai/assets:blog-idea",
        parentId: "missing",
        data: { projectId: "missing", transcriptId: "t", transcriptTitle: "T", title: "Orphan", createdAt: "x" },
      },
    ]);
    expect(warnings.some((w) => w.includes("missing"))).toBe(true);
  });

  it("falls back to parentId when data.projectId is absent on an idea", () => {
    const { store } = assembleStoreFromObjectRows([
      ROWS[0],
      {
        id: "i2",
        type: "@cinatra-ai/assets:blog-idea",
        parentId: "p1",
        data: { transcriptId: "t", transcriptTitle: "T", title: "Idea2", createdAt: "x" },
      },
    ]);
    expect((store.projects[0].ideas as unknown[])).toHaveLength(1);
  });
});

describe("decomposeStoreToObjectRows", () => {
  it("produces one row per project + idea + post with correct parents + ids", () => {
    const out = decomposeStoreToObjectRows({
      projects: [
        {
          id: "p1",
          name: "Proj",
          ideas: [{ id: "i1", title: "I", transcriptId: "t", transcriptTitle: "T", createdAt: "x" }],
          posts: [{ id: "po1", ideaId: "i1", title: "P", excerpt: "", createdAt: "x", updatedAt: "y" }],
        },
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe("@cinatra-ai/assets:blog-project");
    expect(out[0].parentId).toBeNull();
    expect(out[1].type).toBe("@cinatra-ai/assets:blog-idea");
    expect(out[1].parentId).toBe("p1");
    expect(((out[1].data as Record<string, unknown>).projectId)).toBe("p1");
    expect(out[2].type).toBe("@cinatra-ai/assets:blog-post");
    expect(out[2].parentId).toBe("i1");
    expect(((out[2].data as Record<string, unknown>).projectId)).toBe("p1");
  });

  it("strips nested ideas/posts arrays from the project row data", () => {
    const out = decomposeStoreToObjectRows({
      projects: [{ id: "p1", name: "x", ideas: [{ id: "i1", title: "I" }], posts: [{ id: "po1" }] }],
    });
    const project = out.find((r) => r.type === "@cinatra-ai/assets:blog-project")!;
    expect("ideas" in (project.data as object)).toBe(false);
    expect("posts" in (project.data as object)).toBe(false);
  });

  it("preserves caller-supplied ids", () => {
    const out = decomposeStoreToObjectRows({
      projects: [{ id: "fixed-uuid", name: "x", ideas: [], posts: [] }],
    });
    expect(out[0].id).toBe("fixed-uuid");
  });
});

describe("codec round-trip", () => {
  it("assemble(decompose(x)) preserves identity for projects/ideas/posts", () => {
    const { store: assembled } = assembleStoreFromObjectRows(ROWS);
    const rows = decomposeStoreToObjectRows({ projects: assembled.projects });
    const { store: roundTripped } = assembleStoreFromObjectRows(rows);
    // ids + structure preserved
    expect(roundTripped.projects).toHaveLength(1);
    expect(roundTripped.projects[0].id).toBe("p1");
    expect((roundTripped.projects[0].ideas as Array<{ id: string }>)[0].id).toBe("i1");
    expect((roundTripped.projects[0].posts as Array<{ id: string }>)[0].id).toBe("po1");
  });
});
