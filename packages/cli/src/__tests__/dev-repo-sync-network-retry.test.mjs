import path from "node:path";
import { describe, expect, it } from "vitest";

// A namespace import: on a module without the retry each case below fails on
// its own (an absent export reads undefined) instead of the whole file failing
// to load.
import * as repoSync from "../dev-repo-sync.mjs";

const { syncOneRepo, defaultRepoSyncDeps } = repoSync;

const DEST = "/repo/extensions/cinatra-ai/blog-pipeline-agent";
const URL = "https://github.com/cinatra-ai/blog-pipeline-agent.git";
const TOKEN_URL = "https://ghp_exampletoken@github.com/cinatra-ai/blog-pipeline-agent.git";
const PIN = "0123456789abcdef0123456789abcdef01234567";

// Real git stderr lines, as a failed `git clone` / `git fetch` prints them.
const STDERR = {
  resolve: "Cloning into 'blog-pipeline-agent'...\nfatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Could not resolve host: github.com\n",
  connect: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Failed to connect to github.com port 443 after 129 ms: Couldn't connect to server\n",
  reset: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Recv failure: Connection reset by peer\n",
  timedOut: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Connection timed out after 300000 milliseconds\n",
  operationTimedOut: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': Operation timed out after 300000 milliseconds with 0 bytes received\n",
  earlyEof: "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output\n",
  hungUp: "error: 1234 bytes of body are still expected\nfatal: the remote end hung up unexpectedly\n",
  rpc: "error: RPC failed; curl 56 GnuTLS recv error (-9): Error decoding the received TLS packet.\n",
  http502: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': The requested URL returned error: 502\n",
  http429: "error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429\n",
  notOurRef: `fatal: remote error: upload-pack: not our ref ${PIN}\n`,
  notOurRefHungUp: `fatal: remote error: upload-pack: not our ref ${PIN}\nfatal: the remote end hung up unexpectedly\n`,
  noRemoteRef: `fatal: couldn't find remote ref ${PIN}\n`,
  noBranch: "Cloning into 'blog-pipeline-agent'...\nwarning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin\n",
  notFound: "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n",
  http404: "error: RPC failed; HTTP 404 curl 22 The requested URL returned error: 404\nfatal: the remote end hung up unexpectedly\n",
  http403: "fatal: unable to access 'https://github.com/cinatra-ai/blog-pipeline-agent.git/': The requested URL returned error: 403\n",
  auth: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/cinatra-ai/blog-pipeline-agent.git/'\n",
  username: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
};

