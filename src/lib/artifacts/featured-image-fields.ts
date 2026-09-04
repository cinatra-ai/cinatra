// ---------------------------------------------------------------------------
// THE FEATURED IMAGE'S TWO DECLARED FIELDS, READ BY THE HOST (lifecycle-c W9).
//
// The picture type declares two required fields: `post`, the post artifact the
// picture belongs to, and `placement`, whose only declared value is `featured`
// — the pipeline makes ONE picture and there are no body pictures.
//
// This is the host's side of that declaration: one place that WRITES the pair
// onto a picture the host materializes, and one place that READS it back for
// the surfaces that draw the featured image (the review, and the run page's
// outputs list when that surface lands — it has no host code today).
//
// The reader NAMES why it cannot read the pair instead of guessing: a picture
// filed before the declaration existed carries neither field, and a surface
// must be able to say "this picture does not name its post" rather than draw a
// wrong one.
//
// PURE — no fs, no DB, no server-only import.
// ---------------------------------------------------------------------------

/** The only placement the picture type declares. */
export const FEATURED_PLACEMENT = "featured" as const;

export type FeaturedImageFields = {
  /** The post artifact this picture belongs to. */
  post: string;
  placement: typeof FEATURED_PLACEMENT;
};

/** Why the pair could not be read. Named, never a bare null. */
export type FeaturedImageReadFailure =
  | "no-data"
  | "no-post"
  | "no-placement"
  | "unknown-placement";

export type FeaturedImageRead =
  | ({ ok: true } & FeaturedImageFields)
  | { ok: false; reason: FeaturedImageReadFailure };

/** The declared fields for a picture the host files for a known post. */
export function buildFeaturedImageFields(input: { post: string }): FeaturedImageFields {
  return { post: input.post, placement: FEATURED_PLACEMENT };
}

/** Read the two declared fields off a picture row's object data. */
export function readFeaturedImageFields(data: unknown): FeaturedImageRead {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "no-data" };
  }
  const record = data as Record<string, unknown>;
  const post = record.post;
  if (typeof post !== "string" || post.trim().length === 0) {
    return { ok: false, reason: "no-post" };
  }
  const placement = record.placement;
  if (typeof placement !== "string" || placement.trim().length === 0) {
    return { ok: false, reason: "no-placement" };
  }
  if (placement !== FEATURED_PLACEMENT) {
    return { ok: false, reason: "unknown-placement" };
  }
  return { ok: true, post, placement: FEATURED_PLACEMENT };
}
