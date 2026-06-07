import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Generic dev-time git repo sync.
//
// Shared clone/fast-forward machinery used by BOTH `dev-apps.mjs` (the external
// WordPress plugin + Drupal module clones) and `cinatra-dev-extensions.mjs` (the
// cinatra extension checkouts). Lives in its own module so neither consumer has
// to import the other's surface.
//
// Five explicit states per target (never silently destroys local work):
//   - absent OR empty non-git dir            -> clone
//   - clean git, correct origin + branch     -> fetch + ff-only (force: reset)
//   - dirty git, correct origin + branch     -> skip + warn (force: stash+reset)
//   - wrong origin OR wrong branch           -> fail with remediation (never reset)
//   - non-empty non-git dir                  -> fail with remediation
//
// Per-repo URL overrides via env: CINATRA_<NAME>_REPO_URL (HTTPS or SSH).
// ---------------------------------------------------------------------------

/** "@cinatra-ai/wordpress-plugin" -> "CINATRA_WORDPRESS_PLUGIN_REPO_URL" */
export function envOverrideVarFor(pkgName) {
  const base = String(pkgName)
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return `CINATRA_${base}_REPO_URL`;
}

/**
 * Normalize a GitHub remote (HTTPS or SSH) to "owner/repo" (lowercased, no
 * trailing slash, no .git) so HTTPS ↔ SSH forms of the same repo compare equal.
 * Returns null for non-GitHub / unparseable URLs.
 */
export function normalizeGitHubRemote(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\.git$/i, "");
  const m =
    s.match(/^git@github\.com:(.+)$/i) ||
    s.match(/^ssh:\/\/(?:[^@/]+@)?github\.com\/(.+)$/i) ||
    // Accept an optional `user@`/`token@` credential before the host so a
    // credentialed GitHub URL still normalizes to owner/repo (otherwise it
    // returned null → the origin check degraded to a raw path compare).
    s.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/(.+)$/i);
  if (!m) return null;
  return m[1].replace(/\/+$/, "").toLowerCase();
}

// A local (non-network) git remote: file:// or an absolute filesystem path.
// Used to confine the path-equality origin fallback to local remotes ONLY.
export function isLocalGitRemote(url) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  return u.startsWith("file://") || path.isAbsolute(u);
}

// Strip credentials embedded in a URL before logging (e.g. a
// `https://<token>@github.com/...` override leaks a PAT into CI/dev logs).
export function redactGitUrl(url) {
  if (typeof url !== "string") return String(url);
  return url.replace(/(\bhttps?:\/\/)[^@/\s]*@/gi, "$1***@").replace(/(\bssh:\/\/)[^@/\s]*@/gi, "$1***@");
}

