/**
 * File-leaf containment for the install-collision provenance marker read
 * (#300, github.ts ~line 512 — the sink codex flagged FIX-FIRST).
 *
 * `installSkillPackageFromGitHub` computes a realpath-confined target dir, but
 * when that dir is NON-EMPTY it reads `<target>/.cinatra-skill-source.json` to
 * decide whether a reinstall is allowed. The marker LEAF could be a SYMLINK to
 * an outside file: pre-fix, `readFileSync` would follow it and an attacker who
 * pre-planted `<target>/.cinatra-skill-source.json -> /outside/forged.json`
 * (with `{"packageId":"github:owner/repo"}`) could make the collision guard
 * believe the dir is owned by THIS package and silently CLOBBER it. The
 * `isEntryContainedInBase` leaf check now skips the symlinked-out marker, so
 * the guard fails closed into the "no provenance marker" refusal.
 *
 * The marker read happens BEFORE the clone, so the Octokit network surface is
 * never reached — we only need `getGitHubOctokit` to resolve, then assert the
 * function REFUSES (does not follow the symlink and proceed).
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-gh-marker-leaf-"));
const skillsRoot = path.join(tmpBase, "data", "skills");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(skillsRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

vi.mock("server-only", () => ({}));

vi.mock("@/lib/github-api", () => ({
  getGitHubAccessToken: vi.fn(async () => ({ accessToken: "ghp_test", connection: {} })),
  getGitHubAPIStatus: vi.fn(),
  getGitHubOAuthSettings: vi.fn(async () => ({ selectedRepositoryFullName: null })),
}));

vi.mock("octokit", () => ({
  Octokit: function MockOctokit() {
    // The marker collision-check throws before any octokit call in these tests.
    return {};
  },
}));

vi.mock("./skills-store", () => ({
  upsertRepositoryBackedSkillPackage: vi.fn(),
  getSkillsDataRootPath: vi.fn(() => skillsRoot),
}));

vi.mock("./compile-agent-skills", () => ({
  compileAndRegisterAgentSkillsForRepo: vi.fn(),
}));

import { installSkillPackageFromGitHub } from "./github";

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// The SUT lands the package at <skillsRoot>/workspace/<owner>/<repo>/.
const owner = "octo";
const repo = "marker-repo";
const targetDir = path.join(skillsRoot, "workspace", owner, repo);

beforeEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // Make the dir NON-EMPTY so the collision/marker branch fires.
  writeFileSync(path.join(targetDir, "some-existing-file.txt"), "x");
});

describe("install marker-leaf symlink containment (#300, github.ts:512)", () => {
  it("REFUSES when the provenance marker is a symlink to an outside FORGED marker that names THIS package", async () => {
    // The attack: a forged outside marker claims ownership by this exact
    // packageId; following the symlink pre-fix would let the reinstall proceed
    // and clobber the dir. The leaf guard skips the symlinked-out read, so the
    // marker is treated as missing → fail-closed refusal.
    const forged = path.join(outsideDir, "forged-marker.json");
    writeFileSync(forged, JSON.stringify({ packageId: `github:${owner}/${repo}` }));

    const markerLink = path.join(targetDir, ".cinatra-skill-source.json");
    try { rmSync(markerLink, { force: true }); } catch { /* noop */ }
    symlinkSync(forged, markerLink, "file");

    // Post-fix: the symlinked-out marker is NOT read, so markerIsValid stays
    // false and the non-empty-dir guard throws the "no provenance marker"
    // refusal. (Pre-fix, the forged packageId would match and the function
    // would proceed past this guard.)
    await expect(installSkillPackageFromGitHub(`${owner}/${repo}`)).rejects.toThrow(
      /no provenance marker/i,
    );
  });

  it("still REFUSES (different owner) — symlinked-out marker never satisfies the collision check", async () => {
    // Even a forged marker with a DIFFERENT packageId must not be read; the
    // refusal is the no-marker path, never the "owned by X" path that would
    // require actually reading the (escaping) file.
    const forged = path.join(outsideDir, "forged-other.json");
    writeFileSync(forged, JSON.stringify({ packageId: "github:someone/else" }));
    const markerLink = path.join(targetDir, ".cinatra-skill-source.json");
    try { rmSync(markerLink, { force: true }); } catch { /* noop */ }
    symlinkSync(forged, markerLink, "file");

    await expect(installSkillPackageFromGitHub(`${owner}/${repo}`)).rejects.toThrow(
      /no provenance marker/i,
    );
  });
});

void realpathSync;
