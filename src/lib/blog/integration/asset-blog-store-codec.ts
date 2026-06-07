// ---------------------------------------------------------------------------
// Pure codec between the nested-tree `BlogPostsStore` shape and canonical
// `@cinatra-ai/assets:*` ObjectRecord rows in cinatra.objects.
// ---------------------------------------------------------------------------
//
// `readStore()` in `../store.ts` lists the canonical rows and calls
// `assembleStoreFromObjectRows(rows)` to rebuild the nested tree the existing
// write functions expect. `writeStore(partial)` calls
// `decomposeStoreToObjectRows(store)` and upserts each row via
// `upsertObjectAndEnqueue` (id-preserving + Graphiti outbox enqueue).
//
// Pure + dependency-free — NO `server-only`, NO DB, NO Next imports — so the
// reconcile logic is unit-testable in isolation and we can swap the substrate
// later without rewriting the assembly logic.

import {
  ASSETS_BLOG_PROJECT_TYPE,
  ASSETS_BLOG_IDEA_TYPE,
  ASSETS_BLOG_POST_TYPE,
} from "./asset-blog-backfill";

/** Minimal ObjectRecord shape the codec needs (matches `src/lib/objects-store.ts`). */
export type CodecObjectRow = {
  id: string;
  type: string;
  parentId?: string | null;
  parentType?: string | null;
  data: unknown;
};

/** One canonical row the writeStore upsert loop will apply. */
export type CodecUpsertRow = {
  id: string;
  type: string;
  parentId: string | null;
  parentType: string | null;
  data: Record<string, unknown>;
};

/**
 * Assemble the nested `{ projects, media }` tree from a flat list of canonical
 * blog object rows. Bucketing rule: ideas go on their `data.projectId` parent;
 * posts go on their `data.ideaId` parent (or any idea with matching id; if a
 * post has a `data.projectId` but no matching idea, it lands on the project's
 * "orphan posts" — surfaced as a warning the caller can log). saved-media is
 * not represented as object rows, so assembled `media` is always empty.
 */
export function assembleStoreFromObjectRows(rows: readonly CodecObjectRow[]): {
  store: { projects: Array<Record<string, unknown>>; media: unknown[] };
  warnings: string[];
} {
  const warnings: string[] = [];
  const projectRows = rows.filter((r) => r.type === ASSETS_BLOG_PROJECT_TYPE);
  const ideaRows = rows.filter((r) => r.type === ASSETS_BLOG_IDEA_TYPE);
  const postRows = rows.filter((r) => r.type === ASSETS_BLOG_POST_TYPE);

  // Pre-bucket ideas by projectId (project may be referenced via data.projectId
  // OR via parent_id; prefer data.projectId for stability under tree edits).
  const ideasByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const row of ideaRows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const projectId =
      (typeof data.projectId === "string" && data.projectId) ||
      row.parentId ||
      "";
    if (!projectId) {
      warnings.push(`blog-idea ${row.id} has no projectId or parent — dropped`);
      continue;
    }
    const stamped = { ...data, id: row.id };
    if (!ideasByProject.has(projectId)) ideasByProject.set(projectId, []);
    ideasByProject.get(projectId)!.push(stamped);
  }

  // Pre-bucket posts by projectId.
  const postsByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const row of postRows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const projectId = typeof data.projectId === "string" ? data.projectId : "";
    if (!projectId) {
      warnings.push(`blog-post ${row.id} has no projectId — dropped`);
      continue;
    }
    const stamped = { ...data, id: row.id };
    if (!postsByProject.has(projectId)) postsByProject.set(projectId, []);
    postsByProject.get(projectId)!.push(stamped);
  }

  const projects: Array<Record<string, unknown>> = projectRows.map((row) => {
    const data = (row.data ?? {}) as Record<string, unknown>;
    return {
      ...data,
      id: row.id,
      ideas: ideasByProject.get(row.id) ?? [],
      posts: postsByProject.get(row.id) ?? [],
    };
  });

  // Surface orphaned ideas/posts (children pointing at a project that no
  // longer exists). The caller (readStore) logs them; we DO NOT drop them
  // silently into a wrong project.
  for (const projectId of ideasByProject.keys()) {
    if (!projectRows.some((p) => p.id === projectId)) {
      warnings.push(`${ideasByProject.get(projectId)!.length} idea(s) reference missing project ${projectId}`);
    }
  }
  for (const projectId of postsByProject.keys()) {
    if (!projectRows.some((p) => p.id === projectId)) {
      warnings.push(`${postsByProject.get(projectId)!.length} post(s) reference missing project ${projectId}`);
    }
  }

  return { store: { projects, media: [] }, warnings };
}

/**
 * Decompose a `{ projects }` partial into canonical upsert rows. The tree's
 * existing ids are preserved (the in-memory tree generates them via
 * randomUUID at create time → writeStore upserts at those ids → reads return
 * those same ids). Generation states ride on the project row; ideas/posts are
 * stripped from the project's `data` so they only live as their own rows.
 *
 * Note: only UPSERTS are emitted. The current blog write surface never
 * deletes a project/idea/post at the object level (only intra-post array
 * mutations), so writeStore can rely on this invariant.
 */
export function decomposeStoreToObjectRows(
  store: { projects?: ReadonlyArray<Record<string, unknown>> },
): CodecUpsertRow[] {
  const out: CodecUpsertRow[] = [];
  const projects = Array.isArray(store?.projects) ? store.projects : [];

  for (const project of projects) {
    const projectId = typeof project?.id === "string" ? project.id : "";
    if (!projectId) continue;

    const { ideas, posts, ...projectScalar } = project as {
      ideas?: unknown;
      posts?: unknown;
    } & Record<string, unknown>;

    out.push({
      id: projectId,
      type: ASSETS_BLOG_PROJECT_TYPE,
      parentId: null,
      parentType: null,
      data: { ...projectScalar, id: projectId },
    });

    if (Array.isArray(ideas)) {
      for (const idea of ideas as Array<Record<string, unknown>>) {
        const ideaId = typeof idea?.id === "string" ? idea.id : "";
        if (!ideaId) continue;
        out.push({
          id: ideaId,
          type: ASSETS_BLOG_IDEA_TYPE,
          parentId: projectId,
          parentType: ASSETS_BLOG_PROJECT_TYPE,
          data: { ...idea, id: ideaId, projectId },
        });
      }
    }

    if (Array.isArray(posts)) {
      for (const post of posts as Array<Record<string, unknown>>) {
        const postId = typeof post?.id === "string" ? post.id : "";
        if (!postId) continue;
        const ideaId = typeof post?.ideaId === "string" ? post.ideaId : null;
        out.push({
          id: postId,
          type: ASSETS_BLOG_POST_TYPE,
          parentId: ideaId,
          parentType: ideaId ? ASSETS_BLOG_IDEA_TYPE : null,
          data: { ...post, id: postId, projectId },
        });
      }
    }
  }

  return out;
}
