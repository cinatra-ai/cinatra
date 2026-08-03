#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Extension-declaration READ-SITE inventory (cinatra#2331).
//
// The collapse of `cinatra.extensions` + `cinatra.systemExtensions` into one
// versioned `cinatra.systemExtensions` is judged by PROPERTY-READ sites of
// `cinatra.extensions` reaching zero — NOT by a substring grep: the substring
// legitimately appears in unrelated namespaces (e.g.
// `Symbol.for("cinatra.extensions.dataTeardownHook.v1")` in
// packages/extensions/src/data-teardown-hook.ts) and inside diagnostic strings.
//
// So detection here is broad (every candidate member access, comments and
// string literals excluded) while CLASSIFICATION is a curated baseline: each
// known site carries its role and the migration action the collapse requires.
// A file that grows a new read the baseline does not know about FAILS this
// script — that is the drift guard. A baseline site that has disappeared is
// reported as PROGRESS, never as a failure, so the script stays useful while
// the migration lands piece by piece.
//
// Dependency-free, no build step:
//   node scripts/audit/extension-declaration-read-sites.mjs [--json]
//
// STATUS: step-1 scaffold. The baseline below is verified against the tree it
// ships with; the `step1` column is the migration plan from cinatra#2331, not
// an assertion about the current code.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".sh", ".yml", ".yaml"]);
// Never scanned: dependency trees, build output, the VCS dir — and the ROOT
// `extensions/` tree only (acquired/cloned extension packages, not host
// source). The name check must be path-anchored: `packages/extensions/` and
// `scripts/extensions/` are host source and hold several of the read sites.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage", ".turbo"]);
const SKIP_PATHS = new Set(["extensions"]);

