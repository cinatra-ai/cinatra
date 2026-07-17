// ---------------------------------------------------------------------------
// Pure stream-payload normalizers (cinatra#1218 delete stage).
// ---------------------------------------------------------------------------
// Relocated VERBATIM from the deleted bespoke `chat-stream-events.ts` — these
// three helpers are wire-agnostic payload normalizers the AG-UI reducer
// (./ag-ui-reducer) consumes: error-body extraction for RUN_ERROR, and
// citation normalization/merging for `DATA_PART { kind: "citations" }`.
// They carry no bespoke SSE vocabulary; only the reducer imports them.

import type { UiCitation } from "../types";

export function extractErrorMessage(raw: string): string {
  // Try to parse JSON error responses from OpenAI or the API route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.error && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — use as-is.
  }

  const trimmed = raw.trim();
  if (!trimmed) return "Something went wrong. Please try again.";

  // If it looks like a raw HTTP error body, simplify it.
  if (trimmed.length > 300) {
    return "The request failed. Please try again in a moment.";
  }

  return trimmed;
}

/** Normalize a raw `citations` payload into the UiCitation shape. */
export function normalizeCitations(raw: unknown): UiCitation[] {
  const incoming = Array.isArray(raw) ? (raw as unknown[]) : [];
  return incoming
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map((c, i) => ({
      index: typeof c.index === "number" && isFinite(c.index) ? c.index : i + 1,
      title: typeof c.title === "string" ? c.title : "",
      url: typeof c.url === "string" ? c.url : "",
    }))
    .filter((c) => c.url.length > 0);
}

/** Merge + dedupe citations by url, preserving first-seen order. */
export function mergeCitations(existing: UiCitation[], incoming: UiCitation[]): UiCitation[] {
  const merged = [...existing, ...incoming];
  const seen = new Set<string>();
  return merged.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}
