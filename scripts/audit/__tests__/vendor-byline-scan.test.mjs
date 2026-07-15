import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

import {
  stripComments,
  evaluateFile,
  runGate,
  GUARDED_FILES,
  RESOLVER,
} from "../vendor-byline-scan.mjs";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const scopeRule = {
  file: "fixture.tsx",
  requireAny: [RESOLVER],
  forbid: [
    { re: /\bscopeFromPackageName\b/, label: "scopeFromPackageName" },
    { re: /\bvendor\s*\??\.\s*slug\b/, label: "vendor.slug" },
  ],
};

describe("stripComments", () => {
  it("blanks line + block comments while preserving line numbers", () => {
    const src = "a\n// vendor.slug in a comment\nb /* scopeFromPackageName */ c";
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).not.toContain("vendor.slug");
    expect(out).not.toContain("scopeFromPackageName");
    expect(out).toContain("a");
    expect(out).toContain("b ");
    expect(out).toContain(" c");
  });
});

describe("evaluateFile — negative rules", () => {
  it("flags a scopeFromPackageName call", () => {
    const findings = evaluateFile(scopeRule, `const v = ${RESOLVER}(x);\nconst s = scopeFromPackageName(pkg);`);
    expect(findings.some((f) => f.includes("scopeFromPackageName"))).toBe(true);
    expect(findings.some((f) => f.includes(":2:"))).toBe(true);
  });

  it("flags a vendor.slug read (and vendor?.slug)", () => {
    expect(evaluateFile(scopeRule, `${RESOLVER}(x); label = vendor.slug;`).some((f) => f.includes("slug"))).toBe(true);
    expect(evaluateFile(scopeRule, `${RESOLVER}(x); label = vendor?.slug;`).some((f) => f.includes("slug"))).toBe(true);
  });

  it("does NOT flag a slug/scope mention that only appears in a comment", () => {
    const src = `${RESOLVER}(x);\n// historically this used vendor.slug via scopeFromPackageName\nconst y = 1;`;
    expect(evaluateFile(scopeRule, src)).toEqual([]);
  });

  it("does NOT flag an unrelated slug (e.g. deriveIconSlug / a route slug)", () => {
    const src = `${RESOLVER}(x); const s = deriveIconSlug(pkg); const url = "/store/" + storeSlug;`;
    expect(evaluateFile(scopeRule, src)).toEqual([]);
  });
});

describe("evaluateFile — positive rule", () => {
  it("flags a byline path that does not consume the resolver", () => {
    const findings = evaluateFile(scopeRule, "const label = vendor.name || fallback;");
    expect(findings.some((f) => f.includes("must consume the vendor resolver"))).toBe(true);
  });

  it("passes when the resolver is present in code (not just a comment)", () => {
    expect(evaluateFile(scopeRule, `const v = ${RESOLVER}({ name });`)).toEqual([]);
  });

  it("a resolver mention ONLY in a comment does not satisfy the positive rule", () => {
    const findings = evaluateFile(scopeRule, `// call ${RESOLVER} here\nconst label = "x";`);
    expect(findings.some((f) => f.includes("must consume the vendor resolver"))).toBe(true);
  });
});

describe("runGate — the shipped byline paths", () => {
  it("all guarded files exist and are clean", async () => {
    const { findings, missing } = await runGate(repoRoot);
    expect(missing).toEqual([]);
    expect(findings).toEqual([]);
  });

  it("guards every one of the four surfaces + the normalization + vendor sources", () => {
    const files = GUARDED_FILES.map((r) => r.file);
    expect(files).toContain("packages/extensions/src/screens/marketplace-listing-card.tsx"); // §I
    expect(files).toContain("packages/extensions/src/screens/marketplace-modal-byline.tsx"); // §II
    expect(files).toContain("src/components/extensions/installed-extension-card.tsx"); // §III/§IV render
    expect(files).toContain("src/components/extensions/agent-all-card.tsx"); // §IV
    expect(files).toContain("packages/extensions/src/screens/marketplace-card-model.ts"); // normalization
  });
});
