// cinatra#4484: the pinned CI sync makes every companion checkout new at depth
// 1, and reads a checkout the cache restored only as a source of objects.
//
// A full pull request run used to make about 3000 serial full branch clones of
// the companion repositories (26 jobs x 116 repositories, no cache). The
// clone-extensions action now restores extensions/ from a cache keyed on the
// two lock files, and the sync runs with `--shallow`:
//   - an absent checkout is `git init` + `git fetch --depth 1 origin <pin>` +
//     a detached checkout of the pin; when origin refuses a fetch by sha, the
//     sync falls back to the full branch clone (an unreachable pin still fails
//     loud there); a crawling network is never retried as a full clone;
//   - an existing checkout (in CI: one the cache restored) is never used as a
//     repository: it is moved aside, the destination is made new the same way,
//     and the pin is fetched at depth 1 over file:// from the moved copy (the
//     receiving git hashes every object itself), else from origin. The moved
//     copy is removed in every case; no git command runs inside it.
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
const PARENT = path.dirname(DEST);
const SOURCE = "/repo/extensions/cinatra-ai/.blog-pipeline-agent.restored";
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
  sourceNotOurRef: `fatal: git upload-pack: not our ref ${PIN}\nfatal: remote error: upload-pack: not our ref ${PIN}\n`,
  locked: "fatal: cannot mkdir .git: Permission denied\n",
  forbidden: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': The requested URL returned error: 403\n",
  noSpace: "error: unable to write file: No space left on device\n",
};

