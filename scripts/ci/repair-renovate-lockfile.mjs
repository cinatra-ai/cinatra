#!/usr/bin/env node
// FULL Renovate lockfile repair — regenerate pnpm-lock.yaml with the PINNED
// companion extension repos present and the TRUSTED default-branch
// `.pnpmfile.cjs` active, so the lockfile regains BOTH things Mend's hosted
// Renovate strips, while resolving Renovate's controlled dependency bump.
//
// WHY A SECOND (FULLER) REPAIR EXISTS
// -----------------------------------
// `repair-pnpmfile-checksum.mjs` (the surgical primitive) re-inserts only the
// single `pnpmfileChecksum:` line. That flips the *plain* frozen-install gates
// green, but this repo has a SECOND class of gate that clones the companion
// extension repos back and then runs `pnpm install --frozen-lockfile` against
// the full workspace (design-visual-verify, e2e-app-suites, the IoC gates, the
// Docker build ...). Those still fail after the checksum-only repair, because
// the hosted Renovate regenerator ALSO drops every `extensions/<scope>/*`
// workspace IMPORTER entry — it runs with `--ignore-pnpmfile` AND without the
// companion repos cloned, so pnpm never sees those workspace packages and omits
// them:
//
//     ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"
//     because pnpm-lock.yaml is not up to date with
//     extensions/cinatra-ai/a2a-server-connector/package.json
//
// There is also a THIRD failure mode (e.g. PR #1760): Renovate bumps a
// workspace package.json WITHOUT regenerating the lockfile at all, so the
// lockfile is simply stale vs the bumped manifest.
//
// THE COMPLETE REPAIR (this script) reproduces exactly what a normal CI/dev
// install does: clone the companions at their committed pins (the SAME
// `sync-dev-extensions.mjs --pinned` mechanism `.github/actions/clone-extensions`
// uses), then `pnpm install --lockfile-only --ignore-scripts` with the real
// `.pnpmfile.cjs` active. That single deterministic install restores the
// importer set AND the checksum AND resolves the renovate bump. It supersedes
// all three failure modes.
//
// SECURITY MODEL (why regenerating a Renovate branch's lockfile is safe here)
// --------------------------------------------------------------------------
// Regenerating a lockfile runs the repo's `.pnpmfile.cjs` (arbitrary code) and
// reads every workspace package.json / pnpm-workspace.yaml declaratively. The
// hosted Renovate app refuses to run the pnpmfile for exactly this reason. We
// re-enable it under a fail-closed boundary:
//
//   (a) ALLOWLIST GATE (execute ONLY the default-branch pnpmfile). Before
//       regenerating we diff the branch against its merge-base with the trusted
//       base ref and REFUSE LOUDLY unless every changed path is either
//       `pnpm-lock.yaml` or a `package.json` whose ONLY changes are
//       dependency-VERSION values: same dependency keys, every non-dependency
//       field byte-identical, AND every changed value a plain REGISTRY semver
//       range (no `:` / `/` — so a "version" edit can never redirect a dep to an
//       attacker tarball / git / file: / link: / workspace: / npm: alias /
//       github shorthand). Any change to `.pnpmfile.cjs`, `pnpm-workspace.yaml`,
//       a script, a workflow, a lockfile-pin, or a non-version package.json
//       field aborts the repair. Because the branch's `.pnpmfile.cjs` /
//       `pnpm-workspace.yaml` / package.json (sans versions) are thereby proven
//       byte-identical to the trusted base, running the branch's own copies IS
//       running the default-branch's — the one piece of branch-controlled code
//       pnpm executes (the pnpmfile) is vetted-identical.
//   (b) TRUSTED-BASE SEED. We OVERWRITE the worktree's pnpm-lock.yaml with the
//       merge-base (trusted) lockfile BEFORE regenerating, so pnpm derives the
//       resolution graph from base + the vetted manifest bump — never from the
//       branch's (untrusted) lockfile. A poisoned `packages:` / `snapshots:` /
//       integrity entry an attacker planted in the branch lockfile is discarded,
//       not carried forward. (pnpm 11.1.2 predates the upstream attacker-lockfile
//       integrity defenses, so we must not feed it the branch lockfile at all.)
//   (c) `--ignore-scripts` on the install (belt with `--lockfile-only`, which
//       links nothing and runs no lifecycle scripts anyway).
//   (d) SANE-DIFF GATE. After regeneration we verify the result is exactly a
//       lockfile-only, bump-only change vs the trusted base: the working tree
//       touches ONLY `pnpm-lock.yaml`; the `pnpmfileChecksum` is present and
//       equals the one computed from the (vetted) `.pnpmfile.cjs`; the importer
//       key set equals the merge-base lockfile's; and the ONLY importer
//       specifier changes are exactly the renovate-bumped dependencies. Any
//       deviation REFUSES.
//   (e) SECRET SCRUB. EVERY subprocess this script spawns (git, the clone-back,
//       and the pnpm install) gets a copy of the environment with the push
//       credential and any GitHub token DELETED, so neither the vetted pnpmfile
//       nor git can read them. This script itself never pushes; the elevated
//       push credential lives only in the CALLER's push step.
//
// This script does NOT push. It leaves a repaired `pnpm-lock.yaml` in the
// worktree and exits 0 (repaired) / 0 (already-correct, no-op) / non-zero
// (refused / error). The caller commits + pushes (the workflow injects the
// least-privilege push token only into that final step).
//
// MANUAL RUNBOOK (heal one Renovate PR locally)
// ---------------------------------------------
//   # in a throwaway worktree checked out at the Renovate branch tip:
//   git fetch origin renovate/<branch> && git switch --detach FETCH_HEAD
//   node <trusted-checkout>/scripts/ci/repair-renovate-lockfile.mjs \
//       --repo-dir "$PWD" --base origin/main --pnpm "corepack pnpm"
//   #   -> allowlist + clone pinned companions + regenerate + sane-diff verify
//   git add pnpm-lock.yaml
//   git commit -m "fix(deps): regenerate lockfile with pinned companions (restores importers + pnpmfileChecksum stripped by Renovate)" -m "Assisted-by: none"
//   git push origin HEAD:renovate/<branch>
//
// Ticking Renovate's rebase/retry checkbox does NOT fix it — that re-runs the
// Mend regenerator, which strips the importers + checksum again. The repair has
// to run AFTER Renovate writes the lockfile.
//
// Pre-install-safe pure core: the exported helpers use node builtins only and
// perform no IO, so they are unit-tested without git/pnpm.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { computeChecksum, CHECKSUM_LINE } from "./repair-pnpmfile-checksum.mjs";

