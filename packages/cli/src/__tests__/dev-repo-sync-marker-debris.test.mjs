// Regression for cinatra#1136 (update path, previous release tag → current
// head):
//
//  (1) STRAY PUBLISHED-MARKER DEBRIS. Older app releases' boot-time agent
//      published-marker backfill wrote an UNTRACKED `.cinatra-published.json`
//      into every agent companion checkout under extensions/. The pinned sync
//      (`make setup` / scripts/ci/sync-dev-extensions.mjs --pinned) then
//      failed CLOSED on all 33 of them ("has uncommitted changes — pinned
//      sync never stashes or resets local work"), blocking the documented
//      companion recovery. The marker is tool-generated debris the app
//      regenerates on demand — NOT local work: the dirty computation must
//      ignore it and the pinned/re-pin paths must delete it. A TRACKED
//      (committed) marker with modifications stays REAL dirt.
//
//  (2) DETACHED-AT-OLD-PIN RECONCILE. After `git pull`, a companion left
//      DETACHED by a pinned `make setup` sits at the PREVIOUS lock sha while
//      the committed lock (and the committed generated import maps) moved on
//      — every server-rendered page 500s. In non-pinned mode (the
//      `cinatra instance refresh` reconcile), a detached, origin-matching
//      checkout must be RE-PINNED to the caller-resolved `lockSha` when it
//      differs (never dragged to the branch tip); at the pin it stays
//      leave-as-is; real local work blocks the move with a non-fatal skip.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  syncOneRepo,
  defaultRepoSyncDeps,
  PUBLISHED_MARKER_BASENAME,
} from "../dev-repo-sync.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

// A companion origin with TWO commits and a checkout DETACHED at the FIRST
// (the "previous lock" state a pinned fresh-setup leaves behind, after the
// committed lock advanced to the second commit). Both commits are present in
// the checkout (cloned at tip), so a re-pin needs no network fetch.
function makeCompanion(work, name) {
  const origin = path.join(work, `${name}-origin.git`);
  const seed = path.join(work, `${name}-seed`);
  const dest = path.join(work, `${name}-checkout`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, seed]);
  git(seed, ["config", "user.email", "t@t"]);
  git(seed, ["config", "user.name", "t"]);
  writeFileSync(path.join(seed, "package.json"), `{"name":"@cinatra-ai/${name}"}\n`);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "c1"]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);
  const oldPin = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "c2"]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);
  const newPin = git(seed, ["rev-parse", "HEAD"]);
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", origin, dest]);
  git(dest, ["checkout", "-q", "--detach", oldPin]);
  return { origin, seed, dest, oldPin, newPin };
}

const markerPath = (dest) => path.join(dest, PUBLISHED_MARKER_BASENAME);
const writeStrayMarker = (dest) =>
  writeFileSync(markerPath(dest), `{"oasSha256":"deadbeef"}\n`);

const base = (origin, dest) => ({
  pkgName: "@cinatra-ai/apollo-prospecting-agent",
  url: origin,
  branch: "main",
  dest,
  force: false,
  deps: defaultRepoSyncDeps(),
  log: () => {},
});

