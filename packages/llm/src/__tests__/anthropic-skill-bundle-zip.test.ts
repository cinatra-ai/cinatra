/**
 * Canonical Anthropic skill upload-artifact tests.
 *
 * Proves the S0 conformance fixes at the artifact level:
 *  - the zip roots every entry under a common directory == the SKILL.md
 *    frontmatter `name` (the documented contract), with a normalized fallback;
 *  - the archive is deterministic (byte-identical for identical input) and
 *    well-formed (a minimal STORE reader round-trips the entries);
 *  - the boundary rule rejects at 31,457,280 (30 MiB) on EITHER dimension;
 *  - the display title is stable per catalog skill, workspace-unique across
 *    colliding names, and non-sensitive.
 */
import { describe, it, expect } from "vitest";
import {
  buildCanonicalSkillZip,
  checkSkillBoundary,
  deriveSkillRootDir,
  deriveAnthropicDisplayTitle,
  ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
} from "../tools/anthropic-skill-content-hash";

/** Minimal STORE-only zip reader: returns a map of entry path → bytes. */
function readStoreZip(zip: Buffer): Map<string, Buffer> {
  // Locate End Of Central Directory (fixed 22 bytes, no comment here).
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const total = zip.readUInt16LE(eocd + 10);
  let cd = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    expect(zip.readUInt32LE(cd)).toBe(0x02014b50); // central header sig
    const method = zip.readUInt16LE(cd + 10);
    expect(method).toBe(0); // STORE
    const size = zip.readUInt32LE(cd + 24);
    const nameLen = zip.readUInt16LE(cd + 28);
    const extraLen = zip.readUInt16LE(cd + 30);
    const commentLen = zip.readUInt16LE(cd + 32);
    const localOff = zip.readUInt32LE(cd + 42);
    const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString("utf8");
    // Local header: sig(4) + 26 fixed + nameLen + extraLen, then data.
    expect(zip.readUInt32LE(localOff)).toBe(0x04034b50);
    const lNameLen = zip.readUInt16LE(localOff + 26);
    const lExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    out.set(name, zip.subarray(dataStart, dataStart + size));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const SKILL_MD = Buffer.from("---\nname: my-skill\n---\n# hello\n");
const FILES = [
  { relPath: "references/a.md", bytes: Buffer.from("alpha") },
  { relPath: "references/b.txt", bytes: Buffer.from("beta-beta") },
];

describe("deriveSkillRootDir", () => {
  it("uses the frontmatter name verbatim (the API's common-root requirement)", () => {
    expect(deriveSkillRootDir(SKILL_MD, "Display Name")).toBe("my-skill");
  });
  it("falls back to a normalized slug when frontmatter has no name", () => {
    expect(deriveSkillRootDir(Buffer.from("no frontmatter"), "My Cool Skill!")).toBe(
      "my-cool-skill",
    );
    expect(deriveSkillRootDir(Buffer.from(""), "")).toBe("skill");
  });
  it("strips an inline comment on an unquoted frontmatter name", () => {
    expect(
      deriveSkillRootDir(Buffer.from("---\nname: my-skill  # the router\n---\n"), "fallback"),
    ).toBe("my-skill");
  });
  it("handles heavy non-alphanumeric / whitespace input linearly (ReDoS-safe)", () => {
    // A pathological run of separators must still resolve promptly + correctly.
    expect(deriveSkillRootDir(Buffer.from("x"), "-".repeat(50_000) + "a" + "-".repeat(50_000))).toBe(
      "a",
    );
    expect(
      deriveSkillRootDir(Buffer.from("---\nname:" + " ".repeat(50_000) + "\n---\n"), "fb"),
    ).toBe("fb");
  });
});

describe("buildCanonicalSkillZip", () => {
  it("roots every entry under <rootDir>/ and round-trips through a STORE reader", () => {
    const zip = buildCanonicalSkillZip({
      skillMd: SKILL_MD,
      bundledFiles: FILES,
      rootDir: "my-skill",
    });
    expect(zip.rootDir).toBe("my-skill");
    expect(zip.entryPaths).toEqual([
      "my-skill/SKILL.md",
      "my-skill/references/a.md",
      "my-skill/references/b.txt",
    ]);
    const entries = readStoreZip(zip.zipBytes);
    expect(entries.get("my-skill/SKILL.md")).toEqual(SKILL_MD);
    expect(entries.get("my-skill/references/a.md")).toEqual(Buffer.from("alpha"));
    expect(entries.get("my-skill/references/b.txt")).toEqual(Buffer.from("beta-beta"));
    expect(zip.uncompressedTotal).toBe(
      SKILL_MD.length + "alpha".length + "beta-beta".length,
    );
    expect(zip.archiveBytes).toBe(zip.zipBytes.length);
  });

  it("is byte-deterministic for identical input (fixed metadata, sorted, STORE)", () => {
    const a = buildCanonicalSkillZip({ skillMd: SKILL_MD, bundledFiles: FILES, rootDir: "my-skill" });
    const b = buildCanonicalSkillZip({
      skillMd: SKILL_MD,
      // reversed input order must not change the bytes (entries sorted).
      bundledFiles: [...FILES].reverse(),
      rootDir: "my-skill",
    });
    expect(a.zipBytes.equals(b.zipBytes)).toBe(true);
  });

  it("any byte change flips the archive (drift-visible)", () => {
    const a = buildCanonicalSkillZip({ skillMd: SKILL_MD, bundledFiles: FILES, rootDir: "my-skill" });
    const b = buildCanonicalSkillZip({
      skillMd: Buffer.from("---\nname: my-skill\n---\n# HELLO\n"),
      bundledFiles: FILES,
      rootDir: "my-skill",
    });
    expect(a.zipBytes.equals(b.zipBytes)).toBe(false);
  });

  it("sets the UTF-8 filename flag (bit 11) in local + central headers", () => {
    const zip = buildCanonicalSkillZip({ skillMd: SKILL_MD, bundledFiles: [], rootDir: "s" });
    // Local file header general-purpose flag at offset 6.
    expect(zip.zipBytes.readUInt16LE(6)).toBe(0x0800);
    // Central directory header flag at its offset 8 — locate the central dir.
    const eocd = zip.zipBytes.length - 22;
    const cdOff = zip.zipBytes.readUInt32LE(eocd + 16);
    expect(zip.zipBytes.readUInt32LE(cdOff)).toBe(0x02014b50);
    expect(zip.zipBytes.readUInt16LE(cdOff + 8)).toBe(0x0800);
  });

  it("rejects an over-long entry path instead of throwing a raw RangeError", () => {
    const longName = "x".repeat(70_000);
    expect(() =>
      buildCanonicalSkillZip({
        skillMd: SKILL_MD,
        bundledFiles: [{ relPath: longName, bytes: Buffer.from("y") }],
        rootDir: "s",
      }),
    ).toThrow(/entry path too long/);
  });

  it("rejects absolute / traversal / duplicate bundled paths (same as the drift hash)", () => {
    for (const bad of ["/etc/passwd", "../escape.md", "references/../../x"]) {
      expect(() =>
        buildCanonicalSkillZip({ skillMd: SKILL_MD, bundledFiles: [{ relPath: bad, bytes: Buffer.from("x") }], rootDir: "my-skill" }),
      ).toThrow();
    }
    expect(() =>
      buildCanonicalSkillZip({
        skillMd: SKILL_MD,
        bundledFiles: [
          { relPath: "a/b.md", bytes: Buffer.from("1") },
          { relPath: "a/b.md", bytes: Buffer.from("2") },
        ],
        rootDir: "my-skill",
      }),
    ).toThrow(/duplicate/);
  });
});

describe("checkSkillBoundary — reject at 31,457,280 (30 MiB) on either dimension", () => {
  it("uncompressed total reaching the limit is rejected", () => {
    const big = buildCanonicalSkillZip({
      skillMd: Buffer.alloc(100, 0x61),
      bundledFiles: [],
      rootDir: "s",
    });
    // With a tiny max, the uncompressed dimension trips first.
    const r = checkSkillBoundary(big, 100);
    expect(r).toMatchObject({ exceeded: true, dimension: "uncompressed", bytes: 100 });
  });

  it("archive overhead can trip the boundary when uncompressed is just under", () => {
    const zip = buildCanonicalSkillZip({ skillMd: Buffer.alloc(90, 0x61), bundledFiles: [], rootDir: "s" });
    // uncompressed=90 (< 100) but archive (headers + data) >= 100.
    expect(zip.uncompressedTotal).toBe(90);
    expect(zip.archiveBytes).toBeGreaterThanOrEqual(100);
    const r = checkSkillBoundary(zip, 100);
    expect(r).toMatchObject({ exceeded: true, dimension: "archive" });
  });

  it("under the limit ⇒ not exceeded; default limit is 31,457,280 (30 MiB)", () => {
    const zip = buildCanonicalSkillZip({ skillMd: SKILL_MD, bundledFiles: FILES, rootDir: "my-skill" });
    expect(checkSkillBoundary(zip)).toEqual({ exceeded: false });
    // 30 MiB, raised from 30,000,000 on the S7 live evidence (C10: the API
    // ACCEPTED 30,000,505 bytes). See the constant for the full grounding.
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(31_457_280);
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(30 * 1024 * 1024);
  });
});

describe("deriveAnthropicDisplayTitle — stable, unique, non-sensitive", () => {
  it("is stable for the same catalog skill across calls (retry-safe)", () => {
    expect(deriveAnthropicDisplayTitle("Email Agent", "cat-1")).toBe(
      deriveAnthropicDisplayTitle("Email Agent", "cat-1"),
    );
  });
  it("distinguishes two skills whose display names collide", () => {
    const a = deriveAnthropicDisplayTitle("Same Name", "cat-a");
    const b = deriveAnthropicDisplayTitle("Same Name", "cat-b");
    expect(a).not.toBe(b);
    expect(a.startsWith("Same Name ")).toBe(true);
    expect(b.startsWith("Same Name ")).toBe(true);
  });
  it("never embeds a secret (only the public catalog id's hash discriminator)", () => {
    const title = deriveAnthropicDisplayTitle("Skill", "public-catalog-id");
    // The discriminator is a hash, not the raw id, and no key material appears.
    expect(title).toMatch(/^Skill \[[0-9a-f]{12}\]$/);
    expect(title).not.toContain("public-catalog-id");
  });
});