// The four package.json dependency buckets whose VERSION values a Renovate
// branch may legitimately change. Anything else changing = refuse.
export const DEP_BUCKETS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

// Composite-key delimiter for `importer | bucket | dep`. `|` cannot appear in an
// npm package name, a workspace path, or a bucket word, so it round-trips
// unambiguously and stays greppable (no NUL / control bytes in the source).
const SEP = "|";

// Env vars scrubbed from every spawned subprocess (clone + pnpm install) so the
// one piece of branch code that runs (the vetted pnpmfile) can never read a
// credential. Extend via --scrub-env.
const DEFAULT_SCRUB = Object.freeze([
  "RENOVATE_LOCKFILE_REPAIR_TOKEN",
  "REPAIR_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

// ---------------------------------------------------------------------------
// Pure helpers (no IO) — unit-tested in __tests__/repair-renovate-lockfile.test.mjs
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

// Strip one pair of matching surrounding YAML quotes (pnpm quotes a specifier
// only when it contains YAML-special chars; simple specs stay bare).
function unquoteYamlScalar(s) {
  const m = /^'(.*)'$/.exec(s) || /^"(.*)"$/.exec(s);
  return m ? m[1] : s;
}

function keyFor(importer, bucket, dep) {
  return `${importer}${SEP}${bucket}${SEP}${dep}`;
}

function humanKey(k) {
  return k.split(SEP).join(" / ");
}

// A Renovate bump only ever moves a REGISTRY dependency from one semver range to
// another. Reject any value that redirects a dependency to a non-registry source
// while looking like a mere "version" edit. pnpm's non-registry / local forms:
//   - protocols + aliases + paths + github shorthand: contain `:` or `/`
//     (npm:/file:/link:/workspace:/git+/http(s)://, `owner/repo`, `git@h:p`);
//   - a Windows path separator `\`;
//   - an IMPLICIT LOCAL DIRECTORY: a leading `.` (`.`, `..`, `.\x`) — no valid
//     semver range starts with `.`;
//   - an IMPLICIT LOCAL TARBALL: an archive suffix (`x.tgz`, `x.tar.gz`, ...).
// Everything else (semver ranges `^1.2.3` / `>=1 <2` / `1.x` / `*`, and bare
// dist-tags like `latest`, which still resolve from the registry) is accepted;
// the charset bound is a final sanity belt.
export function isRegistrySpecifier(v) {
  if (typeof v !== "string" || v.length === 0) return false;
  if (/[:/\\]/.test(v)) return false; // protocol / alias / path / github shorthand / windows sep
  if (/^\./.test(v)) return false; // leading dot => pnpm local directory
  if (/\.(tgz|tar)(\.(gz|bz2|xz|zst|lz))?$/i.test(v)) return false; // archive suffix => local tarball
  return /^[\sA-Za-z0-9.^~><=*+|-]+$/.test(v); // registry semver ranges + dist-tags only
}

/**
 * Partition the paths a Renovate branch changed (vs its merge-base) into the
 * allowed kinds. `pnpm-lock.yaml` and any `package.json` are allowed here (the
 * package.json CONTENT is dep-version-checked separately); everything else is
 * disallowed.
 */
export function classifyChangedPaths(paths) {
  const packageJson = [];
  const disallowed = [];
  let lockChanged = false;
  for (const p of paths) {
    if (p === "pnpm-lock.yaml") lockChanged = true;
    else if (path.basename(p) === "package.json") packageJson.push(p);
    else disallowed.push(p);
  }
  return { lockChanged, packageJson, disallowed };
}

/**
 * Structural diff of a package.json restricted to dependency-version fields.
 * Returns an object with `violations` (a change OUTSIDE a dependency version)
 * and `changed` (the dependency version bumps: bucket/name/from/to).
 */
export function diffPackageJsonDeps(basePkg, headPkg, label = "package.json") {
  const violations = [];
  const changed = [];

  const stripped = (o) => {
    const c = { ...o };
    for (const b of DEP_BUCKETS) delete c[b];
    return c;
  };
  if (!deepEqual(stripped(basePkg), stripped(headPkg))) {
    violations.push(
      `${label}: a non-dependency field changed — only dependency VERSION values may differ on a Renovate branch.`,
    );
  }

  for (const bucket of DEP_BUCKETS) {
    const a = basePkg[bucket] || {};
    const b = headPkg[bucket] || {};
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) {
      violations.push(
        `${label}: the ${bucket} key set changed — a dependency was added or removed (only version values may change).`,
      );
      continue;
    }
    for (const name of ak) {
      if (a[name] === b[name]) continue;
      if (typeof b[name] !== "string") {
        violations.push(`${label}: ${bucket}.${JSON.stringify(name)} is not a version string.`);
        continue;
      }
      // Both the old and new value must be plain registry semver — a change to
      // or from a source protocol/path/alias is a redirection, not a bump.
      if (!isRegistrySpecifier(a[name]) || !isRegistrySpecifier(b[name])) {
        violations.push(
          `${label}: ${bucket}.${JSON.stringify(name)} version change ${JSON.stringify(a[name])} -> ` +
            `${JSON.stringify(b[name])} is not a registry semver bump (a source protocol / path / alias is refused).`,
        );
        continue;
      }
      changed.push({ bucket, name, from: a[name], to: b[name] });
    }
  }
  return { violations, changed };
}

// The `importers:` block spans from the top-level `importers:` key to the next
// top-level (column-0) key. The lockfile is machine-generated and regular, so a
// scoped, indent-exact line parser is robust and needs no YAML dependency
// (none is available pre-install).
function importersSectionLines(lockText) {
  const lines = lockText.split("\n");
  const start = lines.indexOf("importers:");
  if (start === -1) return [];
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // next top-level key ends the section
    body.push(lines[i]);
  }
  return body;
}

