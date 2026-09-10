// Generic server-side seam shaper for the deterministic `artifact_image_generate`
// passthrough tool (cinatra#3032, plan (C) item 0.28). Pure module (zero project
// deps) so it is unit-testable in isolation — same posture as
// ./artifact-materialize-shaper.
//
// The contract is GENERIC, like the materialize tool's: the ApiNode wires flow
// variables straight to {extension, prompt, title, node_id} plus the picture's
// own data. The shaper normalizes, parses and VALIDATES; it never invents a
// value — the title, the extension and the data come from the node's declared
// inputs, never from prompt text.
//
// `data` may arrive as a native object or, because a wayflowcore ApiNode
// stringifies a json_body template, as a JSON string in `dataJson`. Exactly one
// of the two, and both encode an object — a list or a scalar is not "the data
// the picture carries".

export type ShapedArtifactImageInput = {
  /** Artifact-extension package name — runtime-validated against the run's produces. */
  extension: string;
  /** What the picture is of. Recorded on the ledger row of this write. */
  prompt: string;
  /** The picture's title — explicit, never prompt-invented. Empty on a
   *  REGENERATION: the artifact already carries the title its creator gave it. */
  title: string;
  /** The calling ApiNode's id — the idempotency-ledger output identity. */
  nodeId: string;
  /** OPTIONAL image model the caller names; the adapter may address another. */
  model?: string;
  /** OPTIONAL declared-type discriminator (`@scope/package:local-id`). */
  objectTypeId?: string;
  /** The object's own data — validated against the type's schema at the write. */
  data?: Record<string, unknown>;
  /**
   * THE REGENERATION (item 0.28 through item 0.30). Present together or not at
   * all: a regeneration that does not name what it read cannot be checked, and a
   * base without an artifact names nothing.
   */
  artifactId?: string;
  baseRepresentationRevisionId?: string;
};

/** `@scope/package:local-id` — mirrors the binding grammar regex. */
const OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

function requireNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `artifact_image_generate input.${field} must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

function optionalNonEmptyString(
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `artifact_image_generate input.${field}, when present, must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

function asDataObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `artifact_image_generate ${where} must encode a JSON object — the data the picture ` +
        `carries is the object's own fields (got ${
          value === null ? "null" : Array.isArray(value) ? "array" : typeof value
        })`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Shape a raw passthrough `input` payload into the image tool's call.
 * Throws `Error` on any missing/invalid field — the route surfaces the message
 * as a 400 (the existing shaper-throw contract).
 */
export function shapeArtifactImageInput(
  raw: Record<string, unknown>,
): ShapedArtifactImageInput {
  const extension = requireNonEmptyString(raw, "extension");
  const prompt = requireNonEmptyString(raw, "prompt");
  const nodeId = requireNonEmptyString(raw, "node_id");
  const model = optionalNonEmptyString(raw, "model");

  const hasArtifactId = raw.artifactId !== undefined && raw.artifactId !== null;
  const hasBase =
    raw.baseRepresentationRevisionId !== undefined &&
    raw.baseRepresentationRevisionId !== null;
  if (hasArtifactId !== hasBase) {
    throw new Error(
      "artifact_image_generate input.artifactId and input.baseRepresentationRevisionId must be " +
        "given together — a regeneration names the picture it revises AND the revision it read",
    );
  }
  const artifactId = hasArtifactId ? requireNonEmptyString(raw, "artifactId") : undefined;
  const baseRepresentationRevisionId = hasBase
    ? requireNonEmptyString(raw, "baseRepresentationRevisionId")
    : undefined;

  // A REGENERATION revises a picture that already carries a title; requiring one
  // here would make the caller restate — or worse, invent — a name the picture
  // already has. A first generation still states its title explicitly.
  const title =
    artifactId === undefined
      ? requireNonEmptyString(raw, "title")
      : typeof raw.title === "string"
        ? raw.title.trim()
        : "";

  let objectTypeId: string | undefined;
  if (raw.objectTypeId !== undefined && raw.objectTypeId !== null) {
    if (typeof raw.objectTypeId !== "string" || !OBJECT_TYPE_ID_RE.test(raw.objectTypeId)) {
      throw new Error(
        `artifact_image_generate input.objectTypeId, when present, must be a namespaced object type id (@scope/package:local-id) (got ${JSON.stringify(raw.objectTypeId)})`,
      );
    }
    objectTypeId = raw.objectTypeId;
  }

  const hasData = raw.data !== undefined && raw.data !== null;
  const hasDataJson = raw.dataJson !== undefined && raw.dataJson !== null;
  if (hasData && hasDataJson) {
    throw new Error(
      "artifact_image_generate input.data and input.dataJson are two spellings of one field — " +
        "send exactly one",
    );
  }
  let data: Record<string, unknown> | undefined;
  if (hasData) {
    data = asDataObject(raw.data, "input.data");
  } else if (hasDataJson) {
    if (typeof raw.dataJson !== "string") {
      throw new Error(
        `artifact_image_generate input.dataJson must be a string of JSON (got ${typeof raw.dataJson})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.dataJson);
    } catch {
      throw new Error("artifact_image_generate input.dataJson is not parseable JSON");
    }
    data = asDataObject(parsed, "input.dataJson");
  }

  return {
    extension,
    prompt,
    title,
    nodeId,
    ...(model ? { model } : {}),
    ...(objectTypeId ? { objectTypeId } : {}),
    ...(data ? { data } : {}),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(baseRepresentationRevisionId === undefined
      ? {}
      : { baseRepresentationRevisionId }),
  };
}