function gitError(args, stderr) {
  return Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${stderr}`), { status: 128, stderr });
}

/**
 * A stateful deps double. `plan` maps a git step to a list of outcomes, one per
 * call: a string is a stderr to fail with, `{ ok }` a success. The steps are the
 * git verbs, except that a fetch over file:// is `fetchSource` and any other
 * fetch is `fetch`. `init` creates the destination; `checkout` moves HEAD (to
 * `landsOn` when set). Every git call records its arguments and its cwd.
 */
function makeDeps({
  existing = false,
  emptyDir = false,
  unreadable = false,
  staleSource = false,
  head = PIN,
  plan = {},
  landsOn,
  failRemoval,
} = {}) {
  const state = {
    exists: new Set(),
    dirEntries: {},
    head,
    hasPin: false,
  };
  if (existing) {
    state.exists.add(DEST);
    state.exists.add(path.join(DEST, ".git"));
    state.dirEntries[DEST] = [".git", "package.json"];
  }
  if (emptyDir) {
    state.exists.add(DEST);
    state.dirEntries[DEST] = [];
  }
  if (unreadable) state.exists.add(DEST);
  if (staleSource) state.exists.add(SOURCE);
  const calls = [];
  const cwds = [];
  const removed = [];
  const renamed = [];
  const sleeps = [];
  const used = {};
  const deps = {
    state,
    calls,
    cwds,
    removed,
    renamed,
    sleeps,
    exists: (p) => state.exists.has(p),
    readdir: (p) => {
      if (!state.exists.has(p)) throw new Error(`ENOENT: ${p}`);
      if (unreadable && p === DEST) throw new Error(`EACCES: ${p}`);
      return [...(state.dirEntries[p] ?? [])];
    },
    mkdirp: () => {},
    unlink: () => {},
    removeTree: (p) => {
      removed.push(p);
      if (failRemoval === p) throw new Error(`EBUSY: ${p}`);
      for (const q of [...state.exists]) if (q === p || q.startsWith(`${p}/`)) state.exists.delete(q);
      delete state.dirEntries[p];
    },
    rename: (from, to) => {
      renamed.push([from, to]);
      for (const q of [...state.exists]) {
        if (q === from || q.startsWith(`${from}/`)) {
          state.exists.delete(q);
          state.exists.add(to + q.slice(from.length));
        }
      }
      state.dirEntries[to] = state.dirEntries[from];
      delete state.dirEntries[from];
    },
    sleep: (ms) => sleeps.push(ms),
    git: (args, cwd) => {
      calls.push(args.join(" "));
      cwds.push(cwd);
      const verb = args[0];
      const step = verb === "fetch" && args.some((a) => a.startsWith("file://")) ? "fetchSource" : verb;
      const outcomes = plan[step];
      if (outcomes) {
        const i = used[step] ?? 0;
        used[step] = i + 1;
        const outcome = outcomes[Math.min(i, outcomes.length - 1)];
        if (typeof outcome === "string") throw gitError(args, outcome);
      }
      if (verb === "init" || verb === "clone") {
        state.exists.add(DEST);
        state.exists.add(path.join(DEST, ".git"));
        state.dirEntries[DEST] = [".git"];
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
      if (verb === "checkout") {
        state.head = landsOn ?? args[args.length - 1];
        return "";
      }
      if (verb === "rev-parse" && args[1] === "HEAD") return `${state.head}\n`;
      if (verb === "rev-parse" && args[1] === "--abbrev-ref") return "HEAD\n";
      if (verb === "remote" && args[1] === "get-url") return `${URL}\n`;
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
const ORIGIN_FETCH = `fetch --quiet --depth 1 --no-tags origin ${PIN}`;
const SOURCE_FETCH = `fetch --quiet --depth 1 --no-tags file://${SOURCE} ${PIN}`;
const MADE_NEW = [`init --quiet -- ${DEST}`, `remote add origin ${URL}`];
const CHECKED_OUT = [`checkout --quiet --detach ${PIN}`, "rev-parse HEAD"];
const CLONED = { pkgName: PKG, action: "cloned", changed: true, pinnedSha: PIN };

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
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.calls).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
    expect(deps.cwds).toEqual([PARENT, DEST, DEST, DEST, DEST]);
    expect(deps.removed).toEqual([]);
    expect(lines).toEqual([`  ${PKG}: fetching ${URL} at ${PIN.slice(0, 12)} at depth 1 -> ${DEST}`]);
  });

  it("retries a transient failure of the depth-1 fetch, still without a clone", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.reset, { ok: "" }] } });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.calls.filter((c) => c === ORIGIN_FETCH)).toHaveLength(2);
    expect(deps.sleeps).toEqual([2000]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("gives up after three transient failures, removes what it made and never falls back to the full clone", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.resolve, STDERR.tooSlow, STDERR.timedOut] } });
    const { thrown } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.timedOut);
    expect(deps.calls.filter((c) => c === ORIGIN_FETCH)).toHaveLength(3);
    expect(starts(deps.calls, "clone")).toEqual([]);
    expect(starts(deps.calls, "checkout")).toEqual([]);
    expect(deps.removed).toEqual([DEST]);
    expect(deps.state.exists.has(DEST)).toBe(false);
  });

  it("falls back to the full branch clone when origin refuses a fetch by sha, after removing what it made", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.unadvertised, { ok: "" }] } });
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.removed).toEqual([DEST]);
    const cloneAt = deps.calls.indexOf(`clone --branch main --single-branch -- ${URL} ${DEST}`);
    expect(cloneAt).toBeGreaterThan(deps.calls.indexOf(ORIGIN_FETCH));
    // The full road's own pin fetch and detached checkout follow the clone.
    expect(deps.calls.slice(cloneAt)).toEqual([
      `clone --branch main --single-branch -- ${URL} ${DEST}`,
      `cat-file -e ${PIN}^{commit}`,
      `fetch origin ${PIN}`,
      `checkout --detach ${PIN}`,
      "rev-parse HEAD",
    ]);
    expect(lines.filter((l) => /falling back to the full clone/.test(l))).toEqual([
      `  ${PKG}: origin did not serve ${PIN.slice(0, 12)} at depth 1 (error: Server does not allow request for unadvertised object ${PIN}); falling back to the full clone.`,
    ]);
  });

  it("an unreachable pin still fails loud on the full road after the fallback", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.notOurRef] } });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/not our ref/);
    expect(starts(deps.calls, "clone")).toHaveLength(1);
    expect(starts(deps.calls, "checkout")).toEqual([]);
  });

  it("a HEAD that does not land on the pin throws, with the new checkout removed", () => {
    const deps = makeDeps({ landsOn: OTHER });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/verification failed — HEAD is fedcba987654/);
    expect(deps.removed).toEqual([DEST]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("a failing init throws (no fallback), with what it made removed", () => {
    const deps = makeDeps({ plan: { init: [STDERR.locked] } });
    const { thrown } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.locked);
    expect(deps.calls).toEqual([MADE_NEW[0]]);
    expect(deps.removed).toEqual([DEST]);
  });

  it("an empty destination directory is removed and made new", () => {
    const deps = makeDeps({ emptyDir: true });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.renamed).toEqual([]);
    expect(deps.calls).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
  });

  it("a failing remote add, or a failing checkout, throws with the new checkout removed and no fallback", () => {
    for (const plan of [{ remote: [STDERR.locked] }, { checkout: [STDERR.noSpace] }]) {
      const deps = makeDeps({ plan });
      const { thrown } = run(deps);
      expect(thrown?.stderr).toBe(Object.values(plan)[0][0]);
      expect(deps.removed).toEqual([DEST]);
      expect(starts(deps.calls, "clone")).toEqual([]);
    }
  });

  it("an HTTP 403 on the depth-1 fetch takes the fallback, where the same refusal fails loud", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.forbidden], clone: [STDERR.forbidden] } });
    const { thrown, lines } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.forbidden);
    expect(deps.calls.filter((c) => c === ORIGIN_FETCH)).toHaveLength(1);
    expect(starts(deps.calls, "clone")).toHaveLength(1);
    expect(lines.some((l) => /falling back to the full clone/.test(l))).toBe(true);
  });

  it("a removal that fails after a refused fetch throws the git failure and does not fall back", () => {
    const deps = makeDeps({ plan: { fetch: [STDERR.unadvertised] }, failRemoval: DEST });
    const { thrown, lines } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.unadvertised);
    expect(starts(deps.calls, "clone")).toEqual([]);
    expect(lines.some((l) => /could not remove/.test(l))).toBe(true);
  });

  it("a moved copy left by an interrupted run is removed even when the destination is absent", () => {
    const deps = makeDeps({ staleSource: true });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.removed).toEqual([SOURCE]);
    expect(deps.renamed).toEqual([]);
    expect(deps.calls).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
  });

  it("refuses --shallow without a pinned sha, before any git call", () => {
    const deps = makeDeps();
    const { thrown } = run(deps, { sha: undefined });
    expect(String(thrown?.message)).toMatch(/shallow sync requires a pinned sha/);
    expect(deps.calls).toEqual([]);
  });

  it("refuses a remote URL with credentials, before any git call, and never prints them", () => {
    for (const url of [
      "https://x-access-token:secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "https://secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "ssh://git:secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
    ]) {
      const deps = makeDeps();
      const { thrown } = run(deps, { url });
      expect(String(thrown?.message)).toMatch(/carries credentials|refusing a git remote/);
      expect(String(thrown?.message)).not.toMatch(/secret123|x-access-token/);
      expect(deps.calls).toEqual([]);
      expect(deps.state.exists.size).toBe(0);
    }
  });

  it("lets the plain ssh://git@github.com form through (a user name, no credential)", () => {
    const deps = makeDeps();
    const { result, thrown } = run(deps, { url: "ssh://git@github.com/cinatra-ai/blog-pipeline-agent.git" });
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
  });
});