// Detection must not be dot-notation-only: `cinatra["extensions"]`, a
// destructure off the block, and a member access wrapped across lines are all
// real reads. Newlines are matched explicitly (the scan runs over the whole
// file, not line by line).
// `view` selects which masked view the pattern runs against: "code" has string
// CONTENT blanked (so a declaration name inside a diagnostic message is not a
// read), while "strings" keeps it (a bracket access `cinatra["extensions"]`
// puts the property name inside a string literal — blanking it would make the
// access invisible). Comments are blanked in BOTH views.
const READ_PATTERNS = [
  // cinatra.extensions / cinatra?.systemExtensions (newline-tolerant)
  { view: "code", re: /cinatra\s*\??\.\s*(extensions|systemExtensions)\b/g },
  // cinatra["extensions"] / cinatra?.["systemExtensions"]
  { view: "strings", re: /cinatra\s*\??\.?\s*\[\s*["'`](extensions|systemExtensions)["'`]\s*\]/g },
  // const { extensions, systemExtensions } = <something>.cinatra
  { view: "code", re: /\{[^{}]*\b(extensions|systemExtensions)\b[^{}]*\}\s*=\s*[^;\n]*\bcinatra\b/g },
];

// ---------------------------------------------------------------------------
// The curated inventory. `key` is the declaration read; `role` is what the site
// does with it; `step1` is the action cinatra#2331 step 1 requires.
// ---------------------------------------------------------------------------
const BASELINE = [
  // ---- `cinatra.extensions` readers — these must reach ZERO ---------------
  {
    file: "packages/extensions/src/required-in-prod.ts",
    key: "extensions",
    count: 1,
    role: "canonical app reader (install/update pin gate, boot presence assert)",
    step1: "read cinatra.systemExtensions through the strict parser; missing/empty/rangeless becomes FATAL (the reader currently converts any defect to [], which silently disables the pin gate)",
  },
  {
    file: "packages/cli/src/prod-extension-acquisition.mjs",
    key: "extensions",
    count: 1,
    role: "in-repo CLI helper: lock<->declaration bijection inside `docker build` and CI",
    step1: "same schema-discriminated reader shipped in cinatra-cli step 0, or a direct switch to systemExtensions once the published CLI pin is bumped",
  },
  {
    file: "scripts/audit/required-extensions-cover-host-imports.mjs",
    key: "extensions",
    count: 1,
    role: "cover gate: host-imported ⊆ declared, declared ⇔ lock, plus the (now tautological) extensions ⇄ systemExtensions equality apparatus",
    step1: "read the single declaration; DELETE the equality apparatus; KEEP bootable ⊆ declared and declared ⇔ lock",
  },
  {
    file: "scripts/ci/prune-extensions-to-required.mjs",
    key: "extensions",
    count: 1,
    role: "fresh-public-clone build gate: prune every extension dir not declared",
    step1: "read the single declaration via the strict parser",
  },
  {
    file: "scripts/extensions/update-required-extension-lock.mjs",
    key: "extensions",
    count: 1,
    role: "lock regenerator: resolves each declared spec's range to a concrete SHA/version",
    step1: "read the single declaration via the strict parser (it already needs the RANGE, so it is the site that proves the ranges stay load-bearing)",
  },
  {
    file: "scripts/ci/prod-boot-e2e.sh",
    key: "extensions",
    count: 1,
    role: "prod-boot E2E: the IMAGE's own declaration vs the fresh DB's required_in_prod anchors",
    step1: "keep extracting the raw declaration from the running image, but parse it HOST-side with the shared module instead of the inline `node -e` split (the image is not guaranteed to carry the module)",
  },
  {
    file: "packages/extensions/src/__tests__/required-extensions-lock.test.ts",
    key: "extensions",
    count: 1,
    role: "test: declaration ⇔ lock bijection, and every entry must carry a range",
    step1: "repoint to the single declaration; the range requirement becomes the parser's own contract",
  },
  {
    file: "src/lib/__tests__/integration/demote-optional-extension-anchors.test.ts",
    key: "extensions",
    count: 1,
    role: "integration test: reads BOTH lists (its own lastIndexOf split) to assert the demotion set",
    step1: "read the single declaration through the shared parser; drop the local split",
  },
  {
    file: "docs/internals/proofs/1785-a6/reproduce-clean-boot.mts",
    key: "extensions",
    count: 1,
    role: "committed proof driver: asserts extensions == systemExtensions == lock (the triple)",
    step1: "the equality half is retired with the second list; keep declaration == lock",
  },

  // ---- `cinatra.systemExtensions` readers — repointed to RANGED specs -----
  {
    file: "packages/extensions/src/system-extension-inventory.ts",
    key: "systemExtensions",
    count: 2,
    role: "locked/system set: destructive-op refusal + boot lock (fail-closed reader, bare-name-only regex)",
    step1: "accept ranged specs and strip the range (locator key unchanged); the bare-name-only regex goes",
  },
  {
    file: "scripts/extensions/generate-extension-manifest.mjs",
    key: "systemExtensions",
    count: 1,
    role: "generated-manifest classification (required vs guardedOptional) + fail-closed coverage of every declared entry",
    step1: "strip ranges before building the classification set AND the coverage check — a silent [] here would classify everything guardedOptional",
  },
  {
    file: "scripts/audit/required-extensions-cover-host-imports.mjs",
    key: "systemExtensions",
    count: 1,
    role: "cover gate: the systemExtensions side of the equality apparatus",
    step1: "the equality apparatus is DELETED; the gate reads the one declaration",
  },
  {
    file: "scripts/ci/assert-generated-maps-omit.mjs",
    key: "systemExtensions",
    count: 1,
    role: "presence-degraded build gate: survivors == declared system set",
    step1: "strip ranges; keep fail-closed on an empty declaration",
  },
  {
    file: "scripts/extensions/__tests__/generate-extension-manifest.test.mjs",
    key: "systemExtensions",
    count: 1,
    role: "test: every record classified against the repo-live declaration",
    step1: "strip ranges in the fixture/live comparison",
  },
  {
    file: "packages/extensions/src/__tests__/system-extension-inventory.test.ts",
    key: "systemExtensions",
    count: 0,
    kind: "fixture",
    role: "test: reader contract (valid shape, empty/malformed throws, dedupe) + the subset tautology — writes declaration-shaped fixtures rather than property-reading the root manifest",
    step1: "invert — ranged specs are the valid shape, a rangeless entry throws; delete the subset tautology",
  },
  {
    file: "packages/extensions/src/__tests__/install-profiles.test.ts",
    key: "systemExtensions",
    count: 0,
    kind: "fixture",
    role: "test fixture writing a systemExtensions block",
    step1: "fixture entries gain ranges",
  },
  {
    file: "src/lib/__tests__/integration/demote-optional-extension-anchors.test.ts",
    key: "systemExtensions",
    count: 1,
    role: "integration test: the system half of the demotion assertion",
    step1: "single declaration, shared parser",
  },
  {
    file: "docs/internals/proofs/1785-a6/reproduce-clean-boot.mts",
    key: "systemExtensions",
    count: 1,
    role: "committed proof driver: the system half of the triple",
    step1: "single declaration",
  },
];

// Spec-parser duplicates the collapse folds into the ONE shared module. Listed
// separately from the read sites: a file can hold a parser without holding a
// declaration read (and vice versa).
const SPEC_PARSER_SITES = [
  "packages/extensions/src/required-in-prod.ts",
  "packages/cli/src/prod-extension-acquisition.mjs",
  "scripts/audit/required-extensions-cover-host-imports.mjs",
  "scripts/ci/prune-extensions-to-required.mjs",
  "scripts/ci/prod-boot-e2e.sh",
  "scripts/extensions/update-required-extension-lock.mjs",
  "src/lib/__tests__/integration/demote-optional-extension-anchors.test.ts",
];

// Sites the collapse must change that hold NO declaration read of their own —
// they consume a reader, or they encode the old contract in a test/name.
const RELATED_CODE_SITES = [
  [
    "src/lib/required-extension-activation.ts",
    "CATCHES a reader failure and skips the production assertion — with a fail-closed reader this must become fatal",
  ],
  [
    "packages/extensions/src/__tests__/required-in-prod.test.ts",
    "invert the 'missing/invalid declaration -> []' expectation; delete the subset tautology",
  ],
  [
    "packages/extensions/src/__tests__/dispatcher-install-ordering.test.ts",
    "REQUIRED-PIN GATE suite is named for the old declaration",
  ],
];

// Prose/comment sites (step 1.7). Listed so the doc sweep is enumerable rather
// than remembered; each path is existence-checked at run time.
const DOC_SITES = [
  [
    "docs/internals/decisions/required-system-lock-invariant.md",
    "SUPERSEDE — this issue executes that doc's own deferred 'collapsing the declarations' section",
  ],
  ["docs/internals/contracts/extension-clone-pinning.md", "declaration names + a stale `cinatra.requiredExtensions` reference"],
  ["scripts/audit/extension-coupling-gates.md", "gate description drops the equality apparatus"],
  ["docs/internals/proofs/1785-a6/README.md", "proof narrative describes the retired triple"],
  [".github/workflows/build-image.yml", "stale `requiredExtensions` comments (~1541-1543 and ~3065-3112)"],
  ["packages/sdk-extensions/src/manifest.ts", "stale `cinatra.requiredExtensions` comment (~line 40)"],
  ["migrations/core/core__0004_demote-optional-extension-anchors.mjs", "stale `requiredExtensions` header comment"],
];

// Out-of-repo follow-ups — recorded here because the cinatra PR cannot carry
// them, and because one of the issue's bullets is stale (see the last row).
const OUT_OF_REPO_FOLLOWUPS = [
  [
    "cinatra-cli",
    "step 0: schema-discriminated readers ship FIRST and the release precedes this repo's PR; the transitional discrimination is removed in the CLI release AFTER the cutover",
  ],
  ["docs repo — references/platform/extension-coupling-gates.md", "mirror of the gate description"],
  [
    "claude-plugin skills (extension-conventions / extension-boundary)",
    "the issue lists these as IN-REPO `dev/skills/*/SKILL.md`; no such path exists in cinatra at any commit — the skills live in the plugin repo, so that bullet is a cross-repo follow-up, not a cinatra edit",
  ],
];

// `lastIndexOf("@")` splits that are NOT extension-declaration parsers and must
// NOT be folded into the shared module — recorded so a future sweep does not
// "helpfully" consolidate them.
const UNRELATED_LAST_AT_SPLITS = [
  ["scripts/audit/package-publish-allowlist.mjs", "splits a git TAG (name@version)"],
  ["scripts/fixtures/lib/dev-content-manifest.mjs", "dev content fixture identity"],
  ["src/app/configuration/marketplace/submissions/catalog-sync-enqueue.ts", "marketplace submission identity"],
  ["src/lib/extension-store-gc.ts", "content-addressed store KEY"],
];

// ---------------------------------------------------------------------------

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (SKIP_PATHS.has(path.relative(REPO_ROOT, full).split(path.sep).join("/"))) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.has(path.extname(name))) yield full;
  }
}

