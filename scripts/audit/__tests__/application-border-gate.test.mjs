// application-border-gate tests (cinatra#3821).
//
// Every class of the gate has its own describe block, written red first:
//   T-A1 class 1 — a claimed object type id spelled in application code;
//   T-A2 class 2 — a module named for one domain (acceptance case one, the
//        module form: a module that stores the published words of a CMS page);
//   T-A3 class 3 — growth of a module already on the floor (acceptance case
//        one, the growth form);
//   T-A4 the floor mechanics (stale entry, refused growth, the base guard, the
//        vocabulary-born admission, the owner of every entry);
//   T-A5 the test of record over the real tree — this file runs in the root
//        suite on every pull request, so the floor is held there.
//
// Fixture trees live under a temporary directory and use an owner outside the
// organisation's shape (`@example-org/...`); they are removed after the suite.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOMAIN_TOKENS,
  SANCTIONED_MODULES,
  SECTIONS,
  UNASSIGNED_OWNER,
  isExemptFile,
  domainTokenHits,
  countTopLevelValueNames,
  scanApplicationBorder,
  diffGrown,
  diffShrunk,
  sectionCounts,
  countProblems,
  ownerProblems,
  baseRefProblem,
  baseGrowth,
  writeBaselineDoc,
  fileUnchangedAtRef,
} from "../application-border-gate.mjs";
import {
  ClaimedTypeVocabularyError,
  loadClaimedTypeVocabulary,
} from "../lib/claimed-type-vocabulary.mjs";
import { discoverExtensionDirs } from "../extension-produces-deps-gate.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BASELINE_PATH = join(import.meta.dirname, "..", "application-border-gate.baseline.json");

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fixture repository: one artifact extension claiming `@example-org/widget:card`. */
function makeTree(files = {}, { withExtensions = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "application-border-gate-"));
  roots.push(root);
  const all = {
    "package.json": JSON.stringify({
      name: "example-app",
      cinatra: withExtensions ? { devExtensions: { "@example-org/widget-artifacts": "0.0.0" } } : {},
    }),
    ...(withExtensions
      ? {
          "extensions/example-org/widget-artifacts/package.json": JSON.stringify({
            name: "@example-org/widget-artifacts",
            cinatra: { kind: "artifact", artifact: { objectTypes: [{ type: "@example-org/widget:card" }] } },
          }),
        }
      : {}),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function codeFiles(files) {
  return Object.keys(files).filter((rel) => rel.startsWith("src/") || rel.startsWith("packages/"));
}

function scanFixture(files, options = {}) {
  const root = makeTree(files);
  return scanApplicationBorder(root, { files: codeFiles(files), ...options });
}

describe("T-A1 class 1 — a claimed object type id spelled in application code", () => {
  const files = {
    "src/lib/widget-store.ts": `export const kind = "@example-org/widget:card";\n`,
    "src/lib/widget-other.ts": `export function save() { return { typeHint: "@example-org/widget:other" }; }\n`,
    "src/components/widget-view.tsx": `export function View(p: { t: string }) { return p.t === "@example-org/widget:card" ? null : null; }\n`,
    "src/lib/__tests__/widget-store.test.ts": `const id = "@example-org/widget:card";\n`,
    "src/lib/widget-comment.ts": `// "@example-org/widget:card" in a comment only\nexport const x = 1;\n`,
    "src/lib/widget-pinned.ts": `export const PINNED = "@example-org/widget:pinned";\n`,
  };
  const allowlistHits = new Map();
  const live = scanFixture(files, {
    allowlist: new Map([["@example-org/widget:pinned", "fixture reason"]]),
    allowlistHits,
  });

  it("an exact claimed id spelled as a value is a new key, and the check refuses it", () => {
    expect(live.types["src/lib/widget-store.ts :: type :: @example-org/widget:card"]).toBe(1);
    expect(diffGrown({}, live.types)).toContain("src/lib/widget-store.ts :: type :: @example-org/widget:card (0 -> 1)");
  });

  it("an id under a claimed namespace is a new key, and the check refuses it", () => {
    expect(live.types["src/lib/widget-other.ts :: type :: @example-org/widget:other"]).toBe(1);
    expect(diffGrown({}, live.types)).toContain("src/lib/widget-other.ts :: type :: @example-org/widget:other (0 -> 1)");
  });

  it("the same id in a .tsx module as an equality operand is left to the display boundary gate (count once)", () => {
    expect(Object.keys(live.types).some((k) => k.startsWith("src/components/widget-view.tsx"))).toBe(false);
  });

  it("a test file, a comment and an allowlisted id yield no key; the allowlisted id is reported apart", () => {
    const keys = Object.keys(live.types);
    expect(keys.some((k) => k.startsWith("src/lib/__tests__/"))).toBe(false);
    expect(keys.some((k) => k.startsWith("src/lib/widget-comment.ts"))).toBe(false);
    expect(keys.some((k) => k.startsWith("src/lib/widget-pinned.ts"))).toBe(false);
    expect(allowlistHits.get("@example-org/widget:pinned")).toBe(1);
  });

  it("the vocabulary is derived from the claims of the materialized tree", () => {
    const root = makeTree({});
    const vocabulary = loadClaimedTypeVocabulary(root);
    expect([...vocabulary.ids.keys()]).toEqual(["@example-org/widget:card"]);
    expect(vocabulary.ids.get("@example-org/widget:card")).toBe("@example-org/widget-artifacts");
    expect([...vocabulary.namespaces.keys()]).toEqual(["@example-org/widget"]);
  });

  it("a tree without extensions makes the scan a scanner error (never a pass)", () => {
    const root = makeTree({ "src/lib/a.ts": "export const a = 1;\n" }, { withExtensions: false });
    expect(() => scanApplicationBorder(root, { files: ["src/lib/a.ts"] })).toThrow(ClaimedTypeVocabularyError);
  });

  it("an under-populated tree is a scanner error", () => {
    const root = makeTree({
      "package.json": JSON.stringify({
        cinatra: { devExtensions: { "@example-org/widget-artifacts": "0.0.0", "@example-org/other-agent": "0.0.0" } },
      }),
    });
    expect(() => loadClaimedTypeVocabulary(root)).toThrow(ClaimedTypeVocabularyError);
  });

  it("an extension package whose manifest is unreadable is a scanner error (its claims cannot drop silently)", () => {
    const root = makeTree({ "extensions/example-org/broken-artifacts/package.json": "{ not json" });
    expect(() => loadClaimedTypeVocabulary(root)).toThrow(/unreadable or names no package/);
  });
});

describe("T-A2 class 2 — a module named for one domain (acceptance case one, the module form)", () => {
  it("a new module that stores the published words of a CMS page is a new `name :: cms` key, and the check refuses it", () => {
    const before = scanFixture({ "src/lib/artifacts/page-snapshot.ts": "export const a = 1;\n" });
    const after = scanFixture({
      "src/lib/artifacts/page-snapshot.ts": "export const a = 1;\n",
      "src/lib/artifacts/cms-published-words.ts":
        "export function storePublishedWords(pageId: string, words: string) { return { pageId, words }; }\n",
    });
    expect(after.names["src/lib/artifacts/cms-published-words.ts :: name :: cms"]).toBe(1);
    expect(diffGrown(before.names, after.names)).toEqual([
      "src/lib/artifacts/cms-published-words.ts :: name :: cms (0 -> 1)",
    ]);
  });

  it("the sanctioned member-invitation mail yields no key", () => {
    expect(SANCTIONED_MODULES.has("src/lib/org-invitation-email.ts")).toBe(true);
    const live = scanFixture({ "src/lib/org-invitation-email.ts": "export const a = 1;\n" });
    expect(Object.keys(live.names)).toEqual([]);
  });

  it("a camelCase file is split into whole sub-tokens (cmsPublishedWords is a hit)", () => {
    expect(domainTokenHits("src/lib/cmsPublishedWords.ts").get("cms")).toBe(1);
  });

  it("a word that only contains a token is not a hit (emailer-core is not email)", () => {
    expect(domainTokenHits("src/lib/emailer-core.ts").size).toBe(0);
  });

  it("a package reads its directory name and the segments after its src", () => {
    const hits = domainTokenHits("packages/trigger-email-send/src/mcp/handlers.ts");
    expect(hits.get("email")).toBe(1);
    expect(domainTokenHits("packages/agents/src/lib/tools.ts").size).toBe(0);
  });

  it("the frozen token set holds no vendor word (one path segment is counted by one gate)", () => {
    for (const vendor of ["wordpress", "wp", "drupal", "linkedin", "github", "youtube", "resend", "google", "twenty", "apollo"]) {
      expect(DOMAIN_TOKENS).not.toContain(vendor);
    }
  });
});

describe("T-A3 class 3 — growth of a module on the floor (acceptance case one, the growth form)", () => {
  const source = [
    `import { save } from "./store";`,
    `export function captureSnapshot(input: { id: string }) {`,
    `  return save(input);`,
    `}`,
    `const helper = () => 1;`,
    `export class SnapshotReader {}`,
    `export interface Shape { id: string }`,
    `export type Kind = "a";`,
    "",
  ].join("\n");
  const path = "src/lib/artifacts/cms-snapshot-writer.ts";

  it("counts top-level value declarations only (functions, classes, variables; not types)", () => {
    expect(countTopLevelValueNames(source, path)).toBe(3);
  });

  it("a new top-level function that stores the published words grows the ceiling, and the check refuses it", () => {
    const before = scanFixture({ [path]: source });
    const after = scanFixture({ [path]: source + "export function storePublishedWords() {}\n" });
    expect(before.ceilings[path]).toBe(3);
    expect(diffGrown(before.ceilings, after.ceilings)).toEqual([`${path} (3 -> 4)`]);
  });

  it("a line added inside an existing function leaves the ceiling unchanged", () => {
    const edited = source.replace("  return save(input);", "  const copy = { ...input };\n  return save(copy);");
    const before = scanFixture({ [path]: source });
    const after = scanFixture({ [path]: edited });
    expect(after.ceilings[path]).toBe(before.ceilings[path]);
    expect(diffGrown(before.ceilings, after.ceilings)).toEqual([]);
  });

  it("a module on neither class 1 nor class 2 carries no ceiling", () => {
    const live = scanFixture({ "src/lib/snapshot-writer.ts": source });
    expect(live.ceilings).toEqual({});
  });
});

describe("T-A4 the floor mechanics", () => {
  const doc = (types, owner = "@example-org/widget-agent") => ({
    types: Object.fromEntries(Object.entries(types).map(([k, count]) => [k, { count, owner }])),
    names: {},
    ceilings: {},
  });

  it("a stale entry fails (the floor must ratchet down)", () => {
    expect(diffShrunk({ "a.ts :: type :: @example-org/widget:card": 1 }, {})).toEqual([
      "a.ts :: type :: @example-org/widget:card (1 -> 0)",
    ]);
  });

  it("--write-baseline refuses a grown floor", () => {
    const committed = doc({ "a.ts :: type :: @example-org/widget:card": 1 });
    const live = { types: { "a.ts :: type :: @example-org/widget:card": 2 }, names: {}, ceilings: {} };
    expect(() => writeBaselineDoc(committed, live, { isUnchangedAtBase: () => false })).toThrow(/GROWN/);
  });

  it("--write-baseline writes a shrunk floor, keeps the owners and names a new entry UNASSIGNED on introduction", () => {
    const committed = doc({ "a.ts :: type :: @example-org/widget:card": 2 });
    const live = { types: { "a.ts :: type :: @example-org/widget:card": 1 }, names: {}, ceilings: {} };
    const written = writeBaselineDoc(committed, live, { isUnchangedAtBase: () => false });
    expect(written.types["a.ts :: type :: @example-org/widget:card"]).toEqual({ count: 1, owner: "@example-org/widget-agent" });
    const fresh = writeBaselineDoc(null, live, { isUnchangedAtBase: () => false });
    expect(fresh.types["a.ts :: type :: @example-org/widget:card"].owner).toBe(UNASSIGNED_OWNER);
  });

  it("the base guard refuses a flag-like and an unresolvable reference", () => {
    expect(baseRefProblem("-x", REPO_ROOT, "APPLICATION_BORDER_BASE")).toMatch(/flag-like/);
    expect(baseRefProblem("refs/heads/example-org-no-such-ref", REPO_ROOT, "APPLICATION_BORDER_BASE")).toMatch(/did not resolve/);
  });

  it("the base guard refuses a committed floor grown against the base", () => {
    const base = doc({ "a.ts :: type :: @example-org/widget:card": 1 });
    const committed = doc({ "a.ts :: type :: @example-org/widget:card": 1, "b.ts :: type :: @example-org/widget:card": 1 });
    expect(baseGrowth(base, committed, { isUnchangedAtBase: () => false })).toEqual([
      "types: b.ts :: type :: @example-org/widget:card (0 -> 1)",
    ]);
  });

  it("the vocabulary-born admission holds only for a file byte-identical at the base", () => {
    const base = doc({});
    const committed = {
      types: { "b.ts :: type :: @example-org/widget:card": { count: 1, owner: "x" } },
      names: { "b.ts :: name :: cms": { count: 1, owner: "x" } },
      ceilings: { "b.ts": { count: 2, owner: "x" } },
    };
    // unchanged file: the new type key and its ceiling are admitted; a name key never is
    expect(baseGrowth(base, committed, { isUnchangedAtBase: (f) => f === "b.ts" })).toEqual([
      "names: b.ts :: name :: cms (0 -> 1)",
    ]);
    // changed file: nothing is admitted
    expect(baseGrowth(base, committed, { isUnchangedAtBase: () => false })).toEqual([
      "ceilings: b.ts (0 -> 2)",
      "names: b.ts :: name :: cms (0 -> 1)",
      "types: b.ts :: type :: @example-org/widget:card (0 -> 1)",
    ]);
  });

  it("the vocabulary-born admission covers only a NEW key: a key already on the floor never grows", () => {
    const base = {
      types: { "b.ts :: type :: @example-org/widget:card": { count: 1, owner: "x" } },
      names: {},
      ceilings: { "b.ts": { count: 2, owner: "x" } },
    };
    const committed = {
      types: { "b.ts :: type :: @example-org/widget:card": { count: 2, owner: "x" } },
      names: {},
      ceilings: { "b.ts": { count: 3, owner: "x" } },
    };
    expect(baseGrowth(base, committed, { isUnchangedAtBase: () => true })).toEqual([
      "ceilings: b.ts (2 -> 3)",
      "types: b.ts :: type :: @example-org/widget:card (1 -> 2)",
    ]);
    const live = { types: { "b.ts :: type :: @example-org/widget:card": 2 }, names: {}, ceilings: { "b.ts": 3 } };
    expect(() => writeBaselineDoc(base, live, { isUnchangedAtBase: () => true })).toThrow(/GROWN/);
  });

  it("a count that is not a non-negative integer fails (it would hide growth)", () => {
    const bad = {
      types: { "a.ts :: type :: @example-org/widget:card": { count: "invalid", owner: "x" } },
      names: { "a.ts :: name :: cms": { count: -1, owner: "x" } },
      ceilings: { "a.ts": { owner: "x" } },
    };
    expect(countProblems(bad)).toHaveLength(3);
    expect(countProblems(doc({ "a.ts :: type :: @example-org/widget:card": 1 }))).toEqual([]);
    expect(baseGrowth(doc({}), bad, { isUnchangedAtBase: () => false }).join("\n")).toMatch(/committed floor: .*invalid count/);
    expect(baseGrowth(bad, doc({}), { isUnchangedAtBase: () => false }).join("\n")).toMatch(/base floor: .*invalid count/);
    const live = { types: {}, names: {}, ceilings: {} };
    expect(() => writeBaselineDoc(bad, live, { isUnchangedAtBase: () => false })).toThrow(/invalid counts/);
  });

  it("byte identity is read from the base reference", () => {
    const root = makeTree({ "src/lib/a.ts": "export const a = 1;\n" });
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "fixture");
    const base = git("rev-parse", "HEAD").trim();
    expect(fileUnchangedAtRef(root, base, "src/lib/a.ts")).toBe(true);
    writeFileSync(join(root, "src/lib/a.ts"), "export const a = 2;\n");
    expect(fileUnchangedAtRef(root, base, "src/lib/a.ts")).toBe(false);
    expect(fileUnchangedAtRef(root, base, "src/lib/absent.ts")).toBe(false);
  });

  it("an UNASSIGNED or empty owner fails", () => {
    expect(ownerProblems(doc({ "a.ts :: type :: @example-org/widget:card": 1 }, UNASSIGNED_OWNER))).toHaveLength(1);
    expect(ownerProblems(doc({ "a.ts :: type :: @example-org/widget:card": 1 }, ""))).toHaveLength(1);
    expect(ownerProblems(doc({ "a.ts :: type :: @example-org/widget:card": 1 }))).toEqual([]);
  });

  it("tests, fixtures, test doubles, stories, declarations and documents are exempt; a hand-added generated file is not", () => {
    for (const rel of [
      "src/lib/a.test.ts",
      "src/lib/__tests__/a.ts",
      "src/lib/__fixtures__/a.ts",
      "src/lib/__mocks__/a.ts",
      "src/lib/tests/a.ts",
      "src/components/a.stories.tsx",
      "src/types/a.d.ts",
      "packages/x/src/README.md",
      "src/lib/generated/extensions.server.ts",
    ]) {
      expect(isExemptFile(rel), rel).toBe(true);
    }
    expect(isExemptFile("src/lib/generated/cms-smuggle.ts")).toBe(false);
    expect(isExemptFile("src/lib/cms-state.ts")).toBe(false);
  });
});

