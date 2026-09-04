// ---------------------------------------------------------------------------
// repository-package-intake.ts — the GitHub road's intake (cinatra#3204,
// acceptance criteria 6-10).
//
// The GitHub tab was not an extension road. It took a repository URL and
// installed a SKILL from it — the kind was assumed, not read — and everything
// downstream followed from that assumption: a fixed workspace-tier placement the
// operator never chose, a clone the handler owned outright with no canonical row
// behind it, and no statement anywhere about which bytes were installed.
//
// Four separate weaknesses are addressed here, and they are separate on purpose:
//
//   1. THE KIND IS READ (criterion 6). From the repository's own package.json,
//      through the SAME rules the File road applies — one implementation, so a
//      package is admitted or refused identically whichever tab is open.
//   2. THE REF IS PINNED (criterion 7). A branch name or a release tag is a
//      MOVING pointer. It is resolved ONCE to an immutable commit before the
//      preview, and the install re-checks that both the commit AND the delivered
//      tree are the ones the operator previewed — so a branch that advances, or
//      a release that is retagged, cannot swap the contents underneath a scope
//      decision that was made about something else.
//   3. THE REPOSITORY HAS ITS OWN CONTAINMENT POLICY (criterion 8). An archive
//      is a flat file set; a repository is a graph, and it can point OUT of
//      itself in ways an archive cannot: submodules, symbolic links, and Git LFS
//      pointers that are not the content they stand for. Each is refused
//      explicitly rather than silently skipped, because silently skipping one
//      installs a package that is missing part of itself.
//   4. THE TAB STATES ITS PRECONDITION (criteria 9, 10). Two different failures
//      used to reach the operator as one unexplained refusal, and the copy
//      promised something the road did not enforce.
//
// The module is named for the MECHANISM (a package taken from a source
// repository), not for the host it is reached through: core owns integration
// mechanism and never spells a vendor name in a path or an import edge
// (cinatra#978). The host semantics stay stated in the prose and the copy,
// which is where they belong.
//
// PURE (no IO, no server-only), so every rule above is directly unit-testable
// and the client form can import the copy without pulling a server module.
// ---------------------------------------------------------------------------

import {
  readExtensionPackageIdentity,
  type UploadableExtensionKind,
} from "./extension-package-manifest";

/** A refusal the GitHub tab surfaces verbatim. Typed so the form can tell an
 *  intake refusal apart from a transport failure. */
export class GitHubIntakeError extends Error {
  readonly code = "GITHUB_INTAKE_REFUSED" as const;
  constructor(message: string) {
    super(message);
    this.name = "GitHubIntakeError";
  }
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

export type GitHubPackageReference = {
  owner: string;
  repo: string;
  /** The ref the operator named (branch, tag or sha), or null for the default branch. */
  ref: string | null;
};

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a submitted reference into `owner`, `repo` and an optional ref.
 *
 * HOST IS CHECKED EXACTLY, not by prefix: `github.com.evil.example` is a
 * different host that a prefix test would admit. No other host is accepted, so
 * no network-named host reaches the fetch.
 */
export function parseGitHubPackageReference(input: string): GitHubPackageReference {
  const raw = input.trim();
  if (raw === "") {
    throw new GitHubIntakeError(
      "Enter a GitHub repository, as owner/repo or as a github.com URL.",
    );
  }

  let path = raw;
  let ref: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new GitHubIntakeError(`${JSON.stringify(raw)} is not a valid URL.`);
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new GitHubIntakeError(
        `This road reads only github.com repositories, and ${JSON.stringify(url.hostname)} is a ` +
          "different host.",
      );
    }
    const segments = url.pathname.split("/").filter((s) => s !== "");
    if (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "commit")) {
      ref = decodeURIComponent(segments.slice(3).join("/"));
      path = `${segments[0]}/${segments[1]}`;
    } else if (segments.length === 2) {
      path = segments.join("/");
    } else {
      throw new GitHubIntakeError(
        `${JSON.stringify(raw)} does not name a repository. Use a github.com/owner/repo URL, ` +
          "optionally with /tree/<branch-tag-or-commit>.",
      );
    }
  }

  const parts = path.replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !SEGMENT_RE.test(parts[0] ?? "") || !SEGMENT_RE.test(parts[1] ?? "")) {
    throw new GitHubIntakeError(
      `${JSON.stringify(raw)} does not name a repository. Use owner/repo or a github.com URL.`,
    );
  }
  return { owner: parts[0], repo: parts[1].replace(/\.git$/i, ""), ref };
}

