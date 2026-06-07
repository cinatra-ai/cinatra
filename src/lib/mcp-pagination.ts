// ---------------------------------------------------------------------------
// MCP list pagination primitives
// ---------------------------------------------------------------------------
// Shared cursor utility for all MCP list handlers. Encodes a numeric offset
// as an opaque base64url token so LLM callers receive a stable cursor they
// cannot parse into implementation details.
//
// Consumed by: packages/*/src/mcp/handlers/*.ts (Phases 42–45 migrations).
// Invariants:
//   - decodeCursor(encodeCursor(n)) === n for n ≥ 0
//   - decodeCursor(undefined | "" | malformed | negative) === 0
//   - buildListPage omits nextCursor iff offset + items.length >= total
// ---------------------------------------------------------------------------

/**
 * Standard MCP list response envelope. `nextCursor` is OMITTED (not set to
 * undefined) on the last page so the JSON response is minimal.
 */
export type ListPage<T> = {
  items: T[];
  total: number;
  nextCursor?: string;
};

/**
 * Encode a non-negative integer offset as an opaque base64url cursor token.
 * Uses Node's Buffer (available in Next.js server runtime) rather than
 * browser-only btoa/atob.
 */
export function encodeCursor(offset: number): string {
  const safe = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
  return Buffer.from(String(safe), "utf8").toString("base64url");
}

/**
 * Decode a cursor token back to a numeric offset. Returns 0 as a safe
 * fallback for undefined, empty, malformed, non-integer, or negative input.
 * This is intentional: LLMs or stale stored plans may pass corrupted cursors
 * and we should resume at page 0 rather than crash the handler.
 */
export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const n = parseInt(decoded, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Assemble the standard { items, total, nextCursor? } envelope from a
 * paginated DB slice. Callers pass the slice they already fetched; this
 * helper computes whether another page exists and encodes the next offset.
 *
 * IMPORTANT: nextCursor is derived from `offset + items.length`, NOT
 * `offset + limit`. This correctly handles the final page when the DB
 * returns fewer items than `limit`.
 *
 * The `limit` parameter is accepted for call-site documentation clarity
 * but is not used in the nextCursor computation.
 */
export function buildListPage<T>(
  items: T[],
  total: number,
  offset: number,
  limit: number,
): ListPage<T> {
  void limit; // reserved for future keyset migration (KEYSET-01)
  const nextOffset = offset + items.length;
  if (nextOffset < total) {
    return { items, total, nextCursor: encodeCursor(nextOffset) };
  }
  return { items, total };
}
