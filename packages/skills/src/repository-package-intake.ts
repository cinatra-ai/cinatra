// ---------------------------------------------------------------------------
// repository-package-intake.ts — THE REPOSITORY ROAD'S INTAKE (cinatra#3204 leg 2,
// criteria 6, 7, 8 and 20).
//
// The skill-only road (github.ts) answers a narrower question than the product
// now asks. It resolves a ref to a TREE id, writes the tree straight onto disk
// under the skills data root, assumes what it fetched is a skill, and silently
// SKIPS an entry it does not like. That is three different problems for a
// general intake: a tree id does not say which commit was installed, a road
// that writes while it reads has nowhere to refuse from, and an entry that is
// skipped rather than refused turns an attack into a partial install nobody was
// told about.
//
// So this module does the opposite of all three, and it does exactly this much:
//
//   1. RESOLVE the submitted ref ONCE to an immutable 40-character COMMIT sha
//      (criterion 7). Tag, annotated tag, branch, short sha and default branch
//      all converge on one commit id, and that id — not the ref — is what is
//      shown, what is fetched, and what is recorded.
//   2. STAGE the tree AT that commit sha, IN MEMORY. Nothing is written: this
//      module imports no filesystem, no process and no execution API at all, so
//      "a network-controlled path is never followed during materialization" is
//      a property of the module rather than of a caller remembering to be
//      careful (criterion 8). The only path it ever produces is a key in a Map.
//   3. REFUSE, by name, everything the policy does not accept: a submodule, a
//      symlink, a Git LFS pointer, a traversing or absolute entry name, a
//      truncated tree, a blob the API will not hand over as bytes, and anything
//      over the SHARED intake caps (criterion 8).
//   4. RESOLVE THE KIND through the SAME predicate the archive reader uses
//      (criterion 6) — imported, never re-typed — so the four accepted kinds and
//      the three refusals (absent, unknown, retired) are one implementation.
//
// What it deliberately does NOT do is install anything. It hands back a preview:
// the pin, the kind, the identity, the digest and the delivered bytes. The host
// driver turns that into a supplied snapshot and runs leg 1's pipeline entry.
// ---------------------------------------------------------------------------

import {
  MAX_SUPPLIED_ENTRY_BYTES,
  MAX_SUPPLIED_TREE_BYTES,
  MAX_SUPPLIED_TREE_ENTRIES,
  SUPPLIED_PACKAGE_KINDS,
  SUPPLIED_REPOSITORY_SUBJECT,
  resolveSuppliedPackageTree,
  suppliedEntryNameRefusal,
  type ResolvedSuppliedPackageTree,
  type SuppliedPackageProvenance,
} from "@cinatra-ai/extension-types";

/**
 * The caps this road enforces. They are the ARCHIVE caps, re-exported rather
 * than re-declared: one number per rule, for every road (criterion 8).
 */
export const GITHUB_INTAKE_ENTRY_CAP = MAX_SUPPLIED_TREE_ENTRIES;
export const GITHUB_INTAKE_ENTRY_BYTES_CAP = MAX_SUPPLIED_ENTRY_BYTES;
export const GITHUB_INTAKE_TOTAL_BYTES_CAP = MAX_SUPPLIED_TREE_BYTES;

/** The kinds this road accepts — the SAME list the archive reader resolves through. */
export const GITHUB_INTAKE_KINDS = SUPPLIED_PACKAGE_KINDS;

/** An immutable Git commit id. Nothing shorter is a pin. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Git tree entry modes this road refuses, and why. */
const SUBMODULE_MODE = "160000";
const SYMLINK_MODE = "120000";

/**
 * The first line of a Git LFS pointer file. A repository using LFS delivers this
 * TEXT through the tree API instead of the file it stands for, so installing it
 * would install a 130-byte stub under the name of the real payload. The decision
 * (recorded here because criterion 8 asks for one) is to REFUSE rather than to
 * resolve: resolving would mean a second, differently-authenticated fetch to the
 * LFS endpoint for content the digest was not computed over, and an intake that
 * fetches from somewhere the pin does not cover is not pinned.
 */