// ---------------------------------------------------------------------------
// The kind (criterion 6)
// ---------------------------------------------------------------------------

/**
 * Read the kind the repository's package.json declares — the SAME rules the
 * File road applies, with "repository" in the refusal wording so the operator is
 * told which thing they pointed at.
 */
export function readGitHubPackageKind(packageJsonText: string): UploadableExtensionKind {
  return readExtensionPackageIdentity(packageJsonText, "repository").kind;
}

// ---------------------------------------------------------------------------
// Pinning (criterion 7)
// ---------------------------------------------------------------------------

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The resolved ref must be a full, lowercase 40-hex commit sha.
 *
 * An abbreviated sha is not an identity (it is a prefix that can become
 * ambiguous), and a branch name is not one either. `HEAD` and an empty string
 * are the two ways an unresolved ref reaches here, and both are refused.
 */
export function assertPinnedCommitSha(requestedRef: string | null, resolvedSha: string): void {
  if (!COMMIT_SHA_RE.test(resolvedSha)) {
    throw new GitHubIntakeError(
      `The reference ${JSON.stringify(requestedRef ?? "(default branch)")} did not resolve to an ` +
        `immutable commit (got ${JSON.stringify(resolvedSha)}). A branch or a tag is a moving ` +
        "pointer; the install is pinned to the exact commit it was previewed at.",
    );
  }
}

/**
 * The preview-to-install guard. BOTH halves are checked, and they answer
 * different questions: the commit says the repository still points where it
 * pointed, and the digest says the bytes that arrived are the bytes that were
 * previewed. A retagged release moves the first; a re-served tree moves the
 * second.
 */
export function assertPreviewMatchesInstall(input: {
  previewSha: string;
  installSha: string;
  previewDigest: string;
  installDigest: string;
}): void {
  if (input.previewSha !== input.installSha) {
    throw new GitHubIntakeError(
      `This repository resolved to a different commit between the preview (${input.previewSha}) and ` +
        `this install (${input.installSha}). The reference moved; review it and start again.`,
    );
  }
  if (input.previewDigest !== input.installDigest) {
    throw new GitHubIntakeError(
      `This repository served a different tree at the same commit ${input.installSha} — the preview ` +
        `digested to ${input.previewDigest} and this install to ${input.installDigest}. Refusing to ` +
        "install contents that were never previewed.",
    );
  }
}

// ---------------------------------------------------------------------------
// Containment (criterion 8)
// ---------------------------------------------------------------------------

export type GitTreeEntry = {
  path: string;
  /** The git file mode, e.g. "100644", "120000" (symlink), "160000" (gitlink). */
  mode: string;
  type: "blob" | "tree" | "commit";
  size?: number;
};

export type RepositoryIntakeLimits = {
  maxEntries: number;
  maxTotalBytes: number;
  /** The repository's own `.gitattributes`, when it has one. */
  gitattributes: string | null;
};

export const DEFAULT_REPOSITORY_INTAKE_LIMITS: Omit<RepositoryIntakeLimits, "gitattributes"> = {
  maxEntries: 5000,
  maxTotalBytes: 128 * 1024 * 1024,
};

/**
 * Apply the repository's containment policy and return the BLOBS that survive.
 *
 * Trees are structural and drop out; everything else must be admissible, and a
 * violation is a refusal rather than a skip — a package installed with its
 * submodule silently omitted is a package that is missing part of itself.
 */
