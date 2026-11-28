// border-words tests (cinatra#4848): the vendor gate and class 2 of the
// application border gate read the words the pinned extensions declare in
// their own manifest (`cinatra.borderWords`), plus a temporary shrink-only
// bridge; the gate code names no word.
//
//   B1 the declaration's rules (and parity with the SDK's validator);
//   B2 a declared word is found by both gates without any edit to gate code;
//   B3 the bridge: a word both in the bridge and declared fails; growth
//      against the base fails; a word that left it against the base fails
//      unless a pinned pack declares it in the same list; a malformed or
//      missing bridge is a scanner error; every pinned package must be found
//      in the tree by its manifest name;
//   B4 a pinned pack without the declaration: a warning only while the
//      bridge's shrink-only `packages` list names it; a newly pinned, renamed
//      or no-longer-declaring pack fails, and the list cannot grow;
//   B5 the real tree: no problem, and the gate sources spell no bridge word;
//   B6 when a pin advances, the pack declares (cinatra#4896): a pack whose
//      commit in a lock differs from the base (or that is new to a lock) must
//      carry a valid declaration at the new commit and leave the bridge's
//      `packages` list; an empty `packages` list leaves no bridge word; an
//      unreadable base or lock is a scanner error.
//
// Fixture trees live under a temporary directory and use an owner outside the
// organisation's shape (`@example-org/...`); they are removed after the suite.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as borderWords from "../lib/border-words.mjs";
import {
  BRIDGE_REL,
  BorderWordsError,
  borderWordsIssues,
  bridgeAtRef,
  bridgeGrowth,
  bridgeShrinkProblems,
  loadBorderWordRules,
  loadBorderWords,
} from "../lib/border-words.mjs";
import { scanVendorTokens } from "../vendor-token-core-gate.mjs";
import { scanApplicationBorder } from "../application-border-gate.mjs";
import { borderWordsIssues as sdkBorderWordsIssues } from "../../../packages/sdk-extensions/src/border-words.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SDK_FILES = ["packages/sdk-extensions/src/border-words.ts", "packages/sdk-extensions/src/host-context.ts"];
const RULES = loadBorderWordRules(REPO_ROOT);

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NO_WORD = { vendor: [], domain: [], reason: "fixture: a generic pack" };

/**
 * A fixture repository: the SDK sources the rules are read from, a bridge, and
 * one pinned pack per entry of `packs` ({ name: borderWords | undefined }).
 * The first pack also claims an object type, so the class 1 vocabulary is not
 * empty.
 */
