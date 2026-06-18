import path from "node:path";
import { readFileSync } from "node:fs";
import { defaultRepoSyncDeps, normalizeGitHubRemote, syncOneRepo } from "./dev-repo-sync.mjs";

// ---------------------------------------------------------------------------
// `cinatra setup` dev-extension clone bootstrap.
//
// Dev consumes each extension from a git checkout under
// `extensions/<scope>/<name>/` (git-ignored after the cutover). This module
// clones-or-fast-forwards each entry of `package.json` `cinatra.devExtensions`
// (the `cinatra.devExtensions` map, placed under the `cinatra` key for
// consistency with `devApps`/`extensions`) into its slot.
//
// It REUSES the proven five-state tree-safety model from
// `dev-repo-sync.mjs` (`syncOneRepo`): absent/empty → clone; clean
// + correct origin/branch → fetch + ff-only (force: hard reset); dirty → skip
// unless force; wrong origin/branch → hard fail even with force; non-empty
// non-git → hard fail.
//
// `--pinned` (CI; cinatra#141) swaps tip-tracking for detached checkouts at
// the shas committed in the two lock files (see `loadDevExtensionPins`), so a
// companion-repo merge can never change what a host CI run validates. Local
// `cinatra setup` keeps tip-tracking — devs want tips.
//
// `syncCinatraDevExtensions` returns `{ skipped: true, reason: "no-config" }` on
// an empty map, or `{ results: [...] }` with one entry per selected extension
// (`{ pkgName, action, kind, dest }`). A caller that materializes new checkouts
// (a fresh clone or a `--force` reset) MUST re-run `pnpm install` afterward so the
// newly-present extension packages are linked into the pnpm workspace — pnpm only
// creates an extension's per-extension `node_modules` (and links its transitive
// deps) when the package exists on disk at install time, so a package cloned in
// AFTER the initial install stays unlinked until the next install. See
// `installAfterExtensionSync` in index.mjs (the `setup dev` / `setup clone` flows).
// ---------------------------------------------------------------------------

const KIND_SUFFIXES = [
  ["-agent", "agent"],
  ["-connector", "connector"],
  ["-artifact", "artifact"],
  ["-skills", "skill"],
  ["-skill", "skill"],
  ["-workflow", "workflow"],
];

/** Derive the extension kind WITHOUT cloning — from a declared `kind` or the
 * package-name suffix (best-effort; null when unknown). `--kind` filtering must
 * not require a not-yet-cloned package.json. */
export function deriveKindFromName(pkgName, declaredKind) {
  if (declaredKind) return declaredKind;
  const short = String(pkgName).replace(/^@[^/]+\//, "");
  for (const [suffix, kind] of KIND_SUFFIXES) if (short.endsWith(suffix)) return kind;
  return null;
}

// A real scoped npm name: @scope/name with conservative segment chars — NO "/"
// inside the name segment, no "..", no leading dot. Blocks path-traversal config
// keys like `@cinatra-ai/../../outside` from escaping the extensions tree.
const SAFE_SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/** Throw unless `dest` resolves to a path strictly INSIDE `rootDir`. */
function assertContainedIn(rootDir, dest, pkgName, label) {
  const rel = path.relative(path.resolve(rootDir), dest);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `[cinatra dev-extensions] refusing a destination outside ${label}: "${pkgName}" → "${dest}".`,
    );
  }
  return dest;
}

/** `@scope/name` → `<targetRoot>/extensions/<scope>/<name>` (or spec.path).
 * Hardened: an explicit `spec.path` may live anywhere UNDER the repo/worktree
 * root but never escape it (blocks absolute paths + `../` traversal); a derived
 * path requires a valid scoped package name + is contained to `extensions/`. */