describe("test of record: the application border floor over the real tree", () => {
  let committed;
  let live;
  let vocabulary;

  beforeAll(() => {
    // Fail closed on an absent tree: never skip, never a vacuous pass.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const expected = Object.keys(pkg.cinatra?.devExtensions ?? {}).length;
    const found = discoverExtensionDirs(join(REPO_ROOT, "extensions")).length;
    expect(
      found,
      "extension tree must be cloned back (scripts/ci/sync-dev-extensions.mjs) before this suite",
    ).toBeGreaterThanOrEqual(expected);
    committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    vocabulary = loadClaimedTypeVocabulary(REPO_ROOT);
    const started = Date.now();
    live = scanApplicationBorder(REPO_ROOT, { vocabulary });
    console.log(`[application-border-gate test of record] scan took ${Date.now() - started} ms`);
  }, 120_000);

  for (const section of ["types", "names", "ceilings"]) {
    it(`${section}: no new finding (a new key or a grown count fails, naming it)`, () => {
      expect(diffGrown(sectionCounts(committed, section), live[section])).toEqual([]);
    });

    it(`${section}: no stale floor entry (a fallen count fails until the floor is ratcheted down)`, () => {
      expect(diffShrunk(sectionCounts(committed, section), live[section])).toEqual([]);
    });
  }

  it("the sections are exactly the three classes", () => {
    expect(SECTIONS).toEqual(["types", "names", "ceilings"]);
  });

  it("every floor entry names the extension that will own the code", () => {
    expect(ownerProblems(committed)).toEqual([]);
  });

  it("every floor entry carries a valid count", () => {
    expect(countProblems(committed)).toEqual([]);
  });

  it("the CMS snapshot capture is on the class 2 floor and carries a class 3 ceiling", () => {
    expect(committed.names["src/lib/artifacts/cms-content-snapshot-capture.ts :: name :: cms"]).toBeDefined();
    expect(committed.ceilings["src/lib/artifacts/cms-content-snapshot-capture.ts"]).toBeDefined();
  });

  it("the vocabulary holds more than zero claimed ids", () => {
    expect(vocabulary.ids.size).toBeGreaterThan(0);
  });
});
