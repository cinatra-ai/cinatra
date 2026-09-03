/**
 * The GitHub road's intake (cinatra#3204, acceptance criteria 6-10 and 30).
 *
 * The GitHub tab was not an extension road at all. It took a repository URL and
 * installed a SKILL from it, assuming the kind rather than reading it; it passed
 * the submitted ref straight through, so a moving branch or a retagged release
 * could change the contents between preview and install; it surfaced the raw
 * capability refusal of an absent connector as an unexplained failure and could
 * not tell that state apart from an installed connector with no usable
 * connection; and its copy promised public github.com repositories while the
 * server path used an authenticated client and rejected nothing.
 *
 * This suite is the contract for each of those.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/github-package-intake.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  GITHUB_ROAD_VISIBILITY_COPY,
  GitHubIntakeError,
  assertPinnedCommitSha,
  assertPreviewMatchesInstall,
  assertRepositoryTreeAdmissible,
  describeGitHubPrecondition,
  parseGitHubPackageReference,
  readGitHubPackageKind,
} from "../github-package-intake";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const DIGEST = `sha256-${"c".repeat(64)}`;
const OTHER_DIGEST = `sha256-${"d".repeat(64)}`;

// ---------------------------------------------------------------------------
// Criterion 6 — the kind is READ from the repository's manifest
// ---------------------------------------------------------------------------

describe("the kind comes from the repository manifest, never from the road", () => {
  const manifest = (kind: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: `@vendor/thing-${kind}`, version: "1.0.0", cinatra: { kind, ...extra } });

  it("resolves every live kind", () => {
    expect(readGitHubPackageKind(manifest("agent"))).toBe("agent");
    expect(readGitHubPackageKind(manifest("skill"))).toBe("skill");
    expect(readGitHubPackageKind(manifest("connector"))).toBe("connector");
    expect(readGitHubPackageKind(manifest("artifact", { artifact: { accepts: [] } }))).toBe(
      "artifact",
    );
  });

  it("no longer assumes skill for a repository that declares another kind", () => {
    expect(readGitHubPackageKind(manifest("connector"))).not.toBe("skill");
  });

  it("refuses an undeclared, unknown or retired kind, naming the repository", () => {
    expect(() =>
      readGitHubPackageKind(JSON.stringify({ name: "@v/t", version: "1.0.0" })),
    ).toThrow(/Invalid repository: package\.json declares no `cinatra\.kind`/);
    expect(() => readGitHubPackageKind(manifest("widget"))).toThrow(
      /Invalid repository:.*"widget"/,
    );
    expect(() => readGitHubPackageKind(manifest("workflow"))).toThrow(
      /Invalid repository:.*retired/,
    );
  });
});

// ---------------------------------------------------------------------------
// The reference itself
// ---------------------------------------------------------------------------

describe("the submitted reference", () => {
  it("accepts owner/repo and a github.com URL", () => {
    expect(parseGitHubPackageReference("vendor/thing")).toMatchObject({
      owner: "vendor",
      repo: "thing",
      ref: null,
    });
    expect(parseGitHubPackageReference("https://github.com/vendor/thing")).toMatchObject({
      owner: "vendor",
      repo: "thing",
    });
    expect(parseGitHubPackageReference("https://github.com/vendor/thing.git")).toMatchObject({
      repo: "thing",
    });
  });

  it("reads a ref out of a /tree/ URL", () => {
    expect(parseGitHubPackageReference("https://github.com/vendor/thing/tree/v1.2.3")).toMatchObject(
      { owner: "vendor", repo: "thing", ref: "v1.2.3" },
    );
  });

  it("refuses a host that is not github.com — no network-named host is followed", () => {
    expect(() => parseGitHubPackageReference("https://evil.example/vendor/thing")).toThrow(
      /only github\.com repositories/,
    );
    expect(() => parseGitHubPackageReference("https://github.com.evil.example/v/t")).toThrow(
      /only github\.com repositories/,
    );
  });

  it("refuses a shape that is not a repository", () => {
    for (const bad of ["", "vendor", "vendor/", "/thing", "vendor/thing/extra/deep/path"]) {
      expect(() => parseGitHubPackageReference(bad)).toThrow(GitHubIntakeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — resolved ONCE to an immutable commit, and pinned there
// ---------------------------------------------------------------------------

describe("the ref is resolved once to a commit and installed at exactly that commit", () => {
  it("accepts a full 40-hex commit sha", () => {
    expect(() => assertPinnedCommitSha("main", SHA)).not.toThrow();
  });

  it("refuses an unresolved, abbreviated or branch-shaped 'sha'", () => {
    for (const bad of ["", "main", "a".repeat(7), "HEAD", `${SHA}x`, SHA.toUpperCase()]) {
      expect(() => assertPinnedCommitSha("main", bad)).toThrow(/immutable commit/);
    }
  });

  it("refuses when the commit moved between preview and install", () => {
    expect(() =>
      assertPreviewMatchesInstall({
        previewSha: SHA,
        installSha: OTHER_SHA,
        previewDigest: DIGEST,
        installDigest: DIGEST,
      }),
    ).toThrow(/resolved to a different commit/);
  });

  it("refuses when the commit is the same but the delivered tree is not", () => {
    expect(() =>
      assertPreviewMatchesInstall({
        previewSha: SHA,
        installSha: SHA,
        previewDigest: DIGEST,
        installDigest: OTHER_DIGEST,
      }),
    ).toThrow(/different tree/);
  });

  it("passes when both the commit and the tree are the ones previewed", () => {
    expect(() =>
      assertPreviewMatchesInstall({
        previewSha: SHA,
        installSha: SHA,
        previewDigest: DIGEST,
        installDigest: DIGEST,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 8 — the repository's own containment policy
// ---------------------------------------------------------------------------

describe("repository containment policy", () => {
  const blob = (path: string, size = 10) => ({ path, mode: "100644", type: "blob" as const, size });

  it("admits an ordinary tree", () => {
    const admitted = assertRepositoryTreeAdmissible([
      blob("package.json"),
      { path: "skills", mode: "040000", type: "tree" as const },
      blob("skills/x/SKILL.md"),
    ]);
    expect(admitted.map((e) => e.path)).toEqual(["package.json", "skills/x/SKILL.md"]);
  });

  it("REFUSES a submodule (gitlink) rather than silently skipping it", () => {
    expect(() =>
      assertRepositoryTreeAdmissible([blob("package.json"), { path: "vendor", mode: "160000", type: "commit" as const }]),
    ).toThrow(/submodule/);
  });

  it("REFUSES a symbolic link", () => {
    expect(() =>
      assertRepositoryTreeAdmissible([blob("package.json"), { path: "link", mode: "120000", type: "blob" as const, size: 12 }]),
    ).toThrow(/symbolic link/);
  });

  it("REFUSES an escaping or absolute path", () => {
    expect(() => assertRepositoryTreeAdmissible([blob("../escape")])).toThrow(/escapes/);
    expect(() => assertRepositoryTreeAdmissible([blob("/etc/passwd")])).toThrow(/absolute path/);
  });

  it("REFUSES a Git LFS-managed repository, which serves pointers rather than content", () => {
    expect(() =>
      assertRepositoryTreeAdmissible([blob("package.json"), blob(".gitattributes")], {
        gitattributes: "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      }),
    ).toThrow(/Git LFS/);
  });

  it("admits a .gitattributes that does not use LFS", () => {
    expect(() =>
      assertRepositoryTreeAdmissible([blob("package.json"), blob(".gitattributes")], {
        gitattributes: "* text=auto\n",
      }),
    ).not.toThrow();
  });

  it("caps the file count and the fetched byte total", () => {
    expect(() =>
      assertRepositoryTreeAdmissible([blob("a"), blob("b")], { maxEntries: 1 }),
    ).toThrow(/2 files, more than the 1 accepted/);
    expect(() =>
      assertRepositoryTreeAdmissible([blob("a", 10), blob("b", 10)], { maxTotalBytes: 15 }),
    ).toThrow(/20 bytes, more than the 15 accepted/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 9 — the two precondition states, told apart
// ---------------------------------------------------------------------------

describe("the tab states its precondition instead of leaking a capability refusal", () => {
  it("distinguishes an absent connector from an unusable connection", () => {
    const noConnector = describeGitHubPrecondition({ state: "no-github-connector" });
    const noConnection = describeGitHubPrecondition({ state: "no-github-connection" });
    expect(noConnector.message).not.toBe(noConnection.message);
    expect(noConnector.submitDisabled).toBe(true);
    expect(noConnection.submitDisabled).toBe(true);
  });

  it("names WHERE to fix each one", () => {
    expect(describeGitHubPrecondition({ state: "no-github-connector" }).fixAt).toMatch(
      /marketplace/,
    );
    expect(describeGitHubPrecondition({ state: "no-github-connection" }).fixAt).toMatch(
      /connector/,
    );
  });

  it("never surfaces the raw capability-refusal wording", () => {
    for (const state of ["no-github-connector", "no-github-connection"] as const) {
      const copy = describeGitHubPrecondition({ state });
      expect(copy.message).not.toMatch(/capability/i);
      expect(copy.message).not.toMatch(/relocated vendor client/i);
      expect(copy.message).not.toMatch(/malformed provider/i);
    }
  });

  it("enables submit only when the precondition is met", () => {
    expect(describeGitHubPrecondition({ state: "ready" }).submitDisabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 10 — the visibility claim is made true
// ---------------------------------------------------------------------------

describe("the visibility claim", () => {
  it("stops promising public-only, because the road reads through an authenticated connection", () => {
    expect(GITHUB_ROAD_VISIBILITY_COPY).not.toMatch(/\bpublic\b/i);
    expect(GITHUB_ROAD_VISIBILITY_COPY).toMatch(/connection/i);
  });
});
