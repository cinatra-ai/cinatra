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
//   - an existing checkout (in CI: one the cache restored) is never the cwd
//     or git dir of a git call of the sync: it is moved aside, the
//     destination is made new the same way, and, when the moved copy is a
//     plain repository directory, the pin is fetched at depth 1 over file://
//     from it (the upload-pack that fetch starts reads its config, refs and
//     objects; the receiving git hashes every object itself), else from
//     origin. The moved copy is removed after a success and after a failure.
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
  symlinkSync,
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
  failRename = false,
  failMkdirp = false,
  gitShape,
} = {}) {
  const state = {
    exists: new Set(),
    dirEntries: {},
    // What lstat reads for a path: "dir", "file", "link", "fifo" (a special file) or "eacces"; a path not here is absent.
    types: {},
    // The text readFile returns for a path; a path not here cannot be read.
    files: {},
    // Directories whose listing fails (EACCES).
    unlistable: new Set(),
    head,
    hasPin: false,
  };
  if (existing) {
    state.exists.add(DEST);
    state.exists.add(path.join(DEST, ".git"));
    state.dirEntries[DEST] = [".git", "package.json"];
    state.types[DEST] = "dir";
    state.types[path.join(DEST, ".git")] = "dir";
    state.types[path.join(DEST, ".git", "objects")] = "dir";
    gitShape?.(state.types, path.join(DEST, ".git"), state);
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
    lstat: (p) => {
      const t = state.types[p];
      if (!t) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      if (t === "eacces") throw Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" });
      return { isDirectory: () => t === "dir", isSymbolicLink: () => t === "link", isFile: () => t === "file" };
    },
    readdir: (p) => {
      if (state.unlistable.has(p)) throw Object.assign(new Error(`EACCES: ${p}`), { code: "EACCES" });
      if (!state.exists.has(p) && !(p in state.dirEntries) && state.types[p] !== "dir") throw new Error(`ENOENT: ${p}`);
      if (unreadable && p === DEST) throw new Error(`EACCES: ${p}`);
      return [...(state.dirEntries[p] ?? [])];
    },
    readFile: (p) => {
      if (p in state.files) return state.files[p];
      throw Object.assign(new Error(`${state.types[p] ? "EACCES" : "ENOENT"}: ${p}`), { code: state.types[p] ? "EACCES" : "ENOENT" });
    },
    mkdirp: (p) => {
      if (failMkdirp) throw new Error(`EACCES: ${p}`);
    },
    unlink: () => {},
    removeTree: (p) => {
      removed.push(p);
      if (failRemoval === p) throw new Error(`EBUSY: ${p}`);
      for (const q of [...state.exists]) if (q === p || q.startsWith(`${p}/`)) state.exists.delete(q);
      for (const q of Object.keys(state.types)) if (q === p || q.startsWith(`${p}/`)) delete state.types[q];
      for (const m of [state.dirEntries, state.files]) for (const q of Object.keys(m)) if (q === p || q.startsWith(`${p}/`)) delete m[q];
    },
    rename: (from, to) => {
      renamed.push([from, to]);
      if (failRename) throw new Error(`EXDEV: ${from}`);
      for (const q of [...state.exists]) {
        if (q === from || q.startsWith(`${from}/`)) {
          state.exists.delete(q);
          state.exists.add(to + q.slice(from.length));
        }
      }
      for (const q of Object.keys(state.types)) {
        if (q === from || q.startsWith(`${from}/`)) {
          state.types[to + q.slice(from.length)] = state.types[q];
          delete state.types[q];
        }
      }
      for (const m of [state.dirEntries, state.files]) {
        for (const q of Object.keys(m)) {
          if (q === from || q.startsWith(`${from}/`)) {
            m[to + q.slice(from.length)] = m[q];
            delete m[q];
          }
        }
      }
      for (const q of [...state.unlistable]) {
        if (q === from || q.startsWith(`${from}/`)) {
          state.unlistable.delete(q);
          state.unlistable.add(to + q.slice(from.length));
        }
      }
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

  it("refuses a remote URL with a query, a fragment or user info in any case, before any git call, and never prints it", () => {
    for (const url of [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git?access_token=secret123",
      "https://github.com/cinatra-ai/blog-pipeline-agent.git#secret123",
      "HTTPS://secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "ssh://deploy:secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "file:///srv/mirror/blog-pipeline-agent.git?secret123",
    ]) {
      const deps = makeDeps();
      const { thrown, lines } = run(deps, { url });
      expect(String(thrown?.message), url).toMatch(/carries credentials, a query or a fragment|refusing a git remote/);
      expect(String(thrown?.message), url).not.toMatch(/secret123/);
      expect(lines.join("\n"), url).not.toMatch(/secret123/);
      expect(deps.calls, url).toEqual([]);
      expect(deps.state.exists.size, url).toBe(0);
    }
  });

  it("lets the plain forms through: https and ssh://git@ to github.com, git@github.com:, file:// and an absolute path", () => {
    for (const url of [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git",
      "ssh://git@github.com/cinatra-ai/blog-pipeline-agent.git",
      "git@github.com:cinatra-ai/blog-pipeline-agent.git",
      "file:///srv/mirror/blog-pipeline-agent.git",
      "/srv/mirror/blog-pipeline-agent.git",
    ]) {
      const deps = makeDeps();
      const { result, thrown } = run(deps, { url });
      expect(thrown, url).toBeNull();
      expect(result, url).toEqual(CLONED);
    }
  });

  it("refuses whitespace or a control character anywhere in a plain form, before any git call, and never prints the URL", () => {
    const plain = [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git",
      "ssh://git@github.com/cinatra-ai/blog-pipeline-agent.git",
      "git@github.com:cinatra-ai/blog-pipeline-agent.git",
      "file:///srv/mirror/blog-pipeline-agent.git",
      "/srv/mirror/blog-pipeline-agent.git",
    ];
    const variants = (u) => [
      `${u}\n`,
      `${u}\r\n`,
      `${u}\r`,
      `\n${u}`,
      ` ${u}`,
      `${u} `,
      `${u}\n::error::forged`,
      u.replace("blog-pipeline", "blog\tpipeline"),
      u.replace("blog-pipeline", "blog pipeline"),
      `${u}\u0000`,
      `${u}\u001b[31m`,
      `${u}\u007f`,
      `${u}\u0085`,
      `${u}\u00a0`,
      `${u}\u2028`,
    ];
    for (const base of plain) {
      for (const url of variants(base)) {
        const shown = JSON.stringify(url);
        expect(repoSync.shallowRemoteRefusal(url), shown).toMatch(/whitespace or a control character/);
        const deps = makeDeps();
        const { thrown, lines } = run(deps, { url });
        expect(String(thrown?.message), shown).toMatch(/whitespace or a control character/);
        expect(String(thrown?.message), shown).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
        expect(String(thrown?.message), shown).not.toMatch(/forged|blog-pipeline-agent\.git/);
        expect(lines, shown).toEqual([]);
        expect(deps.calls, shown).toEqual([]);
        expect(deps.state.exists.size, shown).toBe(0);
      }
    }
  });

  it("refuses a Unicode format character (soft hyphen, zero-width, bidi, word joiner, BOM) anywhere in a plain form, and never prints the URL", () => {
    const plain = [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git",
      "ssh://git@github.com/cinatra-ai/blog-pipeline-agent.git",
      "git@github.com:cinatra-ai/blog-pipeline-agent.git",
      "file:///srv/mirror/blog-pipeline-agent.git",
      "/srv/mirror/blog-pipeline-agent.git",
    ];
    const format = ["\u00ad", "\u200b", "\u200e", "\u202e", "\u2060", "\u2066", "\ufeff"];
    for (const base of plain) {
      for (const c of format) {
        for (const url of [base.replace("blog-pipeline", `blog${c}pipeline`), `${base}${c}`]) {
          const shown = JSON.stringify(url);
          expect(repoSync.shallowRemoteRefusal(url), shown).toMatch(/whitespace or a control character/);
          expect(repoSync.shownGitUrl(url), shown).toMatch(/^\(not shown/);
          const deps = makeDeps();
          const { thrown, lines } = run(deps, { url });
          expect(String(thrown?.message), shown).toMatch(/whitespace or a control character/);
          expect(String(thrown?.message), shown).not.toMatch(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
          expect(String(thrown?.message), shown).not.toMatch(/blog-pipeline-agent\.git/);
          expect(lines, shown).toEqual([]);
          expect(deps.calls, shown).toEqual([]);
        }
      }
    }
  });

  it("a HEAD read that fails throws, with the new checkout removed and no fallback", () => {
    const deps = makeDeps({ plan: { "rev-parse": [STDERR.locked] } });
    const { thrown } = run(deps);
    expect(String(thrown?.message)).toMatch(/Permission denied/);
    expect(starts(deps.calls, "clone")).toEqual([]);
    expect(deps.removed).toEqual([DEST]);
    expect(deps.state.exists.has(DEST)).toBe(false);
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

  it("a moved copy that is not a plain repository directory is never fetched from: origin serves the pin", () => {
    const shapes = {
      "a symlinked checkout": (t, g) => (t[path.dirname(g)] = "link"),
      "a symlinked .git": (t, g) => (t[g] = "link"),
      "a .git file (gitfile)": (t, g) => (t[g] = "file"),
      "a symlinked .git/objects": (t, g) => (t[path.join(g, "objects")] = "link"),
      "no .git/objects": (t, g) => delete t[path.join(g, "objects")],
      "a .git/objects/info/alternates": (t, g) => (t[path.join(g, "objects", "info", "alternates")] = "file"),
      "a .git/objects/info/http-alternates": (t, g) => (t[path.join(g, "objects", "info", "http-alternates")] = "file"),
      "a .git/commondir": (t, g) => (t[path.join(g, "commondir")] = "file"),
      "a checkout that is a file": (t, g) => (t[path.dirname(g)] = "file"),
      "no .git": (t, g) => delete t[g],
      "a .git/objects that is a file": (t, g) => (t[path.join(g, "objects")] = "file"),
      "a .git that cannot be read": (t, g) => (t[g] = "eacces"),
      "an alternates path that cannot be read": (t, g) => (t[path.join(g, "objects", "info", "alternates")] = "eacces"),
      // upload-pack opens what the copy's .git holds: a special file (a FIFO with no writer) would block it, and a
      // symlink would make it read outside the copy. Only real directories and regular files are offered.
      "a .git/config that is a FIFO": (t, g, s) => {
        t[path.join(g, "config")] = "fifo";
        s.dirEntries[g] = ["config", "objects"];
      },
      "a .git/config that is a symlink": (t, g, s) => {
        t[path.join(g, "config")] = "link";
        s.dirEntries[g] = ["config", "objects"];
      },
      "a .git/HEAD that is a FIFO": (t, g, s) => {
        t[path.join(g, "HEAD")] = "fifo";
        s.dirEntries[g] = ["HEAD", "objects"];
      },
      "a .git/shallow that is a FIFO": (t, g, s) => {
        t[path.join(g, "shallow")] = "fifo";
        s.dirEntries[g] = ["objects", "shallow"];
      },
      "a symlink inside .git/refs/heads": (t, g, s) => {
        t[path.join(g, "refs")] = "dir";
        t[path.join(g, "refs", "heads")] = "dir";
        t[path.join(g, "refs", "heads", "main")] = "link";
        s.dirEntries[g] = ["objects", "refs"];
        s.dirEntries[path.join(g, "refs")] = ["heads"];
        s.dirEntries[path.join(g, "refs", "heads")] = ["main"];
      },
      "a FIFO inside .git/objects/pack": (t, g, s) => {
        t[path.join(g, "objects", "pack")] = "dir";
        t[path.join(g, "objects", "pack", "pack-1.pack")] = "fifo";
        s.dirEntries[g] = ["objects"];
        s.dirEntries[path.join(g, "objects")] = ["pack"];
        s.dirEntries[path.join(g, "objects", "pack")] = ["pack-1.pack"];
      },
      "a symlink inside .git/objects": (t, g, s) => {
        t[path.join(g, "objects", "ab")] = "link";
        s.dirEntries[g] = ["objects"];
        s.dirEntries[path.join(g, "objects")] = ["ab"];
      },
      "a .git/refs that cannot be listed": (t, g, s) => {
        t[path.join(g, "refs")] = "dir";
        s.dirEntries[g] = ["objects", "refs"];
        s.unlistable.add(path.join(g, "refs"));
      },
      "a .git entry that cannot be read": (t, g, s) => {
        t[path.join(g, "packed-refs")] = "eacces";
        s.dirEntries[g] = ["objects", "packed-refs"];
      },
      "a .git/config with an [include] section": (t, g, s) => {
        t[path.join(g, "config")] = "file";
        s.files[path.join(g, "config")] = "[core]\n\tbare = false\n[include]\n\tpath = /elsewhere/config\n";
        s.dirEntries[g] = ["config", "objects"];
      },
      "a .git/config with an [includeIf] section": (t, g, s) => {
        t[path.join(g, "config")] = "file";
        s.files[path.join(g, "config")] = '[core]\n\tbare = false\n  [IncludeIf "gitdir:/"]\n\tpath = /elsewhere/config\n';
        s.dirEntries[g] = ["config", "objects"];
      },
      "a .git/config with an include.path set in the section header form": (t, g, s) => {
        t[path.join(g, "config")] = "file";
        s.files[path.join(g, "config")] = "[core]\n\tbare = false\n[ INCLUDE ]\n\tpath = /elsewhere/config\n";
        s.dirEntries[g] = ["config", "objects"];
      },
      "a .git/config that cannot be read": (t, g, s) => {
        t[path.join(g, "config")] = "file";
        s.dirEntries[g] = ["config", "objects"];
      },
    };
    for (const [label, gitShape] of Object.entries(shapes)) {
      const deps = makeDeps({ existing: true, gitShape });
      const { result, thrown, lines } = run(deps);
      expect(thrown, label).toBeNull();
      expect(result, label).toEqual(CLONED);
      expect(deps.calls, label).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
      expect(deps.sleeps, label).toEqual([]);
      expect(deps.removed, label).toEqual([SOURCE]);
      expect(lines.some((l) => /is not read as a source of objects/.test(l)), label).toBe(true);
    }
  });

  it("a moved copy that holds only real directories and regular files, with a config without includes, is fetched from", () => {
    const deps = makeDeps({
      existing: true,
      gitShape: (t, g, s) => {
        for (const d of [["refs"], ["refs", "heads"], ["objects", "pack"], ["hooks"]]) t[path.join(g, ...d)] = "dir";
        for (const f of [["config"], ["HEAD"], ["shallow"], ["refs", "heads", "main"], ["objects", "pack", "pack-1.pack"], ["hooks", "pre-commit.sample"]]) {
          t[path.join(g, ...f)] = "file";
        }
        s.files[path.join(g, "config")] = "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://github.com/cinatra-ai/x.git\n";
        s.dirEntries[g] = ["HEAD", "config", "hooks", "objects", "refs", "shallow"];
        s.dirEntries[path.join(g, "refs")] = ["heads"];
        s.dirEntries[path.join(g, "refs", "heads")] = ["main"];
        s.dirEntries[path.join(g, "objects")] = ["pack"];
        s.dirEntries[path.join(g, "objects", "pack")] = ["pack-1.pack"];
        s.dirEntries[path.join(g, "hooks")] = ["pre-commit.sample"];
      },
    });
    const { result, thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    expect(result).toEqual(CLONED);
    expect(deps.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ...CHECKED_OUT]);
    expect(lines.some((l) => /is not read as a source of objects/.test(l))).toBe(false);
    expect(deps.removed).toEqual([SOURCE]);
  });

  it("a removal of the moved copy that fails after a verified checkout throws, with the checkout and the copy left in place", () => {
    const deps = makeDeps({ existing: true, failRemoval: SOURCE });
    const { result, thrown } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/EBUSY/);
    expect(deps.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ...CHECKED_OUT]);
    expect(deps.removed).toEqual([SOURCE]);
    expect(deps.state.exists.has(DEST)).toBe(true);
    expect(deps.state.exists.has(path.join(SOURCE, ".git"))).toBe(true);
  });

  it("a removal of a stale copy that fails stops the sync before any git call, with the copy and the checkout left in place", () => {
    const deps = makeDeps({ existing: true, staleSource: true, failRemoval: SOURCE });
    const { result, thrown } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/EBUSY/);
    expect(deps.calls).toEqual([]);
    expect(deps.renamed).toEqual([]);
    expect(deps.state.exists.has(SOURCE)).toBe(true);
    expect(deps.state.exists.has(path.join(DEST, ".git"))).toBe(true);
  });

  it("a removal of an empty destination that fails stops the sync before any git call, with the destination left in place", () => {
    const deps = makeDeps({ emptyDir: true, failRemoval: DEST });
    const { result, thrown } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/EBUSY/);
    expect(deps.calls).toEqual([]);
    expect(deps.removed).toEqual([DEST]);
    expect(deps.state.exists.has(DEST)).toBe(true);
  });

  it("a move of the existing checkout that fails stops the sync before any git call, with the checkout left in place", () => {
    const deps = makeDeps({ existing: true, failRename: true });
    const { result, thrown } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/EXDEV/);
    expect(deps.calls).toEqual([]);
    expect(deps.removed).toEqual([]);
    expect(deps.state.exists.has(path.join(DEST, ".git"))).toBe(true);
    expect(deps.state.exists.has(SOURCE)).toBe(false);
  });

  it("a removal of the moved copy that fails after a git failure throws the git failure, with no fallback and the copy left", () => {
    const deps = makeDeps({ existing: true, landsOn: OTHER, failRemoval: SOURCE });
    const { result, thrown, lines } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/verification failed/);
    expect(deps.removed).toEqual([DEST, SOURCE]);
    expect(starts(deps.calls, "clone")).toEqual([]);
    expect(lines.some((l) => l.includes(`could not remove ${SOURCE}`))).toBe(true);
    expect(deps.state.exists.has(path.join(SOURCE, ".git"))).toBe(true);
    expect(deps.state.exists.has(DEST)).toBe(false);
  });

  it("a failing creation of the new checkout's parent directory throws before any git call, with what the sync moved removed", () => {
    const deps = makeDeps({ existing: true, failMkdirp: true });
    const { result, thrown } = run(deps);
    expect(result).toBeNull();
    expect(String(thrown?.message)).toMatch(/EACCES/);
    expect(deps.calls).toEqual([]);
    expect(deps.removed).toEqual([DEST, SOURCE]);
    expect(starts(deps.calls, "clone")).toEqual([]);
  });

  it("a config include that git honours in any position, or a .git/config.worktree, is never fetched from: origin serves the pin", () => {
    const withConfig = (config, more = {}) => (t, g, s) => {
      t[path.join(g, "config")] = "file";
      s.files[path.join(g, "config")] = config;
      s.dirEntries[g] = ["config", "objects", ...Object.keys(more)];
      for (const [name, text] of Object.entries(more)) {
        t[path.join(g, name)] = "file";
        s.files[path.join(g, name)] = text;
      }
    };
    const shapes = {
      // git reads a section header that follows another on the same line.
      "[include] after [core] on the same line": withConfig("[core] [include]\n\tpath = /elsewhere/config\n"),
      "[includeIf] after a section header on the same line": withConfig(
        '[core]\n\tbare = false\n[remote "origin"] [includeIf "gitdir:/"]\n\tpath = /elsewhere/config\n',
      ),
      // git skips a UTF-8 byte order mark at the start of a config file.
      "[include] after a byte order mark": withConfig("\ufeff[include]\n\tpath = /elsewhere/config\n"),
      "[include] after a tab and a CR line end": withConfig("[core]\r\n\tbare = false\r\n\t[include]\r\n\tpath = /elsewhere/config\r\n"),
      // With extensions.worktreeConfig git also reads .git/config.worktree.
      "an [include] in .git/config.worktree": withConfig(
        "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tworktreeConfig = true\n",
        { "config.worktree": "[include]\n\tpath = /elsewhere/config\n" },
      ),
      "a .git/config.worktree without an include": withConfig("[core]\n\tbare = false\n", { "config.worktree": "[core]\n\tbare = false\n" }),
    };
    for (const [label, gitShape] of Object.entries(shapes)) {
      const deps = makeDeps({ existing: true, gitShape });
      const { result, thrown, lines } = run(deps);
      expect(thrown, label).toBeNull();
      expect(result, label).toEqual(CLONED);
      expect(deps.calls, label).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
      expect(deps.removed, label).toEqual([SOURCE]);
      expect(lines.some((l) => /is not read as a source of objects/.test(l)), label).toBe(true);
    }
  });

  it("a moved copy whose .git holds more than 100000 entries is never fetched from; one at the limit is", () => {
    const shape = (count) => (t, g, s) => {
      const names = Array.from({ length: count - 1 }, (_, i) => `f${i}`);
      s.dirEntries[g] = ["objects", ...names];
      for (const n of names) t[path.join(g, n)] = "file";
    };
    const over = makeDeps({ existing: true, gitShape: shape(100001) });
    const o = run(over);
    expect(o.thrown).toBeNull();
    expect(over.calls).toEqual([...MADE_NEW, ORIGIN_FETCH, ...CHECKED_OUT]);
    expect(o.lines.some((l) => /more than 100000 entries/.test(l))).toBe(true);
    const at = makeDeps({ existing: true, gitShape: shape(100000) });
    const a = run(at);
    expect(a.thrown).toBeNull();
    expect(at.calls).toEqual([...MADE_NEW, SOURCE_FETCH, ...CHECKED_OUT]);
  });

  it("a refused entry of the moved copy is named JSON-escaped: a hostile name never prints a line of its own", () => {
    const deps = makeDeps({
      existing: true,
      gitShape: (t, g, s) => {
        t[path.join(g, "x\n::error::forged")] = "link";
        s.dirEntries[g] = ["objects", "x\n::error::forged"];
      },
    });
    const { thrown, lines } = run(deps);
    expect(thrown).toBeNull();
    const refusal = lines.filter((l) => /is not read as a source of objects/.test(l));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('".git/x\\n::error::forged" is a symbolic link');
    expect(lines.join("\n").split("\n").filter((l) => /^\s*::/.test(l))).toEqual([]);
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

describe("redactGitUrl — a query, a fragment and scp-style user info are never printed", () => {
  it("hides them in a URL and in a git failure line, and keeps the plain forms", () => {
    const r = repoSync.redactGitUrl;
    expect(r("https://github.com/cinatra-ai/x.git?access_token=secret123")).toBe("https://github.com/cinatra-ai/x.git?***");
    expect(r("https://github.com/cinatra-ai/x.git#secret123")).toBe("https://github.com/cinatra-ai/x.git#***");
    expect(r("secret123@github.com:cinatra-ai/x.git")).toBe("***@github.com:cinatra-ai/x.git");
    expect(r("user:secret123@github.com:cinatra-ai/x.git")).toBe("***@github.com:cinatra-ai/x.git");
    expect(r("git@github.com:cinatra-ai/x.git")).toBe("git@github.com:cinatra-ai/x.git");
    expect(r("https://github.com/cinatra-ai/x.git")).toBe("https://github.com/cinatra-ai/x.git");
    const line = r("fatal: unable to access 'https://github.com/cinatra-ai/x.git/?access_token=secret123': The requested URL returned error: 403");
    expect(line).not.toMatch(/secret123/);
    expect(line).toMatch(/^fatal: unable to access 'https:\/\/github\.com\/cinatra-ai\/x\.git\/\?\*\*\*': The requested URL returned error: 403$/);
  });

  it("hides a query or fragment of an scp-style or absolute-path remote, and a password that holds an @", () => {
    const r = repoSync.redactGitUrl;
    expect(r("git@github.com:cinatra-ai/x.git?access_token=secret123")).toBe("git@github.com:cinatra-ai/x.git?***");
    expect(r("tok:secret@123@github.com:cinatra-ai/x.git#secret123")).toBe("***@github.com:cinatra-ai/x.git#***");
    expect(r("https://user:p@ssword123@github.com/cinatra-ai/x.git")).toBe("https://***@github.com/cinatra-ai/x.git");
    expect(r("/srv/mirror/x.git?secret123")).toBe("/srv/mirror/x.git?***");
    expect(r("file:///srv/mirror/x.git#secret123")).toBe("file:///srv/mirror/x.git#***");
    const line = r("fatal: 'secret123@github.com:cinatra-ai/x.git?t=secret456' does not appear to be a git repository");
    expect(line).toBe("fatal: '***@github.com:cinatra-ai/x.git?***' does not appear to be a git repository");
    expect(r("/srv/mirror/x.git")).toBe("/srv/mirror/x.git");
    expect(r("fatal: unable to read /srv/mirror/x.git/config")).toBe("fatal: unable to read /srv/mirror/x.git/config");
  });

  it("a remote with a query on the scp or absolute-path form, or a password with an @, is never printed on any road", () => {
    // The scp and path forms pass the GitHub-or-local allowlist and are refused by the shallow check; the https form with an
    // "@" in its password reads as another host, so the allowlist refuses it first, on both roads.
    for (const [url, shallowRefusal] of [
      ["git@github.com:cinatra-ai/blog-pipeline-agent.git?access_token=secret123", /carries credentials, a query or a fragment/],
      ["/srv/mirror/blog-pipeline-agent.git?secret123", /carries credentials, a query or a fragment/],
      ["https://user:p@ssword123@github.com/cinatra-ai/blog-pipeline-agent.git", /refusing a git remote that is not GitHub or a local path/],
    ]) {
      for (const shallow of [false, true]) {
        const deps = makeDeps();
        const { thrown, lines } = run(deps, { url, shallow });
        const said = `${String(thrown?.message ?? "")}\n${lines.join("\n")}`;
        expect(said, `${url} shallow=${shallow}`).not.toMatch(/secret123|ssword123/);
        if (shallow) {
          expect(String(thrown?.message), url).toMatch(shallowRefusal);
          expect(deps.calls, url).toEqual([]);
        }
      }
    }
  });

  it("a refused scp-style remote with user info never prints it (any road)", () => {
    for (const shallow of [false, true]) {
      const deps = makeDeps();
      const { thrown } = run(deps, { url: "secret123@github.com:cinatra-ai/blog-pipeline-agent.git", shallow });
      expect(String(thrown?.message)).toMatch(/refusing a git remote/);
      expect(String(thrown?.message)).not.toMatch(/secret123/);
      expect(deps.calls).toEqual([]);
    }
  });

  it("hides the query or fragment of a Windows drive or UNC path, in a bare path and in a git failure line", () => {
    const r = repoSync.redactGitUrl;
    expect(r("C:\\mirror\\r.git#access_token=secret123")).toBe("C:\\mirror\\r.git#***");
    expect(r("c:/mirror/r.git?access_token=secret123")).toBe("c:/mirror/r.git?***");
    expect(r("\\\\server\\share\\r.git?secret123")).toBe("\\\\server\\share\\r.git?***");
    expect(r("fatal: 'C:\\mirror\\r.git#tok=secret123' does not appear to be a git repository")).toBe(
      "fatal: 'C:\\mirror\\r.git#***' does not appear to be a git repository",
    );
    expect(r("C:\\mirror\\r.git")).toBe("C:\\mirror\\r.git");
  });

  it("a refused remote is never printed with a query, a fragment, whitespace or a control character, on any road", () => {
    for (const url of [
      "C:\\mirror\\blog-pipeline-agent.git#access_token=secret123",
      "C:/mirror/blog-pipeline-agent.git?access_token=secret123",
      "\\\\server\\share\\blog-pipeline-agent.git?secret123",
      "github.com:cinatra-ai/blog-pipeline-agent.git?access_token=secret123",
      "https://github.com/cinatra-ai/blog-pipeline-agent.git?access_token=x\nsecret123",
      "https://github.com/cinatra-ai/blog-pipeline-agent.git#\tsecret123",
      "-https://user:secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "--upload-pack=secret123",
    ]) {
      for (const shallow of [false, true]) {
        const deps = makeDeps();
        const { thrown, lines } = run(deps, { url, shallow });
        const said = `${String(thrown?.message ?? "")}\n${lines.join("\n")}`;
        expect(said, `${JSON.stringify(url)} shallow=${shallow}`).not.toMatch(/secret123/);
      }
    }
  });

  it("no remote makes the sync print a line of its own, on any road", () => {
    for (const url of [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git\n::error::forged",
      "https://github.com/cinatra-ai/blog-pipeline-agent.git\r::error::forged",
      "/srv/mirror/blog-pipeline-agent.git\n::add-mask::forged",
      "-x\n::error::forged",
    ]) {
      for (const shallow of [false, true]) {
        const deps = makeDeps();
        const { thrown, lines } = run(deps, { url, shallow });
        const printed = [String(thrown?.message ?? ""), ...lines].join("\n").split(/\r\n|\r|\n|\u0085|\u2028|\u2029/);
        expect(printed.filter((l) => /^\s*::/.test(l)), `${JSON.stringify(url)} shallow=${shallow}`).toEqual([]);
      }
    }
  });

  it("the branch-road clone log, the non-git-directory refusal and the origin-mismatch refusal never print a query, a password or a line of their own", () => {
    const hostile = [
      "https://github.com/cinatra-ai/blog-pipeline-agent.git?access_token=secret123",
      "https://user:secret123@github.com/cinatra-ai/blog-pipeline-agent.git",
      "https://github.com/cinatra-ai/blog-pipeline-agent.git\n::error::secret123",
    ];
    const said = ({ thrown, lines }) => [String(thrown?.message ?? ""), ...lines].join("\n");
    const check = (text, label) => {
      expect(text, label).not.toMatch(/secret123/);
      expect(text.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/).filter((l) => /^\s*::/.test(l)), label).toEqual([]);
    };
    for (const url of hostile) {
      const label = JSON.stringify(url);
      // The clone log of the branch road (no pin).
      const clone = makeDeps();
      const c = run(clone, { url, sha: undefined, shallow: false });
      expect(c.thrown, label).toBeNull();
      expect(c.lines.some((l) => /cloning /.test(l)), label).toBe(true);
      check(said(c), `clone ${label}`);
      // A non-empty directory that is not a git checkout.
      const nonGit = makeDeps();
      nonGit.state.exists.add(DEST);
      nonGit.state.dirEntries[DEST] = ["leftover.txt"];
      const n = run(nonGit, { url, sha: undefined, shallow: false });
      expect(String(n.thrown?.message), label).toMatch(/non-empty, non-git directory/);
      check(said(n), `non-git ${label}`);
      // A checkout whose own origin is another, hostile remote.
      const mismatch = makeDeps({ existing: true });
      const git = mismatch.git;
      mismatch.git = (args, cwd) =>
        args[0] === "remote" && args[1] === "get-url"
          ? "https://github.com/someone-else/x.git?access_token=secret123\n::error::secret123\n"
          : git(args, cwd);
      const m = run(mismatch, { url, shallow: false });
      expect(String(m.thrown?.message), label).toMatch(/is expected/);
      check(said(m), `origin ${label}`);
    }
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

  it("a restored checkout that borrows objects through alternates is not read as a source: origin serves the pin", () => {
    const { url, oldPin } = makeOrigin();
    const lender = path.join(work, `lender-${counter}.git`);
    execFileSync("git", ["clone", "-q", "--bare", url.slice("file://".length), lender]);
    const dest = path.join(work, "alternates", "fixture");
    realSync(url, oldPin, dest);
    writeFileSync(path.join(dest, ".git", "objects", "info", "alternates"), `${path.join(lender, "objects")}\n`);
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /is not read as a source of objects/.test(l))).toBe(true);
    expect(existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(repoSync.shallowSourceDirFor(dest))).toBe(false);
  });

  it("a restored checkout whose config includes another file is not read as a source: origin serves the pin", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "include", "fixture");
    realSync(url, oldPin, dest);
    const config = path.join(dest, ".git", "config");
    writeFileSync(config, `${readFileSync(config, "utf8")}[include]\n\tpath = ${path.join(work, "no-such-config")}\n`);
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /is not read as a source of objects/.test(l))).toBe(true);
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(repoSync.shallowSourceDirFor(dest))).toBe(false);
  });

  it("a restored checkout with an include on a header's line, after a byte order mark, or in config.worktree is not read as a source", () => {
    const plants = {
      "same-line": (gitDir, extra) => {
        const config = path.join(gitDir, "config");
        writeFileSync(config, `${readFileSync(config, "utf8")}[core] [include]\n\tpath = ${extra}\n`);
      },
      bom: (gitDir, extra) => {
        const config = path.join(gitDir, "config");
        writeFileSync(config, `\ufeff[include]\n\tpath = ${extra}\n${readFileSync(config, "utf8")}`);
      },
      "config-worktree": (gitDir, extra) => {
        g(path.dirname(gitDir), ["config", "core.repositoryformatversion", "1"]);
        g(path.dirname(gitDir), ["config", "extensions.worktreeConfig", "true"]);
        writeFileSync(path.join(gitDir, "config.worktree"), `[include]\n\tpath = ${extra}\n`);
      },
    };
    for (const [label, plant] of Object.entries(plants)) {
      const { url, oldPin } = makeOrigin();
      const dest = path.join(work, `include-${label}`, "fixture");
      realSync(url, oldPin, dest);
      // The included file exists, so git reads it: a planted value git would honour.
      const extra = path.join(work, `extra-${label}-${counter}`);
      writeFileSync(extra, "[user]\n\tname = planted-by-include\n");
      plant(path.join(dest, ".git"), extra);
      expect(g(dest, ["config", "user.name"]), label).toBe("planted-by-include");
      const lines = [];
      const r = realSync(url, oldPin, dest, (m) => lines.push(m));
      expect(r, label).toMatchObject({ action: "cloned", pinnedSha: oldPin });
      expect(lines.some((l) => /is not read as a source of objects/.test(l)), label).toBe(true);
      expect(g(dest, ["rev-parse", "HEAD"]), label).toBe(oldPin);
      expect(existsSync(repoSync.shallowSourceDirFor(dest)), label).toBe(false);
    }
  });

  it("a restored checkout with a symlink inside .git/objects is not read as a source: origin serves the pin", () => {
    const { url, oldPin } = makeOrigin();
    const dest = path.join(work, "objects-link", "fixture");
    realSync(url, oldPin, dest);
    symlinkSync(path.join(work, "outside-target"), path.join(dest, ".git", "objects", "info", "planted"));
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /is not read as a source of objects/.test(l))).toBe(true);
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(existsSync(repoSync.shallowSourceDirFor(dest))).toBe(false);
  });

  it("a restored checkout whose .git is a gitfile is not read as a source: origin serves the pin", () => {
    const { url, oldPin } = makeOrigin();
    const elsewhere = path.join(work, `elsewhere-${counter}`);
    realSync(url, oldPin, elsewhere);
    const dest = path.join(work, "gitfile", "fixture");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, ".git"), `gitdir: ${path.join(elsewhere, ".git")}\n`);
    writeFileSync(path.join(dest, "package.json"), "{}\n");
    const lines = [];
    const r = realSync(url, oldPin, dest, (m) => lines.push(m));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: oldPin });
    expect(lines.some((l) => /is not read as a source of objects/.test(l))).toBe(true);
    expect(g(dest, ["rev-parse", "HEAD"])).toBe(oldPin);
    expect(readFileSync(path.join(dest, "src", "a.txt"), "utf8")).toBe("one\n");
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
