import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { Octokit } from "octokit";
import { unzipSync } from "fflate";
import { getGitHubAccessToken, getGitHubAPIStatus, getGitHubOAuthSettings } from "@/lib/github-api";
import { upsertRepositoryBackedSkillPackage, getSkillsDataRootPath } from "./skills-store";
import { compileAndRegisterAgentSkillsForRepo, type CompileAgentSkillsResult } from "./compile-agent-skills";

const GITHUB_SYNC_MARKER = "~github-sync.json";

function getGitHubSyncMarkerPath(): string {
  return path.join(getSkillsDataRootPath(), GITHUB_SYNC_MARKER);
}

function readGitHubSyncMarker(): { repository: string; syncedAt: string } | null {
  const markerPath = getGitHubSyncMarkerPath();
  // Leaf confinement (file-symlink escape, #300). The marker sits at a fixed
  // leaf under the skills data root, but if that leaf is a SYMLINK to an
  // outside file the `readFileSync` would follow it and leak arbitrary local
  // content. Skip (treat as no marker) when the real leaf escapes the real root.
  const skillsRoot = path.resolve(getSkillsDataRootPath());
  if (!existsSync(markerPath) || !isEntryContainedInBase(skillsRoot, path.resolve(markerPath)))
    return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeGitHubSyncMarker(repositoryFullName: string): Promise<void> {
  const markerPath = getGitHubSyncMarkerPath();
  // Leaf confinement (#300). Refuse to write through a symlinked marker leaf
  // that resolves OUT of the skills data root (a `writeFile` would otherwise
  // clobber an arbitrary outside file). A legitimate (non-symlink, or
  // not-yet-created) marker is a no-op for the realpath check.
  const skillsRoot = path.resolve(getSkillsDataRootPath());
  if (!isEntryContainedInBase(skillsRoot, path.resolve(markerPath))) {
    return;
  }
  await mkdir(path.dirname(markerPath), { recursive: true });
  // Dangling-write-leaf confinement (#300): the containment check above uses
  // existsSync (follows symlinks) so a pre-existing DANGLING symlink leaf would
  // slip through and `writeFile` would create the marker at the outside target.
  // lstat catches the dangling symlink. The marker is non-critical, so skip the
  // write (with a log) rather than writing through the symlink.
  if (!isLeafSafeToWrite(markerPath)) {
    console.warn(`[skills/github] refusing to write sync marker through symlink leaf: ${markerPath}`);
    return;
  }
  await writeFile(markerPath, JSON.stringify({ repository: repositoryFullName, syncedAt: new Date().toISOString() }, null, 2));
}

export type GitHubRepositoryReference = {
  owner: string;
  repo: string;
};

function normalizeRepositoryName(value: string) {
  return value.replace(/\.git$/i, "").trim();
}

/**
 * Local fail-closed containment barrier (js/path-injection, code-scanning).
 *
 * Resolve a filesystem target and assert it stays inside the fixed skills data
 * root BEFORE any destructive (`rm`/`mkdir`) or read (`existsSync`/`readdir`/
 * `readFile`) operation touches it. The install/sync callers already validate
 * `owner`/`repo` (see `isSafeOwnerAndRepo`, #291), so this never trips for
 * legitimate input — but the assertion is what CodeQL recognizes as a
 * flow-breaking sanitizer, and it makes the chokepoints safe regardless of a
 * future/unvalidated caller (e.g. the recursive `rm` in
 * `cloneGitHubRepoToDirectory` runs on the function parameter BEFORE the
 * per-entry containment loop).
 *
 * Returns the resolved, confined path so the caller feeds the
 * sanitizer-normalized value into the sink (which CodeQL tracks as the barrier
 * output, breaking the tainted flow).
 */
/**
 * Realpath the nearest EXISTING ancestor of `target` (walking up until a path
 * that exists is found). Used to canonicalize a not-yet-created leaf: realpath
 * of a missing path throws, so we resolve the deepest ancestor that exists and
 * treat the remaining (not-yet-created) segments as confined relative to it.
 * Returns the lexical resolve when no ancestor exists (defensive — the
 * filesystem root always exists in practice).
 */
function realpathNearestExisting(target: string): string {
  let current = path.resolve(target);
  // Walk up to the filesystem root; `path.dirname(root) === root`.
  for (;;) {
    if (existsSync(current)) {
      return realpathSync.native(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export function assertWithinSkillsRoot(targetDirectory: string, errorMessage: string): string {
  const skillsRoot = path.resolve(getSkillsDataRootPath());
  const resolvedTarget = path.resolve(targetDirectory);
  // Layer 1 — lexical containment (defense in depth; KEEP). Breaks the CodeQL
  // tainted flow and rejects pure `..` escapes before any fs access.
  if (resolvedTarget !== skillsRoot && !resolvedTarget.startsWith(skillsRoot + path.sep)) {
    throw new Error(errorMessage);
  }
  // Layer 2 — realpath containment (#300). A symlinked ANCESTOR under the
  // skills root passes the lexical prefix check but a downstream fs op would
  // follow it OUT of the intended root. Canonicalize the root and the target
  // (or, when the leaf does not exist yet, the nearest existing ancestor —
  // realpath of a missing leaf throws) and re-assert containment on the real
  // paths. Behavior is identical for legitimate non-symlink and not-yet-created
  // paths (realpath is a no-op on those).
  const realRoot = realpathNearestExisting(skillsRoot);
  const realTarget = realpathNearestExisting(resolvedTarget);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(errorMessage);
  }
  return resolvedTarget;
}

/**
 * Per-entry realpath containment for a materialized path rooted on an
 * already-confined base directory (#300, ZIP-slip + symlink-escape). Mirrors
 * `assertWithinSkillsRoot`'s two layers but as a no-throw predicate the
 * extraction loop uses to SKIP an escaping entry:
 *   1. Lexical containment — rejects pure `../` traversal baked into a ZIP
 *      entry name before any fs op (zip-slip).
 *   2. Realpath containment — a confined base may contain a SYMLINKED ancestor
 *      (or the entry's own leaf may be a symlink) that resolves OUT of the
 *      base; canonicalize the base and the entry (nearest-existing-ancestor
 *      realpath for a not-yet-created leaf) and re-assert on the real paths.
 * Behavior is identical for legitimate non-symlink, non-traversal entries
 * (realpath is a no-op on those).
 */
function isEntryContainedInBase(baseDirResolved: string, entryResolved: string): boolean {
  // Layer 1 — lexical.
  if (
    entryResolved !== baseDirResolved &&
    !entryResolved.startsWith(baseDirResolved + path.sep)
  ) {
    return false;
  }
  // Layer 2 — realpath.
  const realBase = realpathNearestExisting(baseDirResolved);
  const realEntry = realpathNearestExisting(entryResolved);
  return realEntry === realBase || realEntry.startsWith(realBase + path.sep);
}

/**
 * Dangling-write-leaf confinement (#300). `isEntryContainedInBase` and the
 * realpath helpers use `existsSync`, which FOLLOWS symlinks: a leaf that is a
 * DANGLING symlink (file pre-exists, target does NOT) makes `existsSync` return
 * false so the realpath checks treat it as a not-yet-created leaf and pass —
 * then `writeFile` follows the dangling symlink and creates the file at the
 * OUTSIDE target. `lstatSync` does NOT follow the symlink, catching the dangling
 * case. Returns `false` (refuse-the-write) when the leaf is a symlink so the
 * caller skips the non-critical write rather than writing through it; `true`
 * (proceed) for ENOENT (genuinely new file) or a regular file (the dir is
 * already realpath-confined). Behavior is identical for legitimate new-file and
 * regular-file writes.
 */
function isLeafSafeToWrite(leafPath: string): boolean {
  try {
    return !lstatSync(leafPath).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // genuinely new file — safe to create
    }
    throw err;
  }
}

// GitHub owner (user/org) login charset: alphanumerics and single hyphens.
// GitHub repository-name charset: alphanumerics plus `.`, `_`, `-`.
// Neither may be `.`/`..` nor contain a path separator. These guards are the
// authoritative defense against path traversal: `owner`/`repo` flow verbatim
// into `path.join(getSkillsDataRootPath(), "workspace", owner, repo)`, so a
// reference like `../..` (which the legacy `owner/repo` regex accepted as
// owner=".." repo="..") MUST be rejected here before it can escape the skills
// store sandbox (js/path-injection, code-scanning).
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

function isSafeOwnerAndRepo(owner: string, repo: string): boolean {
  if (!GITHUB_OWNER_PATTERN.test(owner)) return false;
  // Reject `.`/`..` and any traversal/separator chars in the repo segment.
  if (repo === "." || repo === ".." || !GITHUB_REPO_PATTERN.test(repo)) return false;
  if (repo.includes("/") || repo.includes("\\")) return false;
  return true;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseGitHubRepositoryReference(value: string): GitHubRepositoryReference | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const scpLikeMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scpLikeMatch) {
    const owner = scpLikeMatch[1]!.trim();
    const repo = normalizeRepositoryName(scpLikeMatch[2]!);
    return isSafeOwnerAndRepo(owner, repo) ? { owner, repo } : null;
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    const [ownerRaw, repoRaw] = trimmed.split("/");
    if (!ownerRaw || !repoRaw) return null;
    const owner = ownerRaw.trim();
    const repo = normalizeRepositoryName(repoRaw);
    return isSafeOwnerAndRepo(owner, repo) ? { owner, repo } : null;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") {
      return null;
    }

    const [ownerRaw, repoRaw] = url.pathname.split("/").filter(Boolean);
    if (!ownerRaw || !repoRaw) return null;
    const owner = ownerRaw.trim();
    const repo = normalizeRepositoryName(repoRaw);
    return isSafeOwnerAndRepo(owner, repo) ? { owner, repo } : null;
  } catch {
    return null;
  }
}

export type GitHubConnectionStatus = Awaited<ReturnType<typeof getGitHubAPIStatus>>;

export async function getGitHubOctokit(input?: {
  connectionId?: string;
}) {
  const { accessToken, connection } = await getGitHubAccessToken(input);
  const settings = await getGitHubOAuthSettings();
  const selectedRepository = settings.selectedRepositoryFullName
    ? parseGitHubRepositoryReference(settings.selectedRepositoryFullName)
    : null;

  return {
    octokit: new Octokit({
      auth: accessToken,
      userAgent: "cinatra-skills",
    }),
    connection,
    repository: selectedRepository,
  };
}

/**
 * Resolve a user-supplied ref (tag, branch, or commit sha) to a commit tree sha.
 *
 * Supports installing a skill repository at a specific GitHub Release tag
 * instead of just the default branch. Handles annotated tags
 * (object.type === "tag"), lightweight tags (object.type === "commit"),
 * branch names, and raw 40-char SHAs. Tag lookup is tried first because most
 * Release tags collide with no branch and we want a deterministic resolution
 * order. Throws a descriptive error when the ref cannot be resolved.
 */
/**
 * Match an Octokit error against a known HTTP status. Octokit's RequestError
 * exposes `status: number`; older fetch-shim errors only expose a message.
 * Matching on the message substring is fragile: rate-limit and auth errors
 * should not be misclassified as 404s.
 */
function isOctokitStatus(err: unknown, status: number): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number") return value === status;
  }
  return false;
}

