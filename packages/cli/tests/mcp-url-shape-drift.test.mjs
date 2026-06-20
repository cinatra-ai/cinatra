// Byte-identity drift guard for the CLI's package-LOCAL copy of the MCP
// public-base-url shape helper (cinatra#255 Stage-1, workstream S1-b).
//
// The CLI used to statically `import` `mcp-public-base-url-shape.mjs` from
// across the package boundary (`../../mcp-server/src/...`) — the only remaining
// cross-package SOURCE reach in the publishable CLI core. Stage-1 removes that
// reach by carrying a BYTE-IDENTICAL copy under `packages/cli/src/`. This test
// is the load-bearing invariant that the copy NEVER drifts from the mcp-server
// source-of-truth: the two files must be byte-for-byte identical (same sha256).
//
// If this fails after an intentional change to the mcp-server source, re-copy:
//   cp packages/mcp-server/src/mcp-public-base-url-shape.mjs \
//      packages/cli/src/mcp-public-base-url-shape.mjs
// (and review whether the CLI call sites still hold). Do NOT silently edit one
// side — the whole point is a single shared shape.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildMcpPublicBaseUrlRow } from "../src/mcp-public-base-url-shape.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_COPY = path.join(HERE, "..", "src", "mcp-public-base-url-shape.mjs");
const MCP_SOURCE = path.join(
  HERE,
  "..",
  "..",
  "mcp-server",
  "src",
  "mcp-public-base-url-shape.mjs",
);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("mcp-public-base-url-shape — CLI copy ↔ mcp-server source drift", () => {
  it("the CLI copy is byte-identical to the mcp-server source (same sha256)", () => {
    const cli = readFileSync(CLI_COPY);
    const src = readFileSync(MCP_SOURCE);
    expect(sha256(cli)).toBe(sha256(src));
    // Stronger assertion: the raw bytes match exactly (length + content).
    expect(cli.equals(src)).toBe(true);
  });

  it("the source-of-truth is a pure zero-import ESM module (copy-safe)", () => {
    // The whole reason a byte-copy is legitimate: the helper has NO imports, so
    // copying it introduces no transitive dependency into the CLI core.
    const src = readFileSync(MCP_SOURCE, "utf8");
    const topLevelImport = /^\s*import\b/m;
    const topLevelRequire = /^\s*(const|let|var)\s+.*=\s*require\(/m;
    expect(topLevelImport.test(src)).toBe(false);
    expect(topLevelRequire.test(src)).toBe(false);
  });

  it("the exported builder is functionally usable from the CLI copy", () => {
    // A light smoke that the copy actually exports the function the CLI imports
    // (the two index.mjs call sites pass `(current, url[, options])`). The helper
    // enforces an origin-only URL (no path), so use a bare origin here.
    const row = buildMcpPublicBaseUrlRow({}, "https://example.test");
    expect(row.publicBaseUrl).toBe("https://example.test");
    expect(row.publicBaseUrlSource).toBe("manual");
    expect(typeof row.updatedAt).toBe("string");

    // The clear path (url=null) — mirrors index.mjs:5361 `buildMcpPublicBaseUrlRow(current, null)`.
    const cleared = buildMcpPublicBaseUrlRow({ foo: 1 }, null);
    expect(cleared.publicBaseUrl).toBe(null);
    expect(cleared.foo).toBe(1); // existing fields preserved.
  });
});
