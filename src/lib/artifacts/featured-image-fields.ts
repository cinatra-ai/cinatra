// ---------------------------------------------------------------------------
// THE FEATURED IMAGE'S TWO DECLARED FIELDS, READ BY THE HOST (lifecycle-c W9,
// derived from the picture type's own declaration, cinatra#3251).
//
// The picture type declares two required fields: one naming the post artifact
// the picture belongs to, and one naming the placement, whose only declared
// value is the single placement the pipeline makes — it makes ONE picture and
// there are no body pictures.
//
// This is the host's side of that declaration: one place that WRITES the pair
// onto a picture the host materializes, and one place that READS it back for
// the surfaces that draw the featured image (the review, and the run page's
// outputs list when that surface lands — it has no host code today).
//
// THE NAMES ARE THE TYPE'S, NEVER THIS FILE'S (cinatra#3251). Both halves work
// from a CONTRACT read out of the picture type's REGISTERED SCHEMA, so a
// pack-side rename of either field, or a change to the placement's declared
// value, is followed rather than silently contradicted by a host constant.
//
// AND THE HOST NAMES NEITHER FIELD TO FIND THEM. The derivation is STRUCTURAL:
// of the type's required properties, the one declaring a closed set of exactly
// ONE value is the placement — and that value is the placement's — and the one
// remaining required property is the post reference. A schema without that
// shape is refused BY NAME rather than guessed at, which is the same discipline
// the reader below already applies to a row.
//
// The reader NAMES why it cannot read the pair instead of guessing: a picture
// filed before the declaration existed carries neither field, and a surface
// must be able to say "this picture does not name its post" rather than draw a
// wrong one.
//
// PURE — no fs, no DB, no server-only import, no registry import. The caller
// resolves the picture type it is working with and hands its declared schema
// in, which is also why this file names no type id.
// ---------------------------------------------------------------------------

/**
 * The picture type's own field names, read off its declared schema: the field
 * naming the post, the field naming the placement, and the placement's only
 * declared value.
 */
export type FeaturedImageFieldContract = {
  post: string;
  placement: string;
  placementValue: string;
};

/** Why the contract could not be read off a declared schema. Named, never a
 *  silent fallback to a host constant. */
export type FeaturedImageContractFailure =
  | "no-declared-schema"
  | "no-required-fields"
  | "no-single-valued-placement"
  | "no-post-field";

export type FeaturedImageContractRead =
  | { ok: true; contract: FeaturedImageFieldContract }
  | { ok: false; reason: FeaturedImageContractFailure };

/** The pair as it is written onto a row, under the type's own field names. */
export type FeaturedImageFields = Record<string, string>;

/** Why the pair could not be read. Named, never a bare null. */
export type FeaturedImageReadFailure =
  | "no-data"
  | "no-post"
  | "no-placement"
  | "unknown-placement";

export type FeaturedImageRead =
  | { ok: true; post: string; placement: string }
  | { ok: false; reason: FeaturedImageReadFailure };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The single value a property declares as its whole admitted set, or null. */
function soleDeclaredValue(property: unknown): string | null {
  const record = asRecord(property);
  if (!record) return null;
  const declared = record.enum;
  if (!Array.isArray(declared) || declared.length !== 1) return null;
  const only = declared[0];
  return typeof only === "string" && only.length > 0 ? only : null;
}

/**
 * Read the picture type's field contract off the declared schema its package
 * registered (`ObjectTypeDefinition.declaredSchema`).
 *
 * Fail-closed and named: a caller that gets a failure states nothing on the row
 * rather than writing host-invented field names, and the declared-schema check
 * on the write road then refuses with the type's own message.
 */
export function readFeaturedImageFieldContract(
  declaredSchema: unknown,
): FeaturedImageContractRead {
  const schema = asRecord(declaredSchema);
  if (!schema) return { ok: false, reason: "no-declared-schema" };

  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  if (required.length === 0) return { ok: false, reason: "no-required-fields" };

  const properties = asRecord(schema.properties) ?? {};
  const singleValued = required
    .map((name) => ({ name, value: soleDeclaredValue(properties[name]) }))
    .filter((entry): entry is { name: string; value: string } => entry.value !== null);
  if (singleValued.length !== 1) return { ok: false, reason: "no-single-valued-placement" };

  const placement = singleValued[0]!;
  const remaining = required.filter((name) => name !== placement.name);
  if (remaining.length !== 1) return { ok: false, reason: "no-post-field" };

  return {
    ok: true,
    contract: {
      post: remaining[0]!,
      placement: placement.name,
      placementValue: placement.value,
    },
  };
}

/** The declared fields for a picture the host files for a known post, written
 *  under the names the type itself declares. */
export function buildFeaturedImageFields(
  contract: FeaturedImageFieldContract,
  input: { post: string },
): FeaturedImageFields {
  return { [contract.post]: input.post, [contract.placement]: contract.placementValue };
}

/** Read the two declared fields off a picture row's object data, through the
 *  same contract the write side used. */
export function readFeaturedImageFields(
  contract: FeaturedImageFieldContract,
  data: unknown,
): FeaturedImageRead {
  const record = asRecord(data);
  if (!record) return { ok: false, reason: "no-data" };

  const post = record[contract.post];
  if (typeof post !== "string" || post.trim().length === 0) {
    return { ok: false, reason: "no-post" };
  }
  const placement = record[contract.placement];
  if (typeof placement !== "string" || placement.trim().length === 0) {
    return { ok: false, reason: "no-placement" };
  }
  if (placement !== contract.placementValue) {
    return { ok: false, reason: "unknown-placement" };
  }
  return { ok: true, post, placement: contract.placementValue };
}
