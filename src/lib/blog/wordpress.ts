import "server-only";

// The WordPress client is CONNECTOR-owned since cinatra#975 Wave 3 — the
// publish flow resolves the relocated instance-admin + content clients lazily
// and FAILS LOUD (descriptive error through the existing publish failure
// path) when the owning connector is absent.
import {
  requireWordPressContentClient,
  requireWordPressInstanceAdmin,
  type WordPressInstanceRow,
  type WordPressWritableDraftPayload,
} from "@/lib/connector-client-providers";
// The WordPress draft-write is fully routed through the
// @cinatra-ai/blog-connector facade. The create payload (+ optional
// site-specific `postMeta`) is built by the resolved connector:
//   - no `blogConnectorId` binding -> `defaultBlogConnector` (generic
//     markdown->HTML, no Elementor)
//   - a named `blogConnectorId` -> the bundled site connector registered under
//     that id (e.g. a site-specific page-builder node-tree swap + template selectors)
//
// ALL Elementor-meta construction + the site-specific rendered-template
// selectors live in the bundled site connector. This file (and
// `@cinatra-ai/blog-connector`) contain ZERO Elementor-meta references;
// the grep gate asserts this.
// Draft payloads build through the `blog-system` capability the blog-connector
// registers at activation (lazy/guarded host-access cutover) — absence fails
// the draft build with a descriptive error through the existing failure path.
import { requireBlogSystem } from "@/lib/blog-system-provider";
import { readBlogImageArtifactBytes } from "@/lib/blog-image-materializer";

