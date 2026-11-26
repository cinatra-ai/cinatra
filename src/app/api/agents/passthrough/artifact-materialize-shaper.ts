// Generic server-side seam shaper for the deterministic `artifact_materialize`
// passthrough tool (cinatra#925). Pure module (its only project dep is the
// grammar's list limits, shared with the compiler) so it is unit-testable in
// isolation — same posture as ./test-delivery-seam.

import {
  MATERIALIZE_LIST_NODE_ID_PREFIX,
  MATERIALIZE_LIST_RESERVED_DATA_FIELDS,
  MAX_MATERIALIZE_LIST_MEMBERS,
  MAX_MATERIALIZE_LIST_VALUE_CHARS,
} from "@cinatra-ai/agents/artifact-binding";

export { MATERIALIZE_LIST_NODE_ID_PREFIX, MAX_MATERIALIZE_LIST_MEMBERS, MAX_MATERIALIZE_LIST_VALUE_CHARS };
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
   * member order, each filed under the same node. Present only when the call
   * names both `memberContentField` and `memberTitleField`; `content` and
   * `title` are then empty, as every member carries its own.
   */
  members?: ShapedArtifactMaterializeMember[];
};

/** One member of a list call: its title, its bytes and the typed data it is filed with. */
export type ShapedArtifactMaterializeMember = { title: string; content: string; data?: Record<string, string> };

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
  if (nodeId.startsWith(MATERIALIZE_LIST_NODE_ID_PREFIX)) {
    // The ledger output ids of a list call's members live under this prefix
    // (`materializeListMemberOutputId`, cinatra#3089): a node of that name could share one.
    throw new Error(`artifact_materialize input.node_id must not start with "${MATERIALIZE_LIST_NODE_ID_PREFIX}" (a reserved ledger namespace)`);
  }

  // ---- the list mode (cinatra#3089) ---------------------------------------
  if (raw.memberContentField !== undefined || raw.memberTitleField !== undefined) {
    let objectTypeId: string | undefined;
    if (raw.objectTypeId !== undefined) {
      if (typeof raw.objectTypeId !== "string" || !OBJECT_TYPE_ID_RE.test(raw.objectTypeId)) {
        throw new Error(
          `artifact_materialize input.objectTypeId, when present, must be a namespaced object type id (@scope/package:local-id) (got ${JSON.stringify(raw.objectTypeId)})`,
        );
      }
      objectTypeId = raw.objectTypeId;
    }
    return {
      extension,
      content: "",
      declaredMime,
      title: "",
      nodeId,
      ...(objectTypeId ? { objectTypeId } : {}),
      members: shapeListMembers(raw),
    };
  }
  if (raw.memberDataFields !== undefined || raw.memberData !== undefined) {
    throw new Error(
      "artifact_materialize input.memberDataFields and input.memberData belong to a list call (memberContentField + memberTitleField)",
    );
  }

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
  const title =
    artifactId === undefined ? requireNonEmptyString(raw, "title") : titleIfPresent(raw);

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

