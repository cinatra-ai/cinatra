/**
 * Hermetic tests for the GitHub-skill install path:
 *  - parseGitHubRepositoryReference rejects non-github hosts
 *  - installSkillPackageFromGitHub clones at the resolved tree sha when a
 *    ref is supplied (annotated tag, lightweight tag, branch)
 *  - fetchGitHubRepoMetadata filters draft releases and preserves ordering
 *
 * The tests fully mock Octokit and the store layer — no network, no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const {
  upsertMock,
  compileMock,
  getGitHubAccessTokenMock,
  getGitHubOAuthSettingsMock,
  octokitInstance,
} = vi.hoisted(() => {
  const upsertMock = vi.fn();
  const compileMock = vi.fn();
  const getGitHubAccessTokenMock = vi.fn();
  const getGitHubOAuthSettingsMock = vi.fn();
  const octokitInstance = {
    rest: {
      repos: {
        get: vi.fn(),
        getBranch: vi.fn(),
        listReleases: vi.fn(),
      },
      git: {
        getRef: vi.fn(),
        getTag: vi.fn(),
        getCommit: vi.fn(),
        getTree: vi.fn(),
        getBlob: vi.fn(),
      },
    },
    paginate: vi.fn(async (_method: unknown, params: { owner: string; repo: string }) => {
      // Default behavior: forward to octokitInstance.rest.repos.listReleases.
      const result = await octokitInstance.rest.repos.listReleases(params);
      return result.data;
    }),
  };
  return {
    upsertMock,
    compileMock,
    getGitHubAccessTokenMock,
    getGitHubOAuthSettingsMock,
    octokitInstance,
  };
});

vi.mock("@/lib/github-api", () => ({
  getGitHubAccessToken: getGitHubAccessTokenMock,
  getGitHubAPIStatus: vi.fn(),
  getGitHubOAuthSettings: getGitHubOAuthSettingsMock,
}));

vi.mock("octokit", () => ({
  Octokit: function MockOctokit() {
    return octokitInstance;
  },
}));

vi.mock("./skills-store", () => ({
  upsertRepositoryBackedSkillPackage: upsertMock,
  getSkillsDataRootPath: vi.fn(() => path.join(process.cwd(), "data", "skills")),
}));

vi.mock("./compile-agent-skills", () => ({
  compileAndRegisterAgentSkillsForRepo: compileMock,
}));

import {
  parseGitHubRepositoryReference,
  installSkillPackageFromGitHub,
  fetchGitHubRepoMetadata,
} from "./github";

describe("parseGitHubRepositoryReference (host validation)", () => {
  it("accepts the owner/repo shorthand", () => {
    expect(parseGitHubRepositoryReference("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("accepts https://github.com URLs", () => {
    expect(parseGitHubRepositoryReference("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("strips a trailing .git from the repo segment", () => {
    expect(parseGitHubRepositoryReference("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects non-github hosts", () => {
    expect(parseGitHubRepositoryReference("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseGitHubRepositoryReference("https://example.com/owner/repo")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseGitHubRepositoryReference("")).toBeNull();
    expect(parseGitHubRepositoryReference("owner")).toBeNull();
  });
});

describe("installSkillPackageFromGitHub (ref resolution)", () => {
  let refSuiteTmpRoot: string;
  let refSuiteCwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Isolate <cwd>/data/skills/<slug>/ writes per test — see clobber-guard
    // describe for rationale.
    refSuiteTmpRoot = await mkdtemp(path.join(os.tmpdir(), "cinatra-ref-"));
    refSuiteCwdSpy = vi.spyOn(process, "cwd").mockReturnValue(refSuiteTmpRoot);
    getGitHubAccessTokenMock.mockResolvedValue({ accessToken: "ghp_test", connection: {} });
    getGitHubOAuthSettingsMock.mockResolvedValue({ selectedRepositoryFullName: null });

    octokitInstance.rest.repos.get.mockResolvedValue({
      data: {
        default_branch: "main",
        description: "Test repo",
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: "MIT" },
        owner: { login: "owner" },
      },
    });
    octokitInstance.rest.git.getTree.mockResolvedValue({
      data: { truncated: false, tree: [] },
    });
    upsertMock.mockResolvedValue({ skillPackage: { id: "github:owner/repo" }, skills: [] });
    compileMock.mockResolvedValue({ registered: [], skipped: [] });
  });

  afterEach(async () => {
    refSuiteCwdSpy.mockRestore();
    await rm(refSuiteTmpRoot, { recursive: true, force: true });
  });

  it("uses the default-branch tree sha when no ref is given (back-compat)", async () => {
    octokitInstance.rest.repos.getBranch.mockResolvedValue({
      data: { commit: { commit: { tree: { sha: "default-branch-tree-sha" } } } },
    });

    await installSkillPackageFromGitHub("owner/repo");

    expect(octokitInstance.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      branch: "main",
    });
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "default-branch-tree-sha" }),
    );
    // Ref-resolution endpoints should not be touched on the default-branch path.
    expect(octokitInstance.rest.git.getRef).not.toHaveBeenCalled();
  });

  it("resolves an annotated tag via getRef → getTag → getCommit", async () => {
    octokitInstance.rest.git.getRef.mockResolvedValue({
      data: { object: { type: "tag", sha: "annotated-tag-sha" } },
    });
    octokitInstance.rest.git.getTag.mockResolvedValue({
      data: { object: { sha: "commit-sha-from-tag" } },
    });
    octokitInstance.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "annotated-tag-tree-sha" } },
    });

    await installSkillPackageFromGitHub("owner/repo", { ref: "release-1.2.3" });

    expect(octokitInstance.rest.git.getRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "tags/release-1.2.3",
    });
    expect(octokitInstance.rest.git.getTag).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      tag_sha: "annotated-tag-sha",
    });
    expect(octokitInstance.rest.git.getCommit).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      commit_sha: "commit-sha-from-tag",
    });
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "annotated-tag-tree-sha" }),
    );
    // Default-branch path must NOT be taken when a ref is given.
    expect(octokitInstance.rest.repos.getBranch).not.toHaveBeenCalled();
  });

  it("resolves a lightweight tag (object.type === 'commit') without calling getTag", async () => {
    octokitInstance.rest.git.getRef.mockResolvedValue({
      data: { object: { type: "commit", sha: "lightweight-commit-sha" } },
    });
    octokitInstance.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "lightweight-tag-tree-sha" } },
    });

    await installSkillPackageFromGitHub("owner/repo", { ref: "release-0.1.0" });

    expect(octokitInstance.rest.git.getTag).not.toHaveBeenCalled();
    expect(octokitInstance.rest.git.getCommit).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      commit_sha: "lightweight-commit-sha",
    });
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "lightweight-tag-tree-sha" }),
    );
  });

  it("falls back to branch lookup when getRef returns a 404 for the tag", async () => {
    octokitInstance.rest.git.getRef.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokitInstance.rest.repos.getBranch.mockResolvedValue({
      data: { commit: { commit: { tree: { sha: "develop-branch-tree-sha" } } } },
    });

    await installSkillPackageFromGitHub("owner/repo", { ref: "develop" });

    expect(octokitInstance.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      branch: "develop",
    });
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "develop-branch-tree-sha" }),
    );
  });

  it("throws a descriptive error when neither tag nor branch nor sha resolves", async () => {
    octokitInstance.rest.git.getRef.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokitInstance.rest.repos.getBranch.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    await expect(installSkillPackageFromGitHub("owner/repo", { ref: "ghost" })).rejects.toThrow(
      /GitHub ref "ghost" could not be resolved/,
    );
  });

  it("resolves a short commit sha via the sha fallback path", async () => {
    octokitInstance.rest.git.getRef.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokitInstance.rest.repos.getBranch.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokitInstance.rest.git.getCommit.mockResolvedValue({
      data: { tree: { sha: "short-sha-tree-sha" } },
    });

    await installSkillPackageFromGitHub("owner/repo", { ref: "abc1234" });

    expect(octokitInstance.rest.git.getCommit).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      commit_sha: "abc1234",
    });
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "short-sha-tree-sha" }),
    );
  });

  it("propagates non-404 errors from the tag lookup (does NOT classify as miss)", async () => {
    // 403 (rate-limit / auth) errors must propagate instead of being
    // classified as ref misses. The implementation uses Octokit's `status`
    // field to preserve security and observability signals.
    octokitInstance.rest.git.getRef.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
    );

    await expect(installSkillPackageFromGitHub("owner/repo", { ref: "release-1.0.0" })).rejects.toThrow(
      /API rate limit exceeded/,
    );
    expect(octokitInstance.rest.repos.getBranch).not.toHaveBeenCalled();
  });
});

describe("fetchGitHubRepoMetadata (release listing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubAccessTokenMock.mockResolvedValue({ accessToken: "ghp_test", connection: {} });
    getGitHubOAuthSettingsMock.mockResolvedValue({ selectedRepositoryFullName: null });
    octokitInstance.rest.repos.get.mockResolvedValue({
      data: {
        default_branch: "main",
        description: "Sample",
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: "MIT" },
        owner: { login: "owner" },
      },
    });
  });

  it("returns null when the URL is not a github.com repository", async () => {
    const result = await fetchGitHubRepoMetadata("https://gitlab.com/owner/repo");
    expect(result).toBeNull();
    expect(octokitInstance.rest.repos.get).not.toHaveBeenCalled();
  });

  it("filters out draft releases but preserves prerelease and stable", async () => {
    octokitInstance.rest.repos.listReleases.mockResolvedValue({
      data: [
        { tag_name: "release-2.0.0", name: "Two-oh", draft: false, prerelease: false, published_at: "2026-05-01T00:00:00Z", html_url: "u1" },
        { tag_name: "release-2.0.0-rc1", name: null, draft: false, prerelease: true, published_at: "2026-04-25T00:00:00Z", html_url: "u2" },
        { tag_name: "draft-tag", name: "Draft", draft: true, prerelease: false, published_at: null, html_url: "u3" },
        { tag_name: "release-1.0.0", name: "One-oh", draft: false, prerelease: false, published_at: "2026-03-01T00:00:00Z", html_url: "u4" },
      ],
    });

    const result = await fetchGitHubRepoMetadata("https://github.com/owner/repo");

    expect(result).not.toBeNull();
    expect(result?.fullName).toBe("owner/repo");
    expect(result?.defaultBranch).toBe("main");
    expect(result?.licenseSpdxId).toBe("MIT");
    expect(result?.releases.map((r) => r.tagName)).toEqual(["release-2.0.0", "release-2.0.0-rc1", "release-1.0.0"]);
    expect(result?.releases.find((r) => r.tagName === "release-2.0.0-rc1")?.prerelease).toBe(true);
  });

  it("returns empty releases when the repository has none", async () => {
    octokitInstance.rest.repos.listReleases.mockResolvedValue({ data: [] });

    const result = await fetchGitHubRepoMetadata("owner/repo");

    expect(result?.releases).toEqual([]);
  });

  it("normalizes NOASSERTION license to null", async () => {
    octokitInstance.rest.repos.get.mockResolvedValueOnce({
      data: {
        default_branch: "main",
        description: null,
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: "NOASSERTION" },
        owner: { login: "owner" },
      },
    });
    octokitInstance.rest.repos.listReleases.mockResolvedValue({ data: [] });

    const result = await fetchGitHubRepoMetadata("owner/repo");

    expect(result?.licenseSpdxId).toBeNull();
  });
});

describe("installSkillPackageFromGitHub (clobber guard)", () => {
  let tmpRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Stub process.cwd() rather than chdir-ing — vitest runs test files in
    // parallel workers, and process.chdir leaks across files inside the
    // same worker. spyOn keeps the change local to this suite.
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cinatra-clobber-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);

    getGitHubAccessTokenMock.mockResolvedValue({ accessToken: "ghp_test", connection: {} });
    getGitHubOAuthSettingsMock.mockResolvedValue({ selectedRepositoryFullName: null });
    octokitInstance.rest.repos.get.mockResolvedValue({
      data: {
        default_branch: "main",
        description: "Test repo",
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: "MIT" },
        owner: { login: "owner" },
      },
    });
    octokitInstance.rest.repos.getBranch.mockResolvedValue({
      data: { commit: { commit: { tree: { sha: "default-tree-sha" } } } },
    });
    octokitInstance.rest.git.getTree.mockResolvedValue({
      data: { truncated: false, tree: [] },
    });
    upsertMock.mockResolvedValue({ skillPackage: { id: "github:owner/repo" }, skills: [] });
    compileMock.mockResolvedValue({ registered: [], skipped: [] });
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes a .cinatra-skill-source.json marker after a successful install", async () => {
    const result = await installSkillPackageFromGitHub("owner/repo");
    const markerPath = path.join(result.repositoryPath, ".cinatra-skill-source.json");
    const raw = await readFile(markerPath, "utf8");
    const marker = JSON.parse(raw);
    expect(marker.packageId).toBe("github:owner/repo");
    expect(marker.repository).toBe("owner/repo");
    expect(marker.ref).toBeNull();
    expect(typeof marker.installedAt).toBe("string");
  });

  it("refuses to overwrite when an existing marker points at a different packageId", async () => {
    // Stage a marker that claims the slug belongs to a different repo.
    const slug = "owner-repo";
    const targetDir = path.join(tmpRoot, "data", "skills", slug);
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(targetDir, ".cinatra-skill-source.json"),
      JSON.stringify({ packageId: "github:other-owner/other-repo" }),
      "utf8",
    );

    await expect(installSkillPackageFromGitHub("owner/repo")).rejects.toThrow(
      /Refusing to overwrite an existing skill package at data\/skills\/owner-repo/,
    );
    // Octokit's tree fetch must not have been called when the guard fires.
    expect(octokitInstance.rest.git.getTree).not.toHaveBeenCalled();
  });

  it("allows reinstalling when the existing marker matches the same packageId", async () => {
    const slug = "owner-repo";
    const targetDir = path.join(tmpRoot, "data", "skills", slug);
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(targetDir, ".cinatra-skill-source.json"),
      JSON.stringify({ packageId: "github:owner/repo" }),
      "utf8",
    );

    await expect(installSkillPackageFromGitHub("owner/repo")).resolves.toBeDefined();
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalled();
  });

  it("refuses to install when a malformed marker cannot prove package provenance", async () => {
    const slug = "owner-repo";
    const targetDir = path.join(tmpRoot, "data", "skills", slug);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, ".cinatra-skill-source.json"), "{not-valid-json", "utf8");

    await expect(installSkillPackageFromGitHub("owner/repo")).rejects.toThrow(
      /has no provenance marker/,
    );
    expect(octokitInstance.rest.git.getTree).not.toHaveBeenCalled();
  });

  it("refuses to install when a manually staged target dir is non-empty and has no marker", async () => {
    const slug = "owner-repo";
    const targetDir = path.join(tmpRoot, "data", "skills", slug);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, "SOMETHING.md"), "manual content", "utf8");

    await expect(installSkillPackageFromGitHub("owner/repo")).rejects.toThrow(
      /has no provenance marker/,
    );
    expect(octokitInstance.rest.git.getTree).not.toHaveBeenCalled();
  });

  it("proceeds when target dir exists but is empty (half-finished install)", async () => {
    const slug = "owner-repo";
    const targetDir = path.join(tmpRoot, "data", "skills", slug);
    await mkdir(targetDir, { recursive: true });
    // No files dropped — dir is empty.

    await expect(installSkillPackageFromGitHub("owner/repo")).resolves.toBeDefined();
    expect(octokitInstance.rest.git.getTree).toHaveBeenCalled();
  });
});