// Indent-exact matchers. A 2-space key is an importer path; 4-space is a
// dependency bucket; 6-space is a dependency name; an 8-space `specifier:` is
// its declared spec. The first-char guard makes each level reject the
// deeper-indented lines (a 4-space line has a space at offset 2, etc.).
const IMPORTER_KEY = /^ {2}(?:'([^']*)'|"([^"]*)"|([^\s'":][^:]*)):\s*$/;
const BUCKET_KEY = /^ {4}(dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/;
const DEP_KEY = /^ {6}(?:'([^']*)'|"([^"]*)"|([^\s'":][^:]*)):\s*$/;
const SPECIFIER = /^ {8}specifier:\s*(.+?)\s*$/;

const keyOf = (m) => m[1] ?? m[2] ?? m[3];

/** Sorted list of importer path keys (root, packages, cloned extensions). */
export function extractImporterKeys(lockText) {
  const keys = [];
  for (const l of importersSectionLines(lockText)) {
    const m = IMPORTER_KEY.exec(l);
    if (m) keys.push(keyOf(m));
  }
  return keys.sort();
}

/** Map `importer | bucket | depName` -> declared specifier (unquoted). */
export function extractImporterSpecifiers(lockText) {
  const map = new Map();
  let importer = null;
  let bucket = null;
  let dep = null;
  for (const l of importersSectionLines(lockText)) {
    let m;
    if ((m = IMPORTER_KEY.exec(l))) {
      importer = keyOf(m);
      bucket = null;
      dep = null;
    } else if ((m = BUCKET_KEY.exec(l))) {
      bucket = m[1];
      dep = null;
    } else if ((m = DEP_KEY.exec(l))) {
      dep = keyOf(m);
    } else if ((m = SPECIFIER.exec(l)) && importer && bucket && dep) {
      map.set(keyFor(importer, bucket, dep), unquoteYamlScalar(m[1]));
    }
  }
  return map;
}

