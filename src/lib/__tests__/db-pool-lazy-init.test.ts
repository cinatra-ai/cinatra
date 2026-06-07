import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Build-hermeticity guard.
//
// `next build` evaluates server modules during the "Collecting page data"
// phase. A module that creates a pg `Pool` at the top level throws on a
// missing SUPABASE_DB_URL at IMPORT time and breaks the build (this was the
// real cause behind the long-standing build failure). Pool / Drizzle creation
// MUST be deferred into a lazy getter; the public `pool` / `db` exports are
// lazy Proxies that instantiate on first use.
//
// This test fails if any of these modules reintroduces an eager top-level
// pool or Drizzle handle.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const LAZY_DB_MODULES = [
  "src/lib/projects-store.ts",
  "src/lib/authz/audit.ts",
  "src/lib/anthropic-skill-sync-store.ts",
  "src/lib/service-accounts.ts",
  "src/lib/better-auth-db.ts",
  "packages/objects/src/db.ts",
  "packages/agents/src/db.ts",
  "packages/metric-cost-api/src/db.ts",
];

// A top-level (column-0) `const` / `export const` initialized directly from an
// eager pool or Drizzle factory. Indented occurrences (inside a getter
// function body) are intentionally NOT matched — that is the lazy pattern.
const EAGER_TOP_LEVEL =
  /^(?:export\s+)?(?:const|let|var)\s+\w+\b[^\n=]*=\s*(?:globalThis\.[\w$]+\s*\?\?\s*)?(new\s+(?:\w+\.)?Pool|create\w*Pool|drizzle)\s*\(/m;

describe("DB-pool modules stay lazy (build-hermeticity guard)", () => {
  for (const rel of LAZY_DB_MODULES) {
    it(`${rel} creates no pg Pool / Drizzle handle at import time`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      const match = src.match(EAGER_TOP_LEVEL);
      expect(
        match,
        match
          ? `Eager top-level DB handle in ${rel}: "${match[0].trim()}". ` +
              "Move pool/Drizzle creation into a lazy getter so `next build` stays hermetic."
          : undefined,
      ).toBeNull();
    });
  }
});