/**
 * Every `version` line the Git LFS pointer specification still declares
 * supported. The legacy hawser URL is not historical trivia: current clients
 * write and read it, so recognising only the modern one lets a pointer through
 * as ordinary file content — and because the digest faithfully covers the
 * pointer's own bytes, nothing downstream can notice the payload is missing.
 */
/** How many tag-object hops the pin ladder will follow before refusing. */
const MAX_TAG_DEREFERENCE_DEPTH = 8;

const LFS_POINTER_PREFIXES = [
  "version https://git-lfs.github.com/spec/v1",
  "version https://hawser.github.com/spec/v1",
] as const;
const LFS_POINTER_SCAN_BYTES = Math.max(...LFS_POINTER_PREFIXES.map((prefix) => prefix.length));

/**
 * The slice of the GitHub REST client this module uses, as a STRUCTURAL type.
 * Octokit satisfies it; so does a test stub. Typing the dependency rather than
 * importing the client keeps this module free of every transitive concern
 * Octokit carries, and keeps the intake testable without a network.
 */
export type GitHubTreeClient = {
  rest: {
    repos: {
      get: (input: { owner: string; repo: string }) => Promise<{
        data: { default_branch?: string | null; description?: string | null; html_url?: string | null };
      }>;
      getBranch: (input: { owner: string; repo: string; branch: string }) => Promise<{
        data: { commit: { sha?: string | null; commit?: { tree?: { sha?: string | null } } } };
      }>;
    };
    git: {
      getRef: (input: { owner: string; repo: string; ref: string }) => Promise<{
        data: { object: { sha: string; type: string } };
      }>;
      getTag: (input: { owner: string; repo: string; tag_sha: string }) => Promise<{
        // A tag object may point at another TAG object, so the pointee's type is
        // load-bearing: without it the ladder cannot tell a commit from one more
        // hop, and would pin the tag rather than the commit.
        data: { object: { sha: string; type: string } };
      }>;
      getCommit: (input: { owner: string; repo: string; commit_sha: string }) => Promise<{
        data: { sha?: string | null; tree: { sha: string } };
      }>;
      getTree: (input: { owner: string; repo: string; tree_sha: string; recursive?: string }) => Promise<{
        data: {
          truncated?: boolean;
          tree: Array<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>;
        };
      }>;
      getBlob: (input: { owner: string; repo: string; file_sha: string }) => Promise<{
        data: { content: string; encoding: string };
      }>;
    };
  };
};

/** The pin: one ref, one immutable commit, one tree. */
export type GitHubCommitPin = {
  /** The ref that was submitted, or the default branch when none was. */
  ref: string;
  /** The immutable 40-character commit sha the ref resolved to. */
  resolvedSha: string;
};

export type GitHubStagedRepositoryTree = {
  resolvedSha: string;
  treeSha: string;
  /** Every delivered blob, by repository-relative path. In memory, never on disk. */
  entries: Map<string, Uint8Array>;
  entryCount: number;
  totalBytes: number;
};

export type GitHubSuppliedPackagePreview = ResolvedSuppliedPackageTree & {
  /** "owner/repo". */
  repo: string;
  /** The ref as submitted (or the default branch that stood in for it). */
  ref: string;
  /** The immutable commit sha the ref resolved to — what is displayed and installed. */
  resolvedSha: string;
  treeSha: string;
  entryCount: number;
  totalBytes: number;
  /** Ready to record: honest `github` provenance, never a registry claim (criterion 20). */
  provenance: Extract<SuppliedPackageProvenance, { type: "github" }>;
};

/**
 * Match a REST error against a known HTTP status. Matching on the message
 * substring is fragile: a rate-limit or auth error must not be misclassified as
 * a 404 and silently fall through to the next rung of the resolution ladder.
 */