async function resolveCommitTreeSha(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<string> {
  const { octokit, owner, repo, ref } = input;

  // 1. Tag (annotated or lightweight) — Releases land here.
  try {
    const tagRef = await octokit.rest.git.getRef({ owner, repo, ref: `tags/${ref}` });
    let commitSha = tagRef.data.object.sha;
    if (tagRef.data.object.type === "tag") {
      // Annotated tag: object.sha points at the tag object, not the commit.
      const tagObject = await octokit.rest.git.getTag({ owner, repo, tag_sha: commitSha });
      commitSha = tagObject.data.object.sha;
    }
    const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
    return commit.data.tree.sha;
  } catch (err) {
    // Only fall through on a real 404 — auth, rate-limit, network errors must surface.
    if (!isOctokitStatus(err, 404)) {
      throw err;
    }
  }

  // 2. Branch.
  try {
    const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: ref });
    return branch.data.commit.commit.tree.sha;
  } catch (err) {
    if (!isOctokitStatus(err, 404)) {
      throw err;
    }
  }

  // 3. Raw commit sha (full or short).
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    try {
      const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: ref });
      return commit.data.tree.sha;
    } catch {
      // fall through
    }
  }

  throw new Error(`GitHub ref "${ref}" could not be resolved against ${owner}/${repo} (no matching tag, branch, or commit).`);
}

