// Generic server-side seam shaper for the deterministic `artifact_page_capture`
// passthrough tool (cinatra#4223). Pure module (zero project deps) so it is
// unit-testable in isolation — same posture as ./artifact-image-shaper.
//
// The ApiNode wires flow variables straight to {extension, title, url, node_id}.
// The shaper normalizes and VALIDATES; it never invents a value. The url must be
// an absolute http(s) url here; whether its origin is one of the org's
// connect-registered sites is the tool's own check, made against the host's
// records, never against this input.

export type ShapedArtifactPageCaptureInput = {
  /** Artifact-extension package name — runtime-validated against the run's produces. */
  extension: string;
  /** The filed picture's title — explicit, never invented. */
  title: string;
  /** The absolute http(s) url of the page to capture. */
  url: string;
  /** The calling ApiNode's id — the idempotency-ledger output identity. */
  nodeId: string;
};

function requireNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `artifact_page_capture input.${field} must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    // No base: a relative reference does not parse.
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Shape a raw passthrough `input` payload into the page capture tool's call.
 * Throws `Error` on any missing/invalid field — the route surfaces the message
 * as a 400 (the existing shaper-throw contract).
 */
export function shapeArtifactPageCaptureInput(
  raw: Record<string, unknown>,
): ShapedArtifactPageCaptureInput {
  const extension = requireNonEmptyString(raw, "extension");
  const title = requireNonEmptyString(raw, "title");
  const url = requireNonEmptyString(raw, "url");
  const nodeId = requireNonEmptyString(raw, "node_id");
  if (!isAbsoluteHttpUrl(url)) {
    throw new Error("artifact_page_capture input.url must be an absolute http(s) url");
  }
  return { extension, title, url, nodeId };
}
