// vendor-token-core-gate tests (cinatra#973 — epic cinatra-ai/cinatra#978).
//
// Exercises the token matcher (exact short tokens, substring long tokens,
// camelCase evasion), the import-specifier extraction, the sanctioned-surface
// exclusions, the shrink-only baseline diff, and the live-tree invariants
// (gate green on main; the epic's named defect is ENUMERATED in the floor,
// never exempted; the nango mechanism model is NOT counted).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  VENDOR_TOKENS,
  isExemptFile,
  isSanctionedSpecifier,
  subTokens,
  segmentMatchesToken,
  tokenHits,
  extractImportSpecifiers,
  scanVendorTokens,
  diffGrown,
  diffShrunk,
} from "../vendor-token-core-gate.mjs";

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "vendor-token-core-gate.baseline.json"), "utf8"),
).occurrences;

describe("live tree vs committed baseline (the gate is green on main)", () => {
  const current = scanVendorTokens();

  it("no current occurrence exceeds the baseline", () => {
    expect(diffGrown(BASELINE, current)).toEqual([]);
  });

  it("no baseline entry is stale (the committed floor is exact, no headroom)", () => {
    expect(diffShrunk(BASELINE, current)).toEqual([]);
  });

  it("the baseline is a NON-EMPTY residual floor (enumerated, not allowlisted away)", () => {
    expect(Object.keys(BASELINE).length).toBeGreaterThan(0);
  });

  it("the epic #978 named defect (register-host-connector-services.ts) is ENUMERATED in the floor", () => {
    const keys = Object.keys(BASELINE).filter((k) =>
      k.startsWith("src/lib/register-host-connector-services.ts :: import :: "),
    );
    expect(keys.length).toBeGreaterThan(0);
  });

  it("the nango-system mechanism model is NOT counted (nango is not a vendor token)", () => {
    expect(VENDOR_TOKENS).not.toContain("nango");
    expect(Object.keys(current).some((k) => k.startsWith("src/app/api/nango/"))).toBe(false);
  });
});

describe("segmentMatchesToken — exact short tokens, substring long tokens, camelCase", () => {
  it("short token `wp` matches only as an exact sub-token", () => {
    expect(segmentMatchesToken("wp-drupal-contract.ts", "wp")).toBe(true);
    expect(segmentMatchesToken("swap-helper.ts", "wp")).toBe(false);
    expect(segmentMatchesToken("wpapi.ts", "wp")).toBe(false); // squashed short token is out of scope
  });

  it("long tokens match as a segment substring (squashed evasion is caught)", () => {
    expect(segmentMatchesToken("wordpress-api.ts", "wordpress")).toBe(true);
    expect(segmentMatchesToken("wordpressapi.ts", "wordpress")).toBe(true);
  });

  it("camelCase boundaries are split (`wordpressApi` / `importSkillFromGithub`)", () => {
    expect(subTokens("wordpressApi")).toEqual(["wordpress", "api"]);
    expect(segmentMatchesToken("importSkillFromGithubForm.tsx", "github")).toBe(true);
  });

  it("a non-vendor segment does not match", () => {
    expect(segmentMatchesToken("connector-readiness.server.ts", "wordpress")).toBe(false);
  });
});

describe("tokenHits — path/route segments and specifiers", () => {
  it("a Next.js route dir segment is a hit for the file under it", () => {
    const hits = tokenHits("src/app/api/webhooks/wordpress/route.ts");
    expect(hits.get("wordpress")).toBe(1);
  });

  it("multiple tokens in one path are counted per token", () => {
    const hits = tokenHits("src/lib/wp-drupal-contract.ts");
    expect(hits.get("wp")).toBe(1);
    expect(hits.get("drupal")).toBe(1);
  });

  it("a clean path yields no hits", () => {
    expect(tokenHits("src/lib/connector-readiness.server.ts").size).toBe(0);
  });
});

describe("extractImportSpecifiers — static, side-effect, dynamic, require", () => {
  it("extracts every specifier form", () => {
    const src = [
      `import { a } from "@/lib/wordpress-api";`,
      `import "./drupal-side-effect";`,
      `export { b } from "../linkedin-api";`,
      `const c = await import("@/lib/youtube-api");`,
      `const d = require("@/lib/github-api");`,
    ].join("\n");
    expect(extractImportSpecifiers(src)).toEqual([
      "@/lib/wordpress-api",
      "./drupal-side-effect",
      "../linkedin-api",
      "@/lib/youtube-api",
      "@/lib/github-api",
    ]);
  });
});

