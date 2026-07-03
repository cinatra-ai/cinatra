// Generic server-side seam shaper for the deterministic `artifact_materialize`
// passthrough tool (cinatra#925). Pure module (zero project deps) so it is
// unit-testable in isolation — same posture as ./blog-pipeline-seam.
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
  /** Artifact title — explicit, never prompt-invented. */
  title: string;
  /** The calling ApiNode's id — the idempotency-ledger output identity. */
  nodeId: string;
};

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
  const title = requireNonEmptyString(raw, "title");
  const nodeId = requireNonEmptyString(raw, "node_id");

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

  return { extension, content, declaredMime, title, nodeId };
}
