import "server-only";

// Shared (non-"use server") helpers for the artifact-edit-binary-prompt
// portlet's loaders + actions. Lives outside portlet-loaders.ts /
// portlet-actions.ts because "use server" modules may only export async
// functions — these are sync values.

/**
 * Server-side allow-list of live generation primitives, keyed by the START
 * primitive name from portlet config, mapping to its paired CANCEL primitive.
 * Mirrors the `refSwapPrimitive` posture in `editArtifactTextAction`: config
 * carries a primitive NAME, the server decides what is actually invocable.
 * Only the blog hero-image pipeline is live this phase.
 */
export const BINARY_GENERATION_PRIMITIVE_PAIRS: Readonly<Record<string, string>> = Object.freeze({
  "blog_image_generate_start": "blog_image_generate_cancel",
});

/** Live refSwapPrimitive allow-list for the manual-mode revert path (same
 *  single live primitive as the artifact-edit-text portlet). */
export const BINARY_REF_SWAP_PRIMITIVES: ReadonlySet<string> = new Set(["blog_post_update"]);

/** Server-side cap for the user-supplied generation prompt. The primitive
 *  schema accepts an unbounded string and the generator interpolates it into
 *  the provider prompt verbatim — bound it at this trust boundary. */
export const BINARY_REGEN_PROMPT_MAX_LENGTH = 2000;

/**
 * Derive the blog project/post refs from a GATED parent object's data.
 * Canonical `@cinatra-ai/assets:blog-post` rows carry `data.id` (the post id)
 * + `data.projectId` — they have NO `postId` field (see
 * `asset-blog-store-codec.ts` / `register-object-types.ts`). Externally
 * composed dashboard objects may instead carry an explicit `postId`. Accept
 * both: explicit `postId` wins, `id` is the canonical fallback.
 */
export function deriveBlogPostRefs(data: Record<string, unknown>): {
  projectId: string | null;
  postId: string | null;
} {
  const projectId = typeof data.projectId === "string" && data.projectId ? data.projectId : null;
  const explicit = typeof data.postId === "string" && data.postId ? data.postId : null;
  const canonical = typeof data.id === "string" && data.id ? data.id : null;
  return { projectId, postId: explicit ?? canonical };
}

/**
 * The representation-revision field paired with an `…ArtifactId` object field
 * (e.g. `imageArtifactId` → `imageRepresentationRevisionId`). Returns null when
 * the field does not follow the pairing convention.
 */
export function pairedRevisionField(artifactIdField: string): string | null {
  if (!artifactIdField.endsWith("ArtifactId")) return null;
  return `${artifactIdField.slice(0, -"ArtifactId".length)}RepresentationRevisionId`;
}

export type BinaryGenerationStatusValue = "idle" | "running" | "succeeded" | "failed" | "stopped";

/** Canned, post-scoped status messages. Raw pipeline messages (which can
 *  carry provider error text), jobIds, and foreign-post titles never cross
 *  the loader boundary. */
export const BINARY_GENERATION_STATUS_MESSAGES: Readonly<Record<BinaryGenerationStatusValue, string>> =
  Object.freeze({
    idle: "",
    running: "Generating a new image…",
    succeeded: "Generated a new image.",
    failed: "Image generation failed.",
    stopped: "Image generation stopped.",
  });

export function normalizeBinaryGenerationStatus(status: unknown): BinaryGenerationStatusValue {
  return status === "running" || status === "succeeded" || status === "failed" || status === "stopped"
    ? status
    : "idle";
}