/** A field name exactly as given: non-blank, with no white space around it (a padded name is refused, never read as another). */
function requireFieldName(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`artifact_materialize ${where} must be a field name with no surrounding whitespace (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** A typed-data value of a list call: a non-blank string of at most MAX_MATERIALIZE_LIST_VALUE_CHARS, trimmed. */
function requireDataValue(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > MAX_MATERIALIZE_LIST_VALUE_CHARS) {
    throw new Error(`artifact_materialize ${where} must be a non-blank string of at most ${MAX_MATERIALIZE_LIST_VALUE_CHARS} characters`);
  }
  return value.trim();
}

/**
 * THE LIST MODE (cinatra#3089). `content` is the JSON text of an array;
 * `memberContentField` and `memberTitleField` name the field of each member
 * that is its content and its title. `memberDataFields` (optional) names the
 * string fields of each member filed as its typed data; `memberData` (optional)
 * holds call-wide string values filed on every member (a member that carries a
 * field of that name is refused, never overridden). Every member is checked
 * here, so a refusal files nothing. Refused besides: one of the two fields
 * without the other; a list with an append, a `contentJsonField` or a
 * top-level title; a content that is not a JSON array; an empty list or one
 * over MAX_MATERIALIZE_LIST_MEMBERS; a member that is not an object, whose
 * content is not a string or whose title is blank.
 */
function shapeListMembers(raw: Record<string, unknown>): ShapedArtifactMaterializeMember[] {
  if (raw.memberContentField === undefined || raw.memberTitleField === undefined) {
    throw new Error(
      "artifact_materialize input.memberContentField and input.memberTitleField must be given together — a list call names the content AND the title of every member",
    );
  }
  const contentField = requireFieldName(raw.memberContentField, "input.memberContentField");
  const titleField = requireFieldName(raw.memberTitleField, "input.memberTitleField");
  for (const field of ["artifactId", "baseRepresentationRevisionId", "contentJsonField", "title"]) {
    if (raw[field] !== undefined && raw[field] !== null) {
      throw new Error(
        `artifact_materialize input.${field} cannot be combined with a list call — every member is a new artifact with its own title`,
      );
    }
  }
  let dataFields: string[] = [];
  if (raw.memberDataFields !== undefined) {
    if (!Array.isArray(raw.memberDataFields)) {
      throw new Error("artifact_materialize input.memberDataFields must be an array of field names");
    }
    dataFields = raw.memberDataFields.map((f, i) => requireFieldName(f, `input.memberDataFields[${i}]`));
  }
  const fixed: Record<string, string> = {};
  if (raw.memberData !== undefined) {
    if (typeof raw.memberData !== "object" || raw.memberData === null || Array.isArray(raw.memberData)) {
      throw new Error("artifact_materialize input.memberData must be an object of string values");
    }
    for (const [name, value] of Object.entries(raw.memberData as Record<string, unknown>)) {
      fixed[requireFieldName(name, "input.memberData field name")] = requireDataValue(value, `input.memberData.${name}`);
    }
  }
  for (const name of [...dataFields, ...Object.keys(fixed)]) {
    if (MATERIALIZE_LIST_RESERVED_DATA_FIELDS.has(name)) {
      throw new Error(`artifact_materialize a list call cannot set the typed field "${name}" (it is the host's)`);
    }
    if (dataFields.includes(name) && Object.prototype.hasOwnProperty.call(fixed, name)) {
      throw new Error(`artifact_materialize the typed field "${name}" is both a member field and a call-wide value`);
    }
  }
  if (typeof raw.content !== "string") {
    throw new Error(
      `artifact_materialize input.content must be a string (got ${Array.isArray(raw.content) ? "array" : typeof raw.content})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.content);
  } catch {
    throw new Error("artifact_materialize input.content is not parseable JSON (a list call requires a JSON-array content payload)");
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `artifact_materialize input.content must encode a JSON array for a list call (got ${parsed === null ? "null" : typeof parsed})`,
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
  const hasData = dataFields.length > 0 || Object.keys(fixed).length > 0;
  return parsed.map((member: unknown, index) => {
    const where = `input.content member ${index + 1}`;
    if (typeof member !== "object" || member === null || Array.isArray(member)) {
      throw new Error(`artifact_materialize ${where} must be a JSON object`);
    }
    const record = member as Record<string, unknown>;
    const content = record[contentField];
    if (typeof content !== "string") {
      throw new Error(`artifact_materialize ${where} field "${contentField}" must be a string`);
    }
    const title = record[titleField];
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error(`artifact_materialize ${where} field "${titleField}" must be a non-empty string`);
    }
    if (!hasData) return { title: title.trim(), content };
    const data: Record<string, string> = {};
    for (const name of Object.keys(fixed)) {
      if (Object.prototype.hasOwnProperty.call(record, name)) {
        throw new Error(`artifact_materialize ${where} must not carry the field "${name}" (its value is the call's)`);
      }
    }
    for (const name of dataFields) data[name] = requireDataValue(record[name], `${where} field "${name}"`);
    return { title: title.trim(), content, data: { ...data, ...fixed } };
  });
}
