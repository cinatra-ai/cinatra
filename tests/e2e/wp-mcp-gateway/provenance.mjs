// ---------------------------------------------------------------------------
// Capture provenance — SINGLE SOURCE OF TRUTH for the hashes that make the
// committed WP-MCP-gateway captures drift-proof (issue #2016, S1, design §3).
//
// Imported by BOTH the live capture producers (which WRITE a `provenance` block
// into every committed transcript) AND the offline required freshness gate
// (scripts/audit/wp-gateway-capture-freshness.mjs, which RECOMPUTES the hashes
// from the current tree and FAILS a PR whose committed captures no longer match
// the pins / fixture plugin / producers / api-map they were captured against).
//
// Because the producer and the gate share this exact code, a stale transcript
// can never keep PR CI green: touch pins.lock, the fixture plugin, a producer,
// or the api-map, and the recomputed hash diverges from the committed one until
// a fresh capture run re-writes the transcripts. That is the anti-staleness
// teeth dispatch-only capture lacked (design §3, codex MAJOR-1/MAJOR-2).
//
// Zero runtime dependencies (node: builtins only) so the freshness gate stays
// lean — no `pnpm install`, like the sibling audit gates.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

// The provenance-hashed inputs, repo-root-relative. `producer` is the
// annotation producer; `equivalence` is the live VERIFY producer (present from
// C5). A capture file records the SUBSET of these it was captured against; the
// gate checks whichever keys a file declares (see wp-gateway-capture-freshness).
export const PROVENANCE_INPUTS = {
  pinsLockSha256: { kind: "file", rel: "docker/wordpress/pins.lock" },
  fixturePluginSha256: { kind: "tree", rel: "docker/wordpress/fixture-plugin" },
  producerSha256: { kind: "file", rel: "tests/e2e/wp-mcp-gateway/capture-annotations.mjs" },
  apiMapSha256: {
    kind: "file",
    rel: "tests/e2e/wp-mcp-gateway/captures/adapter-0.5.0-api-map.json",
  },
  equivalenceSha256: { kind: "file", rel: "tests/e2e/wp-mcp-gateway/equivalence.spec.ts" },
};

/** sha256 of a single file's bytes (hex). Returns null if the file is absent. */
export function sha256OfFile(absPath) {
  if (!existsSync(absPath)) return null;
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/** Recursively list every file under `dir`, POSIX-relative to `dir`, sorted. */
function listTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push({ abs: childAbs, rel: childRel });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Deterministic sha256 of a whole directory tree (hex). Order-independent of the
 * filesystem: files are sorted by POSIX-relative path, and each contributes
 * `<relPath>\0<fileSha256>\n` to the rolling hash — so a rename, an add, a
 * delete, or a content edit all change the digest. Returns null if `dir` absent.
 */
export function sha256OfTree(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const h = createHash("sha256");
  for (const f of listTree(dir)) {
    h.update(f.rel);
    h.update("\0");
    h.update(sha256OfFile(f.abs));
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Recompute ALL provenance hashes from a repo tree. A hash is `null` when its
 * input file/dir does not exist yet (e.g. equivalenceSha256 before C5).
 *
 * @param {string} repoRoot absolute repo root.
 * @returns {Record<keyof typeof PROVENANCE_INPUTS, string|null>}
 */
export function computeProvenanceHashes(repoRoot) {
  const out = {};
  for (const [key, spec] of Object.entries(PROVENANCE_INPUTS)) {
    const abs = path.join(repoRoot, spec.rel);
    out[key] = spec.kind === "tree" ? sha256OfTree(abs) : sha256OfFile(abs);
  }
  return out;
}

/**
 * Build the `provenance` block a live producer embeds in every committed
 * capture. `keys` selects which hashes to record (the annotation producer omits
 * equivalenceSha256 — that file may not exist at its capture time).
 *
 * @param {string} repoRoot absolute repo root.
 * @param {{ runUrl?: string, commit?: string, keys?: string[] }} [opts]
 */
export function buildProvenance(repoRoot, opts = {}) {
  const all = computeProvenanceHashes(repoRoot);
  const keys =
    opts.keys ||
    ["pinsLockSha256", "fixturePluginSha256", "producerSha256", "apiMapSha256"];
  const provenance = {
    capturedAtCommit: opts.commit || "",
    runUrl: opts.runUrl || "",
    capturedAt: new Date().toISOString(),
  };
  for (const key of keys) provenance[key] = all[key];
  return provenance;
}

// The four canonical hashes the design §3 provenance block always carries.
export const CANONICAL_PROVENANCE_KEYS = [
  "pinsLockSha256",
  "fixturePluginSha256",
  "producerSha256",
  "apiMapSha256",
];