// Remote allowlist: GitHub over https/ssh/scp (real extension + app repos) OR a
// local filesystem path / file:// (local mirrors + test fixtures). Anything else
// is refused BEFORE `git clone` so a malicious config can't make git contact an
// arbitrary remote.
export function isAllowedGitRemote(url) {
  if (typeof url !== "string" || url.trim() === "") return false;
  const u = url.trim();
  if (/^https:\/\/([^/@\s]+@)?github\.com\//i.test(u)) return true;
  if (/^ssh:\/\/git@github\.com\//i.test(u)) return true;
  if (/^git@github\.com:/i.test(u)) return true;
  if (u.startsWith("file://")) return true;
  if (path.isAbsolute(u)) return true; // local bare repo / mirror
  return false;
}

export function defaultRepoSyncDeps() {
  return {
    git: (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    exists: (p) => existsSync(p),
    readdir: (p) => readdirSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
  };
}

function dirIsEmpty(dir, deps) {
  try {
    return deps.readdir(dir).filter((n) => n !== ".DS_Store").length === 0;
  } catch {
    return true;
  }
}

/**
 * Sync a single target repo. `deps` is injectable for tests. Returns
 * { pkgName, action } or throws on a fail-state. `forceFlagHint` / `stashLabel`
 * let each caller surface the right force-flag advice (dev-apps vs extensions).
 */
export function syncOneRepo({
  pkgName,
  url,
  branch,
  dest,
  force,
  deps,
  log,
  forceFlagHint = "--force",
  stashLabel = "cinatra setup --force",
}) {
  const { git } = deps;
  // Git argument-injection defense-in-depth: a `url`/`branch` (from package.json
  // config or a CINATRA_*_REPO_URL env override) that begins with "-" would be
  // parsed by git as an option, not a positional. execFileSync already blocks
  // shell metachars; this blocks flag-like git args. A leading-dash repo URL or
  // branch is never legitimate here.
  for (const [label, val] of [["url", url], ["branch", branch]]) {
    if (typeof val === "string" && val.startsWith("-")) {
      throw new Error(`${pkgName}: refusing a "${label}" that begins with "-" ("${val}") — flag-like git arguments are not allowed.`);
    }
  }
  // Remote allowlist: never let a config entry make git contact an arbitrary host.
  if (!isAllowedGitRemote(url)) {
    throw new Error(
      `${pkgName}: refusing a git remote that is not GitHub or a local path: "${redactGitUrl(url)}". ` +
        `Allowed: https/ssh github.com, file://, or an absolute local path.`,
    );
  }
  const wantRemote = normalizeGitHubRemote(url);
  const exists = deps.exists(dest);
  const isGit = deps.exists(path.join(dest, ".git"));

  // absent OR empty non-git dir -> clone
  if (!exists || (!isGit && dirIsEmpty(dest, deps))) {
    log(`  ${pkgName}: cloning ${redactGitUrl(url)} (${branch}) -> ${dest}`);
    deps.mkdirp(path.dirname(dest));
    git(["clone", "--branch", branch, "--single-branch", "--", url, dest], path.dirname(dest));
    return { pkgName, action: "cloned" };
  }

  // non-empty non-git dir -> fail
  if (!isGit) {
    throw new Error(
      `${pkgName}: "${dest}" is a non-empty, non-git directory. ` +
        `Move it aside (or delete it), then re-run \`cinatra setup\`. ` +
        `Expected a clean clone of ${redactGitUrl(url)}.`,
    );
  }

  // git checkout: verify origin + branch (HTTPS ↔ SSH normalized)
  const originRaw = git(["remote", "get-url", "origin"], dest).trim();
  const haveRemote = normalizeGitHubRemote(originRaw);
  const curBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], dest).trim();

  // For GitHub remotes, compare the normalized owner/repo. For local remotes
  // `normalizeGitHubRemote` returns null for BOTH — comparing null===null would
  // treat two DIFFERENT repos as the same origin — so fall back to a resolved-path
  // comparison ONLY when BOTH sides are genuinely local (file:// / absolute path).
  // A non-GitHub, non-local remote is impossible here (the allowlist rejected it).
  const originMatches =
    wantRemote !== null
      ? haveRemote === wantRemote
      : isLocalGitRemote(url) && isLocalGitRemote(originRaw) && path.resolve(originRaw) === path.resolve(url);

  if (!originMatches || curBranch !== branch) {
    // Wrong origin or branch is NEVER auto-reset, even with --force.
    throw new Error(
      `${pkgName}: "${dest}" tracks ${redactGitUrl(originRaw) || "(no origin)"} on branch "${curBranch}", ` +
        `but ${redactGitUrl(url)} on "${branch}" is expected. ` +
        `Fix the remote/branch or move the directory aside; this is never auto-reset. ` +
        `(Use ${envOverrideVarFor(pkgName)} to point at a fork/SSH URL.)`,
    );
  }

  // clean+correct origin+branch: check dirty
  const dirty = git(["status", "--porcelain"], dest).trim() !== "";
  if (dirty) {
    if (!force) {
      log(
        `  ${pkgName}: SKIP — uncommitted changes in ${dest}. ` +
          `Commit or stash them, or re-run with ${forceFlagHint}.`,
      );
      return { pkgName, action: "skipped-dirty" };
    }
    log(`  ${pkgName}: --force — stashing local changes, then hard-reset to origin/${branch}`);
    git(["stash", "push", "--include-untracked", "-m", stashLabel], dest);
    log(`  ${pkgName}: local changes stashed as "${stashLabel}" — recover via: git -C ${dest} stash list && git -C ${dest} stash pop`);
  }

  const headBefore = git(["rev-parse", "HEAD"], dest).trim();
  git(["fetch", "origin", branch], dest);
  if (force) {
    git(["reset", "--hard", `origin/${branch}`], dest);
    return { pkgName, action: "force-reset" };
  }
  git(["merge", "--ff-only", `origin/${branch}`], dest);
  const headAfter = git(["rev-parse", "HEAD"], dest).trim();
  // `updated` covers BOTH a no-op pull and a real fast-forward. `changed`
  // distinguishes them so a post-sync workspace re-link runs only when HEAD
  // actually moved (a ff that may have added/changed deps), not on every warm run.
  return { pkgName, action: "updated", changed: headBefore !== headAfter };
}
