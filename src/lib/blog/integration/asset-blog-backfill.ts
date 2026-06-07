// ---------------------------------------------------------------------------
// Pure backfill transform.
// ---------------------------------------------------------------------------
//
// Transforms the legacy single-tenant `source_config:asset-blog` metadata blob
// (the nested project -> ideas[] -> posts[] tree) into canonical
// `cinatra.objects` rows at the `@cinatra-ai/assets:*` namespace. Pure +
// dependency-free (NO `server-only`, NO DB, NO Next imports) so the vitest
// parity test can share the implementation.
//
// Identity contract: legacy nested-tree ids are PRESERVED as `objects.id`.
// Minting new ids plus an id-map would leak into routes, job payloads, draft
// refs, HITL payloads, and agent polling. The existing
// `@cinatra-ai/asset-blog:*` shadow rows already carry these ids, so the upsert
// reconciles them in place (re-typed to the new namespace).
//
// Parent contract: project (root, parent=null) -> idea (parent=project) -> post
// (parent=idea). Generation-state machines live on the project object because
// some states predate any idea/post.
//
// Saved-media is RETIRED and has no new writers, so it is NOT backfilled.

export const ASSETS_BLOG_PROJECT_TYPE = "@cinatra-ai/assets:blog-project";
export const ASSETS_BLOG_IDEA_TYPE = "@cinatra-ai/assets:blog-idea";
export const ASSETS_BLOG_POST_TYPE = "@cinatra-ai/assets:blog-post";

/** The legacy `@cinatra-ai/asset-blog:*` shadow types the upsert reconciles. */
export const LEGACY_ASSET_BLOG_TYPES = [
  "@cinatra-ai/asset-blog:blog-post-idea",
  "@cinatra-ai/asset-blog:blog-post",
  "@cinatra-ai/asset-blog:saved-media",
] as const;

/**
 * The ONLY legacy type an existing same-id row may carry for a given target
 * type (idempotent re-run also allows the target type itself). Used by the
 * backfill's collision pre-check so a cross-type id clash (e.g. a legacy
 * `saved-media` or `blog-post` row sharing an id with a target idea/project)
 * is treated as a genuine collision, not a safe reconcile.
 */
export const EXPECTED_LEGACY_BY_TARGET: Record<string, string | null> = {
  [ASSETS_BLOG_PROJECT_TYPE]: null, // projects were metadata-only — no shadow row
  [ASSETS_BLOG_IDEA_TYPE]: "@cinatra-ai/asset-blog:blog-post-idea",
  [ASSETS_BLOG_POST_TYPE]: "@cinatra-ai/asset-blog:blog-post",
};

/**
 * True when an existing row of type `existingType` may be safely reconciled
 * (upserted) into the canonical `targetType` without it being a collision:
 * either an idempotent re-run (already the target type) or the exact legacy
 * predecessor of that target.
 */
export function isSafeReconcileType(targetType: string, existingType: string): boolean {
  if (existingType === targetType) return true;
  return EXPECTED_LEGACY_BY_TARGET[targetType] === existingType;
}

/** One canonical object row to upsert (id-preserving). */
export type BackfillObjectRow = {
  id: string;
  type:
    | typeof ASSETS_BLOG_PROJECT_TYPE
    | typeof ASSETS_BLOG_IDEA_TYPE
    | typeof ASSETS_BLOG_POST_TYPE;
  parentId: string | null;
  parentType: string | null;
  data: Record<string, unknown>;
};

export type BackfillResult = {
  rows: BackfillObjectRow[];
  /** Non-fatal data-integrity notes (e.g. a post referencing a missing idea). */
  warnings: string[];
  counts: { projects: number; ideas: number; posts: number; skippedMedia: number };
};

type BlobProject = Record<string, unknown> & {
  id?: unknown;
  ideas?: unknown;
  posts?: unknown;
};

