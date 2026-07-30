// cinatra#2265 gap (a) — the compiled-bundle READER the CLI writer records its
// content authority from.
//
// `compileAndRegisterAgentSkillsViaPg` stamps `packageId: "custom:<slug>"`, and
// that prefix IS the canonical predicate for "the DATABASE owns this skill's
// content". So the writer has to record the bundle it compiled. Recording ONLY
// the router would reproduce cinatra#2094 F7-A — a bundle-of-one authority
// manifest under a multi-file skill, which the one-hop packaging lint then
// refuses forever because the `references/*` the router links to can never enter
// the stored bundle. This suite pins the reader that prevents that: it returns
// the WHOLE directory, byte-exact, and fails closed on anything it cannot
// faithfully record.

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { agentSkillReadBundleFiles } from "../cli.mjs";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function makeSkillDir(): string {
  root = mkdtempSync(path.join(tmpdir(), "cli-bundle-2265-"));
  const dir = path.join(root, "skill");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("agentSkillReadBundleFiles (cinatra#2265 gap (a))", () => {
  it("reads the WHOLE bundle — router plus nested resources — byte-exact", () => {
    const dir = makeSkillDir();
    const routerBody = "---\nname: x\n---\n# Router\nSee [a](references/a.md).\n";
    writeFileSync(path.join(dir, "SKILL.md"), routerBody);
    mkdirSync(path.join(dir, "references"), { recursive: true });
    writeFileSync(path.join(dir, "references", "a.md"), "# a\n");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    // A non-UTF-8 resource must survive byte-exact (the manifest is raw bytes).
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
    writeFileSync(path.join(dir, "assets", "logo.png"), binary);

    const files = agentSkillReadBundleFiles(dir);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(
      ["SKILL.md", "assets/logo.png", "references/a.md"].sort(),
    );
    expect(byPath.get("SKILL.md")!.isRouter).toBe(true);
    expect(byPath.get("references/a.md")!.isRouter).toBe(false);
    expect(byPath.get("SKILL.md")!.digest).toBe(sha(routerBody));
    expect(byPath.get("assets/logo.png")!.digest).toBe(sha(binary));
    expect(Buffer.from(byPath.get("assets/logo.png")!.b64, "base64").equals(binary)).toBe(true);
    expect(byPath.get("assets/logo.png")!.byteLength).toBe(binary.length);
  });

  it("uses POSIX-separated bundle-relative paths", () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "SKILL.md"), "# r\n");
    mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    writeFileSync(path.join(dir, "a", "b", "c.md"), "# c\n");
    expect(agentSkillReadBundleFiles(dir).map((f) => f.path).sort()).toEqual(
      ["SKILL.md", "a/b/c.md"].sort(),
    );
  });

  it("excludes symlinks and .git / node_modules", () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "SKILL.md"), "# r\n");
    const outside = path.join(root!, "outside.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, path.join(dir, "link.txt"));
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "config"), "x\n");
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x\n");

    expect(agentSkillReadBundleFiles(dir).map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("FAILS CLOSED when the directory ships no SKILL.md router", () => {
    const dir = makeSkillDir();
    writeFileSync(path.join(dir, "notes.md"), "# not a router\n");
    expect(() => agentSkillReadBundleFiles(dir)).toThrow(/no SKILL\.md router/);
  });
});
