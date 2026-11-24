// Generic server-side seam shaper for the deterministic `artifact_materialize`
// passthrough tool (cinatra#925). Pure module (zero project deps) so it is
// unit-testable in isolation — same posture as ./test-delivery-seam.
//
// Unlike the per-agent `_shape` opt-ins, the contract is GENERIC: the ApiNode
// wires flow variables straight to {extension, content, declaredMime, title,
// node_id} (+ optional `contentJsonField` for parse-then-project, covering
// the "seam" JSON-string cases without per-agent code). The shaper
// normalizes/parses; it NEVER invents values — title and MIME come from the
// node's declared inputs, never from prompt text.

export type ShapedArtifactMaterializeInput = {
  /** Artifact-extension package name — runtime-validated ∈ the run's produces. */
  extension: string;
  /** The artifact content bytes (utf-8 string). */
  content: string;
  /** Text-authorable MIME declared by the node. */
  declaredMime: string;
  /** Artifact title — explicit, never prompt-invented. Empty on an APPEND: the
   *  artifact already carries the title its creator gave it. */
  title: string;
  /**
   * THE SAME-ARTIFACT REVISION (cinatra#3030, plan item 0.30). When BOTH of
   * these are present the call APPENDS the next revision of an existing
   * artifact instead of creating a new one, and `baseRepresentationRevisionId`
   * is the revision the caller READ — the compare-and-set's expected base.
   * Present together or not at all: an append that does not name what it read
   * cannot be checked, and a base without an artifact names nothing.
   */
  artifactId?: string;
  baseRepresentationRevisionId?: string;
  /** The calling ApiNode's id — the idempotency-ledger output identity. */
  nodeId: string;
  /** OPTIONAL declared-type discriminator (cinatra#1454) — the exact
   *  `@scope/pkg:local-id` the tool materializes into (else the run
   *  materializer's single-artifact-safe-type fallback / fail-closed). */
  objectTypeId?: string;
  /**
   * THE LIST MODE (cinatra#3089): one artifact per member of a JSON array, in
   * order, each under the same node. Present only when the call names both
   * `memberContentField` and `memberTitleField`; then `content` is the raw list
   * text the call carried and `title` is empty — every member carries its own.
   */
  members?: ShapedArtifactMaterializeMember[];
};

/** One member of a list-mode call: its own title and its own content bytes. */
export type ShapedArtifactMaterializeMember = { title: string; content: string };

/** The list mode's member bound — the review plan's own target bound
 *  (`MAX_REVIEW_TARGETS`), restated because this module has zero deps. */
export const MAX_MATERIALIZE_LIST_MEMBERS = 50;

/** `@scope/package:local-id` — mirrors the binding grammar regex. */
const OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

/** The title an APPEND may carry, or the empty string. Never invented. */
function titleIfPresent(raw: Record<string, unknown>): string {
  const value = raw.title;
  return typeof value === "string" ? value.trim() : "";
}