type BlobShape = {
  projects?: unknown;
  media?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Transform the parsed asset-blog blob into id-preserving canonical object
 * rows. Pure: deterministic, no I/O. The caller (script) decides how to upsert
 * + how to handle warnings (the `--strict` flag turns warnings fatal).
 */
export function transformAssetBlogBlobToObjectRows(blob: BlobShape): BackfillResult {
  const rows: BackfillObjectRow[] = [];
  const warnings: string[] = [];
  const counts = { projects: 0, ideas: 0, posts: 0, skippedMedia: 0 };

  const projects = Array.isArray(blob?.projects) ? (blob.projects as BlobProject[]) : [];

  for (const project of projects) {
    const projectId = asString(project?.id);
    if (!projectId) {
      warnings.push("skipped a project row with no id");
      continue;
    }
    counts.projects += 1;

    // Project row — generation states ride on the object. Strip the nested
    // ideas/posts arrays (they become their own rows).
    const { ideas: _ideas, posts: _posts, ...projectScalar } = project;
    rows.push({
      id: projectId,
      type: ASSETS_BLOG_PROJECT_TYPE,
      parentId: null,
      parentType: null,
      data: { ...projectScalar, id: projectId },
    });

    const ideaIds = new Set<string>();
    const ideas = Array.isArray(project?.ideas) ? (project.ideas as Array<Record<string, unknown>>) : [];
    for (const idea of ideas) {
      const ideaId = asString(idea?.id);
      if (!ideaId) {
        warnings.push(`project ${projectId}: skipped an idea row with no id`);
        continue;
      }
      ideaIds.add(ideaId);
      counts.ideas += 1;
      rows.push({
        id: ideaId,
        type: ASSETS_BLOG_IDEA_TYPE,
        parentId: projectId,
        parentType: ASSETS_BLOG_PROJECT_TYPE,
        data: { ...idea, id: ideaId, projectId },
      });
    }

    const posts = Array.isArray(project?.posts) ? (project.posts as Array<Record<string, unknown>>) : [];
    for (const post of posts) {
      const postId = asString(post?.id);
      if (!postId) {
        warnings.push(`project ${projectId}: skipped a post row with no id`);
        continue;
      }
      const ideaId = asString(post?.ideaId);
      counts.posts += 1;
      if (!ideaId) {
        warnings.push(`project ${projectId}: post ${postId} has no ideaId (parent will be null)`);
      } else if (!ideaIds.has(ideaId)) {
        warnings.push(
          `project ${projectId}: post ${postId} references missing idea ${ideaId} (dangling parent)`,
        );
      }
      rows.push({
        id: postId,
        type: ASSETS_BLOG_POST_TYPE,
        parentId: ideaId || null,
        parentType: ideaId ? ASSETS_BLOG_IDEA_TYPE : null,
        data: { ...post, id: postId, projectId },
      });
    }
  }

  const media = Array.isArray(blob?.media) ? (blob.media as unknown[]) : [];
  counts.skippedMedia = media.length;

  return { rows, warnings, counts };
}

// ---------------------------------------------------------------------------
// Parity comparison (used by the read-only pre-retirement parity gate).
// ---------------------------------------------------------------------------
//
// The gate must prove the canonical `objects.data` preserved EVERY legacy
// field, not just the critical ones — otherwise a row with a truncated `data`
// blob (lost artifact refs, wordpress/linkedin draft state, image refs, saved
// prompts) passes silently. These helpers stay in this pure, dependency-free
// module so the gate script and the vitest share one tested implementation.

/**
 * JSON round-trips a value so a parity comparison is no stricter than what the
 * backfill actually serializes via `JSON.stringify(transform.data)` — dropping
 * `undefined` values, normalizing dates to ISO strings, etc. The DB returns
 * jsonb already-parsed, so only the EXPECTED side needs round-tripping.
 */
export function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

type ValueTag = "null" | "array" | "object" | "primitive";
function valueTag(v: unknown): ValueTag {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "primitive";
}

/**
 * Returns the first key-path where `actual` fails to be a deep SUPERSET of
 * `expected` (a legacy field was lost or diverged), or `null` when
 * `actual ⊇ expected`.
 *
 * Semantics:
 *  - primitives / null: must be strictly equal.
 *  - arrays: same length; each element compared recursively (dropping or
 *    reordering an element is data loss).
 *  - objects: every key in `expected` must exist in `actual` and match
 *    recursively; `actual` MAY carry extra keys (the canonical row is allowed
 *    to ADD normalized fields, but never to LOSE a legacy one).
 *
 * Pass a `jsonRoundTrip`-ed `expected` so the comparison matches the
 * serialized shape stored in the DB.
 */
export function deepSubsetMismatch(
  expected: unknown,
  actual: unknown,
  path = "",
): string | null {
  const here = path || "<root>";
  const et = valueTag(expected);
  const at = valueTag(actual);
  if (et !== at) return `${here}: type ${et} != ${at}`;

  if (et === "primitive" || et === "null") {
    return Object.is(expected, actual)
      ? null
      : `${here}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`;
  }

  if (et === "array") {
    const ea = expected as unknown[];
    const aa = actual as unknown[];
    if (ea.length !== aa.length) {
      return `${here}: array length ${ea.length} != ${aa.length}`;
    }
    for (let i = 0; i < ea.length; i++) {
      const m = deepSubsetMismatch(ea[i], aa[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }

  const eo = expected as Record<string, unknown>;
  const ao = actual as Record<string, unknown>;
  for (const k of Object.keys(eo)) {
    const childPath = path ? `${path}.${k}` : k;
    // OWN-key semantics: `k in ao` would walk the prototype chain, so an
    // expected own key named e.g. `constructor`/`toString` that `actual` lacks
    // as an own property would false-pass via the inherited prototype member.
    if (!Object.prototype.hasOwnProperty.call(ao, k)) {
      return `${childPath}: missing in actual`;
    }
    const m = deepSubsetMismatch(eo[k], ao[k], childPath);
    if (m) return m;
  }
  return null;
}