function makeTree({ packs, bridge = { vendor: [], domain: [] }, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "border-words-"));
  roots.push(root);
  for (const rel of SDK_FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(root, rel));
  }
  const names = Object.keys(packs);
  const all = {
    "package.json": JSON.stringify({
      name: "example-app",
      cinatra: { devExtensions: Object.fromEntries(names.map((n) => [n, "0.0.0"])) },
    }),
    [BRIDGE_REL]: JSON.stringify({ note: "fixture", packages: [], ...bridge }),
    ...files,
  };
  names.forEach((name, i) => {
    const cinatra = { kind: name.endsWith("-connector") ? "connector" : "agent" };
    if (i === 0) Object.assign(cinatra, { kind: "artifact", artifact: { objectTypes: [{ type: "@example-org/widget:card" }] } });
    if (packs[name] !== undefined) cinatra.borderWords = packs[name];
    all[`extensions/example-org/${name.split("/")[1]}/package.json`] = JSON.stringify({ name, cinatra });
  });
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("B1 the declaration's rules", () => {
  const cases = [
    [{ vendor: ["acme"], domain: ["ticket"] }, 0],
    [NO_WORD, 0],
    [undefined, 1],
    [["acme"], 1],
    [{ vendor: ["acme"] }, 1], // domain missing
    [{ vendor: [], domain: [] }, 1], // no word and no reason
    [{ vendor: ["acme"], domain: [], reason: "x" }, 1], // a reason beside a word
    [{ vendor: [], domain: [], reason: " " }, 1],
    [{ vendor: ["Acme"], domain: [] }, 1], // not lower case
    [{ vendor: ["acme-crm"], domain: [] }, 1], // not one token
    [{ vendor: ["a"], domain: [] }, 1], // too short
    [{ vendor: ["connector"], domain: [] }, 1], // a kind word
    [{ vendor: [], domain: ["authsession"] }, 1], // a host port name, lower-cased
    [{ vendor: ["acme", "acme"], domain: [] }, 1], // repeated
    [{ vendor: ["acme"], domain: ["acme"] }, 1], // in both lists
    [{ vendor: ["acme"], domain: [], extra: 1 }, 1], // unknown key
  ];

  for (const [decl, n] of cases) {
    it(`${JSON.stringify(decl)} has ${n === 0 ? "no" : "a"} problem, the same in the gate and in the SDK`, () => {
      const gate = borderWordsIssues(decl, RULES);
      expect(gate.length > 0).toBe(n > 0);
      expect(gate).toEqual(sdkBorderWordsIssues(decl));
    });
  }

  it("the rules' data is read from the SDK source, never re-listed", () => {
    expect(RULES.reserved.has("connector")).toBe(true);
    expect(RULES.hostPorts.has("objects")).toBe(true);
    expect(RULES.pattern.test("wp")).toBe(true);
  });
});

describe("B2 a declared word is found by both gates without any edit to gate code", () => {
  const files = {
    "src/lib/acme-api.ts": "export const a = 1;\n",
    "src/lib/importer.ts": `import { a } from "./acme-api";\nexport const b = a;\n`,
    "src/lib/ticket-store.ts": "export function saveTicket() {}\n",
    "src/lib/plain.ts": "export const c = 1;\n",
  };
  const root = makeTree({
    packs: {
      "@example-org/widget-artifacts": NO_WORD,
      "@example-org/acme-connector": { vendor: ["acme"], domain: [] },
      "@example-org/ticket-agent": { vendor: [], domain: ["ticket"] },
    },
    files,
  });
  const list = Object.keys(files);

  it("the words are the union of the declarations (and the bridge)", () => {
    const words = loadBorderWords(root);
    expect(words.words).toEqual({ vendor: ["acme"], domain: ["ticket"] });
    expect(words.declared.vendor.get("acme")).toEqual(["@example-org/acme-connector"]);
    expect(words.problems).toEqual([]);
    expect(words.warnings).toEqual([]);
  });

  it("the vendor gate finds the declared vendor word in a path and an import specifier", () => {
    const occ = scanVendorTokens(root, list);
    expect(occ).toEqual({
      "src/lib/acme-api.ts :: path :: acme": 1,
      "src/lib/importer.ts :: import :: ./acme-api": 1,
    });
  });

  it("class 2 finds the declared domain word in a module path", () => {
    const live = scanApplicationBorder(root, { files: list });
    expect(live.names).toEqual({ "src/lib/ticket-store.ts :: name :: ticket": 1 });
  });

  it("the same word declared a vendor word by one pack and a domain word by another fails", () => {
    const r = makeTree({
      packs: {
        "@example-org/widget-artifacts": NO_WORD,
        "@example-org/acme-connector": { vendor: ["acme"], domain: [] },
        "@example-org/acme-agent": { vendor: [], domain: ["acme"] },
      },
    });
    expect(loadBorderWords(r).problems.join("\n")).toMatch(/"acme" is declared a vendor word by .* and a domain word by/);
  });

  it("a malformed declaration fails, naming the pack", () => {
    const r = makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD, "@example-org/acme-connector": { vendor: ["Acme"], domain: [] } } });
    expect(loadBorderWords(r).problems.join("\n")).toMatch(/@example-org\/acme-connector: .*not one lower-case token/);
  });

  it("a pack the locks do not pin is not read", () => {
    const r = makeTree({
      packs: { "@example-org/widget-artifacts": NO_WORD },
      files: { "extensions/example-org/stray-connector/package.json": JSON.stringify({ name: "@example-org/stray-connector", cinatra: { borderWords: { vendor: ["stray"], domain: [] } } }) },
    });
    expect(loadBorderWords(r).words.vendor).toEqual([]);
  });
});

