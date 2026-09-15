// THE DESIGN PIN FRESHNESS gate (cinatra#3144 G1).
//
// Runs in the root Vitest suite like its sibling design-pin-drift.test.mjs:
// `scripts/ci/__tests__/**` is in the root include, so a failure here reds a
// required check. The GATE ITSELF stays dependency-free (node builtins only)
// so a pure-node job runs it without an install; only this suite needs vitest.
//
// Organised by the six acceptance items of cinatra#3144 G1:
//
//   1. SHAPE. The checker is dependency-free, its map declares exactly the
//      checker's own global set, and every mapped path exists.
//   2/3. BEHIND. A revision on a governed drawing that is not reachable from
//      the pinned one is BEHIND — red under push-to-main, a warning under a
//      pull request that touches no mapped path. An ancestor-only list and an
//      empty one are current in every event class.
//   4. COULD NOT RUN. No credential, a refused read, a failed read and an
//      unreadable answer all exit 2 and say the gate could not run.
//   5. DISCLOSURE. The negative bound, in the same class as
//      design-pin-drift.test.mjs's "says NOTHING about the upstream source":
//      no bare forty-hex, no `commit`, no `upstream`, no `specs/`, no `@` —
//      and, because a count and a date are facts about a private source too,
//      NO DIGIT AT ALL.
//   6. Held by the diff, not by a suite: the ABSENCE of a
//      .github/branch-protections.json edit.
//
// Plus the pin GRAMMAR itself (the schema decision cinatra#3144 records): a
// pin is one revision and the SET of drawing paths it governs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMMIT_BEARING_PINS,
  DesignPinError,
  DesignSourceError,
  formatSpecCommit,
  loadPathMap,
  parseSpecCommit,
  readCommitBearingPins,
  resolveTouchedPins,
} from "../lib/design-pin.mjs";
import {
  CHECKER_PATH,
  GLOBAL_PATHS,
  MAP_PATH,
  MOVE_RULE,
  WORKFLOW_PATH,
  classifyPinFreshness,
  decide,
  formatBehindMessage,
  runCli,
} from "../design-pin-freshness.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** A pin as the checker reads one. */
const pin = (overrides = {}) => ({
  id: "chat-hitl-lifecycle",
  authority: "scripts/audit/chat-hitl-acceptance-manifest.json",
  mirror: "scripts/audit/chat-hitl-anchor-contract.json",
  revision: A,
  paths: ["specs/app-lifecycle-cards.html"],
  ...overrides,
});

/**
 * A reader stub. `head` and `reachable` are per-path lists; anything not named
 * is empty. Every call is recorded so a test can assert WHICH refs were asked.
 */
function readerStub({ head = {}, reachable = {}, branch = "main", throws = null } = {}) {
  const calls = [];
  return {
    calls,
    async defaultBranch() {
      if (throws === "branch") throw new DesignSourceError("read-failed");
      return branch;
    },
    async revisionsTouching({ ref, path }) {
      calls.push({ ref, path });
      if (throws === "list") throw new DesignSourceError("unauthorized");
      if (throws === "unreadable") throw new DesignSourceError("unreadable-answer");
      return ref === branch ? (head[path] ?? []) : (reachable[path] ?? []);
    },
  };
}

/** A git stub: the base resolves, and the diff reports `touched`. */
const gitStub = (touched = []) => (args) => {
  if (args[0] === "rev-parse") return "";
  if (args[0] === "diff") return touched.join("\n");
  throw new Error(`unexpected git ${args.join(" ")}`);
};