export function destDirForExtension(pkgName, spec, targetRoot) {
  if (spec?.path) {
    const dest = path.resolve(targetRoot, spec.path);
    return assertContainedIn(targetRoot, dest, pkgName, "the repo root");
  }
  if (!SAFE_SCOPED_PKG_RE.test(String(pkgName))) {
    throw new Error(
      `[cinatra dev-extensions] invalid extension package name "${pkgName}" — expected @scope/name ` +
        `(lowercase; no "/" in the name segment, no "..").`,
    );
  }
  const m = String(pkgName).match(/^@([^/]+)\/(.+)$/);
  const dest = path.resolve(targetRoot, "extensions", m[1], m[2]);
  return assertContainedIn(path.join(targetRoot, "extensions"), dest, pkgName, "extensions/");
}

export function readDevExtensionsConfig(repoRoot, readFile = readFileSync) {
  try {
    const pkg = JSON.parse(readFile(path.join(repoRoot, "package.json"), "utf8"));
    // The dev-extension clone set lives under `cinatra.devExtensions`
    // (consistent with `cinatra.devApps`).
    const cfg = pkg?.cinatra?.devExtensions;
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

const shortName = (pkgName) => String(pkgName).replace(/^@[^/]+\//, "");

// ---------------------------------------------------------------------------
// Pinned mode (cinatra#141): CI checks out every dev extension DETACHED at a
// committed lock sha instead of tracking branch tips, so a companion-repo
// merge can never change what a host CI run validates.
//
// The pin set is PARTITIONED across two committed locks, with no overlap:
//   - cinatra-required-extensions.lock.json — the prod bootable set (also the
//     image build's acquisition source; it stays the SINGLE authority for
//     those packages — never duplicated into the dev lock);
//   - cinatra-dev-extensions.lock.json — every OTHER cinatra.devExtensions
//     entry (regenerated by scripts/extensions/update-dev-extension-lock.mjs).
// ---------------------------------------------------------------------------

// Kept in lockstep with prod-extension-acquisition.mjs `LOCK_FILENAME` (not
// imported from there: that module imports `destDirForExtension` from THIS
// one, and the consistency test asserts the strings stay equal).
export const REQUIRED_EXTENSIONS_LOCK_FILENAME = "cinatra-required-extensions.lock.json";
export const DEV_EXTENSIONS_LOCK_FILENAME = "cinatra-dev-extensions.lock.json";

const PIN_SHA_RE = /^[0-9a-f]{40}$/;
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readPinLock(repoRoot, filename, readFile, { allowEmpty = false } = {}) {
  let raw;
  try {
    raw = readFile(path.join(repoRoot, filename), "utf8");
  } catch {
    throw new Error(
      `[cinatra dev-extensions] pinned sync requires the committed ${filename}, which could not be read. ` +
        `Regenerate it (scripts/extensions/update-${filename.includes("-dev-") ? "dev" : "required"}-extension-lock.mjs) and commit it.`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[cinatra dev-extensions] ${filename} is not valid JSON: ${err.message}`);
  }
  const packages = Array.isArray(doc?.packages) ? doc.packages : null;
  if (!packages || (packages.length === 0 && !allowEmpty)) {
    throw new Error(`[cinatra dev-extensions] ${filename} has no "packages" entries — refusing pinned sync.`);
  }
  const seen = new Set();
  for (const [i, p] of packages.entries()) {
    const tag = `${filename} packages[${i}]`;
    if (!p || typeof p !== "object" || typeof p.packageName !== "string") {
      throw new Error(`[cinatra dev-extensions] ${tag}: not an object with a packageName.`);
    }
    if (typeof p.resolvedSha !== "string" || !PIN_SHA_RE.test(p.resolvedSha)) {
      throw new Error(`[cinatra dev-extensions] ${tag} (${p.packageName}): resolvedSha must be a 40-hex lowercase commit sha.`);
    }
    if (typeof p.repo !== "string" || !REPO_SLUG_RE.test(p.repo) || p.repo.includes("..")) {
      throw new Error(`[cinatra dev-extensions] ${tag} (${p.packageName}): repo must be an "owner/name" GitHub slug.`);
    }
    // Duplicates WITHIN one lock would make the later merge order-dependent
    // (last entry silently wins) — refuse them here, fail-closed.
    if (seen.has(p.packageName)) {
      throw new Error(`[cinatra dev-extensions] ${tag}: duplicate pin for "${p.packageName}" in ${filename}.`);
    }
    seen.add(p.packageName);
  }
  return packages;
}

const configUrlOf = (spec) => (spec && typeof spec === "object" ? spec.url : String(spec));

/**
 * Build the fail-closed pkgName -> { sha, repo, source } pin map for pinned
 * sync. Throws (never degrades to tip-tracking) when:
 *   - either lock is missing/malformed;
 *   - a package is pinned in BOTH locks (two authorities = divergence risk);
 *   - a dev-lock entry is not in `cinatra.devExtensions` (stale pin);
 *   - a config entry has no pin in either lock (unpinnable universe);
 *   - a lock `repo` slug contradicts the COMMITTED config URL (a
 *     CINATRA_*_REPO_URL env override is deliberately NOT consulted here — an
 *     override is only an alternate remote that must still serve the pin).
 */
export function loadDevExtensionPins(repoRoot, readFile = readFileSync) {
  const config = readDevExtensionsConfig(repoRoot, readFile);
  if (!config || Object.keys(config).length === 0) {
    throw new Error("[cinatra dev-extensions] pinned sync requires a non-empty `cinatra.devExtensions` config.");
  }
  const required = readPinLock(repoRoot, REQUIRED_EXTENSIONS_LOCK_FILENAME, readFile);
  // An empty dev lock is legal IFF the required lock covers the whole
  // universe (the per-entry completeness check below still enforces that).
  const dev = readPinLock(repoRoot, DEV_EXTENSIONS_LOCK_FILENAME, readFile, { allowEmpty: true });

  const pins = new Map();
  for (const p of required) {
    pins.set(p.packageName, { sha: p.resolvedSha, repo: p.repo, source: REQUIRED_EXTENSIONS_LOCK_FILENAME });
  }
  for (const p of dev) {
    if (pins.has(p.packageName)) {
      throw new Error(
        `[cinatra dev-extensions] "${p.packageName}" is pinned in BOTH locks — the required lock is the sole ` +
          `authority for its packages; remove the duplicate from ${DEV_EXTENSIONS_LOCK_FILENAME} ` +
          `(regenerate it via scripts/extensions/update-dev-extension-lock.mjs).`,
      );
    }
    if (!(p.packageName in config)) {
      throw new Error(
        `[cinatra dev-extensions] ${DEV_EXTENSIONS_LOCK_FILENAME} pins "${p.packageName}", which is not a ` +
          `cinatra.devExtensions entry — stale pin; regenerate the dev lock.`,
      );
    }
    pins.set(p.packageName, { sha: p.resolvedSha, repo: p.repo, source: DEV_EXTENSIONS_LOCK_FILENAME });
  }

  for (const [pkgName, spec] of Object.entries(config)) {
    const pin = pins.get(pkgName);
    if (!pin) {
      throw new Error(
        `[cinatra dev-extensions] "${pkgName}" has no pin in ${REQUIRED_EXTENSIONS_LOCK_FILENAME} or ` +
          `${DEV_EXTENSIONS_LOCK_FILENAME} — pinned sync is fail-closed. Regenerate the dev lock ` +
          `(scripts/extensions/update-dev-extension-lock.mjs) and commit it.`,
      );
    }
    // Repo-slug cross-check against the COMMITTED config URL. Local remotes
    // (file:// / absolute path — test fixtures) normalize to null and skip it.
    const want = normalizeGitHubRemote(configUrlOf(spec));
    if (want !== null && pin.repo.toLowerCase() !== want) {
      throw new Error(
        `[cinatra dev-extensions] "${pkgName}": lock pins repo "${pin.repo}" but the committed config URL ` +
          `resolves to "${want}" — retargeted repo without a re-pin; regenerate the lock entry.`,
      );
    }
  }
  return pins;
}

export function parseDevExtensionFlags(argv = []) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const jobs = parseInt(val("--jobs") ?? "1", 10);
  return {
    select: list(val("--select")),
    kinds: list(val("--kind")),
    exclude: list(val("--exclude")),
    jobs: Number.isFinite(jobs) && jobs > 0 ? jobs : 1,
    force: argv.includes("--force"),
    // CI mode (cinatra#141): detached checkouts at the committed lock shas
    // instead of branch tips. Mutually exclusive with --force by design — the
    // pinned path has no stash/reset semantics.
    pinned: argv.includes("--pinned"),
  };
}

/** Apply `--select` / `--kind` / `--exclude` (match full or short name). */
export function selectEntries(config, flags) {
  const entries = Object.entries(config).map(([pkgName, spec]) => {
    const normalized = spec && typeof spec === "object" ? spec : { url: String(spec) };
    return { pkgName, spec: normalized, kind: deriveKindFromName(pkgName, normalized.kind) };
  });
  const matches = (set, e) => set.includes(e.pkgName) || set.includes(shortName(e.pkgName));
  return entries.filter((e) => {
    if (flags.select.length && !matches(flags.select, e)) return false;
    if (flags.exclude.length && matches(flags.exclude, e)) return false;
    if (flags.kinds.length && (!e.kind || !flags.kinds.includes(e.kind))) return false;
    return true;
  });
}

/** "@cinatra-ai/foo-agent" → "CINATRA_FOO_AGENT_REPO_URL" */
export function extensionEnvOverrideVarFor(pkgName) {
  return `CINATRA_${shortName(pkgName).replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_REPO_URL`;
}

/**
 * Clone-or-pull every selected `cinatra.devExtensions` entry into its
 * `extensions/<scope>/<name>` slot under `targetRoot`. Sequential (the clone
 * correctness is the point; `--jobs` is parsed + reserved for a later perf pass,
 * since the underlying git is synchronous and the dev config is empty today).
 */
export async function syncCinatraDevExtensions({
  repoRoot,
  targetRoot,
  argv = [],
  env = process.env,
  log = console.log,
  deps,
} = {}) {
  const config = readDevExtensionsConfig(repoRoot, deps?.readFile);
  if (!config || Object.keys(config).length === 0) {
    return { skipped: true, reason: "no-config" };
  }
  const flags = parseDevExtensionFlags(argv);
  if (flags.pinned && flags.force) {
    throw new Error(
      "[cinatra dev-extensions] --pinned and --force are mutually exclusive — pinned sync never stashes or resets local work.",
    );
  }
  // Fail-closed BEFORE any git work: every config entry must be pinnable, or
  // pinned sync refuses outright (a partially-pinned universe would mix
  // committed state with floating tips).
  const pins = flags.pinned ? loadDevExtensionPins(repoRoot, deps?.readFile) : null;
  const selected = selectEntries(config, flags);
  if (selected.length === 0) {
    log("- Dev extensions: nothing matched the --select/--kind/--exclude filters.");
    return { results: [] };
  }
  // Merge over defaults so a caller can inject ONE dep (e.g. `readFile` for
  // config, or a fake `git` in tests) without having to supply the whole git-op
  // surface (`exists`/`git`/`mkdirp`/`readdir`) that `syncOneRepo` needs.
  const realDeps = deps ? { ...defaultRepoSyncDeps(), ...deps } : defaultRepoSyncDeps();
  const results = [];
  log(
    `- Dev extensions (${selected.length} selected${flags.pinned ? ", pinned to the committed lock shas" : ""}${flags.jobs > 1 ? `, --jobs ${flags.jobs} reserved` : ""}):`,
  );
  for (const { pkgName, spec, kind } of selected) {
    const url = env[extensionEnvOverrideVarFor(pkgName)] || spec.url;
    const branch = spec.branch || "main";
    const dest = destDirForExtension(pkgName, spec, targetRoot);
    const r = syncOneRepo({
      pkgName,
      url,
      branch,
      // An env-override remote (fork/mirror) must still SERVE the pinned sha;
      // it never unpins (loadDevExtensionPins validated the lock against the
      // committed config URL, not the override).
      sha: pins ? pins.get(pkgName).sha : undefined,
      dest,
      force: flags.force,
      deps: realDeps,
      log,
      forceFlagHint: "--force",
      stashLabel: "cinatra setup --force (devExtensions)",
    });
    results.push({ ...r, kind, dest });
  }
  return { results };
}
