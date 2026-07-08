import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
    unlink: (p) => rmSync(p, { force: true }),
  };
}

// Runtime-written published-marker debris (cinatra#1136). Older app releases'
// boot-time agent published-marker backfill wrote `.cinatra-published.json`
// into every agent companion checkout under extensions/ (the marker the agent
// runtime's loader gates on; the app regenerates it whenever it is needed —
// current releases write it into the runtime mount instead, and the
// create-extension scaffold gitignores it). It is TOOL-GENERATED DEBRIS, not
// local work: an UNTRACKED top-level marker must never read as "uncommitted
// changes" (it blocked the pinned recovery sync across 33 companion checkouts
// on the documented update path), so the dirty computation ignores it and the
// pinned/re-pin paths delete it before detaching.
export const PUBLISHED_MARKER_BASENAME = ".cinatra-published.json";

// Exact `git status --porcelain` line for an UNTRACKED top-level marker. A
// TRACKED (committed, then modified/deleted) marker is deliberately NOT
// matched — that is a real tree divergence, not debris.
const STRAY_MARKER_STATUS_LINE = `?? ${PUBLISHED_MARKER_BASENAME}`;

function dirIsEmpty(dir, deps) {
  try {
    return deps.readdir(dir).filter((n) => n !== ".DS_Store").length === 0;
  } catch {
    return true;
  }
}

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Sync a single target repo. `deps` is injectable for tests. Returns
 * { pkgName, action } or throws on a fail-state. `forceFlagHint` / `stashLabel`
 * let each caller surface the right force-flag advice (dev-apps vs extensions).
 *
 * Pinned mode (`sha` set): the target is checked out DETACHED at exactly that
 * commit instead of tracking `origin/<branch>`. Used by CI so the validated
 * extension universe is the COMMITTED lock state, not whatever the companion
 * repos' tips say at run time (cinatra#141). Pinned semantics per state:
 *   - absent/empty            -> clone (delegates partial-state cleanup to
 *                                `git clone`), ensure the commit is present
 *                                (fetch the exact sha only when the cloned
 *                                branch does not already contain it), then
 *                                `checkout --detach <sha>` + assert HEAD==sha.
 *                                A failure after the clone leaves a valid
 *                                branch-mode checkout that the existing-git
 *                                path below re-pins on retry.
 *   - existing git, clean     -> verify origin (branch-name check does NOT
 *                                apply — detached HEAD is the expected state),
 *                                no-op when HEAD already equals the pin,
 *                                otherwise fetch-if-missing + re-detach.
 *   - existing git, dirty     -> HARD FAIL. Pinned mode never stashes or
 *                                resets local work (no --force semantics).
 *   - wrong origin / non-git  -> hard fail (unchanged from branch mode).
 */
