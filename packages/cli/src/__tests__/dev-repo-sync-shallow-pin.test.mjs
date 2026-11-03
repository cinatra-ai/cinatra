// cinatra#4484: the pinned CI sync fetches each companion at depth 1 and
// verifies every checkout a cache restored before it is used.
//
// A full pull request run used to make about 3000 serial full branch clones of
// the companion repositories (26 jobs x 116 repositories, no cache). The
// clone-extensions action now restores extensions/ from a cache keyed on the
// two lock files, and the sync runs with `--shallow`:
//   - an absent checkout is `git init` + `git fetch --depth 1 origin <pin>` +
//     a detached checkout of the pin; when the server refuses a fetch by sha,
//     the sync falls back to the full branch clone (an unreachable pin still
//     fails loud there); a crawling network is never retried as a full clone;
//   - an existing checkout (in CI: one the cache restored) must pass `git fsck`
//     (a forged object fails), must sit at the pin or be re-pinned to it, and
//     then has its index dropped and its tree rewritten from the pin and
//     cleaned, so a modified, added or ignored file never survives.
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

// A namespace import: on a module without the shallow road each case fails on
// its own instead of the whole file failing to load.
import * as repoSync from "../dev-repo-sync.mjs";

const { syncOneRepo, defaultRepoSyncDeps } = repoSync;

const DEST = "/repo/extensions/cinatra-ai/blog-pipeline-agent";
const URL = "https://github.com/cinatra-ai/blog-pipeline-agent.git";
const PIN = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const STDERR = {
  reset: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Recv failure: Connection reset by peer\n",
  resolve: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Could not resolve host: github.com\n",
  timedOut: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Connection timed out after 300000 milliseconds\n",
  tooSlow: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds\n",
  unadvertised: `error: Server does not allow request for unadvertised object ${PIN}\n`,
  notOurRef: `fatal: remote error: upload-pack: not our ref ${PIN}\n`,
  forged: "error: 3d45ed433c9455e95c2885170a83e535ee013e64: hash-path mismatch, found at: .git/objects/56/26abf0f72e58d7a153368ba57db4c673c0e171\n",
};