describe("syncOneRepo --shallow — an existing (cache-restored) checkout is only a source of objects", () => {
  it("moves it aside, makes the destination new, fetches the pin from it over file:// and removes it", () => {
    const deps = makeDeps({ existing: true });
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.renamed).toEqual([[DEST, SOURCE]]);
    // Nothing runs before the new repository exists, and nothing runs inside the moved copy.
    expect(deps.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ...CHECKED_OUT]);
    expect(deps.cwds).toEqual([PARENT, DEST, DEST, DEST, DEST]);
    expect(deps.removed).toEqual([SOURCE]);
    expect(deps.state.exists.has(SOURCE)).toBe(false);
    expect(lines).toEqual([
      `  ${PKG}: rebuilding ${DEST} at ${PIN.slice(0, 12)} at depth 1; the existing checkout is read only as a source of objects.`,
    ]);
  });

  it("fetches from origin at depth 1 when the moved copy does not serve the pin, and removes the copy", () => {
    const deps = makeDeps({ existing: true, head: OTHER, plan: { fetchSource: [STDERR.sourceNotOurRef] } });
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ORIGIN_FETCH, ...CHECKED_OUT]);
    // A failed local fetch is never retried as a network failure.
    expect(deps.sleeps).toEqual([]);
    expect(deps.removed).toEqual([SOURCE]);
    expect(lines).toContain(
      `  ${PKG}: the existing checkout does not serve ${PIN.slice(0, 12)} (fatal: remote error: upload-pack: not our ref ${PIN}); fetching it from origin at depth 1.`,
    );
  });

  it("a transient origin failure after a moved copy that does not serve: both are removed and the failure is thrown", () => {
    const deps = makeDeps({
      existing: true,
      plan: { fetchSource: [STDERR.sourceNotOurRef], fetch: [STDERR.reset, STDERR.reset, STDERR.reset] },
    });
    const { thrown } = run(deps);
    expect(thrown?.stderr).toBe(STDERR.reset);
    expect(deps.removed).toEqual([DEST, SOURCE]);
    expect(deps.state.exists.size).toBe(0);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("a refused origin fetch after a moved copy that does not serve: both are removed, then the full clone", () => {
    const deps = makeDeps({
      existing: true,
      plan: { fetchSource: [STDERR.sourceNotOurRef], fetch: [STDERR.unadvertised, { ok: "" }] },
    });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.removed).toEqual([DEST, SOURCE]);
    expect(starts(deps.calls, "clone")).toHaveLength(1);
  });

  it("a HEAD that does not land on the pin: the new checkout and the moved copy are removed", () => {
    const deps = makeDeps({ existing: true, landsOn: OTHER });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/verification failed/);
    expect(deps.removed).toEqual([DEST, SOURCE]);
    expect(deps.state.exists.size).toBe(0);
  });

  it("an existing destination that cannot be read is moved aside like any checkout, never taken for empty", () => {
    const deps = makeDeps({ unreadable: true });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.renamed).toEqual([[DEST, SOURCE]]);
    expect(deps.removed).toEqual([SOURCE]);
  });

  it("a source fetch that fails for a local reason (no space) is never fatal: origin serves the pin", () => {
    const deps = makeDeps({ existing: true, plan: { fetchSource: [STDERR.noSpace] } });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ORIGIN_FETCH, ...CHECKED_OUT]);
  });

  it("a removal that fails after a failure still tries the other removal and throws the git failure", () => {
    const deps = makeDeps({ existing: true, landsOn: OTHER, failRemoval: DEST });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/verification failed/);
    expect(deps.removed).toEqual([DEST, SOURCE]);
  });

  it("a moved copy left by an interrupted earlier run is removed first", () => {
    const deps = makeDeps({ existing: true, staleSource: true });
    const { result, thrown } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.removed).toEqual([SOURCE, SOURCE]);
    expect(deps.renamed).toEqual([[DEST, SOURCE]]);
  });

  it("without --shallow the pinned at-pin path is unchanged: nothing is moved or made new", () => {
    const deps = makeDeps({ existing: true, head: PIN });
    const { result, thrown } = run(deps, { shallow: undefined });
    expect(thrown).toBeNull();
    expect(result).toEqual({ pkgName: PKG, action: "pinned", changed: false, pinnedSha: PIN });
    expect(deps.renamed).toEqual([]);
    expect(starts(deps.calls, "init")).toEqual([]);
    expect(deps.removed).toEqual([]);
  });
});

