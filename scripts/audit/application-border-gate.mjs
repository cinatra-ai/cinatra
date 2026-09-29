#!/usr/bin/env node
// Application border gate — classes 1, 2 and 3 (cinatra#3821).
//
// THE RULE. The application offers the same roads to every extension. What an
// artifact holds is the work of the agent extension whose flow creates it; a
// connector gives an agent its connection and tools; an artifact extension
// declares the type and draws it from its content. The application gains no
// function for one artifact type, one agent or one connector.
//
// WHAT THIS GATE REFUSES, over application code (`src/` and every
// `packages/*/src`; .ts .tsx .mts .cts .js .jsx .mjs .cjs):
//   CLASS 1 (`types`)  — a string literal (or a template literal without
//     substitutions) whose text EQUALS an object type id an extension claims,
//     or has the id shape `<namespace>:<local>` under a namespace a claim
//     declares, in any position. Key `<file> :: type :: <id>`, with its count.
//     COUNT ONCE beside the display boundary gate (G1,
//     artifact-ui-boundary-gate.mjs): G1 reads a type id only in a `.tsx`
//     module and only in a keying position; this gate reads every other
//     position of every module. It imports G1's own classifyIdentity and
//     keyingKindOf and skips exactly a literal G1 classifies as an object type
//     in a keying position, so the partition is G1's definition and cannot
//     drift from it; a literal G1 counts is still refused by G1.
//   CLASS 2 (`names`)  — a module whose path carries, as a whole sub-token of
//     a directory or file segment (split on non-alphanumerics and camelCase,
//     the vendor gate's subTokens), a word of the FROZEN DOMAIN_TOKENS set. The
//     segments read are those after `src/`; for a package, its directory name
//     plus those after `packages/<name>/src/`. Key `<file> :: name :: <token>`,
//     with the number of segments.
//   CLASS 3 (`ceilings`) — every module on the class 1 or class 2 floor
//     carries a CEILING: its count of top-level value declarations (the names
//     of top-level functions, classes and variables, exported or not). A count
//     above the ceiling is refused; a count below it is a stale entry. A fix
//     inside an existing declaration adds no name, so a listed module stays
//     maintainable while its surface cannot widen.
//
// THE VOCABULARY is derived, never typed: lib/claimed-type-vocabulary.mjs reads
// the claims of the extension packages the two locks name from the
// materialized tree, and throws (exit 2) on an absent or under-populated tree.
//
// EXEMPT, each with its reason (also in scripts/audit/extension-coupling-gates.md):
//   - the generator-emitted files (PERMANENT_EXEMPT_FILES): generator output
//     from the manifests, byte-pinned by `generate-extension-manifest.mjs
//     --check`; an explicit list, so a hand-added file under src/lib/generated/
//     is still counted;
//   - tests, specs, `__tests__`, `__fixtures__`, `__mocks__` (the test
//     doubles), `test/` and `tests/`, stories and `.d.ts` declarations: the
//     surfaces that police the boundary or declare types only;
//   - documents (`.md`);
//   - class 1 only: the owner-ruled DATA_CONTRACT_ID_ALLOWLIST ids, reported
//     apart exactly as the instance-coupling ban reports them (the one place
//     owner rulings on such ids live — no second exception list);
//   - class 2 only: SANCTIONED_MODULES, exact paths, each with its reason,
//     growing only by a reviewed change to this gate.
//
// THE FLOOR (application-border-gate.baseline.json) only shrinks, with the
// mechanics of the sibling gates: a new key or a grown count fails; a key whose
// count fell is STALE and fails until `--write-baseline` ratchets it down;
// `--write-baseline` refuses to write a grown floor; APPLICATION_BORDER_BASE
// fails closed on a flag-like or unresolvable reference and refuses a committed
// floor that grew against the base (no constraint when the base holds no
// floor). ONE growth is admitted, by `--write-baseline` and by the base guard:
// a new class 1 key (and the class 3 ceiling its module then needs) whose file
// is BYTE-IDENTICAL at the base reference — the code did not change, only the
// vocabulary did (an extension newly claiming an id the application already
// spells). Every entry names its `owner`, the extension that will own the
// code; `--write-baseline` writes a new entry with owner UNASSIGNED and the
// check fails on any UNASSIGNED or empty owner.
//
// Usage:
//   node scripts/audit/application-border-gate.mjs                  # check (default)
//   node scripts/audit/application-border-gate.mjs --write-baseline # ratchet the floor down
//   APPLICATION_BORDER_BASE=<ref> node ...   # also fail if the committed floor GREW vs <ref>
// Exit 0 = clean, 1 = findings, 2 = scanner error.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";
import { subTokens } from "./vendor-token-core-gate.mjs";
import {
  PERMANENT_EXEMPT_FILES,
  DATA_CONTRACT_ID_ALLOWLIST,
} from "./lib/extension-reference-classification.mjs";
import {
  classifyIdentity,
  keyingKindOf,
  IDENTITY_CLASS,
  OBJECT_TYPE_ID_RE,
} from "./lib/artifact-presentation-identity.mjs";
import {
  ClaimedTypeVocabularyError,
  loadClaimedTypeVocabulary,
  namespaceOf,
} from "./lib/claimed-type-vocabulary.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_REL = "scripts/audit/application-border-gate.baseline.json";
const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL);
const TAG = "[application-border-gate]";