describe("B3 the bridge", () => {
  it("bridge words are read beside declared words", () => {
    const r = makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD }, bridge: { vendor: ["legacy"], domain: ["olddomain"] } });
    expect(loadBorderWords(r).words).toEqual({ vendor: ["legacy"], domain: ["olddomain"] });
  });

  it("a word both in the bridge and declared fails", () => {
    const r = makeTree({
      packs: { "@example-org/widget-artifacts": NO_WORD, "@example-org/acme-connector": { vendor: ["acme"], domain: [] } },
      bridge: { vendor: ["acme"], domain: [] },
    });
    expect(loadBorderWords(r).problems).toEqual([
      `"acme" is in the bridge (${BRIDGE_REL}, vendor) and declared by @example-org/acme-connector — remove it from the bridge`,
    ]);
  });

  it("growth against the base is refused; shrinking is not growth", () => {
    const base = { vendor: ["acme", "legacy"], domain: ["ticket"] };
    expect(bridgeGrowth(base, { vendor: ["acme", "legacy", "newword"], domain: ["ticket", "other"] })).toEqual([
      "domain: other",
      "vendor: newword",
    ]);
    expect(bridgeGrowth(base, { vendor: ["legacy"], domain: [] })).toEqual([]);
  });

  it("the base bridge is read from the base reference (none at a base that predates it)", () => {
    const r = makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD }, bridge: { vendor: ["legacy"], domain: [] } });
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: r,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "fixture");
    const base = git("rev-parse", "HEAD").trim();
    expect(bridgeAtRef(r, base, RULES)).toEqual({ vendor: ["legacy"], domain: [], packages: [] });
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: ["legacy", "grown"], domain: [], packages: [] }));
    expect(bridgeGrowth(bridgeAtRef(r, base, RULES), loadBorderWords(r).bridge)).toEqual(["vendor: grown"]);
    git("rm", "-q", "-f", BRIDGE_REL);
    git("commit", "-q", "--no-verify", "-m", "no bridge");
    expect(bridgeAtRef(r, git("rev-parse", "HEAD").trim(), RULES)).toBeNull();
  });

  it("a missing, malformed or duplicated bridge is a scanner error", () => {
    const r = makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD } });
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: ["x-y"], domain: [], packages: [] }));
    expect(() => loadBorderWords(r)).toThrow(BorderWordsError);
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: ["acme"], domain: ["acme"], packages: [] }));
    expect(() => loadBorderWords(r)).toThrow(/appears twice/);
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: [], domain: [] }));
    expect(() => loadBorderWords(r)).toThrow(/"packages" must be an array/);
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: [], domain: [], packages: ["Not A Name"] }));
    expect(() => loadBorderWords(r)).toThrow(/is not a package name/);
    writeFileSync(join(r, BRIDGE_REL), JSON.stringify({ vendor: [], domain: [], packages: ["@example-org/a", "@example-org/a"] }));
    expect(() => loadBorderWords(r)).toThrow(/appears twice in "packages"/);
    rmSync(join(r, BRIDGE_REL));
    expect(() => loadBorderWords(r)).toThrow(/is missing/);
  });

  it("an absent or under-populated extension tree is a scanner error", () => {
    const r = makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD } });
    writeFileSync(join(r, "package.json"), JSON.stringify({ cinatra: { devExtensions: { "@example-org/widget-artifacts": "0", "@example-org/gone-agent": "0" } } }));
    expect(() => loadBorderWords(r)).toThrow(/refusing to read a partial set/);
  });
});

