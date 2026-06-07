/**
 * Verifies content-hash determinism and canonicalization for bundled skill content.
 */
import { describe, it, expect } from "vitest";
import {
  computeSkillContentHash,
  normalizeBundledRelPath,
} from "../tools/anthropic-skill-content-hash";

const md = Buffer.from("SKILL");

describe("computeSkillContentHash", () => {
  it("is deterministic and order-independent in input file list", () => {
    const a = computeSkillContentHash(md, [
      { relPath: "b.txt", bytes: Buffer.from("B") },
      { relPath: "a.txt", bytes: Buffer.from("A") },
    ]);
    const b = computeSkillContentHash(md, [
      { relPath: "a.txt", bytes: Buffer.from("A") },
      { relPath: "b.txt", bytes: Buffer.from("B") },
    ]);
    expect(a).toBe(b);
  });

  it("changes on SKILL.md byte change", () => {
    expect(computeSkillContentHash(Buffer.from("X"), [])).not.toBe(
      computeSkillContentHash(Buffer.from("Y"), []),
    );
  });

  it("changes on a bundled file byte change", () => {
    const base = computeSkillContentHash(md, [{ relPath: "a", bytes: Buffer.from("1") }]);
    const changed = computeSkillContentHash(md, [{ relPath: "a", bytes: Buffer.from("2") }]);
    expect(base).not.toBe(changed);
  });

  it("changes on a file-set change (add/remove)", () => {
    const one = computeSkillContentHash(md, [{ relPath: "a", bytes: Buffer.from("1") }]);
    const two = computeSkillContentHash(md, [
      { relPath: "a", bytes: Buffer.from("1") },
      { relPath: "b", bytes: Buffer.from("1") },
    ]);
    expect(one).not.toBe(two);
  });

  it("frames path/bytes so a rename is detected even with same total bytes", () => {
    const x = computeSkillContentHash(md, [{ relPath: "ab", bytes: Buffer.from("c") }]);
    const y = computeSkillContentHash(md, [{ relPath: "a", bytes: Buffer.from("bc") }]);
    expect(x).not.toBe(y);
  });

  it("normalizes \\ to / so platform separators do not change the hash", () => {
    const posix = computeSkillContentHash(md, [{ relPath: "ref/a.md", bytes: Buffer.from("z") }]);
    const win = computeSkillContentHash(md, [{ relPath: "ref\\a.md", bytes: Buffer.from("z") }]);
    expect(posix).toBe(win);
  });

  it("rejects absolute, traversal, and duplicate normalized paths", () => {
    expect(() => normalizeBundledRelPath("/etc/passwd")).toThrow(/absolute/);
    expect(() => normalizeBundledRelPath("../secret")).toThrow(/traversal/);
    expect(() =>
      computeSkillContentHash(md, [
        { relPath: "a/./b", bytes: Buffer.from("1") },
        { relPath: "a/b", bytes: Buffer.from("2") },
      ]),
    ).toThrow(/duplicate/);
  });
});