function gitError(args, stderr) {
  return Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${stderr}`), { status: 128, stderr });
}

/**
 * A stateful deps double. `plan` maps a git verb to a list of outcomes, one per
 * call: a string is a stderr to fail with, `{ ok }` a success. `init` creates
 * the destination; `checkout`/`reset` move HEAD (to `landsOn` when set).
 */
function makeDeps({
  existing = false,
  head = PIN,
  hasPin = false,
  plan = {},
  status = "",
  afterRewriteStatus = "",
  landsOn,
} = {}) {
  const state = {
    exists: new Set(existing ? [DEST, path.join(DEST, ".git")] : []),
    dirEntries: existing ? { [DEST]: [".git", "package.json"] } : {},
    head,
    hasPin,
    rewritten: false,
  };
  const calls = [];
  const removed = [];
  const unlinked = [];
  const sleeps = [];
  const used = {};
  const deps = {
    state,
    calls,
    removed,
    unlinked,
    sleeps,
    exists: (p) => state.exists.has(p),
    readdir: (p) => {
      if (!state.exists.has(p)) throw new Error(`ENOENT: ${p}`);
      return [...(state.dirEntries[p] ?? [])];
    },
    mkdirp: () => {},
    unlink: (p) => unlinked.push(p),
    removeTree: (p) => {
      removed.push(p);
      state.exists.delete(p);
      state.exists.delete(path.join(p, ".git"));
      delete state.dirEntries[p];
    },
    sleep: (ms) => sleeps.push(ms),
    git: (args) => {
      calls.push(args.join(" "));
      const verb = args[0];
      const outcomes = plan[verb];
      if (outcomes) {
        const i = used[verb] ?? 0;
        used[verb] = i + 1;
        const outcome = outcomes[Math.min(i, outcomes.length - 1)];
        if (typeof outcome === "string") throw gitError(args, outcome);
      }
      if (verb === "init") {
        state.exists.add(DEST);
        state.exists.add(path.join(DEST, ".git"));
        state.dirEntries[DEST] = [".git"];
        return "";
      }
      if (verb === "clone") {
        state.exists.add(DEST);
        state.exists.add(path.join(DEST, ".git"));
        return "";
      }
      if (verb === "fetch") {
        state.hasPin = true;
        return "";
      }
      if (verb === "cat-file") {
        if (state.hasPin) return "";
        throw gitError(args, `fatal: Not a valid object name ${PIN}^{commit}\n`);
      }
      if (verb === "checkout" || verb === "reset") {
        state.head = landsOn ?? args[args.length - 1];
        if (verb === "reset") state.rewritten = true;
        return "";
      }
      if (verb === "rev-parse" && args[1] === "HEAD") return `${state.head}\n`;
      if (verb === "rev-parse" && args[1] === "--abbrev-ref") return "HEAD\n";
      if (verb === "remote" && args[1] === "get-url") return `${URL}\n`;
      if (verb === "status") return state.rewritten ? afterRewriteStatus : status;
      return "";
    },
  };
  return deps;
}

const PKG = "@cinatra-ai/blog-pipeline-agent";

function run(deps, extra = {}) {
  const lines = [];
  let result = null;
  let thrown = null;
  try {
    result = syncOneRepo({
      pkgName: PKG,
      url: URL,
      branch: "main",
      sha: PIN,
      shallow: true,
      dest: DEST,
      force: false,
      deps,
      log: (m) => lines.push(m),
      ...extra,
    });
  } catch (err) {
    thrown = err;
  }
  return { result, thrown, lines };
}

const starts = (calls, prefix) => calls.filter((c) => c.startsWith(prefix));
const SHALLOW_FETCH = `fetch --depth 1 --no-tags origin ${PIN}`;

describe("transientGitNetworkReason — a transfer under the low-speed limit is transient", () => {
  it("names 'transfer too slow' for curl's 'Operation too slow'", () => {
    expect(repoSync.transientGitNetworkReason(gitError(["fetch", "origin", PIN], STDERR.tooSlow))).toBe(
      "transfer too slow",
    );
  });
});

describe("syncOneRepo --shallow — an absent checkout fetches the pin at depth 1", () => {
  it("initialises, fetches the pin at depth 1 and detaches at it — no clone", () => {
    const deps = makeDeps();
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual({ pkgName: PKG, action: "cloned", changed: true, pinnedSha: PIN });
    expect(deps.calls).toEqual([
      `init --quiet -- ${DEST}`,
      `remote add origin ${URL}`,
      SHALLOW_FETCH,
      `cat-file -e ${PIN}^{commit}`,
      `checkout --detach ${PIN}`,
      "rev-parse HEAD",
    ]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("retries a transient failure of the depth-1 fetch, still without a clone", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.reset, { ok: "" }] } });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result.action).toBe("cloned");
    expect(deps.calls.filter((c) => c === SHALLOW_FETCH)).toHaveLength(2);
    expect(deps.sleeps).toEqual([2000]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("gives up after three transient failures and never falls back to the full clone", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.resolve, STDERR.tooSlow, STDERR.timedOut] } });
    const { thrown } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.timedOut);
    expect(deps.calls.filter((c) => c === SHALLOW_FETCH)).toHaveLength(3);
    expect(starts(deps.calls, "clone")).toEqual([]);
    expect(starts(deps.calls, "checkout")).toEqual([]);
    // The initialised repository is not left half made.
    expect(deps.removed).toEqual([DEST]);
  });

  it("falls back to the full branch clone when the server refuses a fetch by sha, after removing what it made", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.unadvertised, { ok: "" }] } });
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual({ pkgName: PKG, action: "cloned", changed: true, pinnedSha: PIN });
    expect(deps.removed).toEqual([DEST]);
    const cloneAt = deps.calls.indexOf(`clone --branch main --single-branch -- ${URL} ${DEST}`);
    expect(cloneAt).toBeGreaterThan(deps.calls.indexOf(SHALLOW_FETCH));
    expect(deps.calls.slice(cloneAt)).toContain(`checkout --detach ${PIN}`);
    expect(lines.some((l) => /falling back to the full clone/.test(l))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/ghp_|token/i);
  });

  it("an unreachable pin still fails loud on the full road after the fallback", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.notOurRef] } });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/not our ref/);
    expect(starts(deps.calls, "clone")).toHaveLength(1);
    expect(starts(deps.calls, "checkout")).toEqual([]);
  });

  it("refuses --shallow without a pinned sha, before any git call", () => {
    const deps = makeDeps();
    const { thrown } = run(deps, { sha: undefined });
    expect(String(thrown?.message)).toMatch(/shallow sync requires a pinned sha/);
    expect(deps.calls).toEqual([]);
  });
});

describe("syncOneRepo --shallow — an existing (cache-restored) checkout is verified before use", () => {
  it("at the pin: git fsck, then the index is dropped and the tree rewritten from the pin and cleaned", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual({ pkgName: PKG, action: "pinned", changed: false, pinnedSha: PIN });
    const fsck = deps.calls.indexOf("fsck --no-dangling --no-progress");
    const reset = deps.calls.indexOf(`reset --quiet --hard ${PIN}`);
    const clean = deps.calls.indexOf("clean -f -f -d -x -q");
    expect(fsck).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(fsck);
    expect(clean).toBeGreaterThan(reset);
    expect(deps.unlinked).toContain(path.join(DEST, ".git", "index"));
    expect(deps.calls.slice(clean)).toContain("rev-parse HEAD");
    expect(deps.calls.slice(clean)).toContain("status --porcelain --untracked-files=all --ignored");
    expect(starts(deps.calls, "fetch")).toEqual([]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("a forged object fails git fsck: the sync throws and never checks out, resets or cleans", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true, plan: { fsck: [STDERR.forged] } });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/fails git fsck/);
    expect(String(thrown?.message)).toMatch(/hash-path mismatch/);
    expect(starts(deps.calls, "checkout")).toEqual([]);
    expect(starts(deps.calls, "reset")).toEqual([]);
    expect(starts(deps.calls, "clean")).toEqual([]);
  });

  it("at another commit: re-pinned at depth 1, then rewritten from the pin", () => {
    const deps = makeDeps({ existing: true, head: OTHER, hasPin: false });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual({ pkgName: PKG, action: "repinned", changed: true, pinnedSha: PIN });
    expect(deps.calls).toContain(SHALLOW_FETCH);
    expect(deps.calls.indexOf(`reset --quiet --hard ${PIN}`)).toBeGreaterThan(
      deps.calls.indexOf(`checkout --detach ${PIN}`),
    );
    expect(deps.calls).toContain("clean -f -f -d -x -q");
  });

  it("a HEAD that does not land on the pin after the rewrite throws", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true, landsOn: OTHER });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/verification failed/);
  });

  it("a path left behind after the rewrite throws", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true, afterRewriteStatus: "!! node_modules/\n" });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/still differs from the pinned commit/);
  });

  it("a dirty restored checkout still fails closed before any rewrite", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true, status: " M src/index.ts\n" });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/never stashes or resets/);
    expect(starts(deps.calls, "reset")).toEqual([]);
  });

  it("without --shallow the pinned at-pin path is unchanged: no fsck, no rewrite", () => {
    const deps = makeDeps({ existing: true, head: PIN, hasPin: true });
    const { result, thrown } = run(deps, { shallow: undefined });
    expect(thrown).toBeNull();
    expect(result.action).toBe("pinned");
    expect(starts(deps.calls, "fsck")).toEqual([]);
    expect(starts(deps.calls, "reset")).toEqual([]);
    expect(starts(deps.calls, "clean")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same roads on real git, against a local file:// origin.
// ---------------------------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), "dev-repo-sync-shallow-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const g = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

let counter = 0;
function makeOrigin() {
  counter += 1;
  const origin = path.join(work, `origin-${counter}.git`);
  const seed = path.join(work, `seed-${counter}`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
  g(seed, ["config", "user.email", "t@t"]);
  g(seed, ["config", "user.name", "t"]);
  g(seed, ["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(seed, "package.json"), `{"name":"@cinatra-ai/fixture-${counter}"}\n`);
  mkdirSync(path.join(seed, "src"));
  writeFileSync(path.join(seed, "src", "a.txt"), "one\n");
  g(seed, ["add", "."]);
  g(seed, ["commit", "-q", "-m", "c1"]);
  const oldPin = g(seed, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(seed, "src", "a.txt"), "two\n");
  g(seed, ["commit", "-q", "-am", "c2"]);
  g(seed, ["push", "-q", "origin", "HEAD:main"]);
  const tipPin = g(seed, ["rev-parse", "HEAD"]);
  return { url: `file://${origin}`, oldPin, tipPin };
}

