// Twenty MCP tool-snapshot canonicalizer.
//
// The committed snapshot at scripts/twenty-bootstrap/twenty-mcp-tools.json is consumed by
// downstream code as the golden allowed-tools list. Byte-stability matters.
//
// Strip:
//   - volatile fields (requestId, timestamps, internal cache keys)
//   - any auth-bearing field (just in case)
//
// Sort:
//   - top-level arrays of tool descriptors by `name`
//   - object keys alphabetically (so spurious key-order changes don't churn)
//
// Format:
//   - JSON.stringify(snapshot, null, 2) + "\n"

// Case-insensitive matching so `Authorization` is stripped as well as the
// lowercase `authorization`.
const VOLATILE_KEYS = [
  "requestId",
  "request_id",
  "timestamp",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "issuedAt",
  "_etag",
  "_cacheKey",
  "_traceId",
].map((k) => k.toLowerCase());
const AUTH_KEYS = [
  "authorization",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "bearer",
  "token",
  "client_secret",
  "clientSecret",
].map((k) => k.toLowerCase());
const REDACTED_KEYS = new Set([...VOLATILE_KEYS, ...AUTH_KEYS]);

function shouldStrip(key) {
  return typeof key === "string" && REDACTED_KEYS.has(key.toLowerCase());
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      if (shouldStrip(k)) continue;
      out[k] = stripVolatile(value[k]);
    }
    return out;
  }
  return value;
}

// The MCP tool catalog comes back as
// `content: [{ type: "text", text: "<json-string>" }]`. To make the snapshot
// truly canonicalize the nested tool order, we parse those text-JSON blobs
// before canonicalizing.
function parseTextContentJson(value) {
  if (Array.isArray(value)) return value.map(parseTextContentJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      // Common MCP pattern: { content: [{ type: "text", text: "{...}" }] }
      if (
        k === "content" &&
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((c) => c && c.type === "text" && typeof c.text === "string")
      ) {
        const parsed = v.map((c) => {
          try {
            return { type: "text", parsed: JSON.parse(c.text) };
          } catch {
            return { type: "text", text: c.text };
          }
        });
        out[k] = parseTextContentJson(parsed);
      } else {
        out[k] = parseTextContentJson(v);
      }
    }
    return out;
  }
  return value;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

function sortToolsArrays(value) {
  if (Array.isArray(value)) {
    // If this looks like an array of tool descriptors (objects with `name`),
    // sort by name first, then recurse.
    const allObjsWithName =
      value.length > 0 &&
      value.every((v) => v && typeof v === "object" && typeof v.name === "string");
    const sorted = allObjsWithName
      ? [...value].sort((a, b) => a.name.localeCompare(b.name))
      : value;
    return sorted.map(sortToolsArrays);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = sortToolsArrays(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Build a byte-stable canonical JSON string for the snapshot.
 * @param {Object} snapshot the raw MCP tool catalog
 * @returns {string} canonical JSON + trailing newline
 */
export function canonicalizeSnapshot(snapshot) {
  const parsed = parseTextContentJson(snapshot);
  const cleaned = stripVolatile(parsed);
  const toolsSorted = sortToolsArrays(cleaned);
  const sorted = sortKeysDeep(toolsSorted);
  return JSON.stringify(sorted, null, 2) + "\n";
}

/**
 * Compare two snapshots byte-stable. Returns null on equal, or a short
 * human-readable diff hint when different.
 */
export function diffSnapshots(existing, fresh) {
  const a = canonicalizeSnapshot(existing);
  const b = canonicalizeSnapshot(fresh);
  if (a === b) return null;
  // Cheap diff: show first 200 chars where they diverge.
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const aSlice = a.slice(Math.max(0, i - 40), i + 80);
  const bSlice = b.slice(Math.max(0, i - 40), i + 80);
  return `snapshots differ at byte ${i}\nexisting…\n${aSlice}\nfresh…\n${bSlice}`;
}