// The shape execFileSync throws: the stderr is on the error AND in its message.
function gitError(args, stderr) {
  return Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${stderr}`), { status: 128, stderr });
}

/**
 * A deps double. `plan` maps a git verb ("clone", "fetch", ...) to a list of
 * outcomes, one per call: a string is a stderr to fail with, `{ ok: value }` a
 * success, and a function runs before the outcome (to model a partial clone).
 */
function makeDeps({ existsPaths = [], dirEntries = {}, plan = {}, catFileHas = false, head = PIN, unreadable = [] } = {}) {
  const state = { exists: new Set(existsPaths), dirEntries: { ...dirEntries } };
  const calls = [];
  const sleeps = [];
  const removed = [];
  const used = {};
  const deps = {
    state,
    calls,
    sleeps,
    removed,
    exists: (p) => state.exists.has(p),
    readdir: (p) => {
      if (!state.exists.has(p)) throw new Error(`ENOENT: ${p}`);
      if (unreadable.includes(p)) throw new Error(`EACCES: ${p}`);
      return [...(state.dirEntries[p] ?? [])];
    },
    mkdirp: () => {},
    removeTree: (p) => {
      removed.push(p);
      state.exists.delete(p);
      delete state.dirEntries[p];
      const parent = path.dirname(p);
      if (state.dirEntries[parent]) {
        state.dirEntries[parent] = state.dirEntries[parent].filter((n) => n !== path.basename(p));
      }
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
        if (typeof outcome === "function") outcome(state);
        const result = typeof outcome === "function" ? outcome.result : outcome;
        if (typeof result === "string") throw gitError(args, result);
        if (result && "ok" in result) return result.ok;
      }
      if (verb === "cat-file") {
        if (catFileHas) return "";
        throw gitError(args, `fatal: Not a valid object name ${PIN}^{commit}\n`);
      }
      if (verb === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
      if (verb === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (verb === "remote") return `${URL}\n`;
      if (verb === "status") return "";
      return "";
    },
  };
  return deps;
}

const OK = { ok: "" };

function run(deps, extra = {}) {
  const lines = [];
  const result = syncOneRepo({
    pkgName: "@cinatra-ai/blog-pipeline-agent",
    url: URL,
    branch: "main",
    dest: DEST,
    force: false,
    deps,
    log: (m) => lines.push(m),
    ...extra,
  });
  return { result, lines };
}

function runThrows(deps, extra = {}) {
  const lines = [];
  let thrown = null;
  try {
    syncOneRepo({
      pkgName: "@cinatra-ai/blog-pipeline-agent",
      url: URL,
      branch: "main",
      dest: DEST,
      force: false,
      deps,
      log: (m) => lines.push(m),
      ...extra,
    });
  } catch (err) {
    thrown = err;
  }
  return { thrown, lines };
}

const retryLines = (lines) => lines.filter((l) => /transient network error/.test(l));
const count = (calls, verb) => calls.filter((c) => c.startsWith(verb)).length;

describe("transientGitNetworkReason — which git failures are transient", () => {
  it.each([
    ["resolve", "could not resolve host"],
    ["connect", "failed to connect"],
    ["reset", "connection reset"],
    ["timedOut", "connection timed out"],
    ["operationTimedOut", "connection timed out"],
    ["earlyEof", "early EOF"],
    ["hungUp", "remote end hung up"],
    ["rpc", "RPC failed"],
    ["http502", "HTTP 5xx"],
    ["http429", "HTTP 429"],
  ])("reads the %s failure as transient (%s)", (key, reason) => {
    expect(repoSync.transientGitNetworkReason(gitError(["fetch", "origin", "main"], STDERR[key]))).toBe(reason);
  });

  it.each([
    "notOurRef",
    "notOurRefHungUp",
    "noRemoteRef",
    "noBranch",
    "notFound",
    "http404",
    "http403",
    "auth",
    "username",
  ])("never reads the %s failure as transient", (key) => {
    expect(repoSync.transientGitNetworkReason(gitError(["fetch", "origin", PIN], STDERR[key]))).toBeNull();
  });

  it("reads the stderr from a Buffer, and from the message when the error carries no stderr", () => {
    const fromBuffer = Object.assign(new Error("Command failed: git clone"), { stderr: Buffer.from(STDERR.resolve) });
    expect(repoSync.transientGitNetworkReason(fromBuffer)).toBe("could not resolve host");
    expect(repoSync.transientGitNetworkReason(new Error(`Command failed: git clone\n${STDERR.reset}`))).toBe(
      "connection reset",
    );
    expect(repoSync.transientGitNetworkReason(new Error("ENOENT: spawn git"))).toBeNull();
    expect(repoSync.transientGitNetworkReason(undefined)).toBeNull();
  });

  it("waits 2 s and then 8 s: three attempts in all", () => {
    expect(repoSync.NETWORK_RETRY_DELAYS_MS).toEqual([2000, 8000]);
    expect(Object.isFrozen(repoSync.NETWORK_RETRY_DELAYS_MS)).toBe(true);
  });

  it("gives the real deps a sleep and a tree removal", () => {
    const deps = defaultRepoSyncDeps();
    expect(typeof deps.sleep).toBe("function");
    expect(typeof deps.removeTree).toBe("function");
  });
});

describe("syncOneRepo — the clone retries a transient network failure", () => {
  it("clones on the second attempt after a DNS failure, with one retry line", () => {
    const deps = makeDeps({ plan: { clone: [STDERR.resolve, OK] } });
    const { result, lines } = run(deps);
    expect(result).toEqual({ pkgName: "@cinatra-ai/blog-pipeline-agent", action: "cloned" });
    expect(count(deps.calls, "clone")).toBe(2);
    expect(deps.sleeps).toEqual([2000]);
    expect(retryLines(lines)).toEqual([
      "  @cinatra-ai/blog-pipeline-agent: git clone failed on a transient network error (could not resolve host); attempt 2 of 3 in 2 s.",
    ]);
  });

  it("never prints a credential in a retry line", () => {
    const deps = makeDeps({ plan: { clone: [STDERR.reset, STDERR.resolve, OK] } });
    const { result, lines } = run(deps, { url: TOKEN_URL });
    expect(result.action).toBe("cloned");
    expect(deps.sleeps).toEqual([2000, 8000]);
    expect(retryLines(lines)).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain("ghp_exampletoken");
  });

  it("throws the LAST error after three transient failures", () => {
    const deps = makeDeps({ plan: { clone: [STDERR.resolve, STDERR.reset, STDERR.earlyEof] } });
    const { thrown, lines } = runThrows(deps);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.stderr).toBe(STDERR.earlyEof);
    expect(count(deps.calls, "clone")).toBe(3);
    expect(deps.sleeps).toEqual([2000, 8000]);
    expect(retryLines(lines)).toHaveLength(3);
    expect(lines.at(-1)).toBe(
      "  @cinatra-ai/blog-pipeline-agent: git clone failed 3 times on a transient network error (early EOF) — giving up.",
    );
  });

  it("makes exactly one attempt on a failure that is not transient", () => {
    const deps = makeDeps({ plan: { clone: [STDERR.noBranch, OK] } });
    const { thrown, lines } = runThrows(deps, { branch: "nope" });
    expect(thrown.stderr).toBe(STDERR.noBranch);
    expect(count(deps.calls, "clone")).toBe(1);
    expect(deps.sleeps).toEqual([]);
    expect(retryLines(lines)).toEqual([]);
  });
});

describe("syncOneRepo — the clone's cleanup takes only what this call created", () => {
  it("removes the destination a failed attempt left when it was absent before the call", () => {
    const partial = (state) => {
      state.exists.add(DEST);
      state.dirEntries[DEST] = [".git"];
    };
    partial.result = STDERR.earlyEof;
    const deps = makeDeps({ plan: { clone: [partial, OK] } });
    const { result } = run(deps);
    expect(result.action).toBe("cloned");
    expect(deps.removed).toEqual([DEST]);
  });

  it("removes nothing when the failed attempt left nothing behind", () => {
    const deps = makeDeps({ plan: { clone: [STDERR.resolve, OK] } });
    run(deps);
    expect(deps.removed).toEqual([]);
  });

  it("keeps an empty directory that was there before the call and removes only what the attempt added", () => {
    const partial = (state) => {
      state.dirEntries[DEST] = [".DS_Store", ".git", "README.md"];
    };
    partial.result = STDERR.hungUp;
    const deps = makeDeps({ existsPaths: [DEST], dirEntries: { [DEST]: [".DS_Store"] }, plan: { clone: [partial, OK] } });
    const { result } = run(deps);
    expect(result.action).toBe("cloned");
    expect(deps.removed).toEqual([path.join(DEST, ".git"), path.join(DEST, "README.md")]);
    expect(deps.state.exists.has(DEST)).toBe(true);
  });

  it("fails closed when the directory's entries could not be read before the call: no cleanup, no retry, the first error", () => {
    const partial = (state) => {
      state.dirEntries[DEST] = [".git"];
    };
    partial.result = STDERR.resolve;
    const deps = makeDeps({ existsPaths: [DEST], unreadable: [DEST], plan: { clone: [partial, OK] } });
    const { thrown, lines } = runThrows(deps);
    expect(thrown.stderr).toBe(STDERR.resolve);
    expect(count(deps.calls, "clone")).toBe(1);
    expect(deps.removed).toEqual([]);
    expect(deps.sleeps).toEqual([]);
    expect(deps.state.exists.has(DEST)).toBe(true);
    expect(retryLines(lines)).toEqual([
      "  @cinatra-ai/blog-pipeline-agent: git clone failed on a transient network error (could not resolve host); not retried — what the failed attempt left could not be told apart from what was there before.",
    ]);
  });

  it("never removes anything on a failure that is not transient", () => {
    const partial = (state) => {
      state.exists.add(DEST);
      state.dirEntries[DEST] = [".git"];
    };
    partial.result = STDERR.notFound;
    const deps = makeDeps({ plan: { clone: [partial] } });
    const { thrown } = runThrows(deps);
    expect(thrown.stderr).toBe(STDERR.notFound);
    expect(deps.removed).toEqual([]);
  });
});

describe("syncOneRepo — the pinned commit's fetch retries a transient network failure", () => {
  it("fetches the pin on the second attempt after a connection reset", () => {
    const deps = makeDeps({ plan: { clone: [OK], fetch: [STDERR.reset, OK] } });
    const { result, lines } = run(deps, { sha: PIN });
    expect(result).toEqual({ pkgName: "@cinatra-ai/blog-pipeline-agent", action: "cloned", changed: true, pinnedSha: PIN });
    expect(deps.calls.filter((c) => c === `fetch origin ${PIN}`)).toHaveLength(2);
    expect(deps.calls).toContain(`checkout --detach ${PIN}`);
    expect(deps.sleeps).toEqual([2000]);
    expect(retryLines(lines)).toEqual([
      `  @cinatra-ai/blog-pipeline-agent: git fetch of the pinned commit ${PIN.slice(0, 12)} failed on a transient network error (connection reset); attempt 2 of 3 in 2 s.`,
    ]);
  });

  it("throws the LAST error after three transient failures and never checks out", () => {
    const deps = makeDeps({ plan: { clone: [OK], fetch: [STDERR.http502, STDERR.timedOut, STDERR.rpc] } });
    const { thrown } = runThrows(deps, { sha: PIN });
    expect(thrown.stderr).toBe(STDERR.rpc);
    expect(count(deps.calls, "fetch")).toBe(3);
    expect(count(deps.calls, "checkout")).toBe(0);
    expect(deps.sleeps).toEqual([2000, 8000]);
  });

  it("fails loud on its first attempt for an unreachable pin, even beside 'the remote end hung up'", () => {
    for (const key of ["notOurRef", "notOurRefHungUp", "noRemoteRef"]) {
      const deps = makeDeps({ plan: { clone: [OK], fetch: [STDERR[key], OK] } });
      const { thrown, lines } = runThrows(deps, { sha: PIN });
      expect(thrown.stderr).toBe(STDERR[key]);
      expect(count(deps.calls, "fetch")).toBe(1);
      expect(deps.sleeps).toEqual([]);
      expect(retryLines(lines)).toEqual([]);
    }
  });

  it("re-pins an existing checkout with the same retry", () => {
    const deps = makeDeps({
      existsPaths: [DEST, path.join(DEST, ".git")],
      head: "f".repeat(40),
      plan: {
        fetch: [STDERR.resolve, OK],
        "rev-parse": [{ ok: "main\n" }, { ok: `${"f".repeat(40)}\n` }, { ok: `${PIN}\n` }],
      },
    });
    const { result } = run(deps, { sha: PIN });
    expect(result).toEqual({ pkgName: "@cinatra-ai/blog-pipeline-agent", action: "repinned", changed: true, pinnedSha: PIN });
    expect(count(deps.calls, "fetch")).toBe(2);
    expect(deps.sleeps).toEqual([2000]);
  });
});

describe("syncOneRepo — the branch fetch retries; local git calls never do", () => {
  it("fast-forwards after a transient failure of the branch fetch", () => {
    const deps = makeDeps({ existsPaths: [DEST, path.join(DEST, ".git")], plan: { fetch: [STDERR.http429, OK] } });
    const { result } = run(deps);
    expect(result.action).toBe("updated");
    expect(deps.calls.filter((c) => c === "fetch origin main")).toHaveLength(2);
    expect(deps.sleeps).toEqual([2000]);
  });

  it("never retries a local git call, whatever its output says", () => {
    const deps = makeDeps({
      existsPaths: [DEST, path.join(DEST, ".git")],
      plan: { merge: [STDERR.reset, OK] },
    });
    const { thrown } = runThrows(deps);
    expect(thrown.stderr).toBe(STDERR.reset);
    expect(count(deps.calls, "merge")).toBe(1);
    expect(count(deps.calls, "fetch")).toBe(1);
    expect(deps.sleeps).toEqual([]);
  });
});