export const SECTIONS = Object.freeze(["types", "names", "ceilings"]);
export const UNASSIGNED_OWNER = "UNASSIGNED";

/**
 * The FROZEN, REVIEWED domain words of class 2. Each names one domain the
 * application must not be written for. Vendor words stay the vendor-token
 * gate's frozen set (none is here), so one path segment is counted by one gate.
 * Growing or shrinking this set is a reviewed change to this gate and its tests.
 */
export const DOMAIN_TOKENS = Object.freeze([
  "appointment",
  "blog",
  "campaign",
  "campaigns",
  "cms",
  "crm",
  "email",
  "icp",
  "mail",
  "newsletter",
  "outreach",
  "playbook",
  "podcast",
  "portfolio",
  "prospecting",
  "social",
]);

/** Class 2 sanctioned modules: exact paths, each with its written reason. */
export const SANCTIONED_MODULES = new Map([
  [
    "src/lib/org-invitation-email.ts",
    "the platform's own member-invitation mail, written for no artifact type, agent or connector",
  ],
]);

const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_PATH_RE =
  /(?:\.(?:test|spec)\.[mc]?[tj]sx?$|(?:^|\/)(?:__tests__|__fixtures__|__mocks__|tests?)\/)/;
const STORY_RE = /\.stories\.[mc]?[tj]sx?$/;
const DECLARATION_RE = /\.d\.[mc]?ts$/;

/** Is `rel` exempt (generated, test, fixture, double, story, declaration, document)? */
export function isExemptFile(rel) {
  return (
    PERMANENT_EXEMPT_FILES.has(rel) ||
    TEST_PATH_RE.test(rel) ||
    STORY_RE.test(rel) ||
    DECLARATION_RE.test(rel) ||
    rel.endsWith(".md")
  );
}

/** Is `rel` application code in scope: `src/**` or `packages/<name>/src/**`, a code file? */
export function isInScope(rel) {
  if (!CODE_FILE_RE.test(rel)) return false;
  return rel.startsWith("src/") || /^packages\/[^/]+\/src\//.test(rel);
}

/** The path segments class 2 reads (after `src/`; a package's directory name plus those after its `src/`). */
export function classTwoSegments(rel) {
  const pkg = rel.match(/^packages\/([^/]+)\/src\/(.+)$/);
  if (pkg) return [pkg[1], ...pkg[2].split("/")];
  if (rel.startsWith("src/")) return rel.slice(4).split("/");
  return [];
}

