// Connector-scoping COMPLETENESS PROOF (cinatra#955, closing wave of epic
// cinatra#950): fails if ANY of the four deleted legacy scope sources — or a
// consumer of them — creeps back into the tree.
//
//   1. the hardcoded per-slug pseudo-scope map in the connectors page
//      (deleted in W3; token ratchet below),
//   2. the static `connector → WORKSPACE_DEFAULT` install default
//      (behavioral: `defaultAccessPolicyForKind("connector")` must throw),
//   3. the per-slug visibility tier in the connectors catalog
//      (behavioral: no descriptor carries the field; token ratchet below),
//   4. the manifest `cinatra.visibility` connector path (behavioral: the
//      handler's validate() rejects its PRESENCE) — plus the SDK absence rule
//      now REFUSING at every surface.
//
// GREP-LEVEL RATCHET: the banned tokens are assembled from fragments so this
// file never matches itself; the allowlist names the two identifier
// collisions that are a DIFFERENT domain (artifact/save ownership defaults,
// not connector scope) and ratchets them — an allowlisted file that stops
// using its token must be removed from the allowlist.

import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { defaultAccessPolicyForKind } from "@cinatra-ai/extensions/install-access-contract";
import { createConnectorExtensionHandler } from "@cinatra-ai/extensions/connector-handler";
import { resolveAbsentConnectorAccessConfig } from "@cinatra-ai/sdk-extensions/access-config";

const REPO_ROOT = process.cwd();

// Assembled from fragments so this test's own source never trips the scan.
const TOKEN_SCOPE_MAP = ["SCOPE", "BY", "SLUG"].join("_");
const TOKEN_SCOPE_FN = "scope" + "For" + "Slug";
const TOKEN_DEFAULT_VIS = "default" + "Visibility";
const BANNED_TOKENS = [TOKEN_SCOPE_MAP, TOKEN_SCOPE_FN, TOKEN_DEFAULT_VIS] as const;

/**
 * Identifier collisions in a DIFFERENT domain (artifact/save ownership
 * visibility defaults — nothing to do with connector scope). Exact file +
 * token pairs; the ratchet fails when an entry goes stale.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; token: string; domain: string }> = [
  {
    file: "src/lib/artifacts/artifact-creation.ts",
    token: TOKEN_DEFAULT_VIS,
    domain: "artifact ownership default (defaultVisibilityFor)",
  },
  {
    file: "packages/objects/src/mcp/handlers.ts",
    token: TOKEN_DEFAULT_VIS,
    domain: "save ownership default (local const)",
  },
];

const SCAN_ROOTS = ["src", "packages", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo"]);
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (SCAN_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      yield full;
    }
  }
}

describe("connector-scope legacy sources — completeness proof (cinatra#955)", () => {
  it("grep-level: no banned legacy token survives outside the justified allowlist", () => {
    const hits: string[] = [];
    const allowlistSeen = new Map<string, boolean>(
      ALLOWLIST.map((a) => [`${a.file}::${a.token}`, false]),
    );
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === SELF) continue;
        const text = readFileSync(file, "utf8");
        for (const token of BANNED_TOKENS) {
          if (!text.includes(token)) continue;
          const key = `${rel}::${token}`;
          if (allowlistSeen.has(key)) {
            allowlistSeen.set(key, true);
            continue;
          }
          hits.push(`${rel}: contains banned legacy token "${token}"`);
        }
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
    // Stale-allowlist ratchet: every allowlisted pair must still exist.
    for (const [key, seen] of allowlistSeen) {
      expect(seen, `stale allowlist entry (remove it): ${key}`).toBe(true);
    }
  });

  it("behavioral: the catalog descriptors carry NO visibility tier field", () => {
    const descriptors = listConnectorDescriptors();
    expect(descriptors.length).toBeGreaterThan(0);
    for (const d of descriptors) {
      expect(
        Object.hasOwn(d, TOKEN_DEFAULT_VIS),
        `${d.packageId} still carries the deleted catalog tier field`,
      ).toBe(false);
    }
  });

  it("behavioral: the connector kind has NO static install default (derives from cinatra/config.json)", () => {
    expect(() => defaultAccessPolicyForKind("connector")).toThrow(/cinatra\/config\.json/);
  });

  it("behavioral: the SDK absence rule REFUSES at every surface", () => {
    for (const surface of ["submit", "install"] as const) {
      expect(() =>
        resolveAbsentConnectorAccessConfig({ packageName: "@test/foo-connector", surface }),
      ).toThrow(/absence is not accepted/);
    }
  });

  it("behavioral: the connector manifest validator rejects the deleted cinatra.visibility axis on PRESENCE", async () => {
    const handler = createConnectorExtensionHandler();
    const result = await handler.validate!({
      name: "@test/foo-connector",
      cinatra: { kind: "connector", visibility: "workspace" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.includes("cinatra/config.json"))).toBe(true);
  });
});