describe("shallowSourceDirFor", () => {
  it("is a dot-name beside the destination, outside every extensions/*/* glob", () => {
    expect(repoSync.shallowSourceDirFor(DEST)).toBe(SOURCE);
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
  return { origin, url: `file://${origin}`, oldPin, tipPin };
}

function realSync(url, sha, dest, log = () => {}) {
  return syncOneRepo({
    pkgName: "@cinatra-ai/fixture",
    url,
    branch: "main",
    sha,
    shallow: true,
    dest,
    force: false,
    deps: { ...defaultRepoSyncDeps(), sleep: () => {} },
    log,
  });
}

// The pinned tree, read from the checkout's own index and files.
const trackedFiles = (dest) => g(dest, ["ls-files"]).split("\n").sort();

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

  it("a restored checkout with a modified file the index vouches for, and ignored leftovers, is rebuilt from it alone", () => {
    const { origin, url, oldPin } = makeOrigin();
    const dest = path.join(work, "tampered-file", "fixture");
    realSync(url, oldPin, dest);
    const file = path.join(dest, "src", "a.txt");
    const { mtime } = statSync(file);
    // Same size, same mtime: only the content says it changed.
    writeFileSync(file, "ONE\n");
    utimesSync(file, mtime, mtime);
    g(dest, ["update-index", "--assume-unchanged", "src/a.txt"]);
    expect(g(dest, ["status", "--porcelain"])).toBe("");
    mkdirSync(path.join(dest, "node_modules", "x"), { recursive: true });
    // Origin is gone: only the restored checkout can serve the pin.
    renameSync(origin, `${origin}.gone`);
    try {
      const lines = [];
      const r = realSync(url, oldPin, dest, (m) => lines.push(m));
      expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
      expect(lines.some((l) => /does not serve/.test(l))).toBe(false);
    } finally {
      renameSync(`${origin}.gone`, origin);
    }
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(readFileSync(file, "utf8")).toBe("one\n");
    expect(existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(g(dest, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).toBe("");
    expect(g(dest, ["ls-files", "-v"]).split("\n").every((l) => l.startsWith("H "))).toBe(true);
    expect(existsSync(repoSync.shallowSourceDirFor(dest))).toBe(false);
  });

  it("a restored checkout with a forged object does not serve the pin: it is rebuilt from origin", () => {
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
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /does not serve/.test(l))).toBe(true);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
    expect(g(dest, ["fsck", "--no-dangling", "--no-progress"])).toBe("");
  });

  it("a restored checkout with a replace ref and a planted file still yields exactly the pinned tree", () => {
    const { url, oldPin, tipPin } = makeOrigin();
    const dest = path.join(work, "replace-ref", "fixture");
    realSync(url, oldPin, dest);
    g(dest, ["fetch", "-q", "--depth", "1", "origin", tipPin]);
    g(dest, ["replace", oldPin, tipPin]);
    writeFileSync(path.join(dest, "planted.js"), "evil\n");
    const r = realSync(url, oldPin, dest);
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(path.join(dest, "planted.js"))).toBe(false);
    expect(existsSync(path.join(dest, ".git", "refs", "replace"))).toBe(false);
    expect(trackedFiles(dest)).toEqual([".gitignore", "package.json", "src/a.txt"]);
  });

  it("no hook, fsmonitor or upload-pack hook of a restored checkout ever runs", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "planted-config", "fixture");
    realSync(url, oldPin, dest);
    const marker = path.join(work, `ran-${counter}`);
    const script = path.join(work, `planted-${counter}.sh`);
    writeFileSync(script, `#!/bin/sh\necho "$0" >> "${marker}"\n`);
    chmodSync(script, 0o755);
    const hooks = path.join(work, `hooks-${counter}`);
    mkdirSync(hooks);
    for (const h of ["pre-upload-pack", "post-checkout", "reference-transaction", "post-index-change"]) {
      writeFileSync(path.join(hooks, h), readFileSync(script));
      chmodSync(path.join(hooks, h), 0o755);
      writeFileSync(path.join(dest, ".git", "hooks", h), readFileSync(script));
      chmodSync(path.join(dest, ".git", "hooks", h), 0o755);
    }
    g(dest, ["config", "core.fsmonitor", script]);
    g(dest, ["config", "core.hooksPath", hooks]);
    g(dest, ["config", "uploadpack.packObjectsHook", script]);
    const r = realSync(url, oldPin, dest);
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(existsSync(marker)).toBe(false);
    // The new checkout's config is git's own, none of the planted keys.
    expect(readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toMatch(/fsmonitor|hookspath|packobjectshook/i);
  });

  it("a restored checkout at another commit is rebuilt at the pin, fetched from origin", () => {
    const { url, oldPin, tipPin } = makeOrigin();
    const dest = path.join(work, "stale-head", "fixture");
    realSync(url, tipPin, dest);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("two\n");
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /does not serve/.test(l))).toBe(true);
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
  });
});