/**
 * True when `index` sits inside a string literal. Template literals are
 * handled properly: a `${...}` substitution is CODE, not string, so a read
 * inside one is still a read (a whole-template "it is a string" shortcut is a
 * false negative).
 */
function insideStringLiteral(text, index) {
  let quote = null;
  let templateDepth = 0; // > 0 while inside a `${ ... }` substitution
  for (let i = 0; i < index; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (quote === "`" && ch === "$" && text[i + 1] === "{") {
        quote = null;
        templateDepth += 1;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (templateDepth > 0 && ch === "}") {
      templateDepth -= 1;
      quote = "`";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== null;
}

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Drop a TRAILING `//` comment (one outside any string literal) so a mention in
 * a end-of-line comment is not counted as a read. `https://` inside a string is
 * unaffected — the string check runs first.
 */
function stripTrailingComment(line) {
  for (let i = 0; i < line.length - 1; i += 1) {
    if (line[i] === "/" && line[i + 1] === "/" && !insideStringLiteral(line, i)) return line.slice(0, i);
  }
  return line;
}

/**
 * Build a CODE-ONLY view of a file: comments and string-literal content blanked
 * out, every other byte and every newline preserved, so an offset in the result
 * maps to the same line in the source.
 *
 * Masking is per LINE (string state does not carry across lines) — deliberately
 * NOT a JS lexer: a whole-file lexer has to model regex literals, block
 * comments and multi-line templates correctly or it desynchronises and starts
 * both missing real reads and reporting string content as code. Per-line state
 * cannot desynchronise beyond one line. The cost is that the INNER lines of a
 * multi-line string literal read as code; a declaration name sitting there
 * would be a false positive, which is the safe direction for an audit whose
 * job is to catch reads.
 *
 * The masked lines are then joined back with newlines, so the read patterns
 * still match a member access that wraps across lines.
 */
function maskComments(text) {
  return text
    .split("\n")
    .map((line) => {
      if (isCommentLine(line)) return " ".repeat(line.length);
      const kept = stripTrailingComment(line);
      return kept + " ".repeat(line.length - kept.length);
    })
    .join("\n");
}

function maskNonCode(text) {
  return text
    .split("\n")
    .map((line) => {
      if (isCommentLine(line)) return " ".repeat(line.length);
      const kept = stripTrailingComment(line);
      const out = kept.split("");
      for (let i = 0; i < kept.length; i += 1) {
        if (insideStringLiteral(kept, i)) out[i] = " ";
        else if (kept[i] === '"' || kept[i] === "'" || kept[i] === "`") out[i] = " ";
      }
      return out.join("") + " ".repeat(line.length - kept.length);
    })
    .join("\n");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function scan() {
  const hits = [];
  for (const abs of walk(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      // An unreadable file is a HOLE in the audit, never a silent skip.
      console.error(`[extension-declaration-read-sites] cannot read ${rel}: ${err.message}`);
      process.exit(2);
    }
    if (!text.includes("cinatra")) continue;
    const views = { code: maskNonCode(text), strings: maskComments(text) };
    const lines = text.split("\n");
    for (const { view, re: pattern } of READ_PATTERNS) {
      const masked = views[view];
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(masked)) !== null) {
        const line = lineOf(text, m.index);
        const key = m[1];
        if (hits.some((h) => h.file === rel && h.line === line && h.key === key)) continue;
        hits.push({ file: rel, line, key, text: (lines[line - 1] ?? "").trim() });
      }
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.key.localeCompare(b.key));
}

const asJson = process.argv.includes("--json");
const hits = scan();
const READ_BASELINE = BASELINE.filter((b) => (b.kind ?? "read") === "read");
const FIXTURE_BASELINE = BASELINE.filter((b) => b.kind === "fixture");
const baselineKeys = new Set(BASELINE.map((b) => `${b.file}::${b.key}`));
const seenKeys = new Set(hits.map((h) => `${h.file}::${h.key}`));

const unknown = hits.filter((h) => !baselineKeys.has(`${h.file}::${h.key}`));

// A file already in the baseline must not GROW new reads: the baseline is keyed
// by file+declaration (line numbers drift), so the count is what makes an added
// read visible.
const actualCounts = new Map();
for (const h of hits) {
  const k = `${h.file}::${h.key}`;
  actualCounts.set(k, (actualCounts.get(k) ?? 0) + 1);
}
const grown = READ_BASELINE.filter((b) => (actualCounts.get(`${b.file}::${b.key}`) ?? 0) > (b.count ?? 0)).map(
  (b) => `${b.file}::${b.key} — baseline ${b.count ?? 0}, now ${actualCounts.get(`${b.file}::${b.key}`)}`,
);
const cleared = READ_BASELINE.map((b) => `${b.file}::${b.key}`).filter((k) => !seenKeys.has(k));
const remainingLegacy = hits.filter((h) => h.key === "extensions");

if (asJson) {
  console.log(
    JSON.stringify(
      {
        hits,
        unknown,
        cleared,
        remainingLegacyReads: remainingLegacy.length,
        grown,
        baseline: BASELINE,
        specParserSites: SPEC_PARSER_SITES,
        unrelatedLastAtSplits: UNRELATED_LAST_AT_SPLITS,
        relatedCodeSites: RELATED_CODE_SITES,
        docSites: DOC_SITES,
        outOfRepoFollowups: OUT_OF_REPO_FOLLOWUPS,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`extension-declaration read sites (repo root: ${REPO_ROOT})\n`);
  for (const key of ["extensions", "systemExtensions"]) {
    const rows = hits.filter((h) => h.key === key);
    console.log(`cinatra.${key} — ${rows.length} property-read site(s):`);
    for (const r of rows) console.log(`  ${r.file}:${r.line}  ${r.text.slice(0, 96)}`);
    console.log("");
  }
  console.log(`declaration-shaped FIXTURES (writes, not reads) to update: ${FIXTURE_BASELINE.length}`);
  for (const f of FIXTURE_BASELINE) console.log(`  ${f.file} — ${f.step1}`);
  console.log("");
  console.log(`spec-parser duplicates to fold: ${SPEC_PARSER_SITES.length}`);
  for (const f of SPEC_PARSER_SITES) console.log(`  ${f}`);
  console.log(`\nunrelated last-"@" splits (DO NOT fold): ${UNRELATED_LAST_AT_SPLITS.length}`);
  for (const [f, why] of UNRELATED_LAST_AT_SPLITS) console.log(`  ${f} — ${why}`);
  console.log(`\nrelated code sites (no declaration read of their own): ${RELATED_CODE_SITES.length}`);
  for (const [f, why] of RELATED_CODE_SITES) console.log(`  ${f} — ${why}`);
  console.log(`\ndoc/comment sites: ${DOC_SITES.length}`);
  for (const [f, why] of DOC_SITES) console.log(`  ${f} — ${why}`);
  console.log(`\nout-of-repo follow-ups: ${OUT_OF_REPO_FOLLOWUPS.length}`);
  for (const [f, why] of OUT_OF_REPO_FOLLOWUPS) console.log(`  ${f} — ${why}`);
  console.log(`\ncinatra.extensions property reads remaining: ${remainingLegacy.length} (target: 0)`);
  if (cleared.length > 0) {
    console.log(`\nPROGRESS — baseline sites no longer reading a declaration:`);
    for (const k of cleared) console.log(`  ${k}`);
  }
}

// Every in-repo path the inventory names must exist — a rotted entry is a
// silent hole in the migration plan.
const namedPaths = [
  ...BASELINE.map((b) => b.file),
  ...SPEC_PARSER_SITES,
  ...UNRELATED_LAST_AT_SPLITS.map(([f]) => f),
  ...RELATED_CODE_SITES.map(([f]) => f),
  ...DOC_SITES.map(([f]) => f),
];
const missingPaths = [...new Set(namedPaths)].filter((f) => {
  try {
    statSync(path.join(REPO_ROOT, f));
    return false;
  } catch {
    return true;
  }
});
if (missingPaths.length > 0) {
  console.error(`\nFAIL: ${missingPaths.length} inventory path(s) no longer exist:`);
  for (const f of missingPaths) console.error(`  ${f}`);
  process.exit(1);
}

if (grown.length > 0) {
  console.error(`\nFAIL: ${grown.length} baselined file(s) grew additional declaration reads:`);
  for (const g of grown) console.error(`  ${g}`);
  console.error("A new read in an already-known file still needs a decision — update the baseline count deliberately.");
  process.exit(1);
}

if (unknown.length > 0) {
  console.error(`\nFAIL: ${unknown.length} declaration read site(s) not in the curated baseline:`);
  for (const u of unknown) console.error(`  ${u.file}:${u.line}  ${u.text.slice(0, 96)}`);
  console.error("Add them to BASELINE with their role + migration action, or remove the read.");
  process.exit(1);
}
