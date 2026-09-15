// ---------------------------------------------------------------------------
// THE PROOF-ARTIFACT TREE GUARD — the check that actually holds the line.
//
// `.gitignore` is a convenience, not enforcement: `git add -f evidence/…` walks
// straight past it, and a proof tree is exactly the thing somebody force-adds
// "just this once". This suite drives the REAL CLI against throwaway
// repositories, because what is being asserted is a fact about the TRACKED tree
// and only git can answer that.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GUARD = join(REPO_ROOT, "scripts", "audit", "repo-docs-tree-guard.mjs");

/** A minimal repository the guard finds structurally clean. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "docs-tree-guard-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  mkdirSync(join(root, "docs", "internals"), { recursive: true });
  writeFileSync(join(root, "docs", "README.md"), "# docs\n");
  writeFileSync(join(root, "docs", "internals", "note.md"), "note\n");
  // The guard resolves the repo root from its OWN location, so it has to be run
  // from a copy that sits inside the repository under test.
  mkdirSync(join(root, "scripts", "audit"), { recursive: true });
  execFileSync("cp", [GUARD, join(root, "scripts", "audit", "repo-docs-tree-guard.mjs")]);
  writeFileSync(join(root, ".gitignore"), "evidence/\npr-evidence/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, run: () =>
    spawnSync(process.execPath, [join(root, "scripts", "audit", "repo-docs-tree-guard.mjs")], {
      cwd: root, encoding: "utf8",
    }) };
}

describe("tracked proof artifacts are refused", () => {
  it("passes on a clean tree and names both roots", () => {
    const { root, run } = makeRepo();
    try {
      const res = run();
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(res.stdout).toContain("no tracked proof artifacts");
      expect(res.stdout).toContain("evidence/");
      expect(res.stdout).toContain("pr-evidence/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // THE CASE THAT MATTERS. `.gitignore` lists `evidence/`, and `git add -f`
  // ignores it — so the guard, not the ignore file, is what keeps the tree clean.
  for (const dir of ["evidence", "pr-evidence"]) {
    it(`FAILS on a force-added ${dir}/ file, past .gitignore`, () => {
      const { root, git, run } = makeRepo();
      try {
        mkdirSync(join(root, dir, "2999-round", "captures"), { recursive: true });
        writeFileSync(join(root, dir, "2999-round", "captures", "shot.png"), "not-really-a-png");
        git("add", "-f", `${dir}/2999-round/captures/shot.png`);
        const res = run();
        expect(res.status).toBe(1);
        expect(res.stderr).toContain(`${dir}/ must be absent from the product tree`);
        expect(res.stderr).toContain(`${dir}/2999-round/captures/shot.png`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it(`FAILS on a tracked file named exactly ${dir}`, () => {
      const { root, git, run } = makeRepo();
      try {
        writeFileSync(join(root, dir), "a file, not a directory\n");
        git("add", "-f", dir);
        const res = run();
        expect(res.status).toBe(1);
        expect(res.stderr).toContain(`${dir}/ must be absent from the product tree`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("an UNtracked proof tree is not a violation — only what git carries counts", () => {
    const { root, run } = makeRepo();
    try {
      mkdirSync(join(root, "evidence", "2999-round"), { recursive: true });
      writeFileSync(join(root, "evidence", "2999-round", "shot.png"), "scratch");
      const res = run();
      expect(res.status, res.stdout + res.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the REAL tree carries no proof artifacts", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "evidence", "pr-evidence"], {
      cwd: REPO_ROOT, encoding: "utf8",
    });
    expect(tracked.trim()).toBe("");
  });
});