function isStatus(err: unknown, status: number): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number") return value === status;
  }
  return false;
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Resolve the submitted ref to ONE immutable commit sha (criterion 7).
 *
 * The ladder is tag, then branch, then raw sha, and it exists because a Release
 * tag usually collides with no branch and the resolution order has to be
 * deterministic. What is new here is where it STOPS: at the COMMIT, not at the
 * commit's tree. A tree id says which bytes; only a commit id says which commit
 * an operator approved, and the row records both.
 *
 * When no ref is submitted the repository's default branch stands in, and the
 * pin reports WHICH branch that was — a pin that says "the default branch" is
 * not a pin, because the default branch can be renamed.
 */
export async function resolveGitHubCommitSha(input: {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  /** A tag, branch or commit sha. Omitted / empty resolves the default branch. */
  ref?: string;
}): Promise<GitHubCommitPin> {
  const { client, owner, repo } = input;
  const submitted = input.ref?.trim() ?? "";

  const pin = (ref: string, sha: unknown): GitHubCommitPin => {
    const resolved = typeof sha === "string" ? sha.trim().toLowerCase() : "";
    if (!COMMIT_SHA_PATTERN.test(resolved)) {
      throw new Error(
        `GitHub ref "${ref}" did not resolve to an immutable 40-character commit sha against ${owner}/${repo} ` +
          `(got ${resolved === "" ? "nothing" : `"${resolved}"`}) — refusing to install from a reference that can move.`,
      );
    }
    return { ref, resolvedSha: resolved };
  };

  if (submitted === "") {
    const repoResponse = await client.rest.repos.get({ owner, repo });
    const defaultBranch = repoResponse.data.default_branch?.trim() || "main";
    const branch = await client.rest.repos.getBranch({ owner, repo, branch: defaultBranch });
    return pin(defaultBranch, branch.data.commit.sha);
  }

  // 1. Tag (annotated or lightweight) — Releases land here.
  try {
    const tagRef = await client.rest.git.getRef({ owner, repo, ref: `tags/${submitted}` });
    let commitSha = tagRef.data.object.sha;
    let objectType: string = tagRef.data.object.type;
    // A tag object may point at another tag object. Dereferencing ONE level and
    // then trusting the forty hexadecimal characters that come back pins the TAG
    // rather than the commit — a sha that is immutable but is not the thing being
    // installed. Follow the chain to the commit, bounded so a cyclic or hostile
    // chain cannot spin, and refuse any other terminal object type by name.
    for (let depth = 0; objectType === "tag" && depth < MAX_TAG_DEREFERENCE_DEPTH; depth += 1) {
      const tagObject = await client.rest.git.getTag({ owner, repo, tag_sha: commitSha });
      commitSha = tagObject.data.object.sha;
      objectType = tagObject.data.object.type;
    }
    if (objectType !== "commit") {
      throw new Error(
        `GitHub tag "${submitted}" in ${owner}/${repo} resolves to a ${objectType === "tag" ? `chain of more than ${MAX_TAG_DEREFERENCE_DEPTH} tag objects` : `git ${objectType} object`}, ` +
          `not a commit — refusing to install from a reference that does not name one commit.`,
      );
    }
    return pin(submitted, commitSha);
  } catch (err) {
    // Only fall through on a real 404 — auth, rate-limit and network errors must
    // surface rather than be re-read as "try the next rung".
    if (!isStatus(err, 404)) throw err;
  }

  // 2. Branch.
  try {
    const branch = await client.rest.repos.getBranch({ owner, repo, branch: submitted });
    return pin(submitted, branch.data.commit.sha);
  } catch (err) {
    if (!isStatus(err, 404)) throw err;
  }

  // 3. Raw commit sha, full or short — expanded to the full id by the API.
  if (/^[0-9a-f]{7,40}$/i.test(submitted)) {
    try {
      const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: submitted });
      return pin(submitted, commit.data.sha);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }

  throw new Error(
    `GitHub ref "${submitted}" could not be resolved against ${owner}/${repo} (no matching tag, branch, or commit).`,
  );
}

/**
 * Fetch the repository tree AT a pinned commit sha, in memory, under the policy
 * (criterion 8).
 *
 * The order matters and is the point: EVERY structural refusal is decided from
 * the tree listing — which carries each entry's mode, type and size — BEFORE a
 * single blob is fetched. A cap that is only noticed while downloading is not a
 * cap on what is downloaded.
 */