describe("sanctioned surfaces — exclusions are exact and enumerated", () => {
  it("tests, mocks, and docs are exempt", () => {
    expect(isExemptFile("src/lib/__tests__/wordpress-api.test.ts")).toBe(true);
    expect(isExemptFile("src/lib/wordpress.spec.ts")).toBe(true);
    expect(isExemptFile("packages/google-oauth-connection/README.md")).toBe(true);
  });

  it("sdk-extensions type contracts and the connectors-catalog identity surface are exempt", () => {
    expect(isExemptFile("packages/sdk-extensions/src/google-oauth-connection-contract.ts")).toBe(true);
    expect(isExemptFile("packages/connectors-catalog/src/descriptors.mjs")).toBe(true);
    expect(isExemptFile("packages/agents/src/reserved-workspace-slugs.ts")).toBe(true);
  });

  it("the generator-emitted manifest files are exempt (explicit list, not a dir prefix)", () => {
    expect(isExemptFile("src/lib/generated/extensions.server.ts")).toBe(true);
    // A hand-added file under src/lib/generated/ is NOT exempt.
    expect(isExemptFile("src/lib/generated/wordpress-smuggle.ts")).toBe(false);
  });

  it("ordinary core source is not exempt", () => {
    expect(isExemptFile("src/lib/wordpress-api.ts")).toBe(false);
    expect(isExemptFile("packages/skills/src/github.ts")).toBe(false);
  });

  it("sanctioned specifiers: framework font loader, LLM SDK, brand icons — and nothing vendor-shaped", () => {
    expect(isSanctionedSpecifier("next/font/google")).toBe(true);
    expect(isSanctionedSpecifier("@google/genai")).toBe(true);
    expect(isSanctionedSpecifier("@icons-pack/react-simple-icons/icons/SiWordpress.mjs")).toBe(true);
    expect(isSanctionedSpecifier("@/lib/wordpress-api")).toBe(false);
    expect(isSanctionedSpecifier("@google/genai-extras")).toBe(false); // exact match only
  });
});

describe("scanVendorTokens — fixture tree", () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-token-gate-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "src/lib"), { recursive: true });
  writeFileSync(join(root, "src/lib/wordpress-api.ts"), "export const wp = 1;\n");
  writeFileSync(
    join(root, "src/lib/generic.ts"),
    [
      `import { wp } from "./wordpress-api";`,
      `// import { dead } from "./drupal-api"; (commented out — must NOT count)`,
      `import Font from "next/font/google";`,
      `export const ok = wp;`,
    ].join("\n") + "\n",
  );
  const files = ["src/lib/wordpress-api.ts", "src/lib/generic.ts"];
  const occ = scanVendorTokens(root, files);

  it("counts the vendor filename and the generic->vendor import edge", () => {
    expect(occ["src/lib/wordpress-api.ts :: path :: wordpress"]).toBe(1);
    expect(occ["src/lib/generic.ts :: import :: ./wordpress-api"]).toBe(1);
  });

  it("does not count commented-out imports or sanctioned specifiers", () => {
    expect(Object.keys(occ).some((k) => k.includes("drupal"))).toBe(false);
    expect(Object.keys(occ).some((k) => k.includes("next/font/google"))).toBe(false);
  });

  it("a worktree-deleted file is not counted (scan reflects the worktree, not the index)", () => {
    const occ2 = scanVendorTokens(root, [...files, "src/lib/youtube-api.ts"]);
    expect(Object.keys(occ2).some((k) => k.startsWith("src/lib/youtube-api.ts"))).toBe(false);
  });
});

describe("diffGrown / diffShrunk — the shrink-only ratchet arithmetic", () => {
  it("a new key and a grown count are both NEW", () => {
    const baseline = { "a.ts :: path :: wordpress": 1 };
    const current = { "a.ts :: path :: wordpress": 2, "b.ts :: path :: drupal": 1 };
    expect(diffGrown(baseline, current)).toEqual([
      "a.ts :: path :: wordpress (1 -> 2)",
      "b.ts :: path :: drupal (0 -> 1)",
    ]);
  });

  it("a removed occurrence is STALE (the floor must ratchet down)", () => {
    const baseline = { "a.ts :: path :: wordpress": 1 };
    expect(diffShrunk(baseline, {})).toEqual(["a.ts :: path :: wordpress (1 -> 0)"]);
  });

  it("identical floors diff to empty in both directions", () => {
    const b = { "a.ts :: path :: wordpress": 1 };
    expect(diffGrown(b, { ...b })).toEqual([]);
    expect(diffShrunk(b, { ...b })).toEqual([]);
  });
});