async function cloneGitHubRepoToDirectory(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  targetDirectory: string;
  /** Optional tag / branch / sha. When undefined the repository's default branch is used. */
  ref?: string;
}) {
  const { octokit, owner, repo, ref } = input;
  let targetDirectory = input.targetDirectory;

  const repoResponse = await octokit.rest.repos.get({ owner, repo });
  let treeSha: string;
  if (ref) {
    treeSha = await resolveCommitTreeSha({ octokit, owner, repo, ref });
  } else {
    const defaultBranch = repoResponse.data.default_branch || "main";
    const branchResponse = await octokit.rest.repos.getBranch({ owner, repo, branch: defaultBranch });
    treeSha = branchResponse.data.commit.commit.tree.sha;
  }
  const treeResponse = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true",
  });

  if (treeResponse.data.truncated) {
    throw new Error("The selected GitHub repository is too large to sync through the current tree API flow.");
  }

  // Fail-closed local barrier (js/path-injection). The destructive recursive
  // `rm` below runs on the `targetDirectory` PARAMETER before the per-entry
  // containment loop, so confine it to the skills data root here regardless of
  // what the caller passed. Callers already validate `owner`/`repo` (#291); a
  // legitimate target never trips this. Reassign `targetDirectory` to the
  // resolved/confined path so CodeQL tracks the sanitizer output into the
  // `rm`/`mkdir` sinks below (the sink reads the barrier's return value; the
  // variable name is immaterial to the dataflow).
  targetDirectory = assertWithinSkillsRoot(
    targetDirectory,
    "Refusing to sync: clone target escapes the skills data root.",
  );

  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });

  // Containment root for every materialized tree entry. Defense-in-depth: Git
  // tree paths cannot themselves contain `..` components (Git rejects them in
  // tree objects), but we never write a path that resolves outside the clone
  // target regardless of what the API returns (js/path-injection).
  // `targetDirectory` is the confined base asserted above.
  for (const entry of treeResponse.data.tree) {
    if (!entry.path) continue;

    // Build the destination from the confined `targetDirectory` base (the
    // barrier output asserted above), then re-confirm the resolved entry stays
    // inside it. This is the #291 per-entry pattern; rooting it on the
    // sanitizer output makes the mkdir/writeFile/chmod sinks below tracked as
    // confined (js/path-injection).
    const destinationPath = path.join(targetDirectory, entry.path);
    // Per-entry realpath containment (#300), mirroring the ZIP-install loop's
    // `isEntryContainedInBase`. Git tree paths cannot contain `..`, but a tree
    // CAN carry a symlink blob (mode 120000) pointing outside; an earlier
    // symlink entry would then let a later `mkdir`/`writeFile` traverse OUT of
    // the confined clone target. Resolve each entry against the confined base
    // and SKIP on escape (lexical `..` + realpath symlink). Behavior is
    // identical for legitimate non-symlink, non-traversal trees.
    if (!isEntryContainedInBase(targetDirectory, path.resolve(destinationPath))) {
      // Skip any entry that would escape the clone target.
      continue;
    }

    if (entry.type === "tree") {
      await mkdir(destinationPath, { recursive: true });
      continue;
    }

    if (entry.type !== "blob" || !entry.sha) continue;

    const blobResponse = await octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    const content =
      blobResponse.data.encoding === "base64"
        ? Buffer.from(blobResponse.data.content, "base64")
        : Buffer.from(blobResponse.data.content, "utf8");

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, content);

    if (entry.mode === "100755") {
      await chmod(destinationPath, 0o755);
    }
  }

  return repoResponse.data;
}