function requireNonEmptyString(
  raw: Record<string, unknown>,
  field: string,
): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `artifact_materialize input.${field} must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

/**
 * Shape a raw passthrough `input` payload into the materializer call.
 * Throws `Error` on any missing/invalid field — the route surfaces the
 * message as a 400 (the existing shaper-throw contract).
 *
 * `contentJsonField` semantics (parse-then-project): `content` must be a
 * JSON string encoding an object; the named field is projected out. A string
 * value becomes the content verbatim; a structured value is accepted ONLY
 * for `declaredMime: application/json` bindings (deterministic
 * JSON.stringify — mirroring the run-completion materializer's structured-
 * output rule); anything else fails closed.
 */
export function shapeArtifactMaterializeInput(
  raw: Record<string, unknown>,
): ShapedArtifactMaterializeInput {
  const extension = requireNonEmptyString(raw, "extension");
  const declaredMime = requireNonEmptyString(raw, "declaredMime");
  const nodeId = requireNonEmptyString(raw, "node_id");

  // ---- the same-artifact revision (cinatra#3030, item 0.30) --------------
  const hasArtifactId = raw.artifactId !== undefined && raw.artifactId !== null;
  const hasBase =
    raw.baseRepresentationRevisionId !== undefined && raw.baseRepresentationRevisionId !== null;
  if (hasArtifactId !== hasBase) {
    throw new Error(
      "artifact_materialize input.artifactId and input.baseRepresentationRevisionId must be " +
        "given together — an append names the artifact it revises AND the revision it read",
    );
  }
  const artifactId = hasArtifactId ? requireNonEmptyString(raw, "artifactId") : undefined;
  const baseRepresentationRevisionId = hasBase
    ? requireNonEmptyString(raw, "baseRepresentationRevisionId")
    : undefined;
  // An APPEND revises an artifact that already carries a title; requiring one
  // here would make the caller restate — or worse, invent — a name the artifact
  // already has. A CREATE still states its title explicitly.
  const isList = raw.memberContentField !== undefined || raw.memberTitleField !== undefined;
  const title =
    artifactId !== undefined || isList ? titleIfPresent(raw) : requireNonEmptyString(raw, "title");

  let objectTypeId: string | undefined;
  const objectTypeIdRaw = raw.objectTypeId;
  if (objectTypeIdRaw !== undefined) {
    if (typeof objectTypeIdRaw !== "string" || !OBJECT_TYPE_ID_RE.test(objectTypeIdRaw)) {
      throw new Error(
        `artifact_materialize input.objectTypeId, when present, must be a namespaced object type id (@scope/package:local-id) (got ${JSON.stringify(objectTypeIdRaw)})`,
      );
    }
    objectTypeId = objectTypeIdRaw;
  }

  const contentRaw = raw.content;
  const hasMemberContentField = raw.memberContentField !== undefined;
  const hasMemberTitleField = raw.memberTitleField !== undefined;
  if (hasMemberContentField || hasMemberTitleField) {
    return {
      extension,
      content: typeof contentRaw === "string" ? contentRaw : "",
      declaredMime,
      title: "",
      nodeId,
      ...(objectTypeId ? { objectTypeId } : {}),
      members: shapeListMembers(raw, hasMemberContentField, hasMemberTitleField),
    };
  }
  if (typeof contentRaw !== "string") {
    throw new Error(
      `artifact_materialize input.content must be a string (got ${
        Array.isArray(contentRaw) ? "array" : typeof contentRaw
      })`,
    );
  }
  let content = contentRaw;

  const contentJsonField = raw.contentJsonField;
  if (contentJsonField !== undefined) {
    if (typeof contentJsonField !== "string" || contentJsonField.length === 0) {
      throw new Error(
        "artifact_materialize input.contentJsonField, when present, must be a non-empty string",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentRaw);
    } catch {
      throw new Error(
        `artifact_materialize input.content is not parseable JSON (contentJsonField "${contentJsonField}" requires a JSON-object content payload)`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `artifact_materialize input.content must encode a JSON object when contentJsonField is set (got ${
          Array.isArray(parsed) ? "array" : typeof parsed
        })`,
      );
    }
    const projected = (parsed as Record<string, unknown>)[contentJsonField];
    if (typeof projected === "string") {
      content = projected;
    } else if (
      projected !== undefined &&
      projected !== null &&
      declaredMime === "application/json"
    ) {
      // Structured field bound as application/json — serialize
      // deterministically. Never applied to non-JSON MIMEs (no value
      // invention).
      content = JSON.stringify(projected);
    } else {
      throw new Error(
        `artifact_materialize input.contentJsonField "${contentJsonField}" did not resolve to a string` +
          (projected === undefined || projected === null
            ? " (field missing from the content payload)"
            : ` (got ${Array.isArray(projected) ? "array" : typeof projected}; structured values are only accepted for application/json)`),
      );
    }
  }

  return {
    extension,
    content,
    declaredMime,
    title,
    nodeId,
    ...(objectTypeId ? { objectTypeId } : {}),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(baseRepresentationRevisionId === undefined
      ? {}
      : { baseRepresentationRevisionId }),
  };
}

/**
 * THE LIST MODE (cinatra#3089). `content` is a JSON array (the text a flow
 * variable carries); `memberContentField` and `memberTitleField` name, as
 * literals, the field of each member that is its content and its title. Every
 * member is checked before anything is filed, so a refusal here files nothing.
 * Refused: one field without the other; a list combined with an append or with
 * `contentJsonField`, or with a top-level title; a content that is not a JSON
 * array; an empty list or one over the bound; a member that is not an object,
 * whose content is missing or not a string, or whose title is missing or blank;
 * two members with the same content bytes (they would collapse into one
 * artifact, and the review plan refuses one target named twice).
 */
function shapeListMembers(
  raw: Record<string, unknown>,
  hasMemberContentField: boolean,
  hasMemberTitleField: boolean,
): ShapedArtifactMaterializeMember[] {
  if (!hasMemberContentField || !hasMemberTitleField) {
    throw new Error(
      "artifact_materialize input.memberContentField and input.memberTitleField must be " +
        "given together — a list call names the content AND the title of every member",
    );
  }
  const contentField = requireNonEmptyString(raw, "memberContentField");
  const titleField = requireNonEmptyString(raw, "memberTitleField");
  for (const field of ["artifactId", "baseRepresentationRevisionId", "contentJsonField", "title"]) {
    if (raw[field] !== undefined && raw[field] !== null) {
      throw new Error(
        `artifact_materialize input.${field} cannot be combined with a list call ` +
          "(memberContentField + memberTitleField) — every member is a new artifact with its own title",
      );
    }
  }
  const contentRaw = raw.content;
  if (typeof contentRaw !== "string") {
    throw new Error(
      `artifact_materialize input.content must be a string (got ${
        Array.isArray(contentRaw) ? "array" : typeof contentRaw
      })`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentRaw);
  } catch {
    throw new Error(
      "artifact_materialize input.content is not parseable JSON (a list call requires a JSON-array content payload)",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `artifact_materialize input.content must encode a JSON array for a list call (got ${
        parsed === null ? "null" : typeof parsed
      })`,
    );
  }
  if (parsed.length === 0) {
    throw new Error("artifact_materialize input.content is an empty list — a list call files at least one member");
  }
  if (parsed.length > MAX_MATERIALIZE_LIST_MEMBERS) {
    throw new Error(
      `artifact_materialize input.content has ${parsed.length} members; a list call files at most ${MAX_MATERIALIZE_LIST_MEMBERS}`,
    );
  }
  const seen = new Map<string, number>();
  return parsed.map((member: unknown, index) => {
    const where = `artifact_materialize input.content member ${index + 1}`;
    if (typeof member !== "object" || member === null || Array.isArray(member)) {
      throw new Error(`${where} must be a JSON object (got ${Array.isArray(member) ? "array" : member === null ? "null" : typeof member})`);
    }
    const record = member as Record<string, unknown>;
    const content = record[contentField];
    if (typeof content !== "string") {
      throw new Error(
        `${where} field "${contentField}" must be a string` +
          (content === undefined || content === null
            ? " (field missing from the member)"
            : ` (got ${Array.isArray(content) ? "array" : typeof content})`),
      );
    }
    const title = record[titleField];
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error(`${where} field "${titleField}" must be a non-empty string (got ${JSON.stringify(title)})`);
    }
    const earlier = seen.get(content);
    if (earlier !== undefined) {
      throw new Error(
        `${where} has the same content bytes as member ${earlier + 1} — the two would be one artifact, ` +
          "and a review names each artifact once",
      );
    }
    seen.set(content, index);
    return { title: title.trim(), content };
  });
}