export async function stageGitHubRepositoryTree(input: {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  /** The pin. Anything that is not a 40-character commit sha is refused. */
  commitSha: string;
  entryCap?: number;
  entryBytesCap?: number;
  totalBytesCap?: number;
}): Promise<GitHubStagedRepositoryTree> {
  const { client, owner, repo } = input;
  const entryCap = input.entryCap ?? GITHUB_INTAKE_ENTRY_CAP;
  const entryBytesCap = input.entryBytesCap ?? GITHUB_INTAKE_ENTRY_BYTES_CAP;
  const totalBytesCap = input.totalBytesCap ?? GITHUB_INTAKE_TOTAL_BYTES_CAP;

  const commitSha = input.commitSha.trim().toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error(
      `Refusing to stage ${owner}/${repo}: "${input.commitSha}" is not an immutable 40-character commit sha. ` +
        `The ref is resolved once, before preview, and the install fetches that commit and no other.`,
    );
  }

  // Fetch AT the pin. The commit object is asked for BY ITS ID, and the id it
  // comes back under must be the one asked for: a preview-to-install mismatch is
  // a refusal, not a surprise (criterion 7).
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  const echoed = typeof commit.data.sha === "string" ? commit.data.sha.trim().toLowerCase() : commitSha;
  if (echoed !== commitSha) {
    throw new Error(
      `Refusing to install ${owner}/${repo}: the pinned commit ${commitSha} came back as ${echoed}. ` +
        `The commit that was previewed is not the commit that was served.`,
    );
  }
  const treeSha = commit.data.tree.sha;

  const treeResponse = await client.rest.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true",
  });

  if (treeResponse.data.truncated) {
    throw new Error(
      `Refusing to install ${owner}/${repo} at ${commitSha}: the repository tree came back TRUNCATED, ` +
        `so what was read is not the whole package.`,
    );
  }

  const tree = treeResponse.data.tree;
  if (tree.length > entryCap) {
    throw new Error(
      `Refusing to install ${owner}/${repo} at ${commitSha}: the tree declares more than ${entryCap} entries.`,
    );
  }

  // POLICY PASS — decided entirely from the listing, before any bytes move.
  const blobs: { path: string; sha: string; size: number }[] = [];
  let totalBytes = 0;
  for (const entry of tree) {
    const name = entry.path ?? "";
    const refusal = suppliedEntryNameRefusal(name, "repository");
    if (refusal) {
      throw new Error(`Refusing to install ${owner}/${repo} at ${commitSha}: ${refusal}.`);
    }

    if (entry.mode === SUBMODULE_MODE || entry.type === "commit") {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${name}" is a submodule. ` +
          `A submodule is a second repository at a second revision, and the pin covers neither.`,
      );
    }
    if (entry.mode === SYMLINK_MODE) {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${name}" is a symlink. ` +
          `A symlink in a package tree names a target the package does not carry, and it is refused rather than skipped.`,
      );
    }
    if (entry.type === "tree") continue;
    if (entry.type !== "blob" || typeof entry.sha !== "string") continue;

    const size = typeof entry.size === "number" ? entry.size : 0;
    if (size > entryBytesCap) {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${name}" declares ${size} bytes, ` +
          `over the ${entryBytesCap}-byte per-file limit.`,
      );
    }
    totalBytes += size;
    if (totalBytes > totalBytesCap) {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: the tree declares more than ${totalBytesCap} bytes, ` +
          `over the ${totalBytesCap}-byte total limit.`,
      );
    }
    blobs.push({ path: name, sha: entry.sha, size });
  }

  // FETCH PASS — the policy already said yes to every one of these.
  const entries = new Map<string, Uint8Array>();
  let fetchedBytes = 0;
  for (const blob of blobs) {
    const response = await client.rest.git.getBlob({ owner, repo, file_sha: blob.sha });
    const encoding = response.data.encoding;
    let bytes: Uint8Array;
    if (encoding === "base64") {
      bytes = decodeBase64(response.data.content);
    } else if (encoding === "utf-8" || encoding === "utf8") {
      bytes = new TextEncoder().encode(response.data.content);
    } else {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${blob.path}" came back with encoding ` +
          `"${encoding}", which this intake cannot read as bytes.`,
      );
    }

    if (bytes.byteLength > entryBytesCap) {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${blob.path}" delivered ${bytes.byteLength} bytes, ` +
          `over the ${entryBytesCap}-byte per-file limit.`,
      );
    }
    fetchedBytes += bytes.byteLength;
    if (fetchedBytes > totalBytesCap) {
      throw new Error(
        `Refusing to install ${owner}/${repo} at ${commitSha}: the delivered files exceed the ` +
          `${totalBytesCap}-byte total limit.`,
      );
    }

    // GIT LFS. The pointer is short and its first line is unambiguous, so this
    // is checked on the bytes rather than on the size.
    if (bytes.byteLength < 1024) {
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, LFS_POINTER_SCAN_BYTES));
      if (LFS_POINTER_PREFIXES.some((prefix) => head.startsWith(prefix))) {
        throw new Error(
          `Refusing to install ${owner}/${repo} at ${commitSha}: entry "${blob.path}" is a Git LFS pointer, ` +
            `not the file it stands for. Publish a package whose files are in the repository itself.`,
        );
      }
    }

    entries.set(blob.path, bytes);
  }

  return { resolvedSha: commitSha, treeSha, entries, entryCount: entries.size, totalBytes: fetchedBytes };
}