export function extractChecksum(lockText) {
  return lockText.match(CHECKSUM_LINE)?.[1] ?? null;
}

/**
 * The post-regeneration invariant: a lockfile-only, bump-only change.
 *   - `expectedChecksum` present in the regenerated lockfile;
 *   - regenerated importer key set == base importer key set;
 *   - the ONLY importer specifier changes are exactly `bumpedSpecifiers`
 *     (a Map `importer | bucket | depName` -> new specifier), each reflected;
 *   - at least one bump (otherwise there is nothing to regenerate for).
 * Returns `{ ok, problems, changedSpecifierKeys }`.
 */
export function saneDiff({ baseLock, regenLock, expectedChecksum, bumpedSpecifiers }) {
  const problems = [];

  const regenSum = extractChecksum(regenLock);
  if (!regenSum) {
    problems.push("regenerated lockfile has no pnpmfileChecksum line.");
  } else if (regenSum !== expectedChecksum) {
    problems.push(
      `pnpmfileChecksum mismatch: regenerated ${regenSum} != expected ${expectedChecksum} ` +
        "(computed from the vetted .pnpmfile.cjs).",
    );
  }

  const baseKeys = extractImporterKeys(baseLock);
  const regenKeys = extractImporterKeys(regenLock);
  if (baseKeys.join("\n") !== regenKeys.join("\n")) {
    const added = regenKeys.filter((k) => !baseKeys.includes(k));
    const removed = baseKeys.filter((k) => !regenKeys.includes(k));
    problems.push(
      `importer set != base lockfile: added [${added.join(", ")}] removed [${removed.join(", ")}].`,
    );
  }

  const baseSpec = extractImporterSpecifiers(baseLock);
  const regenSpec = extractImporterSpecifiers(regenLock);
  const changedKeys = new Set();
  for (const [k, v] of regenSpec) if (baseSpec.get(k) !== v) changedKeys.add(k);
  for (const [k, v] of baseSpec) if (regenSpec.get(k) !== v) changedKeys.add(k);

  const expectedKeys = new Set(bumpedSpecifiers.keys());
  for (const k of changedKeys) {
    if (!expectedKeys.has(k)) {
      problems.push(
        `unexpected importer specifier change at ${humanKey(k)}: ` +
          `${baseSpec.get(k) ?? "(absent)"} -> ${regenSpec.get(k) ?? "(absent)"} — ` +
          "not part of the Renovate bump.",
      );
    }
  }
  for (const [k, want] of bumpedSpecifiers) {
    const got = regenSpec.get(k);
    if (got !== want) {
      problems.push(
        `Renovate bump not reflected at ${humanKey(k)}: expected specifier ${want}, lockfile has ${got ?? "(absent)"}.`,
      );
    }
  }
  if (bumpedSpecifiers.size === 0) {
    problems.push("no dependency-version bump detected on the branch — nothing to regenerate.");
  }

  return { ok: problems.length === 0, problems, changedSpecifierKeys: [...changedKeys] };
}