export function syncOneRepo({
  pkgName,
  url,
  branch,
  sha,
  lockSha,
  dest,
  force,
  deps,
  log,
  forceFlagHint = "--force",
  stashLabel = "cinatra setup --force",
}) {
  const { git } = deps;
  // Pinned mode accepts ONLY a full lowercase 40-hex commit sha — anything
  // else (branch name, short sha, flag-like string) is refused before any git
  // invocation. The regex also subsumes the leading-dash argument guard.
  if (sha !== undefined && (typeof sha !== "string" || !COMMIT_SHA_RE.test(sha))) {
    throw new Error(
      `${pkgName}: pinned sync requires a full lowercase 40-hex commit sha (got "${sha}").`,
    );
  }
  // `lockSha` (non-pinned mode only): the committed lock pin for this repo,
  // resolved BEST-EFFORT by the caller. Consulted ONLY for a detached,
  // origin-matching checkout (see below); same sha grammar as `sha`.
  if (lockSha !== undefined && (typeof lockSha !== "string" || !COMMIT_SHA_RE.test(lockSha))) {
    throw new Error(
      `${pkgName}: lockSha must be a full lowercase 40-hex commit sha (got "${lockSha}").`,
    );
  }
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

  // Ensure the pinned commit exists locally, fetching the EXACT sha only when
  // the checkout does not already contain it (the common case — a recorded
  // branch head — is already present after a branch clone/earlier fetch, so
  // this avoids a per-repo network round-trip). GitHub serves reachable-sha
  // fetches; an unreachable pin (force-pushed companion history) fails loud
  // here — that is the bump-the-lock signal, never a silent fallback to tip.
  const ensurePinnedCommitTo = (pin) => {
    let present = true;
    try {
      git(["cat-file", "-e", `${pin}^{commit}`], dest);
    } catch {
      present = false;
    }
    if (!present) git(["fetch", "origin", pin], dest);
    git(["checkout", "--detach", pin], dest);
    const head = git(["rev-parse", "HEAD"], dest).trim();
    if (head !== pin) {
      throw new Error(
        `${pkgName}: pinned checkout verification failed — HEAD is ${head}, expected ${pin}.`,
      );
    }
  };
  const ensurePinnedCommit = () => ensurePinnedCommitTo(sha);

  // Tree state, with the untracked published-marker debris classified apart
  // from real local work (see PUBLISHED_MARKER_BASENAME above).
  const readTreeState = () => {
    const lines = git(["status", "--porcelain"], dest)
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() !== "");
    const strayMarkers = lines.filter((l) => l === STRAY_MARKER_STATUS_LINE);
    return {
      dirty: lines.length > strayMarkers.length,
      hasStrayMarker: strayMarkers.length > 0,
    };
  };
  const dropStrayPublishedMarker = () => {
    log(
      `  ${pkgName}: removing stray untracked ${PUBLISHED_MARKER_BASENAME} ` +
        `(runtime-written marker debris, regenerated by the app — not local work).`,
    );
    const unlink = deps.unlink ?? ((p) => rmSync(p, { force: true }));
    unlink(path.join(dest, PUBLISHED_MARKER_BASENAME));
  };

  // absent OR empty non-git dir -> clone
  if (!exists || (!isGit && dirIsEmpty(dest, deps))) {
    log(
      sha
        ? `  ${pkgName}: cloning ${redactGitUrl(url)} (pinned ${sha.slice(0, 12)}) -> ${dest}`
        : `  ${pkgName}: cloning ${redactGitUrl(url)} (${branch}) -> ${dest}`,
    );
    deps.mkdirp(path.dirname(dest));
    git(["clone", "--branch", branch, "--single-branch", "--", url, dest], path.dirname(dest));
    if (sha) {
      ensurePinnedCommit();
      return { pkgName, action: "cloned", changed: true, pinnedSha: sha };
    }
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

  // A detached HEAD reports "HEAD" as its branch. In PINNED mode that is the
  // expected state (handled in full below). In NON-PINNED mode a detached,
  // origin-matching companion is the committed-lock state a pinned fresh-clone
  // left behind (`make setup` → scripts/ci/sync-dev-extensions.mjs --pinned,
  // cinatra#489) — NOT a wrong branch. Leave it AT the validated pin instead of
  // throwing, and instead of dragging it to the branch tip (which would
  // reintroduce the #489 lockfile/generated-maps drift). cinatra#835: this is
  // exactly what `cinatra instance refresh` (and `instance setup dev`) hit after
  // a pinned `make setup` — without this the non-pinned sync exits non-zero with
  // a confusing `tracks ... on branch "HEAD"` error even though the checkout sits
  // at precisely the lock the committed tree was built against. A WRONG origin
  // (checked below) still hard-fails; a NON-detached wrong branch still hard-fails.
  if (sha === undefined && originMatches && curBranch === "HEAD") {
    const head = git(["rev-parse", "HEAD"], dest).trim();
    // cinatra#1136 (update path): when the caller resolved a committed lock
    // pin for this repo and the detached checkout is NOT at it, the lock has
    // MOVED since the pinned clone (a `git pull` advanced the tree). Leaving
    // the companion at the old pin breaks the reconcile contract — its modules
    // no longer match the committed generated import maps, and every
    // server-rendered page 500s. Re-pin to the CURRENT lock (still never a
    // drag to the branch tip). Real local work blocks the move with a
    // non-fatal skip, mirroring the branch-mode dirty path; stray
    // published-marker debris does not.
    if (lockSha !== undefined && lockSha !== head) {
      const tree = readTreeState();
      if (tree.dirty) {
        log(
          `  ${pkgName}: SKIP — uncommitted changes in ${dest} (detached at ${head.slice(0, 12)}; ` +
            `the committed lock expects ${lockSha.slice(0, 12)}). Commit or stash them, then re-run.`,
        );
        return { pkgName, action: "skipped-dirty" };
      }
      // LOCAL-COMMIT guard (codex review): `status --porcelain` cannot see a
      // COMMIT made while detached that no branch/tag/remote ref reaches —
      // re-pinning would strand it (git's "leaving N commits behind" warning
      // is swallowed by the captured subprocess). Only an OLD MANAGED PIN
      // (reachable from some ref) may be moved; anything unreachable is local
      // work → non-fatal skip with remediation.
      let unreachableTip = "";
      try {
        unreachableTip = git(
          ["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--remotes", "--tags"],
          dest,
        ).trim();
      } catch {
        unreachableTip = "unverifiable";
      }
      if (unreachableTip !== "") {
        log(
          `  ${pkgName}: SKIP — detached HEAD ${head.slice(0, 12)} carries commits no branch/tag/remote ` +
            `ref reaches (local work made while detached). Branch it (git -C ${dest} branch <name>) or ` +
            `move it aside, then re-run.`,
        );
        return { pkgName, action: "skipped-local-commits" };
      }
      if (tree.hasStrayMarker) dropStrayPublishedMarker();
      log(
        `  ${pkgName}: re-pinning ${head.slice(0, 12)} -> ${lockSha.slice(0, 12)} (detached; the committed lock moved)`,
      );
      ensurePinnedCommitTo(lockSha);
      return { pkgName, action: "repinned", changed: true, pinnedSha: lockSha };
    }
    log(
      `  ${pkgName}: detached at ${head.slice(0, 12)} (committed-lock fresh-clone state) — leaving as-is.`,
    );
    // When the caller-resolved lock CONFIRMS this checkout is at the pin,
    // report the verified pin (callers use it to classify the SOURCE CONTENT
    // as committed-lock state, e.g. the local-registry seed's skew policy).
    // `pinnedSha` asserts the WORKING TREE matches the pin, so it is only
    // emitted when the tree is clean (codex review: local edits at the
    // current pin must never be classified as committed content — the seed
    // packs the working tree). Stray marker debris is dropped first, exactly
    // like the pinned at-pin path.
    if (lockSha !== undefined && lockSha === head) {
      const tree = readTreeState();
      if (!tree.dirty) {
        if (tree.hasStrayMarker) dropStrayPublishedMarker();
        return { pkgName, action: "skipped-detached", changed: false, pinnedSha: lockSha };
      }
    }
    return { pkgName, action: "skipped-detached", changed: false };
  }

  // Pinned mode skips the branch-name check (a detached HEAD reports "HEAD",
  // and a pre-existing branch checkout is simply re-pinned below) — the origin
  // check still applies in full.
  if (!originMatches || (sha === undefined && curBranch !== branch)) {
    // Wrong origin or branch is NEVER auto-reset, even with --force.
    throw new Error(
      `${pkgName}: "${dest}" tracks ${redactGitUrl(originRaw) || "(no origin)"} on branch "${curBranch}", ` +
        `but ${redactGitUrl(url)} on "${branch}" is expected. ` +
        `Fix the remote/branch or move the directory aside; this is never auto-reset. ` +
        `(Use ${envOverrideVarFor(pkgName)} to point at a fork/SSH URL.)`,
    );
  }

  // clean+correct origin+branch: check dirty (stray published-marker debris
  // is classified apart — it never counts as local work).
  const tree = readTreeState();
  const dirty = tree.dirty;

  if (sha) {
    // Pinned mode has NO stash/reset path: a dirty tree is a hard fail (CI
    // checkouts are always fresh; a local pinned run must never destroy work).
    if (dirty) {
      throw new Error(
        `${pkgName}: "${dest}" has uncommitted changes — pinned sync never stashes or resets local work. ` +
          `Clean the tree (or move the directory aside), then re-run.`,
      );
    }
    // The pinned contract is the EXACT committed-lock tree: drop the
    // runtime-written marker debris (cinatra#1136 — 33 stray markers made the
    // pinned recovery sync fail closed on the documented update path).
    if (tree.hasStrayMarker) dropStrayPublishedMarker();
    const headBefore = git(["rev-parse", "HEAD"], dest).trim();
    if (headBefore === sha) {
      // The pinned contract is "AT the pin and DETACHED" — a warm checkout
      // sitting on a branch that happens to point at the pin is still
      // detached here (cheap; content unchanged, so `changed` stays false).
      if (curBranch !== "HEAD") git(["checkout", "--detach", sha], dest);
      return { pkgName, action: "pinned", changed: false, pinnedSha: sha };
    }
    log(`  ${pkgName}: re-pinning ${headBefore.slice(0, 12)} -> ${sha.slice(0, 12)} (detached)`);
    ensurePinnedCommit();
    return { pkgName, action: "repinned", changed: true, pinnedSha: sha };
  }
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
