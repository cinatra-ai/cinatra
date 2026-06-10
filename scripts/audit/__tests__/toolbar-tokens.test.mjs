// Tests for the toolbar design-system gate.
//
// Contract lives in scripts/audit/toolbar-tokens.mjs:
//   1. token drift — spec ground values pinned in the light blocks of both
//      token homes;
//   2. non-canonical toolbars — role="toolbar" outside the canonical
//      component (allowlist mechanism, comment-stripped scan, tests skipped);
//   3. ground-hex leaks — spec hexes hardcoded outside the token files.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import {
  SPEC_TOOLBAR_TOKENS,
  TOKEN_FILES,
  CANONICAL_TOOLBAR_REL,
  NONCANONICAL_TOOLBAR_ALLOWLIST,
  stripComments,
  extractBlocks,
  checkTokenDrift,
  scanRoleToolbar,
  scanGroundHexes,
  runGate,
} from "../toolbar-tokens.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();

// ---------------------------------------------------------------------------
// Live smoke — the in-tree state must pass all three checks.

describe("toolbar-tokens — live smoke", () => {
  it("the working tree passes the gate", async () => {
    const findings = await runGate(REPO_ROOT);
    expect(findings.drift).toEqual([]);
    expect(findings.role).toEqual([]);
    expect(findings.hex).toEqual([]);
  });

  it("the canonical component actually exists at the pinned path", () => {
    const tracked = execSync(`git ls-files -- ${CANONICAL_TOOLBAR_REL}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe(CANONICAL_TOOLBAR_REL);
  });

  it("every token home is tracked", () => {
    for (const fileRel of Object.keys(TOKEN_FILES)) {
      const tracked = execSync(`git ls-files -- ${fileRel}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      expect(tracked, `${fileRel} must exist`).toBe(fileRel);
    }
  });
});

// ---------------------------------------------------------------------------
// stripComments

describe("stripComments", () => {
  it("strips block comments while preserving line numbers", () => {
    const out = stripComments("a /* one\ntwo */ b\nc");
    expect(out.split("\n").length).toBe(3);
    expect(out).not.toContain("one");
    expect(out).toContain("a ");
    expect(out).toContain(" b");
  });

  it("strips line comments", () => {
    expect(stripComments('x // role="toolbar"\ny')).not.toContain("toolbar");
  });

  it("survives unterminated block comments", () => {
    expect(stripComments("a /* never closed")).toBe("a ".padEnd(17, " "));
  });
});

// ---------------------------------------------------------------------------
// extractBlocks + checkTokenDrift

const SPEC_DECLS = Object.entries(SPEC_TOOLBAR_TOKENS)
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n");

describe("checkTokenDrift", () => {
  it("passes when both light blocks carry the spec values", () => {
    const css = `:root {\n${SPEC_DECLS}\n}\n.cinatra {\n${SPEC_DECLS}\n}\n`;
    expect(checkTokenDrift(css, "f.css", [":root", ".cinatra"])).toEqual([]);
  });

  it("flags a drifted ground value", () => {
    const css = `:root {\n  --toolbar: #e8e8e3;\n  --toolbar-l2: #e3e4dc;\n  --toolbar-l3: #e9eae2;\n}`;
    const findings = checkTokenDrift(css, "f.css", [":root"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("--toolbar");
    expect(findings[0].message).toContain("#e8e8e3");
  });

  it("flags a missing depth token", () => {
    const css = `:root {\n  --toolbar: #dcddd5;\n  --toolbar-l2: #e3e4dc;\n}`;
    const findings = checkTokenDrift(css, "f.css", [":root"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("--toolbar-l3");
  });

  it("flags a missing block", () => {
    const findings = checkTokenDrift("body { color: red; }", "f.css", [
      ".cinatra",
    ]);
    expect(findings.some((f) => f.message.includes("missing"))).toBe(true);
  });

  it("does not mistake `.dark .cinatra` for the standalone block", () => {
    const css = `.dark .cinatra {\n  --toolbar: #000001;\n}\n.cinatra {\n${SPEC_DECLS}\n}`;
    expect(checkTokenDrift(css, "f.css", [".cinatra"])).toEqual([]);
  });

  it("matches values case-insensitively", () => {
    const upperValues = Object.entries(SPEC_TOOLBAR_TOKENS)
      .map(([k, v]) => `  ${k}: ${v.toUpperCase()};`)
      .join("\n");
    const css = `:root {\n${upperValues}\n}`;
    expect(checkTokenDrift(css, "f.css", [":root"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanRoleToolbar

describe("scanRoleToolbar", () => {
  it("flags double- and single-quoted role attributes with line numbers", () => {
    const src = `<div>\n  <div role="toolbar" />\n  <div role='toolbar' />\n</div>`;
    const findings = scanRoleToolbar(src, "f.tsx");
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
  });

  it("tolerates whitespace around the equals sign", () => {
    expect(scanRoleToolbar(`<div role = "toolbar" />`, "f.tsx")).toHaveLength(1);
  });

  it("ignores commented-out markup", () => {
    const src = `// <div role="toolbar" />\n/* role="toolbar" */`;
    expect(scanRoleToolbar(src, "f.tsx")).toEqual([]);
  });

  it("ignores other roles", () => {
    expect(scanRoleToolbar(`<div role="menubar" />`, "f.tsx")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanGroundHexes

describe("scanGroundHexes", () => {
  it("flags each spec hex, case-insensitively", () => {
    const src = `.a { background: #DCDDD5; }\n.b { background: #e3e4dc; }`;
    const findings = scanGroundHexes(src, "f.css");
    expect(findings.map((f) => f.match)).toEqual(["#dcddd5", "#e3e4dc"]);
  });

  it("ignores comments and unrelated hexes", () => {
    const src = `/* spec ground is #dcddd5 */\n.a { color: #15213a; }`;
    expect(scanGroundHexes(src, "f.css")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Allowlist hygiene

describe("NONCANONICAL_TOOLBAR_ALLOWLIST", () => {
  it("every entry names a tracked file and a reason", () => {
    for (const [fileRel, reason] of NONCANONICAL_TOOLBAR_ALLOWLIST) {
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(10);
      const tracked = execSync(`git ls-files -- ${fileRel}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      expect(tracked, `${fileRel} is allowlisted but not tracked`).toBe(
        fileRel,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// extractBlocks regression

describe("extractBlocks", () => {
  it("collects multiple occurrences of the same selector", () => {
    const css = `:root { --a: 1; }\n@media x { }\n:root { --b: 2; }`;
    const blocks = extractBlocks(css, [":root"]);
    expect(blocks.get(":root")).toHaveLength(2);
  });

  it("handles a block at the very start of the file", () => {
    const blocks = extractBlocks(`:root { --a: 1; }`, [":root"]);
    expect(blocks.get(":root")).toHaveLength(1);
  });
});
