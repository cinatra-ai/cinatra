/**
 * GitHub install hook.
 *
 * Asserts that `installSkillPackageFromGitHub` invokes
 * `compileAndRegisterAgentSkillsForRepo` on the cloned target directory
 * when an `agents/` tree is present, and surfaces the result on the
 * return value as `agentSkills`.
 *
 * The test fully mocks Octokit (network) + the package store layer
 * (DB) + compile-agent-skills (the unit under test asserts only the *call*).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));

const {
  cloneToDirectoryMock,
  upsertRepositoryBackedSkillPackageMock,
  compileAndRegisterAgentSkillsForRepoMock,
  getGitHubAccessTokenMock,
  getGitHubOAuthSettingsMock,
  octokitInstance,
} = vi.hoisted(() => {
  const cloneToDirectoryMock = vi.fn();
  const upsertRepositoryBackedSkillPackageMock = vi.fn();
  const compileAndRegisterAgentSkillsForRepoMock = vi.fn();
  const getGitHubAccessTokenMock = vi.fn();
  const getGitHubOAuthSettingsMock = vi.fn();
  const octokitInstance = {
    rest: {
      repos: {
        get: vi.fn(),
        getBranch: vi.fn(),
      },
      git: {
        getTree: vi.fn(),
        getBlob: vi.fn(),
      },
    },
  };
  return {
    cloneToDirectoryMock,
    upsertRepositoryBackedSkillPackageMock,
    compileAndRegisterAgentSkillsForRepoMock,
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
  upsertRepositoryBackedSkillPackage: upsertRepositoryBackedSkillPackageMock,
  getSkillsDataRootPath: vi.fn(() => path.join(process.cwd(), "data", "skills")),
}));

vi.mock("./compile-agent-skills", () => ({
  compileAndRegisterAgentSkillsForRepo: compileAndRegisterAgentSkillsForRepoMock,
}));

import { installSkillPackageFromGitHub } from "./github";

describe("installSkillPackageFromGitHub GitHub install hook", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    cloneToDirectoryMock.mockReset();
    upsertRepositoryBackedSkillPackageMock.mockReset();
    compileAndRegisterAgentSkillsForRepoMock.mockReset();
    getGitHubAccessTokenMock.mockReset();
    getGitHubOAuthSettingsMock.mockReset();
    octokitInstance.rest.repos.get.mockReset();
    octokitInstance.rest.repos.getBranch.mockReset();
    octokitInstance.rest.git.getTree.mockReset();
    octokitInstance.rest.git.getBlob.mockReset();

    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cinatra-gh-"));

    getGitHubAccessTokenMock.mockResolvedValue({ accessToken: "ghp_test", connection: {} });
    getGitHubOAuthSettingsMock.mockResolvedValue({ selectedRepositoryFullName: null });

    // Octokit shape that mimics a successful clone from a tiny fake repo.
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
      data: { commit: { commit: { tree: { sha: "tree-sha" } } } },
    });
    octokitInstance.rest.git.getTree.mockResolvedValue({
      data: { truncated: false, tree: [] },
    });

    upsertRepositoryBackedSkillPackageMock.mockResolvedValue({
      skillPackage: { id: "github:owner/repo" },
      skills: [],
    });
    compileAndRegisterAgentSkillsForRepoMock.mockResolvedValue({
      registered: ["custom:foo:bar"],
      skipped: [],
    });
  });

  it("calls compileAndRegisterAgentSkillsForRepo on cloned target when agents/ exists", async () => {
    // We can't easily intercept the targetDirectory inside the SUT — the
    // production code computes its own path. Instead, monkey-patch the
    // octokit clone to materialize the agents/ tree at whatever
    // targetDirectory the SUT picks.
    octokitInstance.rest.repos.get.mockImplementation(async () => ({
      data: {
        default_branch: "main",
        description: "Test repo",
        html_url: "https://github.com/owner/repo",
        license: null,
        owner: { login: "owner" },
      },
    }));
    octokitInstance.rest.git.getTree.mockImplementationOnce(async () => ({
      data: { truncated: false, tree: [] },
    }));

    // Track the target directory by intercepting upsertRepositoryBackedSkillPackage
    // (which receives the cloned repositoryPath). When it's called, drop a
    // skeleton agents/ tree so the SUT's hook will discover it.
    upsertRepositoryBackedSkillPackageMock.mockImplementationOnce(async (input: { repositoryPath: string }) => {
      const agentDir = path.join(input.repositoryPath, "agents", "foo");
      const skillDir = path.join(agentDir, "skills", "bar");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(agentDir, "package.json"),
        JSON.stringify({ name: "@x/foo" }),
      );
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: Bar\n---\nbody",
      );
      return { skillPackage: { id: "github:owner/repo" }, skills: [] };
    });

    const result = await installSkillPackageFromGitHub("owner/repo");

    expect(compileAndRegisterAgentSkillsForRepoMock).toHaveBeenCalledTimes(1);
    expect(compileAndRegisterAgentSkillsForRepoMock.mock.calls[0][0]).toMatchObject({
      repoRoot: result.repositoryPath,
    });
    expect((result as { agentSkills?: { registered: string[] } }).agentSkills?.registered).toEqual([
      "custom:foo:bar",
    ]);

    // Cleanup the staged dir so subsequent tests don't see it.
    await rm(result.repositoryPath, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("does NOT call compileAndRegisterAgentSkillsForRepo when no agents/ tree is present", async () => {
    upsertRepositoryBackedSkillPackageMock.mockImplementationOnce(async () => ({
      skillPackage: { id: "github:owner/no-agents" },
      skills: [],
    }));

    const result = await installSkillPackageFromGitHub("owner/no-agents");

    expect(compileAndRegisterAgentSkillsForRepoMock).not.toHaveBeenCalled();
    expect((result as { agentSkills?: unknown }).agentSkills).toBeUndefined();

    await rm(result.repositoryPath, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });
});