/**
 * PREVIEW a repository as a supplied package: resolve the ref ONCE, stage at the
 * resolved commit, and resolve the kind through the shared predicate.
 *
 * Everything a caller needs to display, and everything an install needs to
 * repeat, comes out of this ONE call — which is what makes the pin meaningful:
 * the sha shown to the operator is the sha the bytes were read at, and the
 * digest is over exactly those bytes.
 */
export async function previewGitHubSuppliedPackage(input: {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<GitHubSuppliedPackagePreview> {
  const { client, owner, repo } = input;
  const pin = await resolveGitHubCommitSha({ client, owner, repo, ref: input.ref });
  const staged = await stageGitHubRepositoryTree({ client, owner, repo, commitSha: pin.resolvedSha });
  return buildPreview({ owner, repo, pin, staged });
}

/**
 * Re-read a repository AT AN ALREADY-PINNED commit — the install half of
 * criterion 7. The ref is NOT resolved again: re-resolving would reopen the
 * exact window the pin exists to close.
 */
export async function fetchGitHubSuppliedPackageAtPin(input: {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  /** The ref the operator submitted, carried for the provenance record only. */
  ref: string;
  resolvedSha: string;
}): Promise<GitHubSuppliedPackagePreview> {
  const { client, owner, repo } = input;
  const staged = await stageGitHubRepositoryTree({ client, owner, repo, commitSha: input.resolvedSha });
  return buildPreview({
    owner,
    repo,
    pin: { ref: input.ref, resolvedSha: staged.resolvedSha },
    staged,
  });
}

async function buildPreview(input: {
  owner: string;
  repo: string;
  pin: GitHubCommitPin;
  staged: GitHubStagedRepositoryTree;
}): Promise<GitHubSuppliedPackagePreview> {
  const { owner, repo, pin, staged } = input;
  const resolved = await resolveSuppliedPackageTree(staged.entries, SUPPLIED_REPOSITORY_SUBJECT);
  const repository = `${owner}/${repo}`;
  return {
    ...resolved,
    repo: repository,
    ref: pin.ref,
    resolvedSha: staged.resolvedSha,
    treeSha: staged.treeSha,
    entryCount: staged.entryCount,
    totalBytes: staged.totalBytes,
    provenance: {
      type: "github",
      repo: repository,
      ref: pin.ref,
      resolvedSha: staged.resolvedSha,
      contentDigest: resolved.contentDigest,
    },
  };
}
