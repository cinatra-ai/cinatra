import path from "node:path";
import { readFileSync } from "node:fs";
import { defaultRepoSyncDeps, syncOneRepo } from "./dev-repo-sync.mjs";

// ---------------------------------------------------------------------------
// `cinatra setup` dev-extension clone bootstrap.
//
// Dev consumes each extension from a git checkout under
// `extensions/<scope>/<name>/` (git-ignored after the cutover). This module
// clones-or-fast-forwards each entry of `package.json` `cinatra.devExtensions`
// (the `cinatraDevExtensions` map, placed under the `cinatra` key for
// consistency with `devApps`/`requiredExtensions`) into its slot.
//
// It REUSES the proven five-state tree-safety model from
// `dev-repo-sync.mjs` (`syncOneRepo`): absent/empty → clone; clean
// + correct origin/branch → fetch + ff-only (force: hard reset); dirty → skip
// unless force; wrong origin/branch → hard fail even with force; non-empty
// non-git → hard fail.
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
    // The milestone names this top-level `cinatraDevExtensions`; we also accept
    // `cinatra.devExtensions` (consistent with `cinatra.devApps`).
    // Top-level wins so the documented key is authoritative if both are set.
    const cfg = pkg?.cinatraDevExtensions ?? pkg?.cinatra?.devExtensions;
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

const shortName = (pkgName) => String(pkgName).replace(/^@[^/]+\//, "");

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
  log(`- Dev extensions (${selected.length} selected${flags.jobs > 1 ? `, --jobs ${flags.jobs} reserved` : ""}):`);
  for (const { pkgName, spec, kind } of selected) {
    const url = env[extensionEnvOverrideVarFor(pkgName)] || spec.url;
    const branch = spec.branch || "main";
    const dest = destDirForExtension(pkgName, spec, targetRoot);
    const r = syncOneRepo({
      pkgName,
      url,
      branch,
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