describe("syncOneRepo — stray published-marker debris (cinatra#1136)", () => {
  let work;
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-1136-marker-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("PINNED: a tree dirty ONLY by the untracked marker proceeds and deletes the marker", () => {
    const { origin, dest, oldPin, newPin } = makeCompanion(work, "pinned-marker-only");
    writeStrayMarker(dest);
    expect(git(dest, ["status", "--porcelain"])).toContain(PUBLISHED_MARKER_BASENAME);
    const r = syncOneRepo({ ...base(origin, dest), sha: newPin });
    expect(r).toMatchObject({ action: "repinned", changed: true, pinnedSha: newPin });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(newPin);
    expect(existsSync(markerPath(dest))).toBe(false); // debris cleaned
    expect(oldPin).not.toBe(newPin);
  });

  it("PINNED at the pin already: marker-only dirt still cleans up (action 'pinned')", () => {
    const { origin, dest, oldPin } = makeCompanion(work, "pinned-at-pin");
    writeStrayMarker(dest);
    const r = syncOneRepo({ ...base(origin, dest), sha: oldPin });
    expect(r).toMatchObject({ action: "pinned", changed: false });
    expect(existsSync(markerPath(dest))).toBe(false);
  });

  it("PINNED: marker + REAL local work still hard-fails, and the marker survives", () => {
    const { origin, dest, newPin } = makeCompanion(work, "pinned-real-dirt");
    writeStrayMarker(dest);
    writeFileSync(path.join(dest, "local-work.txt"), "precious\n");
    expect(() => syncOneRepo({ ...base(origin, dest), sha: newPin })).toThrow(
      /never stashes or resets/,
    );
    expect(existsSync(markerPath(dest))).toBe(true); // nothing was touched
  });

  it("PINNED: a TRACKED (committed) marker with local modifications is REAL dirt", () => {
    const { origin, seed, dest, newPin } = makeCompanion(work, "pinned-tracked-marker");
    // Commit a marker upstream, sync the checkout to contain it…
    writeFileSync(path.join(seed, PUBLISHED_MARKER_BASENAME), "{}\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-q", "-m", "c3 tracked marker"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
    const trackedPin = git(seed, ["rev-parse", "HEAD"]);
    git(dest, ["fetch", "-q", "origin", "main"]);
    git(dest, ["checkout", "-q", "--detach", trackedPin]);
    // …then MODIFY the tracked marker: that is a tree divergence, not debris.
    writeFileSync(markerPath(dest), `{"oasSha256":"drifted"}\n`);
    expect(() => syncOneRepo({ ...base(origin, dest), sha: newPin })).toThrow(
      /never stashes or resets/,
    );
    expect(existsSync(markerPath(dest))).toBe(true);
  });
});

describe("syncOneRepo — detached companion vs the committed lock (cinatra#1136)", () => {
  let work;
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-1136-repin-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("non-pinned + detached at the OLD pin + lockSha moved → re-pins to the lock (never the tip)", () => {
    const { origin, dest, oldPin, newPin } = makeCompanion(work, "repin");
    writeStrayMarker(dest); // the realistic combined state: old pin + marker debris
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: newPin });
    expect(r).toMatchObject({ action: "repinned", changed: true, pinnedSha: newPin });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(newPin);
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD"); // still detached
    expect(existsSync(markerPath(dest))).toBe(false); // debris cleaned before the move
    expect(oldPin).not.toBe(newPin);
  });

  it("non-pinned + detached AT the lock, clean → leave-as-is + VERIFIED pinnedSha; marker debris cleaned", () => {
    const { origin, dest, oldPin } = makeCompanion(work, "at-lock");
    writeStrayMarker(dest);
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: oldPin });
    expect(r).toMatchObject({ action: "skipped-detached", changed: false, pinnedSha: oldPin });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(markerPath(dest))).toBe(false); // debris cleaned like the pinned at-pin path
  });

  it("non-pinned + detached AT the lock with REAL local edits → skipped-detached WITHOUT pinnedSha", () => {
    // `pinnedSha` asserts the working tree matches the committed pin — local
    // edits at the pin must never be classified as committed-lock content
    // (the local-registry seed packs the WORKING TREE; codex review).
    const { origin, dest, oldPin } = makeCompanion(work, "at-lock-dirty");
    writeFileSync(path.join(dest, "local-edit.txt"), "drift\n");
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: oldPin });
    expect(r).toMatchObject({ action: "skipped-detached", changed: false });
    expect(r.pinnedSha).toBeUndefined();
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(path.join(dest, "local-edit.txt"))).toBe(true); // untouched
  });

  it("non-pinned + detached, NO lockSha resolved → leave-as-is (previous contract intact)", () => {
    const { origin, dest, oldPin } = makeCompanion(work, "no-lock");
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined });
    expect(r).toMatchObject({ action: "skipped-detached", changed: false });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
  });

  it("non-pinned + detached + lock moved + REAL local work → non-fatal skip, HEAD unchanged", () => {
    const { origin, dest, oldPin, newPin } = makeCompanion(work, "repin-dirty");
    writeFileSync(path.join(dest, "local-work.txt"), "precious\n");
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: newPin });
    expect(r).toMatchObject({ action: "skipped-dirty" });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(path.join(dest, "local-work.txt"))).toBe(true);
  });

  it("a malformed lockSha is refused before any git call", () => {
    const { origin, dest } = makeCompanion(work, "bad-lock");
    expect(() =>
      syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: "main" }),
    ).toThrow(/lockSha must be a full lowercase 40-hex commit sha/);
  });

  it("non-pinned + detached + lock moved, but HEAD carries a LOCAL COMMIT no ref reaches → non-fatal skip", () => {
    // `status --porcelain` is clean here — the local work is a COMMIT made
    // while detached, unreachable from any branch/tag/remote ref. Re-pinning
    // would strand it, so the sync must refuse to move (codex review).
    const { origin, dest, newPin } = makeCompanion(work, "repin-local-commit");
    git(dest, ["config", "user.email", "t@t"]);
    git(dest, ["config", "user.name", "t"]);
    git(dest, ["commit", "-q", "--allow-empty", "-m", "local work while detached"]);
    const localTip = git(dest, ["rev-parse", "HEAD"]);
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined, lockSha: newPin });
    expect(r).toMatchObject({ action: "skipped-local-commits" });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(localTip); // nothing moved
  });
});
