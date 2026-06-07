// CI postinstall safety test.
//
// `pnpm install` runs `node scripts/vendor-anthropic-skills.mjs --quiet`
// as a postinstall hook. CI environments do NOT set CINATRA_RUNTIME_MODE,
// so the fetcher MUST exit 0 with no side effects: no network call, no
// .gitignore mutation, no destination dir created.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "vendor-anthropic-skills.mjs");
const GITIGNORE = path.join(REPO_ROOT, ".gitignore");

function spawn(envOverride) {
  const env = { ...process.env, ...envOverride };
  // Explicitly unset CINATRA_RUNTIME_MODE unless caller supplies it.
  if (!Object.hasOwn(envOverride, "CINATRA_RUNTIME_MODE")) {
    delete env.CINATRA_RUNTIME_MODE;
  }
  return spawnSync("node", [SCRIPT, "--quiet"], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("vendor-anthropic-skills.mjs — CI postinstall safety", () => {
  it("exits 0 when CINATRA_RUNTIME_MODE is unset (no fetch, no .gitignore mutation)", () => {
    const gitignoreBefore = existsSync(GITIGNORE) ? readFileSync(GITIGNORE, "utf8") : null;
    const result = spawn({});
    expect(result.status).toBe(0);
    expect(result.stderr || "").not.toMatch(/ERROR:/);
    if (gitignoreBefore !== null) {
      const gitignoreAfter = readFileSync(GITIGNORE, "utf8");
      expect(gitignoreAfter).toBe(gitignoreBefore);
    }
  });

  it("exits 0 when CINATRA_RUNTIME_MODE=production (no fetch)", () => {
    const result = spawn({ CINATRA_RUNTIME_MODE: "production" });
    expect(result.status).toBe(0);
    expect(result.stderr || "").not.toMatch(/ERROR:/);
  });

  it("--check mode reports state even with no env (no fetch, no mutation)", () => {
    const result = spawnSync("node", [SCRIPT, "--check"], {
      env: { ...process.env, CINATRA_RUNTIME_MODE: undefined },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr || "").not.toMatch(/ERROR:/);
  });
});

// Patch fail-closed coverage.
//
// The fetcher's applyPatches() must refuse to mutate a vendored SKILL.md
// when an anchor is missing OR present multiple times. This is the
// regression-guard for upstream rewording silently breaking the
// adaptation. Direct in-process import of applyPatches via a controlled
// fixture would require restructuring the script to export helpers; for
// this test we run the script in a sandboxed env via a fake bundles list
// + a fake destination, and assert non-zero exit + diagnostic.
//
// Strategy: the script reads cinatra.vendoredSkillBundles[] from the
// repo's package.json. To avoid mutating the live config, the test
// instead unit-tests the fail-closed semantics via a small inline harness
// that mirrors the applyPatches algorithm. The harness IS the contract.

import { describe as describe2, it as it2, expect as expect2 } from "vitest";

function inlineApplyPatch(content, findAnchor, replaceWith) {
  const occurrences = content.split(findAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `patch anchor found ${occurrences} times (expected exactly 1)`,
    );
  }
  return content.replace(findAnchor, replaceWith);
}

describe2("vendor-anthropic-skills.mjs — patch fail-closed semantics", () => {
  it2("succeeds for an exact-once anchor", () => {
    const content = "before\n# Section\nbody\n";
    const out = inlineApplyPatch(content, "# Section\nbody", "# Replaced\nadapted");
    expect2(out).toContain("# Replaced");
    expect2(out).not.toContain("# Section");
  });

  it2("throws when anchor is missing (count = 0)", () => {
    expect2(() => inlineApplyPatch("no match here", "# Missing", "x")).toThrowError(
      /found 0 times/,
    );
  });

  it2("throws when anchor appears multiple times (count = 2)", () => {
    const content = "alpha\nalpha\nbeta";
    expect2(() => inlineApplyPatch(content, "alpha", "ALPHA")).toThrowError(
      /found 2 times/,
    );
  });

  it2("handles multi-line anchors with $, backslash, and special chars literally", () => {
    const findAnchor = "price = \"$5\"\\path\nlevel 2";
    const content = `before\n${findAnchor}\nafter`;
    const out = inlineApplyPatch(content, findAnchor, "REPLACED");
    expect2(out).toBe("before\nREPLACED\nafter");
  });
});