describe("B3b a word leaves the bridge only into a declaration of its own list", () => {
  const base = { vendor: ["acme", "legacy"], domain: ["ticket"] };
  const packs = { "@example-org/widget-artifacts": NO_WORD, "@example-org/acme-connector": { vendor: ["acme"], domain: [] } };

  it("a word removed while a pinned pack declares it in the same list passes", () => {
    const now = loadBorderWords(makeTree({ packs, bridge: { vendor: ["legacy"], domain: ["ticket"] } }));
    expect(bridgeShrinkProblems(base, now)).toEqual([]);
  });

  it("a word removed that no pinned pack declares fails, naming the word", () => {
    const now = loadBorderWords(makeTree({ packs, bridge: { vendor: [], domain: ["ticket"] } }));
    expect(bridgeShrinkProblems(base, now)).toEqual(["vendor: legacy"]);
  });

  it("a word removed while the pack that declares it is unpinned in the same change fails", () => {
    const now = loadBorderWords(makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD }, bridge: { vendor: ["legacy"], domain: ["ticket"] } }));
    expect(bridgeShrinkProblems(base, now)).toEqual(["vendor: acme"]);
  });

  it("a word declared only in the other list does not cover its removal", () => {
    const now = loadBorderWords(
      makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD, "@example-org/acme-agent": { vendor: [], domain: ["acme"] } }, bridge: { vendor: ["legacy"], domain: ["ticket"] } }),
    );
    expect(bridgeShrinkProblems(base, now)).toEqual(["vendor: acme"]);
  });

  it("a word moved to the other bridge list fails as removed from one and grown in the other", () => {
    const now = loadBorderWords(makeTree({ packs, bridge: { vendor: ["acme"], domain: ["ticket", "legacy"] } }));
    expect(bridgeShrinkProblems(base, now)).toEqual(["vendor: legacy"]);
    expect(bridgeGrowth(base, now.bridge)).toEqual(["domain: legacy"]);
  });

  it("an emptied bridge fails for every word no pinned pack declares", () => {
    const now = loadBorderWords(makeTree({ packs, bridge: { vendor: [], domain: [] } }));
    expect(bridgeShrinkProblems(base, now)).toEqual(["domain: ticket", "vendor: legacy"]);
  });

  it("no base bridge (the introducing change) sets no constraint", () => {
    const now = loadBorderWords(makeTree({ packs, bridge: { vendor: [], domain: [] } }));
    expect(bridgeShrinkProblems(null, now)).toEqual([]);
  });
});

describe("B3c every pinned package must be found by its manifest name", () => {
  const packs = { "@example-org/widget-artifacts": NO_WORD, "@example-org/acme-connector": { vendor: ["acme"], domain: [] } };

  it("a missing pinned directory is not made up for by a stray one", () => {
    const r = makeTree({
      packs,
      files: { "extensions/example-org/stray-connector/package.json": JSON.stringify({ name: "@example-org/stray-connector", cinatra: {} }) },
    });
    rmSync(join(r, "extensions/example-org/acme-connector"), { recursive: true });
    expect(() => loadBorderWords(r)).toThrow(/1 pinned package\(s\) not found under extensions\/: @example-org\/acme-connector/);
  });

  it("the folder name does not matter, but two directories naming one pinned package are a scanner error", () => {
    const r = makeTree({ packs });
    renameSync(join(r, "extensions/example-org/acme-connector"), join(r, "extensions/example-org/renamed"));
    expect(loadBorderWords(r).words.vendor).toEqual(["acme"]);
    mkdirSync(join(r, "extensions/example-org/copy"), { recursive: true });
    copyFileSync(join(r, "extensions/example-org/renamed/package.json"), join(r, "extensions/example-org/copy/package.json"));
    expect(() => loadBorderWords(r)).toThrow(/two extension directories name the pinned package @example-org\/acme-connector/);
  });

  it("a symlinked pack directory is not followed: its package counts as missing", () => {
    const r = makeTree({ packs });
    const outside = mkdtempSync(join(tmpdir(), "border-words-link-"));
    roots.push(outside);
    renameSync(join(r, "extensions/example-org/acme-connector"), join(outside, "acme-connector"));
    symlinkSync(join(outside, "acme-connector"), join(r, "extensions/example-org/acme-connector"));
    expect(() => loadBorderWords(r)).toThrow(/not found under extensions\/: @example-org\/acme-connector/);
  });
});