// ---------------------------------------------------------------------------
// Orchestration (IO) — guarded by the direct-invocation check at the bottom.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    repoDir: process.cwd(),
    base: "origin/main",
    pnpm: "pnpm",
    syncScript: null,
    skipClone: false,
    check: false,
    scrub: [...DEFAULT_SCRUB],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo-dir") args.repoDir = path.resolve(argv[++i]);
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--pnpm") args.pnpm = argv[++i];
    else if (a === "--sync-script") args.syncScript = path.resolve(argv[++i]);
    else if (a === "--skip-clone") args.skipClone = true;
    else if (a === "--check") args.check = true;
    else if (a === "--scrub-env") args.scrub = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "-h" || a === "--help") args.help = true;
    else {
      console.error(`repair-renovate-lockfile: unknown argument '${a}'`);
      process.exit(2);
    }
  }
  return args;
}

const USAGE = `Usage: node scripts/ci/repair-renovate-lockfile.mjs [options]

  --repo-dir <path>     Worktree checked out at the Renovate branch tip (default: cwd).
  --base <ref>          Trusted base ref; its merge-base with HEAD anchors the diff (default: origin/main).
  --pnpm <cmd>          pnpm invocation, e.g. "corepack pnpm" (default: "pnpm").
  --sync-script <path>  Trusted clone-back script (default: sibling sync-dev-extensions.mjs).
  --skip-clone          Reuse companions already cloned into <repo-dir>/extensions (still verified present).
  --scrub-env <a,b>     Env vars deleted from spawned subprocesses (default: the push/GitHub tokens).
  --check               Verify only; leave the repaired lockfile in the worktree and describe (caller commits).
  -h, --help

Exit: 0 repaired or already-correct; 2 refused (allowlist / sane-diff); other = error.`;

function git(repoDir, args, opts = {}) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

function scrubbedEnv(scrub) {
  const env = { ...process.env };
  for (const k of scrub) delete env[k];
  return env;
}