export function assertRepositoryTreeAdmissible(
  entries: readonly GitTreeEntry[],
  limits: Partial<RepositoryIntakeLimits> = {},
): GitTreeEntry[] {
  const caps = { ...DEFAULT_REPOSITORY_INTAKE_LIMITS, gitattributes: null, ...limits };

  if (typeof caps.gitattributes === "string" && /\bfilter\s*=\s*lfs\b/.test(caps.gitattributes)) {
    throw new GitHubIntakeError(
      "This repository is managed with Git LFS. The files a tree read returns for LFS-tracked paths " +
        "are pointer stubs, not the content they stand for, so installing from it would install a " +
        "package whose files are placeholders. Publish the package to the registry, or upload it as " +
        "an archive on the File tab.",
    );
  }

  const blobs: GitTreeEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new GitHubIntakeError(
        `This repository contains a submodule at ${JSON.stringify(entry.path)}. A submodule points ` +
          "at another repository, whose contents are not part of this one; installing would leave " +
          "that path empty. Vendor the dependency into the repository, or upload an archive instead.",
      );
    }
    if (entry.type === "tree") continue;
    if (entry.mode === "120000") {
      throw new GitHubIntakeError(
        `This repository contains a symbolic link at ${JSON.stringify(entry.path)}. A symbolic ` +
          "link's content is a path, and the install never follows one.",
      );
    }
    assertSafeRepositoryPath(entry.path);
    blobs.push(entry);
    totalBytes += entry.size ?? 0;
  }

  if (blobs.length > caps.maxEntries) {
    throw new GitHubIntakeError(
      `This repository holds ${blobs.length} files, more than the ${caps.maxEntries} accepted.`,
    );
  }
  if (totalBytes > caps.maxTotalBytes) {
    throw new GitHubIntakeError(
      `This repository holds ${totalBytes} bytes, more than the ${caps.maxTotalBytes} accepted.`,
    );
  }
  return blobs;
}

function assertSafeRepositoryPath(path: string): void {
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new GitHubIntakeError(
        `This repository contains a path with a control character in its name (${JSON.stringify(path)}).`,
      );
    }
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new GitHubIntakeError(
      `This repository contains ${JSON.stringify(path)}, an absolute path; only paths relative to ` +
        "the repository root are accepted.",
    );
  }
  if (path.includes("\\")) {
    throw new GitHubIntakeError(
      `This repository contains ${JSON.stringify(path)}, which uses a backslash path separator.`,
    );
  }
  if (path.split("/").some((segment) => segment === "..")) {
    throw new GitHubIntakeError(
      `This repository contains ${JSON.stringify(path)}, which escapes the repository root.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The precondition (criterion 9) and the visibility claim (criterion 10)
// ---------------------------------------------------------------------------

export type GitHubPreconditionState =
  | { state: "ready" }
  /** The connector extension that OWNS the GitHub client is not installed/active. */
  | { state: "no-github-connector" }
  /** The connector is installed, but no usable GitHub connection resolves. */
  | { state: "no-github-connection" };

export type GitHubPreconditionCopy = {
  message: string;
  /** Where the operator fixes it — a root-relative path, never a hardcoded host. */
  fixAt: string;
  submitDisabled: boolean;
};

/**
 * Describe the precondition in the operator's terms.
 *
 * The two failure states are genuinely different problems with different fixes,
 * and they used to reach the screen as one refusal — the raw capability message,
 * which names host internals ("relocated vendor client", "malformed provider")
 * and tells an operator nothing they can act on. Neither state's copy repeats
 * any of that wording; each names what is missing and where it is fixed.
 */
export function describeGitHubPrecondition(
  state: GitHubPreconditionState,
): GitHubPreconditionCopy {
  switch (state.state) {
    case "no-github-connector":
      return {
        message:
          "Installing from a repository needs the GitHub connector, which is not installed on this " +
          "instance yet. Install it from the marketplace, then come back to this tab.",
        fixAt: "/configuration/marketplace",
        submitDisabled: true,
      };
    case "no-github-connection":
      return {
        message:
          "The GitHub connector is installed, but no GitHub account is connected yet, so a " +
          "repository cannot be read. Connect an account in the connector's settings, then come " +
          "back to this tab.",
        fixAt: "/configuration/connectors",
        submitDisabled: true,
      };
    case "ready":
      return { message: "", fixAt: "", submitDisabled: false };
  }
}

/**
 * The visibility claim, made TRUE (criterion 10).
 *
 * The old copy promised "public github.com repositories". The road never
 * enforced that: it reads through this instance's authenticated GitHub
 * connection and rejects nothing on visibility. Rather than adding a
 * public-only refusal that would break the private-repository case the
 * authenticated client already serves, the claim is corrected to describe what
 * actually happens.
 */
export const GITHUB_ROAD_VISIBILITY_COPY =
  "Paste a github.com repository. It is read through this instance's GitHub connection, so any " +
  "repository that connection can see is accepted.";
