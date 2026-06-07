/**
 * `updatedAt` field on LinkedIn + WordPress draft entries.
 *
 * Draft selection uses `updatedAt` as a tiebreaker. Without it, selection
 * falls through to insertion order. WordPress drafts rely on the same invariant.
 *
 * Current invariants:
 *  - The field is part of the type.
 *  - `save{LinkedIn,WordPress}DraftReference` stamps it on the new entry.
 *  - `update{LinkedIn,WordPress}DraftReference` bumps it on the matched entry.
 *  - `readStore()` backfills the field for legacy entries (read-time normalize).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// store.ts reads/writes canonical `cinatra.objects` rows via the
// objects-store substrate. The legacy
// database.ts blob mock stays (defensive) but `dbStore["asset-blog"]` is the
// SINGLE source of truth for the test: the substrate mock decomposes it on
// every read and re-trees per-row upserts back into it on every write. This
// keeps mid-test direct `dbStore["asset-blog"] = ...` reassignments visible.
type CanonicalRow = { id: string; type: string; parentId: string | null; parentType: string | null; data: Record<string, unknown> };

let dbStore: Record<string, unknown> = {};

vi.mock("@/lib/database", () => ({
  readAgentConfigFromDatabase: (key: string, fallback: unknown) =>
    key in dbStore ? dbStore[key] : fallback,
  writeAgentConfigToDatabase: (key: string, value: unknown) => {
    dbStore[key] = value;
  },
}));

function getBlogTree(): { projects: Array<Record<string, unknown>>; media: unknown[] } {
  if (!dbStore["asset-blog"]) dbStore["asset-blog"] = { projects: [], media: [] };
  const t = dbStore["asset-blog"] as { projects?: Array<Record<string, unknown>>; media?: unknown[] };
  if (!Array.isArray(t.projects)) t.projects = [];
  if (!Array.isArray(t.media)) t.media = [];
  return t as { projects: Array<Record<string, unknown>>; media: unknown[] };
}

function rowsDecomposedFromDbStore(): CanonicalRow[] {
  const tree = dbStore["asset-blog"] as { projects?: Array<Record<string, unknown>> } | undefined;
  if (!tree?.projects) return [];
  return decomposeStoreToObjectRows({ projects: tree.projects }).map((r) => ({
    id: r.id,
    type: r.type,
    parentId: r.parentId,
    parentType: r.parentType,
    data: r.data,
  }));
}

function reTreeUpsert(row: CanonicalRow): void {
  const tree = getBlogTree();
  if (row.type === "@cinatra-ai/assets:blog-project") {
    const idx = tree.projects.findIndex((p) => (p as { id?: string }).id === row.id);
    const previous = idx >= 0 ? tree.projects[idx] : {};
    // Preserve nested ideas/posts arrays on the project — they are owned by
    // their own rows; the project row's data only carries scalars.
    const merged: Record<string, unknown> = {
      ...(previous as Record<string, unknown>),
      ...row.data,
      id: row.id,
      ideas: (previous as { ideas?: unknown[] }).ideas ?? [],
      posts: (previous as { posts?: unknown[] }).posts ?? [],
    };
    if (idx >= 0) tree.projects[idx] = merged;
    else tree.projects.push(merged);
    return;
  }
  const projectId = (row.data as { projectId?: string }).projectId;
  if (!projectId) return;
  const project = tree.projects.find((p) => (p as { id?: string }).id === projectId) as
    | (Record<string, unknown> & { ideas?: Array<Record<string, unknown>>; posts?: Array<Record<string, unknown>> })
    | undefined;
  if (!project) return; // orphan upsert — ignore in tests
  if (row.type === "@cinatra-ai/assets:blog-idea") {
    if (!Array.isArray(project.ideas)) project.ideas = [];
    const idx = project.ideas.findIndex((i) => i.id === row.id);
    if (idx >= 0) project.ideas[idx] = { ...project.ideas[idx], ...row.data, id: row.id };
    else project.ideas.push({ ...row.data, id: row.id });
  } else if (row.type === "@cinatra-ai/assets:blog-post") {
    if (!Array.isArray(project.posts)) project.posts = [];
    const idx = project.posts.findIndex((p) => p.id === row.id);
    if (idx >= 0) project.posts[idx] = { ...project.posts[idx], ...row.data, id: row.id };
    else project.posts.push({ ...row.data, id: row.id });
  }
}

vi.mock("@/lib/objects-store", () => ({
  readObjectsByType: (type: string) => rowsDecomposedFromDbStore().filter((r) => r.type === type),
  upsertObjectAndEnqueue: ({
    upsertInput,
  }: {
    upsertInput: { id?: string; type: string; parentId?: string | null; parentType?: string | null; data: unknown };
  }) => {
    const id = upsertInput.id ?? crypto.randomUUID();
    const row: CanonicalRow = {
      id,
      type: upsertInput.type,
      parentId: upsertInput.parentId ?? null,
      parentType: upsertInput.parentType ?? null,
      data: (upsertInput.data ?? {}) as Record<string, unknown>,
    };
    reTreeUpsert(row);
    return { ...row, createdAt: "x", updatedAt: "x", deletedAt: null, version: 1 };
  },
}));
vi.mock("@/lib/objects-dual-write", () => ({
  shadowUpsertObject: vi.fn(),
  shadowUpsertObjects: vi.fn(),
}));
vi.mock("@/lib/background-jobs", () => ({
  isBackgroundJobExecutionContext: () => true,
  BACKGROUND_JOB_NAMES: {},
  cancelBackgroundJob: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  isBackgroundJobActive: vi.fn(),
  registerBackgroundJobAbortController: vi.fn(),
  unregisterBackgroundJobAbortController: vi.fn(),
}));

import {
  readBlogPostsProjectById,
  saveLinkedInDraftReference,
  saveWordPressDraftReference,
  updateLinkedInDraftReference,
  updateWordPressDraftReference,
} from "../store";
import { decomposeStoreToObjectRows } from "../integration/asset-blog-store-codec";

function seedProjectWithPost(): void {
  dbStore["asset-blog"] = {
    projects: [
      {
        id: "proj-1",
        name: "P",
        companyUrl: "https://example.com",
        ideasPerTranscript: 1,
        transcriptIds: [],
        log: [],
        posts: [
          {
            id: "post-1",
            ideaId: "idea-1",
            title: "T",
            excerpt: "E",
            content: "C",
            savedPrompts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            linkedinDrafts: [],
            wordpressDrafts: [],
          },
        ],
        ideaGeneration: { status: "idle" },
        draftGeneration: { status: "idle" },
        imageGeneration: { status: "idle" },
        wordpressDraftGeneration: { status: "idle" },
        linkedinDraftGeneration: { status: "idle" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    media: [],
  };
}

beforeEach(() => {
  dbStore = {};
  seedProjectWithPost();
  // dbStore["asset-blog"] is the SINGLE source of truth;
  // the substrate mock decomposes/re-trees it on every read/write. No extra
  // sync step needed.
});

// LinkedIn copy bodies live in `@cinatra-ai/blog-post-artifact`.
// `saveLinkedInDraftReference` takes `contentArtifactId` +
// `contentRepresentationRevisionId` refs; the body string lives in the
// artifact store. These tests verify the coalesce / updatedAt
// invariants — they assert structural behavior on the draft entry, not
// the body bytes. The publish integration test asserts payload bytes
// match the artifact representation bytes.
describe("saveLinkedInDraftReference — stamps updatedAt", () => {
  it("new entry has a non-empty updatedAt equal to createdAt", async () => {
    await saveLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization",
      destinationId: "org-1",
      destinationName: "Acme Co",
      contentArtifactId: "art-hello",
      contentRepresentationRevisionId: "rev-hello",
      blogPostUrl: "https://example.com/p1",
    });
    const project = await readBlogPostsProjectById("proj-1");
    const draft = project!.posts[0].linkedinDrafts![0];
    expect(draft.updatedAt).toBeTruthy();
    expect(draft.updatedAt).toBe(draft.createdAt);
  });
});

describe("updateLinkedInDraftReference — bumps updatedAt", () => {
  it("bumps updatedAt later than createdAt", async () => {
    await saveLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization",
      destinationId: "org-1",
      destinationName: "Acme Co",
      contentArtifactId: "art-hello",
      contentRepresentationRevisionId: "rev-hello",
      blogPostUrl: "https://example.com/p1",
    });
    const before = await readBlogPostsProjectById("proj-1");
    const draftId = before!.posts[0].linkedinDrafts![0].id;
    const originalCreatedAt = before!.posts[0].linkedinDrafts![0].createdAt;

    await new Promise((r) => setTimeout(r, 5));

    await updateLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      draftId,
      contentArtifactId: "art-edited",
      contentRepresentationRevisionId: "rev-edited",
    });
    const after = await readBlogPostsProjectById("proj-1");
    const draft = after!.posts[0].linkedinDrafts![0];
    expect(draft.createdAt).toBe(originalCreatedAt);
    expect(draft.updatedAt > draft.createdAt).toBe(true);
  });
});

describe("saveWordPressDraftReference — stamps updatedAt", () => {
  it("new entry has a non-empty updatedAt", async () => {
    await saveWordPressDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      wordpressInstanceId: "wp-1",
      wordpressInstanceName: "Site",
      wordpressPostId: 42,
      adminUrl: "https://site.example.com/wp-admin/post.php?post=42",
    });
    const project = await readBlogPostsProjectById("proj-1");
    const draft = project!.posts[0].wordpressDrafts![0];
    expect(draft.updatedAt).toBeTruthy();
    expect(draft.updatedAt).toBe(draft.createdAt);
  });
});

describe("updateWordPressDraftReference — bumps updatedAt", () => {
  it("bumps updatedAt later than createdAt", async () => {
    await saveWordPressDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      wordpressInstanceId: "wp-1",
      wordpressInstanceName: "Site",
      wordpressPostId: 42,
      adminUrl: "https://site.example.com/wp-admin/post.php?post=42",
    });
    const before = await readBlogPostsProjectById("proj-1");
    const draftId = before!.posts[0].wordpressDrafts![0].id;
    const originalCreatedAt = before!.posts[0].wordpressDrafts![0].createdAt;

    await new Promise((r) => setTimeout(r, 5));

    await updateWordPressDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      draftId,
      status: "publish",
    });
    const after = await readBlogPostsProjectById("proj-1");
    const draft = after!.posts[0].wordpressDrafts![0];
    expect(draft.createdAt).toBe(originalCreatedAt);
    expect(draft.updatedAt > draft.createdAt).toBe(true);
  });
});

describe("saveLinkedInDraftReference — coalesce upsert", () => {
  it("re-saving with same (account, destination, blogPostUrl) produces 1 entry, not 2", async () => {
    const baseInput = {
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization" as const,
      destinationId: "org-1",
      destinationName: "Acme Co",
      blogPostUrl: "https://example.com/p1",
    };
    await saveLinkedInDraftReference({
      ...baseInput,
      contentArtifactId: "art-first",
      contentRepresentationRevisionId: "rev-first",
    });
    const after1 = await readBlogPostsProjectById("proj-1");
    const firstDraft = after1!.posts[0].linkedinDrafts![0];
    const firstId = firstDraft.id;
    const firstCreatedAt = firstDraft.createdAt;

    await new Promise((r) => setTimeout(r, 5));
    await saveLinkedInDraftReference({
      ...baseInput,
      contentArtifactId: "art-second",
      contentRepresentationRevisionId: "rev-second",
    });
    const after2 = await readBlogPostsProjectById("proj-1");
    const drafts = after2!.posts[0].linkedinDrafts!;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe(firstId);
    expect(drafts[0].createdAt).toBe(firstCreatedAt);
    expect(drafts[0].contentArtifactId).toBe("art-second");
    expect(drafts[0].contentRepresentationRevisionId).toBe("rev-second");
    expect(drafts[0].updatedAt > drafts[0].createdAt).toBe(true);
  });

  it("re-saving with different destination produces 2 entries", async () => {
    await saveLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization",
      destinationId: "org-1",
      destinationName: "Acme Co",
      contentArtifactId: "art-org1",
      contentRepresentationRevisionId: "rev-org1",
      blogPostUrl: "https://example.com/p1",
    });
    await saveLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization",
      destinationId: "org-2",
      destinationName: "Acme Sub",
      contentArtifactId: "art-org2",
      contentRepresentationRevisionId: "rev-org2",
      blogPostUrl: "https://example.com/p1",
    });
    const project = await readBlogPostsProjectById("proj-1");
    expect(project!.posts[0].linkedinDrafts).toHaveLength(2);
  });

  it("re-saving with same key but published status does NOT coalesce a draft over a published row", async () => {
    // Seed with one published entry for the destination.
    dbStore["asset-blog"] = {
      projects: [
        {
          id: "proj-1",
          name: "P",
          companyUrl: "https://example.com",
          ideasPerTranscript: 1,
          transcriptIds: [],
          log: [],
          posts: [
            {
              id: "post-1",
              ideaId: "idea-1",
              title: "T",
              excerpt: "E",
              content: "C",
              savedPrompts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              linkedinDrafts: [
                {
                  id: "lkd-published",
                  linkedinAccountId: "li-1",
                  linkedinAccountName: "Acme",
                  destinationType: "organization",
                  destinationId: "org-1",
                  destinationName: "Acme Co",
                  // LinkedIn copy lives in
                  // `@cinatra-ai/blog-post-artifact`; the seed row carries
                  // refs (matches the post-strip store shape).
                  contentArtifactId: "art-original-published",
                  contentRepresentationRevisionId: "rev-original-published",
                  blogPostUrl: "https://example.com/p1",
                  status: "published",
                  linkedinPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:99",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              wordpressDrafts: [],
            },
          ],
          ideaGeneration: { status: "idle" },
          draftGeneration: { status: "idle" },
          imageGeneration: { status: "idle" },
          wordpressDraftGeneration: { status: "idle" },
          linkedinDraftGeneration: { status: "idle" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      media: [],
    };
    // Save a fresh draft for the same destination — this is a new attempt,
    // it must NOT overwrite the published row.
    await saveLinkedInDraftReference({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-1",
      linkedinAccountName: "Acme",
      destinationType: "organization",
      destinationId: "org-1",
      destinationName: "Acme Co",
      contentArtifactId: "art-second-attempt",
      contentRepresentationRevisionId: "rev-second-attempt",
      blogPostUrl: "https://example.com/p1",
    });
    const project = await readBlogPostsProjectById("proj-1");
    const drafts = project!.posts[0].linkedinDrafts!;
    expect(drafts).toHaveLength(2);
    const published = drafts.find((d) => d.status === "published");
    // The published-vs-draft coalesce invariant
    // is now asserted on the artifact refs (the body lives in the
    // artifact store; this test verifies the refs survived the new
    // draft attempt).
    expect(published?.contentArtifactId).toBe("art-original-published");
    expect(published?.contentRepresentationRevisionId).toBe("rev-original-published");
    expect(published?.linkedinPostUrl).toBe("https://www.linkedin.com/feed/update/urn:li:share:99");
  });
});

describe("readStore — backfills updatedAt for legacy entries", () => {
  it("backfills LinkedIn draft missing updatedAt to createdAt", async () => {
    // Seed a project with a legacy draft missing updatedAt.
    dbStore["asset-blog"] = {
      projects: [
        {
          id: "proj-1",
          name: "P",
          companyUrl: "https://example.com",
          ideasPerTranscript: 1,
          transcriptIds: [],
          log: [],
          posts: [
            {
              id: "post-1",
              ideaId: "idea-1",
              title: "T",
              excerpt: "E",
              content: "C",
              savedPrompts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              linkedinDrafts: [
                {
                  id: "lkd-legacy",
                  linkedinAccountId: "li-1",
                  linkedinAccountName: "Acme",
                  destinationType: "organization",
                  destinationId: "org-1",
                  destinationName: "Acme Co",
                  content: "legacy",
                  blogPostUrl: "https://example.com/p1",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  // updatedAt deliberately omitted (legacy entry)
                },
              ],
              wordpressDrafts: [],
            },
          ],
          ideaGeneration: { status: "idle" },
          draftGeneration: { status: "idle" },
          imageGeneration: { status: "idle" },
          wordpressDraftGeneration: { status: "idle" },
          linkedinDraftGeneration: { status: "idle" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      media: [],
    };
    const project = await readBlogPostsProjectById("proj-1");
    const draft = project!.posts[0].linkedinDrafts![0];
    expect(draft.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("backfills WordPress draft missing updatedAt (prefers lastCheckedAt over createdAt)", async () => {
    dbStore["asset-blog"] = {
      projects: [
        {
          id: "proj-1",
          name: "P",
          companyUrl: "https://example.com",
          ideasPerTranscript: 1,
          transcriptIds: [],
          log: [],
          posts: [
            {
              id: "post-1",
              ideaId: "idea-1",
              title: "T",
              excerpt: "E",
              content: "C",
              savedPrompts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              linkedinDrafts: [],
              wordpressDrafts: [
                {
                  id: "wp-legacy",
                  wordpressInstanceId: "wp-1",
                  wordpressInstanceName: "Site",
                  wordpressPostId: 42,
                  adminUrl: "https://site.example.com/x",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastCheckedAt: "2026-01-02T00:00:00.000Z",
                  // updatedAt deliberately omitted
                },
              ],
            },
          ],
          ideaGeneration: { status: "idle" },
          draftGeneration: { status: "idle" },
          imageGeneration: { status: "idle" },
          wordpressDraftGeneration: { status: "idle" },
          linkedinDraftGeneration: { status: "idle" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      media: [],
    };
    const project = await readBlogPostsProjectById("proj-1");
    const draft = project!.posts[0].wordpressDrafts![0];
    expect(draft.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