function die(msg, code = 2) {
  console.error(`\n::error::repair-renovate-lockfile REFUSED — ${msg}`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const { repoDir, pnpm, skipClone, check, scrub } = args;
  const syncScript =
    args.syncScript || path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-dev-extensions.mjs");
  const lockPath = path.join(repoDir, "pnpm-lock.yaml");

  // (e) SECRET SCRUB — the token-free env every subprocess (git, clone, pnpm)
  // inherits. Computed up front so even the read-only git calls never carry it.
  const env = scrubbedEnv(scrub);
  const g = (a, o) => git(repoDir, a, { env, ...o });

  if (!existsSync(lockPath)) {
    die(`no pnpm-lock.yaml under --repo-dir ${repoDir}`, 3);
  }
  const pnpmfilePath = path.join(repoDir, ".pnpmfile.cjs");
  if (!existsSync(pnpmfilePath)) {
    die(`no .pnpmfile.cjs under --repo-dir ${repoDir} — this repair only applies to the pnpmfile repo.`, 3);
  }

  // Resolve the merge-base of the trusted base ref and the branch tip.
  const base = g(["merge-base", args.base, "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) {
    die(`could not resolve a merge-base of ${args.base} and HEAD (got '${base}'). Fetch the base ref first.`, 4);
  }
  const headSha = g(["rev-parse", "HEAD"]).trim();
  console.log(`repair-renovate-lockfile: repoDir=${repoDir}`);
  console.log(`  HEAD=${headSha.slice(0, 12)}  base(merge-base with ${args.base})=${base.slice(0, 12)}`);

  // (a) ALLOWLIST GATE ------------------------------------------------------
  const changedRaw = g(["diff", "--name-only", `${base}..HEAD`]).trim();
  const changedPaths = changedRaw ? changedRaw.split("\n") : [];
  const { packageJson, disallowed } = classifyChangedPaths(changedPaths);
  if (disallowed.length) {
    die(
      "the Renovate branch changed paths OUTSIDE the allowlist " +
        "(only pnpm-lock.yaml and dependency-version package.json edits are permitted):\n    - " +
        disallowed.join("\n    - "),
    );
  }

  const bumpedSpecifiers = new Map();
  const violations = [];
  for (const p of packageJson) {
    let basePkg;
    let headPkg;
    try {
      basePkg = JSON.parse(g(["show", `${base}:${p}`]));
    } catch {
      // package.json added on the branch (no base version) — refuse: a new
      // manifest is not a version bump and changes the workspace shape.
      violations.push(`${p}: added on the branch (not present at base) — outside a dependency-version bump.`);
      continue;
    }
    try {
      headPkg = JSON.parse(readFileSync(path.join(repoDir, p), "utf8"));
    } catch (err) {
      violations.push(`${p}: unreadable/invalid JSON in the worktree (${err.message}).`);
      continue;
    }
    const { violations: v, changed } = diffPackageJsonDeps(basePkg, headPkg, p);
    violations.push(...v);
    const importer = path.dirname(p) === "." ? "." : path.dirname(p);
    for (const c of changed) bumpedSpecifiers.set(keyFor(importer, c.bucket, c.name), c.to);
  }
  if (violations.length) {
    die("package.json changes are not confined to dependency versions:\n    - " + violations.join("\n    - "));
  }
  if (bumpedSpecifiers.size === 0) {
    die(
      "no dependency-version bump found vs base — nothing for this full repair to regenerate. " +
        "(If only pnpm-lock.yaml changed, the checksum-only primitive already covers it.)",
      3,
    );
  }
  console.log(
    `  allowlist OK — bumped: ${[...bumpedSpecifiers].map(([k, v]) => `${humanKey(k)}=${v}`).join(", ")}`,
  );

  // Capture the trusted reference state from the merge-base lockfile.
  const baseLock = g(["show", `${base}:pnpm-lock.yaml`]);
  const expectedChecksum = computeChecksum(readFileSync(pnpmfilePath));
  const baseChecksum = extractChecksum(baseLock);
  if (baseChecksum && baseChecksum !== expectedChecksum) {
    // The allowlist already forbids .pnpmfile.cjs edits; this is a redundant
    // guard that the branch's pnpmfile really is the base's.
    die(
      `.pnpmfile.cjs checksum (${expectedChecksum}) does not match the base lockfile's (${baseChecksum}) — ` +
        "the pnpmfile diverged from base despite the allowlist. Aborting.",
    );
  }
  // CLONE the pinned companions with the trusted script + scrubbed env.
  if (skipClone) {
    // Verify the workspace-member companions (the extension importers of the
    // base lockfile) are actually present before trusting a prior clone.
    const missing = extractImporterKeys(baseLock)
      .filter((k) => k.startsWith("extensions/"))
      .filter((k) => {
        try {
          return !statSync(path.join(repoDir, k, "package.json")).isFile();
        } catch {
          return true;
        }
      });
    if (missing.length) {
      die(
        `--skip-clone but ${missing.length} companion importer package.json are missing under ${repoDir} ` +
          `(e.g. ${missing.slice(0, 3).join(", ")}). Run without --skip-clone.`,
        4,
      );
    }
    console.log("  companions: reusing already-cloned extensions/ (--skip-clone; presence verified).");
  } else {
    console.log("  companions: cloning pinned set via sync-dev-extensions --pinned ...");
    execFileSync("node", [syncScript, "--pinned"], { cwd: repoDir, stdio: "inherit", env });
  }

  // (b) TRUSTED-BASE SEED — overwrite the branch's (untrusted) lockfile with the
  // merge-base lockfile so pnpm derives the resolution graph from base + the
  // vetted manifest bump, never from anything the branch planted in its
  // packages:/snapshots:/integrity entries.
  writeFileSync(lockPath, baseLock);

  // (c) REGENERATE — the vetted pnpmfile runs here; scrubbed env; no scripts.
  const [pnpmBin, ...pnpmPre] = pnpm.split(" ").filter(Boolean);
  console.log(`  seeded trusted base lockfile; regenerating: ${pnpm} install --lockfile-only --ignore-scripts --no-frozen-lockfile`);
  execFileSync(
    pnpmBin,
    [...pnpmPre, "install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"],
    { cwd: repoDir, stdio: "inherit", env },
  );

  // (d) SANE-DIFF GATE ------------------------------------------------------
  const restore = () => g(["checkout", "--", "pnpm-lock.yaml"]);

  // Content: the regenerated lockfile is base + exactly the renovate bump.
  const regenLock = readFileSync(lockPath, "utf8");
  const verdict = saneDiff({ baseLock, regenLock, expectedChecksum, bumpedSpecifiers });
  if (!verdict.ok) {
    restore(); // leave a clean worktree on refusal
    die("regenerated lockfile failed the sane-diff invariant:\n    - " + verdict.problems.join("\n    - "));
  }

  // Shape: the working tree must touch ONLY pnpm-lock.yaml (extensions/ +
  // node_modules are git-ignored, so `status --porcelain` hides the clone + any
  // install output). NB: do NOT trim the whole block — porcelain prefixes each
  // entry with a 2-col status + a space (` M pnpm-lock.yaml`); trimming would
  // strip the first entry's leading space and shift the slice.
  const porcelain = g(["status", "--porcelain"]);
  const dirty = porcelain.split("\n").filter((l) => l.length > 0).map((l) => l.slice(3));
  const unexpected = dirty.filter((p) => p !== "pnpm-lock.yaml");
  if (unexpected.length) {
    restore();
    die("regeneration touched paths other than pnpm-lock.yaml:\n    - " + unexpected.join("\n    - "));
  }

  // Repaired vs no-op: does the trusted regeneration differ from the branch's
  // COMMITTED lockfile? If not, the branch already carried the correct
  // (base-derived) lockfile — nothing to push.
  if (!dirty.includes("pnpm-lock.yaml")) {
    console.log("\nrepair-renovate-lockfile: RESULT already-correct (branch already carried the trusted regeneration).");
    process.exit(0);
  }

  console.log(
    `\nrepair-renovate-lockfile: RESULT repaired — importers restored, checksum ${expectedChecksum}, ` +
      `bump-only specifier change(s): ${verdict.changedSpecifierKeys.map(humanKey).join("; ")}.`,
  );
  if (check) {
    console.log("  (--check) leaving the repaired pnpm-lock.yaml in the worktree; caller to commit.");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