async function run({ argv = [], env = {}, reader, touched = [], pins } = {}) {
  const out = [];
  const err = [];
  const code = await runCli({
    argv,
    env: { DESIGN_PIN_DRIFT_DIFF_BASE: "base", DESIGN_SOURCE_TOKEN: "t", ...env },
    pins,
    createReader: () => reader ?? null,
    runGit: gitStub(touched),
    log: (line) => out.push(String(line)),
    logError: (line) => err.push(String(line)),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n") };
}

// ---------------------------------------------------------------------------
// The grammar (the schema decision)
// ---------------------------------------------------------------------------

describe("the pin grammar carries one revision and the SET of drawings it governs", () => {
  it("parses a single-path pin unchanged — a set of one is a set", () => {
    expect(parseSpecCommit(`design@${A} specs/app-lifecycle-cards.html`)).toEqual({
      revision: A,
      paths: ["specs/app-lifecycle-cards.html"],
    });
  });

  it("parses a pin that governs several drawings", () => {
    expect(
      parseSpecCommit(`design@${A} specs/app-lifecycle-cards.html specs/app-artifact-review.html`),
    ).toEqual({
      revision: A,
      paths: ["specs/app-lifecycle-cards.html", "specs/app-artifact-review.html"],
    });
  });

  it("refuses a pin with no drawing, a bad revision, a bad path or a repeat", () => {
    for (const bad of [
      "",
      `design@${A}`,
      `design@${A.toUpperCase()} specs/app-lifecycle-cards.html`,
      `design@${A.slice(1)} specs/app-lifecycle-cards.html`,
      `sketch@${A} specs/app-lifecycle-cards.html`,
      `design@${A} app-lifecycle-cards.html`,
      `design@${A} specs/app-lifecycle-cards.html specs/app-lifecycle-cards.html`,
    ]) {
      expect(() => parseSpecCommit(bad), JSON.stringify(bad)).toThrow(DesignPinError);
    }
  });

  it("never echoes the value it refused, and names no number", () => {
    try {
      parseSpecCommit(`design@${A.slice(1)} specs/app-lifecycle-cards.html`);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(DesignPinError);
      expect(e.message).not.toContain(A.slice(1));
      expect(e.message).not.toMatch(/\d/);
      expect(e.message).not.toContain("@");
    }
  });

  it("round-trips through formatSpecCommit", () => {
    const value = formatSpecCommit({ revision: B, paths: ["specs/a.html", "specs/b.html"] });
    expect(value).toBe(`design@${B} specs/a.html specs/b.html`);
    expect(parseSpecCommit(value).paths).toHaveLength(2);
  });

  it("reads the REAL tree's commit-bearing pin, authority and mirror agreeing", () => {
    const pins = readCommitBearingPins(REPO_ROOT);
    expect(pins).toHaveLength(COMMIT_BEARING_PINS.length);
    for (const p of pins) {
      expect(p.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(p.paths.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Shape
// ---------------------------------------------------------------------------

describe("the checker's shape", () => {
  const source = readFileSync(join(REPO_ROOT, CHECKER_PATH), "utf8");

  it("is dependency-free — node builtins and its own lib, nothing else", () => {
    const specifiers = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) {
      expect(s.startsWith("node:") || s.startsWith("./"), s).toBe(true);
    }
  });

  it("declares the global set the map must mirror, and the map mirrors it", () => {
    expect(GLOBAL_PATHS).toContain(CHECKER_PATH);
    expect(GLOBAL_PATHS).toContain(MAP_PATH);
    expect(GLOBAL_PATHS).toContain(WORKFLOW_PATH);
    const map = loadPathMap({ repoRoot: REPO_ROOT, mapPath: MAP_PATH, globalPaths: GLOBAL_PATHS });
    expect(Object.keys(map.pins)).toEqual(COMMIT_BEARING_PINS.map((p) => p.id));
  });

  it("refuses a map that narrows the global set", () => {
    expect(() =>
      loadPathMap({
        repoRoot: REPO_ROOT,
        mapPath: MAP_PATH,
        globalPaths: GLOBAL_PATHS,
        readImpl: () => JSON.stringify({ globalPaths: [CHECKER_PATH], pins: {} }),
      }),
    ).toThrow(DesignPinError);
  });

  it("maps only paths that exist — the map cannot rot quietly", () => {
    const map = loadPathMap({ repoRoot: REPO_ROOT, mapPath: MAP_PATH, globalPaths: GLOBAL_PATHS });
    for (const [id, paths] of Object.entries(map.pins)) {
      for (const p of paths) {
        expect(existsSync(join(REPO_ROOT, p)), `${id} -> ${p}`).toBe(true);
      }
    }
    for (const p of GLOBAL_PATHS) expect(existsSync(join(REPO_ROOT, p)), p).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2/3. Behind, ancestor-only, empty
// ---------------------------------------------------------------------------

describe("what BEHIND means", () => {
  it("is behind when a governed drawing moved past the pinned revision", () => {
    const result = classifyPinFreshness({
      pin: pin(),
      perPath: [{ path: "specs/app-lifecycle-cards.html", head: [C, B, A], reachable: [B, A] }],
    });
    expect(result.outcome).toBe("behind");
    expect(result.unadopted).toEqual([C]);
  });

  it("is current when every listed revision is reachable from the pin", () => {
    const result = classifyPinFreshness({
      pin: pin(),
      perPath: [{ path: "specs/app-lifecycle-cards.html", head: [B, A], reachable: [B, A] }],
    });
    expect(result.outcome).toBe("current");
    expect(result.unadopted).toEqual([]);
  });

  it("is current when no revision touches the governed drawings at all", () => {
    const result = classifyPinFreshness({
      pin: pin(),
      perPath: [{ path: "specs/app-lifecycle-cards.html", head: [], reachable: [] }],
    });
    expect(result.outcome).toBe("current");
  });

  it("asks EVERY governed drawing, and one behind drawing is enough", () => {
    const result = classifyPinFreshness({
      pin: pin({ paths: ["specs/one.html", "specs/two.html"] }),
      perPath: [
        { path: "specs/one.html", head: [A], reachable: [A] },
        { path: "specs/two.html", head: [C, A], reachable: [A] },
      ],
    });
    expect(result.outcome).toBe("behind");
    expect(result.unadopted).toEqual([C]);
  });
});

describe("the event classes", () => {
  const behind = readerStub({
    head: { "specs/app-lifecycle-cards.html": [C, B, A] },
    reachable: { "specs/app-lifecycle-cards.html": [B, A] },
  });
  const current = readerStub({
    head: { "specs/app-lifecycle-cards.html": [B, A] },
    reachable: { "specs/app-lifecycle-cards.html": [B, A] },
  });
  const pins = [pin()];

  it("is RED on a push to main when a pin is behind", async () => {
    const r = await run({
      env: { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      reader: behind,
      pins,
    });
    expect(r.code).toBe(1);
    expect(r.all).toContain("chat-hitl-lifecycle");
  });

  it("WARNS and exits 0 on a pull request touching no mapped path", async () => {
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      reader: behind,
      pins,
      touched: ["README.md"],
      argv: ["--github-annotations"],
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning");
  });

  it("is RED on a pull request that touches a mapped lifecycle path", async () => {
    const map = loadPathMap({ repoRoot: REPO_ROOT, mapPath: MAP_PATH, globalPaths: GLOBAL_PATHS });
    const mapped = map.pins["chat-hitl-lifecycle"][0];
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      reader: behind,
      pins,
      touched: [mapped],
    });
    expect(r.code).toBe(1);
  });

  it("is RED on a pull request that touches a global path", async () => {
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      reader: behind,
      pins,
      touched: [CHECKER_PATH],
    });
    expect(r.code).toBe(1);
  });

  it("exits 0 in EVERY event class when the pin is current", async () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_EVENT_NAME: "merge_group" },
      {},
    ]) {
      const r = await run({ env, reader: current, pins });
      expect(r.code, JSON.stringify(env)).toBe(0);
    }
  });

  it("treats an unset diff base as every pin touched (fail-closed)", async () => {
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_PIN_DRIFT_DIFF_BASE: "" },
      reader: behind,
      pins,
      touched: ["README.md"],
    });
    expect(r.code).toBe(1);
  });

  it("resolveTouchedPins gives a global path every id and a mapped path its own", () => {
    const map = { pins: { one: ["src/one.ts"], two: ["src/two/"] } };
    const globalPaths = ["scripts/ci/x.mjs"];
    expect(resolveTouchedPins({ touchedPaths: ["README.md"], map, globalPaths })).toEqual([]);
    expect(resolveTouchedPins({ touchedPaths: ["src/one.ts"], map, globalPaths })).toEqual(["one"]);
    expect(resolveTouchedPins({ touchedPaths: ["src/two/a.ts"], map, globalPaths })).toEqual(["two"]);
    expect(resolveTouchedPins({ touchedPaths: ["scripts/ci/x.mjs"], map, globalPaths })).toEqual([
      "one",
      "two",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The gate could not run
// ---------------------------------------------------------------------------

describe("it refuses to certify an uninspected pin", () => {
  const pins = [pin()];

  it("exits 2 with no credential", async () => {
    const r = await run({ env: { DESIGN_SOURCE_TOKEN: "" }, reader: null, pins });
    expect(r.code).toBe(2);
    expect(r.err).toContain("could not run");
    expect(r.err).toContain("no credential");
  });

  it("exits 2 when the source refuses the read", async () => {
    const r = await run({ reader: readerStub({ throws: "list" }), pins });
    expect(r.code).toBe(2);
    expect(r.err).toContain("could not run");
    expect(r.err).toContain("refused");
  });

  it("exits 2 when the read does not complete", async () => {
    const r = await run({ reader: readerStub({ throws: "branch" }), pins });
    expect(r.code).toBe(2);
    expect(r.err).toContain("could not run");
  });

  it("exits 2 when the answer cannot be read as data", async () => {
    const r = await run({ reader: readerStub({ throws: "unreadable" }), pins });
    expect(r.code).toBe(2);
    expect(r.err).toContain("could not run");
  });

  it("exits 2 when the pin files cannot be read", async () => {
    const r = await run({
      pins: () => {
        throw new DesignPinError("the pin files could not be read");
      },
      reader: readerStub(),
    });
    expect(r.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Disclosure
// ---------------------------------------------------------------------------

describe("the public message discloses nothing about the design source", () => {
  const behindResult = {
    id: "chat-hitl-lifecycle",
    authority: "scripts/audit/chat-hitl-acceptance-manifest.json",
    mirror: "scripts/audit/chat-hitl-anchor-contract.json",
    outcome: "behind",
    unadopted: [C, B],
  };

  it("names the pin and the contract, and says the pin has un-adopted ratifications", () => {
    const message = formatBehindMessage([behindResult]);
    expect(message).toContain("chat-hitl-lifecycle");
    expect(message).toContain("scripts/audit/chat-hitl-acceptance-manifest.json");
    expect(message.toLowerCase()).toContain("un-adopted");
    expect(message).toContain(MOVE_RULE);
  });

  it("says NOTHING about the design source — no revision, no path, no count, no date", () => {
    const message = formatBehindMessage([behindResult]);
    expect(message).not.toMatch(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/);
    expect(message.toLowerCase()).not.toContain("commit");
    expect(message.toLowerCase()).not.toContain("upstream");
    expect(message).not.toContain("specs/");
    expect(message).not.toContain("@");
    // A count and a date are facts about a private source as much as a
    // revision is. The cheapest bound that holds both out is to hold every
    // number out.
    expect(message).not.toMatch(/\d/);
  });

  it("holds the same bound over everything the CLI prints, red and warning alike", async () => {
    const behind = readerStub({
      head: { "specs/app-lifecycle-cards.html": [C, B, A] },
      reachable: { "specs/app-lifecycle-cards.html": [B, A] },
    });
    for (const env of [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      { GITHUB_EVENT_NAME: "pull_request" },
    ]) {
      const r = await run({
        env,
        reader: behind,
        pins: [pin()],
        touched: ["README.md"],
        argv: ["--github-annotations"],
      });
      // The annotation newline escape (%0A) is transport, not content.
      const text = r.all.replaceAll("%0A", "");
      expect(text, JSON.stringify(env)).not.toMatch(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/);
      expect(text.toLowerCase(), JSON.stringify(env)).not.toContain("upstream");
      expect(text, JSON.stringify(env)).not.toContain("specs/");
      expect(text, JSON.stringify(env)).not.toContain("@");
      expect(text, JSON.stringify(env)).not.toMatch(/\d/);
    }
  });

  it("holds it over the could-not-run messages too", async () => {
    for (const reader of [null, readerStub({ throws: "list" }), readerStub({ throws: "unreadable" })]) {
      const r = await run({
        env: reader === null ? { DESIGN_SOURCE_TOKEN: "" } : {},
        reader,
        pins: [pin()],
      });
      expect(r.code).toBe(2);
      expect(r.all).not.toMatch(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/);
      expect(r.all).not.toContain("specs/");
      expect(r.all).not.toMatch(/\d/);
    }
  });

  it("gives the detail only to a reader with access, never in a public log", async () => {
    const behind = readerStub({
      head: { "specs/app-lifecycle-cards.html": [C, B, A] },
      reachable: { "specs/app-lifecycle-cards.html": [B, A] },
    });
    const local = await run({ argv: ["--detail"], reader: behind, pins: [pin()] });
    expect(local.all).toContain(C);

    const inCi = await run({
      argv: ["--detail", "--github-annotations"],
      env: { GITHUB_ACTIONS: "true" },
      reader: behind,
      pins: [pin()],
    });
    expect(inCi.code).toBe(2);
    expect(inCi.all).not.toContain(C);
  });
});

// ---------------------------------------------------------------------------
// The verdict function, directly
// ---------------------------------------------------------------------------

describe("decide", () => {
  const behind = [{ id: "chat-hitl-lifecycle", outcome: "behind", unadopted: [C] }];

  it("reds every behind pin on a push to main and on dispatch", () => {
    for (const event of ["push-main", "workflow_dispatch"]) {
      expect(decide({ event, results: behind, touchedPinIds: [] }).exitCode, event).toBe(1);
    }
  });

  it("warns on a pull request that adopts no behind pin", () => {
    const verdict = decide({ event: "pull_request", results: behind, touchedPinIds: [] });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.warning).toHaveLength(1);
  });

  it("reds a pull request that touches the behind pin's paths", () => {
    const verdict = decide({
      event: "pull_request",
      results: behind,
      touchedPinIds: ["chat-hitl-lifecycle"],
    });
    expect(verdict.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The convergence round's findings
// ---------------------------------------------------------------------------

describe("the disclosure bound holds over the CLEAN path too", () => {
  const current = () =>
    readerStub({
      head: { "specs/app-lifecycle-cards.html": [A] },
      reachable: { "specs/app-lifecycle-cards.html": [A] },
    });

  it("carries none of the banned words, and no digit, when every pin is current", async () => {
    // The green path is public output like every other. The word `commit` is
    // one of the words design-pin-drift's own assertion holds out, and the
    // earlier wording ("every commit-bearing design pin is current") carried
    // it — on the ONE path the disclosure block did not exercise.
    for (const env of [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" },
      { GITHUB_EVENT_NAME: "pull_request" },
    ]) {
      const r = await run({ env, reader: current(), pins: [pin()], argv: ["--github-annotations"] });
      const text = r.all.replaceAll("%0A", "");
      expect(r.code, JSON.stringify(env)).toBe(0);
      expect(text.toLowerCase(), JSON.stringify(env)).not.toContain("commit");
      expect(text.toLowerCase(), JSON.stringify(env)).not.toContain("upstream");
      expect(text, JSON.stringify(env)).not.toContain("specs/");
      expect(text, JSON.stringify(env)).not.toContain("@");
      expect(text, JSON.stringify(env)).not.toMatch(/\d/);
    }
  });

  it("holds `commit` out of the behind path and the could-not-run path as well", async () => {
    const behind = readerStub({
      head: { "specs/app-lifecycle-cards.html": [B, A] },
      reachable: { "specs/app-lifecycle-cards.html": [A] },
    });
    const cases = [
      await run({ env: { GITHUB_EVENT_NAME: "pull_request" }, reader: behind, pins: [pin()] }),
      await run({ env: { DESIGN_SOURCE_TOKEN: "" }, reader: null, pins: [pin()] }),
    ];
    for (const r of cases) expect(r.all.toLowerCase()).not.toContain("commit");
  });
});

describe("a diff that cannot be read fails closed rather than throwing", () => {
  it("exits 2 when the diff itself fails, not only when the base does not resolve", async () => {
    // `rev-parse` was guarded and `git diff` was not, so a diff failure left
    // the process by an uncaught exception — the wrong exit code, and a stack
    // trace is not output this gate controls.
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      reader: readerStub(),
      pins: [pin()],
      argv: [],
      touched: [],
    });
    expect(r.code).toBe(0);

    const out = [];
    const err = [];
    const code = await runCli({
      env: { DESIGN_PIN_DRIFT_DIFF_BASE: "base", DESIGN_SOURCE_TOKEN: "t", GITHUB_EVENT_NAME: "pull_request" },
      pins: [pin()],
      createReader: () => readerStub(),
      runGit: (args) => {
        if (args[0] === "rev-parse") return "";
        throw new Error("fatal: bad revision");
      },
      log: (l) => out.push(String(l)),
      logError: (l) => err.push(String(l)),
    });
    expect(code).toBe(2);
    expect([...out, ...err].join("\n")).toContain("could not run");
  });
});