/**
 * Checks if the configured GitHub skill repository has been cloned locally.
 * If it has not been cloned yet, clones it automatically. Intended to be called
 * once at startup so skills are available without a manual "Install" step.
 *
 * Fails silently — if GitHub is not configured, not connected, or the network
 * is unavailable, the call is a no-op and the rest of the skills system continues
 * serving whatever is available locally.
 */
export async function ensureConfiguredRepositorySynced(): Promise<void> {
  const settings = await getGitHubOAuthSettings().catch(() => null);
  if (!settings?.selectedRepositoryFullName) {
    return; // No repo configured — nothing to sync
  }

  const repository = parseGitHubRepositoryReference(settings.selectedRepositoryFullName);
  if (!repository) {
    return;
  }

  const repositoryFullName = settings.selectedRepositoryFullName.trim();

  // Already synced this exact repo — nothing to do
  const marker = readGitHubSyncMarker();
  if (marker?.repository === repositoryFullName) {
    return;
  }

  const targetDirectory = getSkillsDataRootPath();

  // Clone the configured repository — it's a skills *store* (container of
  // packages), not a package itself. The third-party scanner will discover
  // individual sub-packages inside it automatically.
  const { octokit } = await getGitHubOctokit();

  await cloneGitHubRepoToDirectory({
    octokit,
    owner: repository.owner,
    repo: repository.repo,
    targetDirectory,
  });

  await writeGitHubSyncMarker(repositoryFullName);
}