describe("B4 a pinned pack without the declaration", () => {
  const QUIET = "@example-org/quiet-agent";
  const packs = { "@example-org/widget-artifacts": NO_WORD, [QUIET]: undefined };
  const notListed = (name) =>
    `${name}: the pinned pack declares no cinatra.borderWords and is not in the bridge's "packages" list ` +
    `(a newly pinned or renamed pack, or one that dropped its declaration, must declare)`;

  it("is a warning, listing the pack, while the bridge's packages list names it", () => {
    const words = loadBorderWords(makeTree({ packs, bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] } }));
    expect(words.undeclared).toEqual([QUIET]);
    expect(words.problems).toEqual([]);
    expect(words.warnings).toHaveLength(1);
    expect(words.warnings[0]).toMatch(/@example-org\/quiet-agent/);
    expect(words.warnings[0]).toMatch(/shrink-only "packages" list/);
  });

  it("a newly pinned pack the list does not name fails, even while the bridge holds words", () => {
    const words = loadBorderWords(makeTree({ packs, bridge: { vendor: ["legacy"], domain: [] } }));
    expect(words.problems).toEqual([notListed(QUIET)]);
    expect(words.warnings).toEqual([]);
  });

  it("a re-pinned pack (same name, new commit) stays listed and passes", () => {
    const r = makeTree({ packs, bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] } });
    writeFileSync(join(r, "package.json"), JSON.stringify({ cinatra: { devExtensions: { "@example-org/widget-artifacts": "0", [QUIET]: "1.2.3" } } }));
    const words = loadBorderWords(r);
    expect(words.problems).toEqual([]);
    expect(words.warnings[0]).toMatch(/shrink-only "packages" list/);
  });

  it("a renamed pack is a new pin: the new name must declare and the old name must leave the list", () => {
    const NEW = "@example-org/quieter-agent";
    const words = loadBorderWords(
      makeTree({ packs: { "@example-org/widget-artifacts": NO_WORD, [NEW]: undefined }, bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] } }),
    );
    expect(words.problems).toEqual([
      `${QUIET}: in the bridge's "packages" list (${BRIDGE_REL}) but not pinned — remove it from the list`,
      notListed(NEW),
    ]);
  });

  it("a pack that declared and drops the declaration fails (it is not in the list, and the list cannot grow)", () => {
    const base = { vendor: ["legacy"], domain: [], packages: [] };
    const words = loadBorderWords(makeTree({ packs, bridge: base }));
    expect(words.problems).toEqual([notListed(QUIET)]);
    const relisted = loadBorderWords(makeTree({ packs, bridge: { ...base, packages: [QUIET] } }));
    expect(relisted.problems).toEqual([]);
    expect(bridgeGrowth(base, relisted.bridge)).toEqual([`packages: ${QUIET}`]);
  });

  it("a listed pack that declares must leave the list", () => {
    const words = loadBorderWords(
      makeTree({ packs: { ...packs, [QUIET]: NO_WORD }, bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] } }),
    );
    expect(words.problems).toEqual([
      `${QUIET}: declares cinatra.borderWords but is still in the bridge's "packages" list (${BRIDGE_REL}) — remove it from the list`,
    ]);
  });

  it("a declaration that becomes invalid fails, listed or not", () => {
    for (const packages of [[], [QUIET]]) {
      const words = loadBorderWords(makeTree({ packs: { ...packs, [QUIET]: { vendor: ["Acme"], domain: [] } }, bridge: { vendor: [], domain: [], packages } }));
      expect(words.problems.some((p) => p.startsWith(`${QUIET}: cinatra.borderWords.vendor: "Acme"`))).toBe(true);
      // a listed pack that now carries a declaration, even an invalid one, must also leave the list
      expect(words.problems.some((p) => p.includes(`still in the bridge's "packages" list`))).toBe(packages.length > 0);
    }
  });

  it("the packages list only shrinks against the base", () => {
    const base = { vendor: [], domain: [], packages: [QUIET] };
    expect(bridgeGrowth(base, { vendor: [], domain: [], packages: [QUIET, "@example-org/new-agent"] })).toEqual(["packages: @example-org/new-agent"]);
    expect(bridgeGrowth(base, { vendor: [], domain: [], packages: [] })).toEqual([]);
  });
});