// cinatra#2022 — blog-publish re-point. Three of the four legs this function
// used to run as direct REST through the connector-owned
// `wordpressContent`/`wordpressAdmin` clients now run through the GOVERNED
// generic invoker (cinatra#2017) against the community
// `enable-abilities-for-mcp` catalog instead of the plugin's own bespoke
// content-server abilities:
//   - draft creation        -> ewpa/create-post
//   - draft meta write      -> ewpa/update-post-meta
//   - latest-published read -> ewpa/get-posts (status:publish, newest-first)
// Featured-image upload is the one leg that does NOT move here: it stays on
// the direct WordPress core REST path (`/wp/v2/media`) for now. It follows
// onto the generic pipeline in a follow-up PR (cinatra persisting the image as
// an artifact and passing its URL to the catalog's upload ability) — see the
// comment at its call site below.
import {
  invokeConnectorInstanceTool,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import { buildConnectorInstanceInvokerDeps } from "@/lib/register-host-connector-services";
import { resolveTrustedWriteActor } from "@/lib/connector-instance-write-authority";

const WORDPRESS_INVOKER_CONNECTOR_KEY = "wordpress";

/**
 * Resolve the trusted actor this invocation runs as. `publishBlogPostDraftToWordPress`
 * executes inside a queued BullMQ worker job (`BLOG_POST_WORDPRESS_DRAFT_CREATION`),
 * never a live request — but the platform's job dispatcher already re-establishes
 * the ENQUEUING actor's ALS frame around the whole job handler: `enqueueBackgroundJob`
 * attaches the enqueue-time actor context onto the job payload (`__actorContext`,
 * `background-jobs.ts`), and the dispatcher restores it via `withActorContext`
 * before the registered `handle` runs (`background-jobs-registry.ts`'s
 * `BLOG_POST_WORDPRESS_DRAFT_CREATION` entry: `authorityKind: "originating-actor"`,
 * `actorSource: "enqueuer-actor-context"`).
 *
 * `resolveTrustedWriteActor()` is the SAME host-derived actor resolver the
 * invoker's own MCP-bound guard uses (`resolveConnectorInstanceInvokerContext`,
 * `register-host-connector-services.ts`), so this re-authorizes LIVE against the
 * actor's CURRENT org membership at execution time — never an enqueue-time
 * snapshot — satisfying the same per-instance write-authority gate (#409) every
 * other invoker caller goes through (`connector-instance-write-authority.ts`'s
 * live org-membership re-verification, run again per-call inside the invoker's
 * own gate). No anonymous/synthetic executor: an absent actor fails the publish
 * loudly rather than degrading to a synthetic identity.
 */
async function resolveBlogPublishInvokerActor(): Promise<InvokerTrustedActor> {
  const resolved = await resolveTrustedWriteActor();
  if (!resolved) {
    throw new Error(
      "Unable to publish to WordPress: no trusted actor could be resolved for this job. " +
        "The originating user's session context may have been lost before the background job ran.",
    );
  }
  return resolved;
}

/**
 * One call, one invoker call. `buildConnectorInstanceInvokerDeps` is the ONE
 * additive builder `register-host-connector-services.ts` exports for exactly
 * this "job path" seam — a low-level caller supplying `connectorKey` directly
 * rather than through the signed-pin MCP guard (the same builder the S5 resume
 * executor uses, so park-time and resume-time invoker deps share one object
 * graph by construction).
 */
async function invokeWordPressSiteAbility(input: {
  instanceId: string;
  toolName: string;
  args: Record<string, unknown>;
  actor: InvokerTrustedActor;
  primitiveName: string;
  causation?: string;
}): Promise<unknown> {
  return invokeConnectorInstanceTool(
    {
      connectorKey: WORDPRESS_INVOKER_CONNECTOR_KEY,
      instanceId: input.instanceId,
      toolName: input.toolName,
      args: input.args,
      actor: input.actor,
      primitiveName: input.primitiveName,
      // Deliberately NOT one of the invoker's recognized delegated surfaces
      // (chat/agent_run/public_site_widget/session) — a background worker job
      // has no live human to click a confirmation card.
      // `normalizeConfirmationSurface` (connector-instance-destructive-hook.ts)
      // maps any unrecognized value to the fail-safe "session" (REQUIRE) row,
      // so IF a site ever misclassified one of these abilities as destructive,
      // the job would fail loudly instead of executing unconfirmed — the
      // correct default for an unattended path. In practice this never fires:
      // none of create-post/update-post-meta/get-posts match the
      // known-destructive name floor (`known-destructive-floor.ts`).
      sourceType: "background_job",
      ...(input.causation ? { causation: input.causation } : {}),
    },
    buildConnectorInstanceInvokerDeps(WORDPRESS_INVOKER_CONNECTOR_KEY),
  );
}

/** Linear trailing-slash trim (repo-standard ReDoS-safe form, matching
 * `register-host-connector-services.ts`'s `trimTrailingSlashesForSiteMatch`). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return value.slice(0, end);
}

function buildWordPressAdminEditUrl(siteUrl: string, wordpressPostId: number): string {
  return `${trimTrailingSlashes(siteUrl)}/wp-admin/post.php?post=${wordpressPostId}&action=edit`;
}

/**
 * Map the blog-connector's WP-REST-shaped draft payload onto `ewpa/create-post`'s
 * ability schema — verified against the pinned fixture (cinatra#2016,
 * `tests/e2e/wp-mcp-gateway/captures/verify-verdicts.json`): `inputSchemaProps`
 * title/content/excerpt/status/categories/tags/featured_image_id/post_date/
 * author_id/slug/meta_title/meta_description/language/translation_of).
 *
 * Only fields with a confirmed 1:1 counterpart are forwarded. REST-only fields
 * the ability's schema has no equivalent for (`comment_status`, `ping_status`,
 * `format`, `sticky`, `template`, the generic `meta` map) are DISCLOSED-dropped
 * — never silently absorbed — with a loud warning if a caller ever actually
 * populates one, so a future site-specific blog connector that starts setting
 * them doesn't lose that setting unnoticed. `categories`/`tags` are ALSO
 * dropped: the REST payload carries numeric WP term ids, but `ewpa/get-posts`'s
 * own captured output returns category/tag NAMES (not ids) for this same
 * plugin family — forwarding the REST ids as-is would silently miscategorize
 * the post rather than tag it correctly, so omitting is safer than guessing.
 */
function buildEwpaCreatePostArgs(payload: WordPressWritableDraftPayload): Record<string, unknown> {
  const unsupportedIfSet: Array<[string, unknown]> = [
    ["comment_status", payload.comment_status],
    ["ping_status", payload.ping_status],
    ["format", payload.format],
    ["sticky", payload.sticky],
    ["template", payload.template],
    ["meta", payload.meta],
    ["categories", payload.categories],
    ["tags", payload.tags],
  ];
  for (const [field, value] of unsupportedIfSet) {
    if (value !== undefined) {
      console.warn(
        `[blog:publishToWordPress] draft payload field "${field}" has no ewpa/create-post ` +
          "equivalent and was NOT sent to WordPress (cinatra#2022 re-point).",
      );
    }
  }
  const args: Record<string, unknown> = {
    title: payload.title,
    content: payload.content,
    excerpt: payload.excerpt,
    status: payload.status,
  };
  if (payload.slug !== undefined) args.slug = payload.slug;
  if (payload.author !== undefined) args.author_id = payload.author;
  if (payload.featured_media !== undefined) args.featured_image_id = payload.featured_media;
  return args;
}

/** Create the draft via `ewpa/create-post` through the invoker. Response shape
 * verified against the pinned WordPress MCP gateway fixture (cinatra#2016):
 * `{success, data:{post_id, permalink, status, message}}`. */
async function createDraftViaInvoker(input: {
  instance: WordPressInstanceRow;
  payload: WordPressWritableDraftPayload;
  actor: InvokerTrustedActor;
  causation?: string;
}): Promise<{ wordpressPostId: number; publicUrl?: string; adminUrl: string }> {
  const raw = await invokeWordPressSiteAbility({
    instanceId: input.instance.id,
    toolName: "ewpa/create-post",
    args: buildEwpaCreatePostArgs(input.payload),
    actor: input.actor,
    primitiveName: "blog_publish_wordpress_create_draft",
    causation: input.causation,
  });
  const parsed = raw as { success?: boolean; data?: { post_id?: unknown; permalink?: unknown } } | null;
  const postId = parsed?.data?.post_id;
  const rawPermalink = parsed?.data?.permalink;
  if (!parsed?.success || typeof postId !== "number") {
    throw new Error(
      "WordPress draft creation did not return a post id (ewpa/create-post response was malformed).",
    );
  }
  const permalink = typeof rawPermalink === "string" ? rawPermalink : undefined;
  return {
    wordpressPostId: postId,
    ...(permalink ? { publicUrl: permalink } : {}),
    adminUrl: buildWordPressAdminEditUrl(input.instance.siteUrl, postId),
  };
}

/** Write the draft's post-meta via `ewpa/update-post-meta` through the
 * invoker. Response shape verified against the pinned fixture (cinatra#2016)
 * on the highest-risk protected-meta case, `_elementor_data`. The ability
 * writes ONE {post_id, meta_key, meta_value}
 * triple per call — unlike the old single REST PATCH, a multi-key `meta` map
 * is applied as N SEQUENTIAL calls, NOT atomically. Today's only production
 * caller (the Elementor-meta site connector) ever populates exactly one key
 * (`_elementor_data`), so this is behavior-identical in practice; a future
 * multi-key caller should be aware a mid-loop failure leaves the draft with a
 * PARTIAL meta write (surfaced through the existing publish failure path
 * either way, never swallowed). */
async function updateDraftMetaViaInvoker(input: {
  instance: WordPressInstanceRow;
  wordpressPostId: number;
  meta: Record<string, unknown>;
  actor: InvokerTrustedActor;
  causation?: string;
}): Promise<void> {
  for (const [metaKey, metaValue] of Object.entries(input.meta)) {
    const raw = await invokeWordPressSiteAbility({
      instanceId: input.instance.id,
      toolName: "ewpa/update-post-meta",
      args: {
        post_id: input.wordpressPostId,
        meta_key: metaKey,
        meta_value: typeof metaValue === "string" ? metaValue : JSON.stringify(metaValue),
      },
      actor: input.actor,
      primitiveName: "blog_publish_wordpress_update_draft_meta",
      causation: input.causation,
    });
    // Mirror createDraftViaInvoker's validation: a non-erroring MCP call can
    // still carry a business-level `success:false` in its JSON body (the
    // ability's own error path, distinct from the transport-level `isError`
    // the invoker already throws on). Not checking this would let a failed
    // meta write report the publish as fully succeeded with a silently
    // missing/partial `_elementor_data` — a real regression from the old REST
    // path, where a failed meta write fails the publish.
    const parsed = raw as { success?: boolean } | null;
    if (!parsed?.success) {
      throw new Error(
        `WordPress post-meta update for "${metaKey}" did not report success (ewpa/update-post-meta response was malformed or failed).`,
      );
    }
  }
}

/**
 * Read the latest published post via `ewpa/get-posts` through the invoker —
 * status:"publish", orderby:"date"/order:"DESC", newest first (verified
 * against the pinned fixture, cinatra#2016). Returns `null` when the site has
 * no published post yet, matching the pre-re-point contract's nullable
 * return.
 *
 * KNOWN, DISCLOSED GAP: `ewpa/get-posts` is a LIST ability. Confirmed against
 * the WP MCP gateway's own advertised tool descriptions
 * (`tests/e2e/wp-mcp-gateway/captures/annotations-c-gateway-triad.json`):
 * `ewpa/get-posts` = "Retrieves a list of blog posts with optional filters...",
 * while only the SINGULAR `ewpa/get-post` = "Retrieves all details of a
 * specific post by ID, INCLUDING FULL CONTENT, metadata, and featured image."
 * The list ability's captured output (verify-verdicts.json) confirms this:
 * items carry ID/post_title/post_status/post_date/post_excerpt/post_author/
 * permalink/categories/tags — no post body content, no numeric taxonomy ids.
 * `ewpa/get-post`'s existence has not been proven out yet, so this leg does
 * not build on it. The `writableTemplate` this returns is therefore a
 * BEST-EFFORT template with `content` left empty: a site-specific blog
 * connector that reads the latest published post's body for template
 * purposes gets a degraded (empty-content) template until a future change
 * re-points this onto `ewpa/get-post` once that ability's existence is
 * proven out. Flagged here and in the PR description — not a silent
 * regression.
 */
async function readLatestPublishedWordPressPostViaInvoker(input: {
  instance: WordPressInstanceRow;
  actor: InvokerTrustedActor;
  causation?: string;
}): Promise<{ apiResponse: unknown; writableTemplate: WordPressWritableDraftPayload } | null> {
  const raw = await invokeWordPressSiteAbility({
    instanceId: input.instance.id,
    toolName: "ewpa/get-posts",
    args: { status: "publish", orderby: "date", order: "DESC", numberposts: 1 },
    actor: input.actor,
    primitiveName: "blog_publish_wordpress_read_latest_published",
    causation: input.causation,
  });
  const parsed = raw as { success?: boolean; data?: unknown } | null;
  // A business-level `success:false` (or a malformed/absent wrapper, INCLUDING
  // a `data` that isn't even an array) is a REAL failure — an auth/API error
  // or a shape the invoker's evidence never proved, not "no published posts
  // yet" — and must fail the publish rather than be treated the same as a
  // genuinely empty result set. Only `success:true` with an EMPTY `data` array
  // means "no published posts" (the nullable case this leg's contract already
  // documents); a non-array `data` (missing/object/etc.) is malformed, not empty.
  if (!parsed || !parsed.success || !Array.isArray(parsed.data)) {
    throw new Error(
      "Unable to read the latest published WordPress post (ewpa/get-posts response was malformed or failed).",
    );
  }
  const list = parsed.data as Array<Record<string, unknown>>;
  const latest = list[0];
  if (!latest) return null;

  const title = typeof latest.post_title === "string" ? latest.post_title : "";
  const excerpt = typeof latest.post_excerpt === "string" ? latest.post_excerpt : "";

  return {
    // Raw ability response, passed through OPAQUE exactly like the pre-re-point
    // contract (`apiResponse: unknown`) — but its SHAPE has changed: this is
    // `ewpa/get-posts`'s flattened list-item JSON, NOT the raw WP REST
    // `/wp/v2/posts` document the old direct-REST leg returned. A downstream
    // connector reading old REST field names here (e.g. `title.rendered`) will
    // no longer find them — a disclosed, real shape change (see PR body).
    apiResponse: latest,
    writableTemplate: {
      title,
      content: "",
      excerpt,
      status: "draft",
    },
  };
}

export async function publishBlogPostDraftToWordPress(input: {
  wordpressInstanceId: string;
  companyUrl: string;
  postTitle: string;
  postExcerpt: string;
  blogPostContent: string;
  /** When `true`, `blogPostContent` is already HTML (returned by a site-specific MCP converter). */
  contentIsHtml?: boolean;
  // Image bytes are read from the canonical
  // `@cinatra-ai/blog-image-artifact` representation via refs; the publish
  // path does not accept raw bytes from callers.
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  /** Advisory causation stamp (jobId) threaded into the invoker's audit rows
   * for the three re-pointed legs below (cinatra#2022). */
  causation?: string;
  onProgress?: (message: string, instanceName?: string) => Promise<void> | void;
}) {
  const wordpressAdmin = requireWordPressInstanceAdmin();
  // Used ONLY for the featured-image upload leg now (the carve-out below) —
  // the other three legs this client used to serve (createDraft/
  // updateDraftMeta/readLatestPublishedWordPressPost) are re-pointed onto the
  // governed invoker.
  const wordpressContent = requireWordPressContentClient();
  const instance = wordpressAdmin.readInstanceById(input.wordpressInstanceId);
  if (!instance) {
    throw new Error("Selected WordPress instance not found.");
  }

  const invokerActor = await resolveBlogPublishInvokerActor();

  await input.onProgress?.("Loading the latest published WordPress post JSON.", instance.name);
  const latestPublishedPost = await readLatestPublishedWordPressPostViaInvoker({
    instance,
    actor: invokerActor,
    causation: input.causation,
  });

  let featuredMediaId: number | undefined;
  let featuredMediaUrl: string | undefined;
  if (input.imageArtifactId && input.imageRepresentationRevisionId) {
    await input.onProgress?.("Reading image bytes from the blog-image-artifact.", instance.name);
    const bytes = await readBlogImageArtifactBytes({
      imageArtifactId: input.imageArtifactId,
      imageRepresentationRevisionId: input.imageRepresentationRevisionId,
    });
    if (bytes) {
      await input.onProgress?.("Uploading image as the featured image in WordPress.", instance.name);
      // MEDIA-UPLOAD CARVE-OUT: this leg stays on the direct WordPress core
      // REST path (`/wp/v2/media`) FOR NOW — the pinned-fixture VERIFY pass
      // (cinatra#2016) found `ewpa/upload-image`'s schema is URL-only (no
      // base64/bytes input), so it cannot carry these already-materialized
      // image bytes as-is. It follows onto the generic pipeline in a
      // follow-up PR: cinatra persists the image as an artifact and passes
      // the artifact's URL to the catalog's upload ability, rather than
      // staging bytes at a new ad hoc public URL. Nothing else in this
      // function's call graph reaches `wordpressContent` anymore.
      const uploadedMedia = await wordpressContent.uploadMedia({
        instance,
        imageBase64: bytes.imageBase64,
        imageMimeType: bytes.imageMimeType,
        title: input.postTitle,
      });
      featuredMediaId = uploadedMedia.mediaId;
      featuredMediaUrl = uploadedMedia.sourceUrl;
    }
  }

  await input.onProgress?.("Preparing the WordPress post payload.", instance.name);
  const builtDraft = await requireBlogSystem().buildDraftPayload(
    {
      postTitle: input.postTitle,
      postExcerpt: input.postExcerpt,
      blogPostContent: input.blogPostContent,
      contentIsHtml: input.contentIsHtml,
      latestPublishedPost,
      featuredMedia:
        featuredMediaId && featuredMediaUrl
          ? { id: featuredMediaId, url: featuredMediaUrl }
          : undefined,
    },
    {
      instanceBlogConnectorId: instance.blogConnectorId,
    },
  );

  await input.onProgress?.("Creating the draft in WordPress.", instance.name);
  const createdDraft = await createDraftViaInvoker({
    instance,
    payload: {
      ...builtDraft.createPayload,
      excerpt: input.postExcerpt.trim() || builtDraft.createPayload.excerpt,
      featured_media:
        featuredMediaId ??
        ("featured_media" in builtDraft.createPayload
          ? builtDraft.createPayload.featured_media
          : undefined),
    } satisfies WordPressWritableDraftPayload,
    actor: invokerActor,
    causation: input.causation,
  });

  // The resolved connector returns `postMeta` ONLY when it has site-
  // specific meta to write (the named site connector -> the swapped node-tree).
  // The generic default returns `postMeta: undefined` and the second call
  // is skipped entirely.
  if (builtDraft.postMeta) {
    await input.onProgress?.("Applying the connector-supplied post meta to the draft.", instance.name);
    await updateDraftMetaViaInvoker({
      instance,
      wordpressPostId: createdDraft.wordpressPostId,
      meta: builtDraft.postMeta,
      actor: invokerActor,
      causation: input.causation,
    });
  }

  return {
    instance,
    formattedDraft: builtDraft.createPayload,
    createdDraft,
  };
}
