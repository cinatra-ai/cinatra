// Tests for the toolbar design-system gate.
//
// Contract lives in scripts/audit/toolbar-tokens.mjs:
//   1. token drift — spec ground values pinned in the light blocks of both
//      token homes;
//   2. non-canonical toolbars — role="toolbar" outside the canonical
//      component (allowlist mechanism, comment-stripped scan, tests skipped);
//   3. ground-hex leaks — spec hexes hardcoded outside the token files.

import { afterAll, describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import * as toolbarGate from "../toolbar-tokens.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  fixtureGit,
  makeFloorRepo,
} from "./floor-base-fixture.mjs";

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

// ---------------------------------------------------------------------------
// The lint rule's allow list for arbitrary type values may not grow against
// the base branch (cinatra#3832). The list lives in its own data file, which
// eslint.config.mjs reads; the gate compares it with the copy on the base
// (and, on a base from before the move, with the array in eslint.config.mjs).
// The module is read as a namespace so a missing export is an assertion
// failure here, not a load error.

describe("toolbar-tokens — the type allow list may not grow against the base", () => {
  const LIST = "scripts/audit/type-arbitrary-allowlist.baseline.json";
  const doc = (...files) => ({ note: "a fixture list", files });
  const cleanups = [];
  afterAll(() => cleanups.forEach((c) => c()));

  function check() {
    expect(typeof toolbarGate.checkTypeAllowlistAgainstBase, "checkTypeAllowlistAgainstBase is exported").toBe("function");
    return toolbarGate.checkTypeAllowlistAgainstBase;
  }
  function fixture(base, head) {
    const f = makeFloorRepo({ base, head });
    cleanups.push(f.cleanup);
    return f.root;
  }
  const run = (root, env) => check()({ repoRoot: root, env });
  const text = (r) => r.lines.join("\n");

  it("the live tree keeps the list in its own file and eslint.config.mjs reads it", () => {
    expect(toolbarGate.TYPE_ALLOWLIST_REL).toBe(LIST);
    expect(existsSync(resolve(REPO_ROOT, LIST)), `${LIST} exists`).toBe(true);
    const files = JSON.parse(readFileSync(resolve(REPO_ROOT, LIST), "utf8")).files;
    expect(files.length).toBeGreaterThan(0);
    const config = readFileSync(resolve(REPO_ROOT, "eslint.config.mjs"), "utf8");
    expect(config).toContain(LIST);
    expect(config).not.toMatch(/TYPE_ARBITRARY_MIGRATION_ALLOWLIST = \[/);
  });

  it("an added entry FAILS on a pull request, naming the file", () => {
    const r = run(fixture({ [LIST]: doc("src/a.tsx") }, { [LIST]: doc("src/a.tsx", "src/new.tsx") }), PULL_REQUEST_RUN);
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/GREW against/);
    expect(text(r)).toContain("files src/new.tsx");
  });

  it("a removal passes, and an unchanged list passes", () => {
    const fewer = run(fixture({ [LIST]: doc("src/a.tsx", "src/b.tsx") }, { [LIST]: doc("src/a.tsx") }), PULL_REQUEST_RUN);
    expect(fewer.ok, text(fewer)).toBe(true);
    expect(text(fewer)).toMatch(/does not grow against/);
    const same = run(fixture({ [LIST]: doc("src/a.tsx") }, { [LIST]: doc("src/a.tsx") }), PULL_REQUEST_RUN);
    expect(same.ok, text(same)).toBe(true);
  });

  it("a base from before the move is read from the array in eslint.config.mjs", () => {
    const config = [
      "const OTHER = [\"src/other.tsx\"];",
      "const TYPE_ARBITRARY_MIGRATION_ALLOWLIST = [",
      "  \"src/a.tsx\",",
      "  // a comment that names \"src/commented.tsx\"",
      "  \"src/b.tsx\",",
      "];",
      "",
    ].join("\n");
    const moved = run(fixture({ "eslint.config.mjs": config }, { [LIST]: doc("src/a.tsx", "src/b.tsx") }), PULL_REQUEST_RUN);
    expect(moved.ok, text(moved)).toBe(true);
    expect(text(moved)).toMatch(/does not grow against/);
    const grown = run(
      fixture({ "eslint.config.mjs": config }, { [LIST]: doc("src/a.tsx", "src/commented.tsx", "src/other.tsx") }),
      PULL_REQUEST_RUN,
    );
    expect(grown.ok).toBe(false);
    expect(text(grown)).toContain("files src/commented.tsx");
    expect(text(grown)).toContain("files src/other.tsx");
  });

  it("a base that cannot be read fails closed with its reason", () => {
    const unresolved = run(fixture({ [LIST]: doc() }, { [LIST]: doc() }), UNREADABLE_BASE_RUN);
    expect(unresolved.ok).toBe(false);
    expect(text(unresolved)).toMatch(/the base "origin\/no-such-base-3832" did not resolve/);
    const neither = run(fixture({ "README.md": "base\n" }, { [LIST]: doc() }), PULL_REQUEST_RUN);
    expect(neither.ok).toBe(false);
    expect(text(neither)).toMatch(/is not on the base/);
    const noArray = run(fixture({ "eslint.config.mjs": "export default [];\n" }, { [LIST]: doc() }), PULL_REQUEST_RUN);
    expect(noArray.ok).toBe(false);
    expect(text(noArray)).toMatch(/not a readable floor/);
    const badJson = run(fixture({ [LIST]: { files: "src/a.tsx" } }, { [LIST]: doc() }), PULL_REQUEST_RUN);
    expect(badJson.ok).toBe(false);
    expect(text(badJson)).toMatch(/files is not a list of paths/);
  });

  it("a missing or wrongly shaped list on the head fails closed", () => {
    const root = fixture({ [LIST]: doc() }, { [LIST]: doc() });
    fixtureGit(root, ["rm", "-q", "-f", LIST]);
    const missing = run(root, PULL_REQUEST_RUN);
    expect(missing.ok).toBe(false);
    expect(text(missing)).toMatch(/not a readable list/);
    const bad = run(fixture({ [LIST]: doc() }, { [LIST]: { files: [5] } }), PULL_REQUEST_RUN);
    expect(bad.ok).toBe(false);
    expect(text(bad)).toMatch(/files is not a list of paths/);
  });

  it("a run that is no pull request says so and passes the comparison", () => {
    const r = run(fixture({ [LIST]: doc() }, { [LIST]: doc("src/new.tsx") }), NO_PULL_REQUEST_RUN);
    expect(r.ok, text(r)).toBe(true);
    expect(text(r)).toMatch(/not compared with a base on this run/);
  });

  // The event's base commit (TYPE_ALLOWLIST_BASE, set by the workflow step from
  // the pull request's or the merge group's base SHA) is compared, not the
  // moving tip of the target branch. In the fixture the pinned base holds
  // `pinned`, live origin/main has moved on to `live`, and the head holds `head`.
  function movedTip({ pinned, live, head }) {
    const root = fixture({ [LIST]: doc(...pinned) }, { [LIST]: doc(...head) });
    const headSha = fixtureGit(root, ["rev-parse", "HEAD"]).trim();
    const pinnedSha = fixtureGit(root, ["rev-parse", "HEAD~1"]).trim();
    fixtureGit(root, ["checkout", "-q", "--detach", pinnedSha]);
    writeFileSync(resolve(root, LIST), JSON.stringify(doc(...live), null, 2) + "\n");
    fixtureGit(root, ["commit", "-q", "-a", "--allow-empty", "-m", "live main moved on"]);
    fixtureGit(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixtureGit(root, ["checkout", "-q", "--detach", headSha]);
    return { root, pinnedSha };
  }

  it("moved tip: an unchanged entry that live main has since removed passes against the pinned event base", () => {
    const { root, pinnedSha } = movedTip({ pinned: ["src/old.tsx"], live: [], head: ["src/old.tsx"] });
    const pinnedRun = run(root, { ...PULL_REQUEST_RUN, TYPE_ALLOWLIST_BASE: pinnedSha });
    expect(pinnedRun.ok, text(pinnedRun)).toBe(true);
    expect(text(pinnedRun)).toContain(`does not grow against the base "${pinnedSha}"`);
    // Without the event's base the live tip is read: the unchanged entry looks like growth.
    const tip = run(root, PULL_REQUEST_RUN);
    expect(tip.ok).toBe(false);
    expect(text(tip)).toContain("files src/old.tsx");
  });

  it("merge group: growth against the group's base commit fails, and an unchanged list passes", () => {
    const grown = movedTip({ pinned: [], live: [], head: ["src/new.tsx"] });
    const r = run(grown.root, { GITHUB_EVENT_NAME: "merge_group", TYPE_ALLOWLIST_BASE: grown.pinnedSha });
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/GREW against/);
    expect(text(r)).toContain("files src/new.tsx");
    const same = movedTip({ pinned: ["src/old.tsx"], live: [], head: ["src/old.tsx"] });
    const held = run(same.root, { GITHUB_EVENT_NAME: "merge_group", TYPE_ALLOWLIST_BASE: same.pinnedSha });
    expect(held.ok, text(held)).toBe(true);
  });

  it("merge group with no base named fails closed instead of passing as no-base", () => {
    const r = run(fixture({ [LIST]: doc() }, { [LIST]: doc("src/new.tsx") }), { GITHUB_EVENT_NAME: "merge_group" });
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/merge group's but TYPE_ALLOWLIST_BASE is empty/);
  });

  it("the workflow step sets TYPE_ALLOWLIST_BASE from the merge group's or the pull request's base SHA", () => {
    const lines = readFileSync(resolve(REPO_ROOT, ".github/workflows/gates.yml"), "utf8").split("\n");
    const at = lines.findIndex((l) => l === "      - name: Toolbar Design-System Gate — Toolbar design-system gate");
    expect(at, "the step is missing").toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > at && /^ {6}(- |#)/.test(l));
    const step = lines.slice(at, end === -1 ? undefined : end).join("\n");
    expect(step).toContain(
      "        env:\n          TYPE_ALLOWLIST_BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}\n",
    );
    expect(step).toContain("node scripts/audit/toolbar-tokens.mjs");
  });
});