export async function cloneConfiguredGitHubSkillRepository() {
  const { octokit, repository } = await getGitHubOctokit();

  if (!repository) {
    throw new Error("Choose a GitHub repository before syncing it into the skills package.");
  }

  const targetDirectory = getSkillsDataRootPath();

  // The configured repo is a skills *store* — a container of packages.
  // Clone directly into the store root; the third-party scanner discovers sub-packages automatically.
  await cloneGitHubRepoToDirectory({
    octokit,
    owner: repository.owner,
    repo: repository.repo,
    targetDirectory,
  });

  const repositoryFullName = `${repository.owner}/${repository.repo}`;
  await writeGitHubSyncMarker(repositoryFullName);

  return { repository, repositoryPath: targetDirectory };
}

/**
 * Overloaded install path. Accepts either the original positional
 * `connectionId` (back-compat with `extensions_install`) or an options
 * object with `ref` (release tag, branch, or commit sha) and `connectionId`.
 * Existing call sites continue to compile unchanged.
 */
export async function installSkillPackageFromGitHub(
  repoRef: string,
  connectionIdOrOptions?: string | { ref?: string; connectionId?: string },
) {
  const options =
    typeof connectionIdOrOptions === "string"
      ? { connectionId: connectionIdOrOptions }
      : connectionIdOrOptions ?? {};
  const { ref, connectionId } = options;

  const repository = parseGitHubRepositoryReference(repoRef);
  if (!repository) {
    throw new Error(`Invalid GitHub repository reference: "${repoRef}". Use "owner/repo" or a github.com URL.`);
  }

  const { octokit } = await getGitHubOctokit({ connectionId });

  const packageSlug = slugify(`${repository.owner}-${repository.repo}`) || slugify(repository.repo) || "github-skills";
  const packageId = `github:${repository.owner}/${repository.repo}`;
  const packageName = `${repository.owner}/${repository.repo}`;

  // Target the ownership-first layout. GitHub-installed packages are
  // workspace-tier installs; they land at workspace/<owner>/<repo>/.
  // `getSkillsDataRootPath()` honors config + worktree isolation, and the
  // workspace scope prevents top-level package layouts from being created.
  const targetDirectory = assertWithinSkillsRoot(
    path.join(
      getSkillsDataRootPath(),
      "workspace",
      repository.owner,
      repository.repo,
    ),
    `Refusing to install ${packageId}: resolved target escapes the skills data root.`,
  );

  // Clobber guard. slugify() can produce a collision when two repositories
  // normalize to the same disk slug (e.g. `foo/bar-baz` vs `foo-bar/baz`).
  // Three cases:
  //   1. target dir is missing or empty → safe to clone.
  //   2. target has a marker pointing at THIS packageId → reinstall, allowed.
  //   3. target exists and is non-empty AND either has no marker, has a
  //      malformed marker, or has a marker pointing at a DIFFERENT
  //      packageId → refuse. Operator must uninstall via
  //      /configuration/extensions or remove the directory manually.
  const installMarkerPath = path.join(targetDirectory, ".cinatra-skill-source.json");
  const targetDirExists = existsSync(targetDirectory);
  const targetDirIsNonEmpty =
    targetDirExists && readdirSync(targetDirectory).filter((name) => name !== ".DS_Store").length > 0;
  if (targetDirIsNonEmpty) {
    let recordedPackageId: string | null = null;
    let markerIsValid = false;
    // Leaf confinement (file-symlink escape, #300). `targetDirectory` is the
    // realpath-confined install base, but `.cinatra-skill-source.json` inside
    // it could be a SYMLINK to an outside file the `readFileSync` below would
    // follow (leaking arbitrary local content into the provenance check, and
    // letting an attacker forge a "matching" marker from outside). Skip the
    // read when the real marker escapes the real base — treated as a missing
    // marker, which fails closed into the "no provenance marker" refusal.
    if (
      existsSync(installMarkerPath) &&
      isEntryContainedInBase(path.resolve(targetDirectory), path.resolve(installMarkerPath))
    ) {
      try {
        const marker = JSON.parse(readFileSync(installMarkerPath, "utf8")) as { packageId?: unknown };
        if (typeof marker.packageId === "string" && marker.packageId.length > 0) {
          recordedPackageId = marker.packageId;
          markerIsValid = true;
        }
      } catch {
        // malformed marker — treat as missing
      }
    }
    if (!markerIsValid) {
      throw new Error(
        `Refusing to overwrite a non-empty directory at data/skills/${packageSlug}/ that has no provenance marker. ` +
          `Uninstall the existing package via /configuration/extensions or remove the directory manually before installing ${packageId}.`,
      );
    }
    if (recordedPackageId !== packageId) {
      throw new Error(
        `Refusing to overwrite an existing skill package at data/skills/${packageSlug}/. ` +
          `That directory is owned by ${recordedPackageId}; uninstall it first before installing ${packageId}.`,
      );
    }
  }

  const repoData = await cloneGitHubRepoToDirectory({
    octokit,
    owner: repository.owner,
    repo: repository.repo,
    targetDirectory,
    ref,
  });

  // Drop a fresh marker that future installs use for the collision check.
  // Write-LEAF confinement (#300), mirroring the read-side check above. The
  // clone wiped+rebuilt `targetDirectory`, but a tree entry named
  // `.cinatra-skill-source.json` could have materialized the marker leaf as a
  // SYMLINK (the per-entry guard only confines its REAL target inside the base,
  // it does not forbid an in-base symlink), and `writeFile` would then follow
  // that link. Refuse to write through a marker leaf whose real path escapes the
  // install base. A non-symlink / not-yet-created marker is a no-op for the
  // realpath check, so behavior is identical for legitimate installs.
  if (
    existsSync(installMarkerPath) &&
    !isEntryContainedInBase(path.resolve(targetDirectory), path.resolve(installMarkerPath))
  ) {
    throw new Error(
      `Refusing to write the install marker for ${packageId}: marker leaf escapes the install target via symlink.`,
    );
  }
  await writeFile(
    installMarkerPath,
    JSON.stringify({ packageId, repository: packageName, ref: ref ?? null, installedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  const result = await upsertRepositoryBackedSkillPackage({
    packageId,
    name: packageName,
    slug: packageSlug,
    description: repoData.description?.trim() || `GitHub-backed skills package installed from ${packageName}.`,
    repositoryUrl: repoData.html_url,
    repositoryPath: targetDirectory,
    license: repoData.license?.spdx_id && repoData.license.spdx_id !== "NOASSERTION" ? repoData.license.spdx_id : undefined,
    authors: repoData.owner?.login ? [repoData.owner.login] : undefined,
  });

  // If the cloned repo contains an agents/ tree, auto-register every
  // agents/<slug>/skills/<skillSlug>/SKILL.md as level:"agent". Wrapped
  // defensively — a malformed agent or a single bad SKILL.md must not abort
  // the package install.
  let agentSkills: CompileAgentSkillsResult | undefined;
  if (existsSync(path.join(targetDirectory, "agents"))) {
    try {
      agentSkills = await compileAndRegisterAgentSkillsForRepo({ repoRoot: targetDirectory });
    } catch (err) {
      console.warn(
        `[skills/github] compileAndRegisterAgentSkillsForRepo failed for ${packageName}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { repository, repositoryPath: targetDirectory, packageId, ...result, agentSkills };
}

// ---------------------------------------------------------------------------
// Repository metadata + release discovery for the
// /configuration/extensions/upload GitHub-skill flow.
// ---------------------------------------------------------------------------

export type GitHubRepoReleaseSummary = {
  tagName: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  htmlUrl: string;
};

export type GitHubRepoMetadata = {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  licenseSpdxId: string | null;
  releases: GitHubRepoReleaseSummary[];
};

/**
 * Fetch repository metadata + non-draft releases for the upload form preview.
 * Returns null when the URL is not a github.com repo reference. The caller
 * decides whether the missing-ref case is user-fixable.
 */
export async function fetchGitHubRepoMetadata(
  repoRef: string,
  options?: { connectionId?: string },
): Promise<GitHubRepoMetadata | null> {
  const repository = parseGitHubRepositoryReference(repoRef);
  if (!repository) return null;

  const { octokit } = await getGitHubOctokit({ connectionId: options?.connectionId });

  const repoResponse = await octokit.rest.repos.get({ owner: repository.owner, repo: repository.repo });
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner: repository.owner,
    repo: repository.repo,
    per_page: 100,
  });

  const summaries: GitHubRepoReleaseSummary[] = releases
    .filter((release) => !release.draft && typeof release.tag_name === "string" && release.tag_name.length > 0)
    .map((release) => ({
      tagName: release.tag_name,
      name: release.name ?? null,
      draft: Boolean(release.draft),
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at ?? null,
      htmlUrl: release.html_url,
    }));

  return {
    owner: repository.owner,
    repo: repository.repo,
    fullName: `${repository.owner}/${repository.repo}`,
    description: repoResponse.data.description ?? null,
    defaultBranch: repoResponse.data.default_branch || "main",
    htmlUrl: repoResponse.data.html_url,
    licenseSpdxId:
      repoResponse.data.license?.spdx_id && repoResponse.data.license.spdx_id !== "NOASSERTION"
        ? repoResponse.data.license.spdx_id
        : null,
    releases: summaries,
  };
}

export async function installSkillPackageFromZip(zipBuffer: Buffer, slug: string) {
  const packageSlug = slugify(slug) || "zip-package";
  const packageId = `zip:${packageSlug}`;
  // Target the ownership-first layout. ZIP-uploaded packages are workspace-tier
  // user-authored installs; they land at workspace/uploaded/<slug>/.
  // Fail-closed base confinement (#300). Confine the install base to the
  // skills data root BEFORE the destructive `rm`/`mkdir` and per-entry writes.
  // The slug is slugified, so a legitimate upload never trips this; a symlinked
  // ancestor under workspace/uploaded that resolves the base outside the root
  // is rejected here. Reassign so the sanitizer output feeds the sinks below.
  const targetDirectory = assertWithinSkillsRoot(
    path.join(
      getSkillsDataRootPath(),
      "workspace",
      "uploaded",
      packageSlug,
    ),
    `Refusing to install ${packageId}: resolved target escapes the skills data root.`,
  );

  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });

  // Unzip using fflate
  const unzipped = unzipSync(new Uint8Array(zipBuffer));

  // Detect if there's a common root directory prefix (e.g., repo-main/) in the zip
  const allPaths = Object.keys(unzipped);
  const firstSlash = allPaths[0]?.indexOf("/") ?? -1;
  const rootPrefix = firstSlash > 0 && allPaths.every((p) => p.startsWith(allPaths[0]!.slice(0, firstSlash + 1)))
    ? allPaths[0]!.slice(0, firstSlash + 1)
    : "";

  // The extraction base for the per-entry zip-slip check is the confined target.
  const resolvedTarget = path.resolve(targetDirectory);
  for (const [zipPath, content] of Object.entries(unzipped)) {
    const relativePath = rootPrefix ? zipPath.slice(rootPrefix.length) : zipPath;
    if (!relativePath) continue; // root directory entry

    // ZIP-SLIP / symlink-escape (#300). Resolve each entry against the confined
    // base and SKIP any entry whose resolved real path escapes it — covers a
    // `../` lexical traversal baked into the entry name AND a symlinked
    // ancestor/leaf already materialized inside the base by an earlier entry.
    const destinationPath = path.join(targetDirectory, relativePath);
    if (!isEntryContainedInBase(resolvedTarget, path.resolve(destinationPath))) {
      continue;
    }
    if (zipPath.endsWith("/")) {
      await mkdir(destinationPath, { recursive: true });
    } else {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, content);
    }
  }

  const result = await upsertRepositoryBackedSkillPackage({
    packageId,
    name: slug,
    slug: packageSlug,
    description: `Skills package installed from ZIP: ${slug}.`,
    repositoryUrl: "",
    repositoryPath: targetDirectory,
  });

  return { packageId, repositoryPath: targetDirectory, ...result };
}

// ---------------------------------------------------------------------------
// Push the local skills store to the configured GitHub repository
// ---------------------------------------------------------------------------

/**
 * Push the entire contents of the local skills store (data/skills/) to the
 * configured GitHub skills repository.
 *
 * In normal mode, uses base_tree so the push merges with existing repo content.
 * With force: true, omits base_tree so the commit replaces all repo content.
 *
 * Fails silently if GitHub is not configured. Writes/updates ~github-sync.json
 * marker after a successful push.
 */
export async function pushSkillStoreToGitHub(options?: { force?: boolean }): Promise<{
  owner: string;
  repo: string;
  commitSha: string;
}> {
  const { octokit, repository } = await getGitHubOctokit();
  if (!repository) {
    throw new Error("Choose a GitHub repository before pushing the skills store.");
  }

  const { owner, repo } = repository;
  const storeRoot = getSkillsDataRootPath();

  // Collect all files from the store root, excluding .git and the marker itself
  const ignoreNames = new Set([".git", ".github", "node_modules"]);
  const allFiles = await collectFilesRecursive(storeRoot, storeRoot, ignoreNames);

  // Exclude the sync marker from the push — it's local-only metadata
  const files = allFiles.filter((f) => f.relativePath !== GITHUB_SYNC_MARKER);

  if (files.length === 0) {
    throw new Error("No skill files found in the store to push.");
  }

  // Get the current default branch
  const repoResponse = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoResponse.data.default_branch || "main";
  const branchRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
  const baseCommitSha = branchRef.data.object.sha;

  // Create blobs for all files
  const treeItems: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];

  const resolvedStoreRoot = path.resolve(storeRoot);
  for (const file of files) {
    // Leaf confinement (file-symlink escape, #300). `collectFilesRecursive`
    // walks `storeRoot`, but a file leaf under it that is a SYMLINK to an
    // outside secret would be followed by the `readFile` below and pushed to
    // the remote repo. Skip any file whose real path escapes the real store
    // root (`continue` matches the loop's per-file, non-fatal handling).
    if (!isEntryContainedInBase(resolvedStoreRoot, path.resolve(file.absolutePath))) {
      continue;
    }
    const content = await readFile(file.absolutePath);
    const blobResponse = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: content.toString("base64"),
      encoding: "base64",
    });
    treeItems.push({
      path: file.relativePath,
      mode: "100644",
      type: "blob",
      sha: blobResponse.data.sha,
    });
  }

  // Build the tree — omit base_tree in force mode to replace repo content entirely
  const baseCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseCommitSha });
  const treePayload: Parameters<typeof octokit.rest.git.createTree>[0] = {
    owner,
    repo,
    tree: treeItems,
    ...(options?.force ? {} : { base_tree: baseCommit.data.tree.sha }),
  };
  const treeResponse = await octokit.rest.git.createTree(treePayload);

  // Create the commit
  const commitResponse = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: options?.force
      ? "skill-store: force-replace repo content from local store"
      : "skill-store: sync local changes",
    tree: treeResponse.data.sha,
    parents: [baseCommitSha],
  });

  // Update the branch reference
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
    sha: commitResponse.data.sha,
    force: options?.force ?? false,
  });

  await writeGitHubSyncMarker(`${owner}/${repo}`);

  return { owner, repo, commitSha: commitResponse.data.sha };
}

// ---------------------------------------------------------------------------
// Push monorepo skills to the configured GitHub skills store
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under a directory, returning paths relative to
 * the given root. Skips directories like .git, node_modules, src.
 */
async function collectFilesRecursive(
  dirPath: string,
  rootPath: string,
  ignoreDirs = new Set([".git", ".github", "node_modules", "src"]),
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const results: Array<{ relativePath: string; absolutePath: string }> = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      results.push(...(await collectFilesRecursive(absolutePath, rootPath, ignoreDirs)));
    } else {
      results.push({
        relativePath: path.relative(rootPath, absolutePath),
        absolutePath,
      });
    }
  }

  return results;
}