describe("B5 the real tree", () => {
  const words = loadBorderWords(REPO_ROOT);

  it("has no border-word problem", () => {
    expect(words.problems).toEqual([]);
  });

  it("the gates read words for both lists", () => {
    expect(words.words.vendor.length).toBeGreaterThan(0);
    expect(words.words.domain.length).toBeGreaterThan(0);
  });

  it("the gate sources spell no border word as a string literal (the words live in the packs and the bridge)", () => {
    const all = [...words.words.vendor, ...words.words.domain];
    for (const rel of ["scripts/audit/vendor-token-core-gate.mjs", "scripts/audit/application-border-gate.mjs", "scripts/audit/lib/border-words.mjs"]) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      const spelled = all.filter((w) => text.includes(`"${w}"`) || text.includes(`'${w}'`));
      expect(spelled, rel).toEqual([]);
    }
  });
});

describe("B6 when a pin advances, the pack declares", () => {
  // red-first-expect: AssertionError: pinAdvanceProblems is exported: expected undefined to be type of 'function'
  const QUIET = "@example-org/quiet-agent";
  const WIDGET = "@example-org/widget-artifacts";
  const LOCK = "cinatra-dev-extensions.lock.json";
  const OLD = "1".repeat(40);
  const NEW = "2".repeat(40);
  const W = "3".repeat(40);
  const lock = (pins) =>
    JSON.stringify({ schemaVersion: 1, packages: Object.entries(pins).map(([packageName, resolvedSha]) => ({ packageName, repo: packageName.slice(1), resolvedSha })) });

  /** A fixture repository whose base commit pins `basePins`; the worktree (the head) then pins `headPins`. */
  function repoWithBase({ basePins, headPins, packs, bridge }) {
    const r = makeTree({ packs, bridge, files: { [LOCK]: lock(basePins) } });
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: r,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "base");
    writeFileSync(join(r, LOCK), lock(headPins));
    return { root: r, base: git("rev-parse", "HEAD").trim() };
  }

  function pinRule(root, base) {
    expect(borderWords.pinAdvanceProblems, "pinAdvanceProblems is exported").toBeTypeOf("function");
    return borderWords.pinAdvanceProblems(root, base, loadBorderWords(root));
  }

  it("a pin that advances to a commit that declares, with its row removed, passes", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W, [QUIET]: OLD },
      headPins: { [WIDGET]: W, [QUIET]: NEW },
      packs: { [WIDGET]: NO_WORD, [QUIET]: NO_WORD },
      bridge: { vendor: [], domain: [], packages: [] },
    });
    expect(loadBorderWords(root).problems).toEqual([]);
    expect(pinRule(root, base)).toEqual({ ran: true, problems: [] });
  });

  it("a pin that advances to a commit without the declaration fails, naming the pack and both commits", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W, [QUIET]: OLD },
      headPins: { [WIDGET]: W, [QUIET]: NEW },
      packs: { [WIDGET]: NO_WORD, [QUIET]: undefined },
      bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] },
    });
    const { ran, problems } = pinRule(root, base);
    expect(ran).toBe(true);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(`${QUIET}: its pin advanced (${LOCK}: ${OLD} -> ${NEW})`);
    expect(problems[0]).toContain("cinatra.borderWords is absent");
    expect(problems[1]).toContain(`${QUIET}: its pin advanced (${LOCK}: ${OLD} -> ${NEW}) but its row stays in the bridge`);
  });

  it("a pin that advances to a commit that declares, while its row stays in the bridge, fails", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W, [QUIET]: OLD },
      headPins: { [WIDGET]: W, [QUIET]: NEW },
      packs: { [WIDGET]: NO_WORD, [QUIET]: { vendor: [], domain: ["quietword"] } },
      bridge: { vendor: [], domain: [], packages: [QUIET] },
    });
    const { problems } = pinRule(root, base);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${QUIET}: its pin advanced (${LOCK}: ${OLD} -> ${NEW}) but its row stays in the bridge's "packages" list`);
  });

  it("a pin that does not move is not judged, declaration or not", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W, [QUIET]: OLD },
      headPins: { [WIDGET]: W, [QUIET]: OLD },
      packs: { [WIDGET]: NO_WORD, [QUIET]: undefined },
      bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] },
    });
    expect(pinRule(root, base)).toEqual({ ran: true, problems: [] });
  });

  it("a pack newly added to a lock without the declaration fails (not pinned there at the base)", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W },
      headPins: { [WIDGET]: W, [QUIET]: NEW },
      packs: { [WIDGET]: NO_WORD, [QUIET]: undefined },
      bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] },
    });
    const { problems } = pinRule(root, base);
    expect(problems.some((p) => p.startsWith(`${QUIET}: its pin advanced (${LOCK}: not pinned -> ${NEW})`) && p.includes("cinatra.borderWords is absent"))).toBe(true);
  });

  it("a pack removed from a lock is not judged", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W, [QUIET]: OLD },
      headPins: { [WIDGET]: W },
      packs: { [WIDGET]: NO_WORD, [QUIET]: undefined },
      bridge: { vendor: ["legacy"], domain: [], packages: [QUIET] },
    });
    expect(pinRule(root, base)).toEqual({ ran: true, problems: [] });
  });

  it("an empty packages list with words left in the bridge fails", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W },
      headPins: { [WIDGET]: W },
      packs: { [WIDGET]: NO_WORD },
      bridge: { vendor: ["legacy"], domain: ["olddomain"], packages: [] },
    });
    const { problems } = pinRule(root, base);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"packages" list is empty but its word lists still hold 2 word\(s\)/);
  });

  it("an unreadable base or an unparsable lock is a scanner error; no base means the rule did not run", () => {
    const { root, base } = repoWithBase({
      basePins: { [WIDGET]: W },
      headPins: { [WIDGET]: W },
      packs: { [WIDGET]: NO_WORD },
      bridge: { vendor: [], domain: [], packages: [] },
    });
    expect(borderWords.pinAdvanceProblems, "pinAdvanceProblems is exported").toBeTypeOf("function");
    const loaded = loadBorderWords(root);
    expect(() => borderWords.pinAdvanceProblems(root, "0".repeat(40), loaded)).toThrow(BorderWordsError);
    expect(borderWords.pinAdvanceProblems(root, undefined, loaded)).toEqual({ ran: false, problems: [] });
    writeFileSync(join(root, LOCK), "{ not json");
    expect(() => borderWords.pinAdvanceProblems(root, base, loaded)).toThrow(/cannot be parsed/);
    writeFileSync(join(root, LOCK), JSON.stringify({ packages: [{ packageName: WIDGET }] }));
    expect(() => borderWords.pinAdvanceProblems(root, base, loaded)).toThrow(/cannot be parsed/);
  });
});