/** Domain tokens in a path, with the number of segments carrying each (whole sub-tokens only). */
export function domainTokenHits(rel, tokens = DOMAIN_TOKENS) {
  const hits = new Map();
  const segments = classTwoSegments(rel).map((seg) => new Set(subTokens(seg)));
  for (const token of tokens) {
    const n = segments.filter((set) => set.has(token)).length;
    if (n > 0) hits.set(token, n);
  }
  return hits;
}

function scriptKindOf(rel) {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(rel, text) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKindOf(rel));
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.add(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  }
}

/** Class 3 measure: the number of distinct top-level value names (functions, classes, variables). */
export function countTopLevelValueNames(text, rel) {
  const sf = parse(rel, text);
  const names = new Set();
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.add(st.name.text);
    else if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) bindingNames(decl.name, names);
    }
  }
  return names.size;
}

/** Is `value` a class 1 id: a claimed id, or the id shape under a claimed namespace? */
export function isVocabularyId(value, vocabulary) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (vocabulary.ids.has(value)) return true;
  return OBJECT_TYPE_ID_RE.test(value) && vocabulary.namespaces.has(namespaceOf(value));
}

/** Class 1 literals in one module, as Map<id, count>; allowlisted ids go to `allowlistHits`. */
export function typeIdLiterals(rel, text, vocabulary, { allowlist = DATA_CONTRACT_ID_ALLOWLIST, allowlistHits } = {}) {
  const found = new Map();
  if (!text.includes(":")) return found;
  const sf = parse(rel, text);
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (isVocabularyId(value, vocabulary)) {
        const leftToG1 =
          classifyIdentity(value, rel) === IDENTITY_CLASS.OBJECT_TYPE && keyingKindOf(node, ts) !== null;
        if (!leftToG1) {
          if (allowlist.has(value)) {
            if (allowlistHits) allowlistHits.set(value, (allowlistHits.get(value) ?? 0) + 1);
          } else {
            found.set(value, (found.get(value) ?? 0) + 1);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Candidate files under the scan roots: git's view when `repoRoot` is a checkout, else the file system. */
export function listScanFiles(repoRoot = REPO_ROOT) {
  if (existsSync(join(repoRoot, ".git"))) {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src/", "packages/"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split("\0").filter(Boolean);
  }
  const files = [];
  for (const top of ["src", "packages"]) {
    for (const abs of walk(join(repoRoot, top), [])) files.push(relative(repoRoot, abs).split("\\").join("/"));
  }
  return files;
}

/**
 * Scan the application for classes 1, 2 and 3. Returns
 * { types: {key: count}, names: {key: count}, ceilings: {file: count}, vocabulary }.
 * Options (injectable for tests): `files` (repo-relative), `vocabulary`
 * (default: derived from `repoRoot`'s materialized tree — throws
 * ClaimedTypeVocabularyError when absent), `allowlist`, `allowlistHits`.
 */
export function scanApplicationBorder(repoRoot = REPO_ROOT, options = {}) {
  const vocabulary = options.vocabulary ?? loadClaimedTypeVocabulary(repoRoot);
  const files = options.files ?? listScanFiles(repoRoot);
  const allowlist = options.allowlist ?? DATA_CONTRACT_ID_ALLOWLIST;
  const allowlistHits = options.allowlistHits;
  const types = {};
  const names = {};
  const ceilings = {};
  for (const rel of [...files].sort()) {
    if (!isInScope(rel) || isExemptFile(rel)) continue;
    // Scan the worktree truth: a file deleted but still in the index is gone.
    if (!existsSync(join(repoRoot, rel))) continue;
    let onFloor = false;
    if (!SANCTIONED_MODULES.has(rel)) {
      for (const [token, n] of domainTokenHits(rel)) {
        names[`${rel} :: name :: ${token}`] = n;
        onFloor = true;
      }
    }
    const text = readFileSync(join(repoRoot, rel), "utf8");
    for (const [id, n] of typeIdLiterals(rel, text, vocabulary, { allowlist, allowlistHits })) {
      types[`${rel} :: type :: ${id}`] = n;
      onFloor = true;
    }
    if (onFloor) ceilings[rel] = countTopLevelValueNames(text, rel);
  }
  return { types, names, ceilings, vocabulary };
}

/** Keys whose CURRENT count exceeds the baseline count, or are entirely new. */
export function diffGrown(baseline, current) {
  const grown = [];
  for (const [k, c] of Object.entries(current)) {
    const base = baseline[k] ?? 0;
    if (c > base) grown.push(`${k} (${base} -> ${c})`);
  }
  return grown.sort();
}

/** Baseline keys whose CURRENT count fell below the baseline count (stale floor). */
export function diffShrunk(baseline, current) {
  const shrunk = [];
  for (const [k, c] of Object.entries(baseline)) {
    const cur = current[k] ?? 0;
    if (cur < c) shrunk.push(`${k} (${c} -> ${cur})`);
  }
  return shrunk.sort();
}

/** A section of a floor document as {key: count}. */
export function sectionCounts(doc, section) {
  return Object.fromEntries(Object.entries(doc?.[section] ?? {}).map(([k, v]) => [k, Number(v?.count ?? 0)]));
}

/** The file a floor key names. */
export function fileOfKey(key) {
  return key.split(" :: ")[0];
}

/**
 * Every entry whose count is not a non-negative integer. A count such as
 * "invalid" reads as NaN, and NaN compares false both ways, so it would hide
 * growth and staleness alike; such a floor fails instead.
 */
export function countProblems(doc) {
  const problems = [];
  for (const section of SECTIONS) {
    for (const [key, entry] of Object.entries(doc?.[section] ?? {})) {
      const c = entry?.count;
      if (!Number.isInteger(c) || c < 0) problems.push(`${section}: ${key} has an invalid count (${JSON.stringify(c ?? null)})`);
    }
  }
  return problems.sort();
}

/**
 * The vocabulary-born admission: a NEW `types` key (absent from `previousDoc`),
 * or the NEW ceiling its module then needs, whose file is byte-identical at the
 * base. A key already on the previous floor is never admitted to grow.
 */
function admittedGrowth(section, key, previousDoc, isUnchangedAtBase) {
  if (section === "names") return false;
  if (Object.prototype.hasOwnProperty.call(previousDoc?.[section] ?? {}, key)) return false;
  return isUnchangedAtBase(fileOfKey(key));
}

/** Every entry whose owner is empty or UNASSIGNED. */
export function ownerProblems(doc) {
  const problems = [];
  for (const section of SECTIONS) {
    for (const [key, entry] of Object.entries(doc?.[section] ?? {})) {
      const owner = typeof entry?.owner === "string" ? entry.owner.trim() : "";
      if (!owner || owner === UNASSIGNED_OWNER) problems.push(`${section}: ${key} has no owner (${JSON.stringify(entry?.owner ?? null)})`);
    }
  }
  return problems.sort();
}

/**
 * Growth of `committed` against `base`, section by section, minus the one
 * admitted growth: a NEW `types` key, or the new ceiling its module then needs,
 * whose file is byte-identical at the base (`isUnchangedAtBase(file)`) — the
 * vocabulary moved, the code did not. An invalid count on either side fails.
 */
export function baseGrowth(baseDoc, committedDoc, { isUnchangedAtBase }) {
  const grown = [
    ...countProblems(baseDoc).map((p) => `base floor: ${p}`),
    ...countProblems(committedDoc).map((p) => `committed floor: ${p}`),
  ];
  for (const section of SECTIONS) {
    for (const entry of diffGrown(sectionCounts(baseDoc, section), sectionCounts(committedDoc, section))) {
      const key = entry.replace(/ \(\d+ -> \d+\)$/, "");
      if (!admittedGrowth(section, key, baseDoc, isUnchangedAtBase)) grown.push(`${section}: ${entry}`);
    }
  }
  return grown.sort();
}

/** Is `rel` byte-identical in the worktree and at `ref`? */
export function fileUnchangedAtRef(repoRoot, ref, rel) {
  let atRef;
  try {
    atRef = execFileSync("git", ["show", `${ref}:${rel}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const path = join(repoRoot, rel);
  if (!existsSync(path)) return false;
  return Buffer.compare(atRef, readFileSync(path)) === 0;
}

/** Why a base reference cannot be used (flag-like, unresolvable), or null. */
export function baseRefProblem(ref, repoRoot, variable) {
  if (ref.startsWith("-")) return `${variable}="${ref}" is flag-like.`;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return null;
  } catch {
    return `${variable}="${ref}" did not resolve (shallow checkout / misconfig?). Failing closed — fetch the base ref (fetch-depth: 0).`;
  }
}

/**
 * The floor document `--write-baseline` writes. Refuses (throws) a floor that
 * grew against `committedDoc`, except the vocabulary-born admission. Existing
 * owners are kept; a new entry is written with owner UNASSIGNED.
 */
export function writeBaselineDoc(committedDoc, live, { isUnchangedAtBase }) {
  if (committedDoc) {
    const invalid = countProblems(committedDoc);
    if (invalid.length) {
      throw new Error(`refusing to write over a floor with invalid counts:\n${invalid.map((p) => `  ! ${p}`).join("\n")}`);
    }
    const grown = [];
    for (const section of SECTIONS) {
      for (const entry of diffGrown(sectionCounts(committedDoc, section), live[section])) {
        const key = entry.replace(/ \(\d+ -> \d+\)$/, "");
        if (admittedGrowth(section, key, committedDoc, isUnchangedAtBase)) continue;
        grown.push(`${section}: ${entry}`);
      }
    }
    if (grown.length) {
      const err = new Error(
        `refusing to write a GROWN floor (shrink-only; move the code into the extension that owns it instead; a new ` +
          `class 1 key born of a vocabulary change is admitted only with APPLICATION_BORDER_BASE set to the base branch):\n` +
          grown.map((g) => `  + ${g}`).join("\n"),
      );
      err.grown = grown;
      throw err;
    }
  }
  const doc = {
    note:
      "Application border floor (cinatra#3821): application code (src/ and packages/*/src) written for one artifact type, " +
      "agent or connector. types = a claimed object type id spelled in application code (class 1); names = a module named " +
      "for one domain (class 2); ceilings = the top-level value declarations of each listed module (class 3). Each entry " +
      "names its owner, the extension that will own the code. SHRINK-ONLY: regenerate with " +
      "`node scripts/audit/application-border-gate.mjs --write-baseline` (it refuses growth). See " +
      "scripts/audit/extension-coupling-gates.md.",
  };
  for (const section of SECTIONS) {
    const out = {};
    for (const key of Object.keys(live[section]).sort()) {
      const owner = committedDoc?.[section]?.[key]?.owner;
      out[key] = { count: live[section][key], owner: typeof owner === "string" && owner ? owner : UNASSIGNED_OWNER };
    }
    doc[section] = out;
  }
  return doc;
}

function summarize(live, allowlistHits) {
  const files = (o) => new Set(Object.keys(o).map(fileOfKey)).size;
  const allowlisted = [...allowlistHits.values()].reduce((a, b) => a + b, 0);
  return (
    `class 1: ${Object.keys(live.types).length} type-id entr(ies) in ${files(live.types)} file(s) ` +
    `[data-contract allowlisted (reported apart, not counted): ${allowlisted}]; ` +
    `class 2: ${Object.keys(live.names).length} name entr(ies) in ${files(live.names)} file(s); ` +
    `class 3: ${Object.keys(live.ceilings).length} ceiling(s); ` +
    `vocabulary: ${live.vocabulary.ids.size} claimed id(s) under ${live.vocabulary.namespaces.size} namespace(s) ` +
    `from ${live.vocabulary.extensionCount} extension package(s)`
  );
}

function main() {
  const args = process.argv.slice(2);
  const baseRef = process.env.APPLICATION_BORDER_BASE;
  if (baseRef) {
    const problem = baseRefProblem(baseRef, REPO_ROOT, "APPLICATION_BORDER_BASE");
    if (problem) {
      console.error(`${TAG} FAIL — ${problem}`);
      process.exit(1);
    }
  }
  const allowlistHits = new Map();
  let live;
  try {
    live = scanApplicationBorder(REPO_ROOT, { allowlistHits });
  } catch (err) {
    const why = err instanceof ClaimedTypeVocabularyError ? err.message : err?.stack ?? String(err);
    console.error(`${TAG} scanner error: ${why}`);
    process.exit(2);
  }
  const committed = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
  // Byte identity is read at the base reference only: without APPLICATION_BORDER_BASE
  // nothing is admitted (a file committed with a new literal is identical at HEAD).
  const isUnchangedAtBase = baseRef ? (rel) => fileUnchangedAtRef(REPO_ROOT, baseRef, rel) : () => false;

  if (args.includes("--write-baseline")) {
    let doc;
    try {
      doc = writeBaselineDoc(committed, live, { isUnchangedAtBase });
    } catch (err) {
      console.error(`${TAG} FAIL — ${err.message}`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(doc, null, 2) + "\n");
    const unassigned = ownerProblems(doc).length;
    console.log(`${TAG} floor written — ${summarize(live, allowlistHits)}; ${unassigned} entr(ies) without an owner.`);
    return;
  }

  if (!committed) {
    console.error(`${TAG} FAIL — no floor at ${BASELINE_REL}. Run with --write-baseline first.`);
    process.exit(1);
  }
  const invalidCounts = countProblems(committed);
  if (invalidCounts.length) {
    console.error(`${TAG} FAIL — ${invalidCounts.length} floor entr(ies) carry an invalid count (a non-negative integer is required):`);
    invalidCounts.forEach((e) => console.error(`  ! ${e}`));
    process.exit(1);
  }

  if (baseRef) {
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:${BASELINE_REL}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      baseText = null; // the reference resolves but holds no floor: the introducing change, no constraint
    }
    if (baseText) {
      const grew = baseGrowth(JSON.parse(baseText), committed, { isUnchangedAtBase });
      if (grew.length) {
        console.error(`${TAG} FAIL — the committed floor GREW vs ${baseRef} (shrink-only; no regenerate can raise it):`);
        grew.forEach((g) => console.error(`  + ${g}`));
        process.exit(1);
      }
    }
  }

  let failed = false;
  for (const section of SECTIONS) {
    const grown = diffGrown(sectionCounts(committed, section), live[section]);
    if (grown.length) {
      failed = true;
      console.error(`${TAG} FAIL — ${grown.length} NEW ${section} finding(s) in application code:`);
      grown.forEach((e) => console.error(`  + ${e}`));
    }
  }
  if (failed) {
    console.error(
      "\nThe application offers the same roads to every extension and gains no function for one artifact type, one\n" +
        "agent or one connector (cinatra#3821). Write the code in the extension that owns it: the agent extension\n" +
        "creates an artifact and its content, a connector gives tools, an artifact extension declares and draws its\n" +
        "type. The committed floor cannot grow. See scripts/audit/extension-coupling-gates.md.",
    );
    process.exit(1);
  }
  for (const section of SECTIONS) {
    const stale = diffShrunk(sectionCounts(committed, section), live[section]);
    if (stale.length) {
      failed = true;
      console.error(
        `${TAG} FAIL — ${stale.length} STALE ${section} floor entr(ies) (the floor shrank — ratchet it down so the ` +
          `headroom cannot be re-spent): node scripts/audit/application-border-gate.mjs --write-baseline`,
      );
      stale.forEach((e) => console.error(`  - ${e}`));
    }
  }
  const owners = ownerProblems(committed);
  if (owners.length) {
    failed = true;
    console.error(`${TAG} FAIL — ${owners.length} floor entr(ies) name no owner (the extension that will own the code):`);
    owners.forEach((e) => console.error(`  - ${e}`));
  }
  if (failed) process.exit(1);

  console.log(`${TAG} OK — ${summarize(live, allowlistHits)}; 0 new, 0 stale (shrink-only floor — cinatra#3821; see scripts/audit/extension-coupling-gates.md).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