function realSync(url, sha, dest) {
  return syncOneRepo({
    pkgName: "@cinatra-ai/fixture",
    url,
    branch: "main",
    sha,
    shallow: true,
    dest,
    force: false,
    deps: { ...defaultRepoSyncDeps(), sleep: () => {} },
    log: () => {},
  });
}

describe("syncOneRepo --shallow on real git", () => {
  it("fetches a pin below the branch tip at depth 1 and detaches at it", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "fresh", "fixture");
    const r = realSync(url, oldPin, dest);
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(path.join(dest, ".git", "shallow"))).toBe(true);
    expect(g(dest, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
  });

  it("a restored checkout with a modified file the index vouches for, and ignored leftovers, is rewritten to exactly the pin", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "tampered-file", "fixture");
    realSync(url, oldPin, dest);
    const file = path.join(dest, "src", "a.txt");
    const { mtime } = statSync(file);
    // Same size, same mtime: only the content says it changed.
    writeFileSync(file, "ONE\n");
    utimesSync(file, mtime, mtime);
    // The index is made to vouch for the modified file, so `git status` reads it clean.
    g(dest, ["update-index", "--assume-unchanged", "src/a.txt"]);
    expect(g(dest, ["status", "--porcelain"])).toBe("");
    // An ignored directory is not dirt for `git status`, but it is not the pinned tree either.
    mkdirSync(path.join(dest, "node_modules", "x"), { recursive: true });
    const r = realSync(url, oldPin, dest);
    expect(r).toMatchObject({ action: "pinned", pinnedSha: oldPin });
    expect(readFileSync(file, "utf8")).toBe("one\n");
    expect(existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(g(dest, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).toBe("");
  });

  it("a restored checkout with a forged object is refused by git fsck", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "forged-object", "fixture");
    realSync(url, oldPin, dest);
    // Make every object a loose file: a small fetch is already stored loose
    // (fetch.unpackLimit); a fetched pack is moved out and unpacked.
    const packDir = path.join(dest, ".git", "objects", "pack");
    const aside = path.join(work, `aside-${counter}`);
    mkdirSync(aside);
    for (const name of existsSync(packDir) ? readdirSync(packDir) : []) {
      renameSync(path.join(packDir, name), path.join(aside, name));
    }
    for (const pack of readdirSync(aside).filter((n) => n.endsWith(".pack"))) {
      execFileSync("git", ["-C", dest, "unpack-objects", "-q"], { input: readFileSync(path.join(aside, pack)) });
    }
    // Forge the blob of src/a.txt: the file keeps its name, the content changes.
    const blob = g(dest, ["rev-parse", `${oldPin}:src/a.txt`]);
    const objectPath = path.join(dest, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, deflateSync(Buffer.from("blob 4\0EVIL")));
    expect(() => realSync(url, oldPin, dest)).toThrow(/fails git fsck/);
  });

  it("a restored checkout at another commit is re-pinned to the pin", () => {
    const { url, oldPin, tipPin } = makeOrigin();
    const dest = path.join(work, "stale-head", "fixture");
    realSync(url, tipPin, dest);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("two\n");
    const r = realSync(url, oldPin, dest);
    expect(r).toMatchObject({ action: "repinned", pinnedSha: oldPin });
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
  });
});
