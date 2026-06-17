/**
 * Write-LEAF symlink containment for the relocation marker (#300, the final
 * write-leaf class flagged by codex's review).
 *
 * `resolveRelocationAbsPath` realpath-confines the move DIRECTORIES, but the
 * marker leaf `<oldAbs>/.cinatra-moving.json` is composed afterwards and was
 * unconfined: a pre-existing symlink planted at that leaf (the old skill dir
 * already exists on disk) pointing OUT of the skills root would have the marker
 * `writeFile` follow it and clobber an arbitrary outside file. These tests pin
 * the skills root to a real temp tree (so realpath resolves a real on-disk
 * root), plant a real marker-leaf symlink to outside, and assert the exported
 * guard `assertRelocationMarkerLeafContained` REJECTS it while a legitimate
 * non-symlink / not-yet-created marker leaf is accepted.
 *
 * No database: the production write path is DB-driven, so the guard is exported
 * and exercised directly here. The guard is the same callee the write path
 * invokes, so reverting it breaks these tests (revert-sensitive).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));

// Temp tree: a skills root and an "outside" dir the symlink points at. Created
// BEFORE the module mock resolves so realpath() of the root succeeds.
const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-relocate-marker-leaf-"));
const skillsRoot = path.join(tmpBase, "data", "skills");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(skillsRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

// Pin getSkillsDataRootPath to the temp root; keep the real isRealpathContained
// so the guard canonicalizes against a real on-disk root we control.
vi.mock("./skills-store", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getSkillsDataRootPath: () => skillsRoot,
  };
});

let assertRelocationMarkerLeafContained: (markerPath: string) => void;

beforeAll(async () => {
  ({ assertRelocationMarkerLeafContained } = await import("./relocate-worker"));
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* noop */ }
});

const MARKER_FILE_NAME = ".cinatra-moving.json";

describe("relocation marker write-leaf containment (#300)", () => {
  it("accepts a not-yet-created marker leaf inside a confined skill dir", () => {
    const oldDir = path.join(skillsRoot, "personal", "alice", "ok-new");
    mkdirSync(oldDir, { recursive: true });
    const markerPath = path.join(oldDir, MARKER_FILE_NAME);
    // Leaf does not exist yet — guard is a no-op (the legitimate move case).
    expect(existsSync(markerPath)).toBe(false);
    expect(() => assertRelocationMarkerLeafContained(markerPath)).not.toThrow();
  });

  it("accepts a pre-existing real (non-symlink) marker leaf inside the root", () => {
    const oldDir = path.join(skillsRoot, "personal", "alice", "ok-real");
    mkdirSync(oldDir, { recursive: true });
    const markerPath = path.join(oldDir, MARKER_FILE_NAME);
    writeFileSync(markerPath, JSON.stringify({ stale: true }));
    expect(() => assertRelocationMarkerLeafContained(markerPath)).not.toThrow();
  });

  it("REJECTS a marker leaf that is a pre-existing symlink to an outside file (no write-through)", () => {
    // The outside secret the marker symlink points at.
    const outsideSecret = path.join(outsideDir, "secret-relocate-target.json");
    writeFileSync(outsideSecret, "ORIGINAL OUTSIDE CONTENT — MUST NOT BE OVERWRITTEN");

    const oldDir = path.join(skillsRoot, "personal", "alice", "evil");
    mkdirSync(oldDir, { recursive: true });
    const markerPath = path.join(oldDir, MARKER_FILE_NAME);
    // Plant the marker leaf as a symlink to the outside secret. The dir itself
    // is legitimately inside the skills root; only the leaf escapes.
    try { rmSync(markerPath, { force: true }); } catch { /* noop */ }
    symlinkSync(outsideSecret, markerPath, "file");

    expect(() => assertRelocationMarkerLeafContained(markerPath)).toThrow(
      /relocation marker leaf escapes skills root via symlink/i,
    );

    // The guard rejected BEFORE any write — the outside secret is untouched.
    expect(readFileSync(outsideSecret, "utf8")).toBe(
      "ORIGINAL OUTSIDE CONTENT — MUST NOT BE OVERWRITTEN",
    );
  });

  it("REJECTS a DANGLING symlink marker leaf and does NOT create the outside target (#300)", () => {
    // A pre-existing DANGLING symlink: the symlink file exists, but its target
    // (outside the skills root) does NOT yet exist. `existsSync` FOLLOWS the
    // symlink and returns false, so the realpath check is skipped — the
    // pre-lstat guard treated this as a new leaf and `writeFile` would FOLLOW
    // the dangling symlink and CREATE the file at the outside target. lstat
    // catches it. Revert-sensitive: without the lstat arm this test fails by
    // materializing `outsideTarget`.
    const outsideTarget = path.join(outsideDir, "dangling-relocate-target.json");
    // Ensure the target does NOT exist — that is what makes the symlink dangle.
    try { rmSync(outsideTarget, { force: true }); } catch { /* noop */ }
    expect(existsSync(outsideTarget)).toBe(false);

    const oldDir = path.join(skillsRoot, "personal", "alice", "dangling");
    mkdirSync(oldDir, { recursive: true });
    const markerPath = path.join(oldDir, MARKER_FILE_NAME);
    try { rmSync(markerPath, { force: true }); } catch { /* noop */ }
    symlinkSync(outsideTarget, markerPath, "file");

    // existsSync follows the dangling symlink -> false (proving the pre-lstat
    // realpath guard would NOT have fired on this leaf).
    expect(existsSync(markerPath)).toBe(false);

    expect(() => assertRelocationMarkerLeafContained(markerPath)).toThrow(
      /relocation marker leaf is a symlink; refusing to write through it/i,
    );

    // Crucially: no write occurred through the dangling symlink, so the outside
    // target was never created.
    expect(existsSync(outsideTarget)).toBe(false);
  });
});
