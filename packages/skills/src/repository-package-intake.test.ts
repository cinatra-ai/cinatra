/**
 * THE REPOSITORY INTAKE (cinatra#3204 leg 2 — criteria 6, 7, 8 and 30).
 *
 * The claim under test is not "a repository installs". It is three separate
 * claims, one per criterion, and the per-kind tests below assert all three at
 * once for each of the four live kinds, because a kind that resolves but is not
 * pinned — or is pinned but not contained — is not an intake anybody should
 * trust:
 *
 *   6. the KIND comes from the repository's own manifest, through the SAME
 *      predicate the archive reader uses (asserted by identity, not by a
 *      re-typed list);
 *   7. the submitted ref is resolved ONCE to an immutable 40-character COMMIT
 *      sha, and the tree is fetched at exactly that sha;
 *   8. the intake's containment policy is enforced BEFORE any blob is fetched.
 *
 * Everything is driven through a structural client stub: no network, no disk,
 * no Octokit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SUPPLIED_PACKAGE_KINDS,
  MAX_SUPPLIED_TREE_ENTRIES,
  MAX_SUPPLIED_ENTRY_BYTES,
  MAX_SUPPLIED_TREE_BYTES,
} from "@cinatra-ai/extension-types";

import {
  GITHUB_INTAKE_KINDS,
  GITHUB_INTAKE_ENTRY_CAP,
  GITHUB_INTAKE_ENTRY_BYTES_CAP,
  GITHUB_INTAKE_TOTAL_BYTES_CAP,
  previewGitHubSuppliedPackage,
  resolveGitHubCommitSha,
  stageGitHubRepositoryTree,
  type GitHubTreeClient,
} from "./repository-package-intake";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const TREE = "t".repeat(40);

type StubEntry = {
  path: string;
  mode?: string;
  type?: string;
  size?: number;
  content?: string;
};

/** A repository the stub client serves: one commit, one tree, blobs by path. */
function makeClient(input: {
  entries: StubEntry[];
  commitSha?: string;
  treeSha?: string;
  truncated?: boolean;
  defaultBranch?: string;
  /** Refs the stub knows: tag name -> {type, sha}. */
  tags?: Record<string, { type: "tag" | "commit"; sha: string }>;
  branches?: Record<string, string>;
  /** Tag OBJECTS the stub knows: tag-object sha -> what it points at. */
  tagObjects?: Record<string, { type: string; sha: string }>;
  /** getCommit echoes THIS sha instead of the one asked for (mismatch case). */
  echoSha?: string;
  blobEncoding?: string;
}): GitHubTreeClient & { calls: string[] } {
  const calls: string[] = [];
  const commitSha = input.commitSha ?? COMMIT;
  const treeSha = input.treeSha ?? TREE;
  const bySha = new Map<string, StubEntry>();
  const tree = input.entries.map((entry, index) => {
    const sha = `blob${index}`;
    bySha.set(sha, entry);
    const bytes = new TextEncoder().encode(entry.content ?? "");
    return {
      path: entry.path,
      mode: entry.mode ?? "100644",
      type: entry.type ?? "blob",
      sha,
      size: entry.size ?? bytes.length,
    };
  });

  const client = {
    calls,
    rest: {
      repos: {
        get: async () => {
          calls.push("repos.get");
          return {
            data: {
              default_branch: input.defaultBranch ?? "main",
              description: "a repository",
              html_url: "https://github.com/owner/repo",
            },
          };
        },
        getBranch: async ({ branch }: { branch: string }) => {
          calls.push(`repos.getBranch:${branch}`);
          const sha = input.branches?.[branch];
          if (sha === undefined && input.branches !== undefined) {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          return { data: { commit: { sha: sha ?? commitSha, commit: { tree: { sha: treeSha } } } } };
        },
      },
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          calls.push(`git.getRef:${ref}`);
          const name = ref.replace(/^tags\//, "");
          const tag = input.tags?.[name];
          if (!tag) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: { sha: tag.sha, type: tag.type } } };
        },
        getTag: async ({ tag_sha }: { tag_sha: string }) => {
          calls.push(`git.getTag:${tag_sha}`);
          const pointee = input.tagObjects?.[tag_sha];
          return { data: { object: { sha: pointee?.sha ?? commitSha, type: pointee?.type ?? "commit" } } };
        },
        getCommit: async ({ commit_sha }: { commit_sha: string }) => {
          calls.push(`git.getCommit:${commit_sha}`);
          return { data: { sha: input.echoSha ?? commit_sha, tree: { sha: treeSha } } };
        },
        getTree: async ({ tree_sha }: { tree_sha: string }) => {
          calls.push(`git.getTree:${tree_sha}`);
          return { data: { truncated: Boolean(input.truncated), tree } };
        },
        getBlob: async ({ file_sha }: { file_sha: string }) => {
          calls.push(`git.getBlob:${file_sha}`);
          const entry = bySha.get(file_sha);
          if (!entry) throw new Error(`unknown blob ${file_sha}`);
          const bytes = new TextEncoder().encode(entry.content ?? "");
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return {
            data: {
              content: input.blobEncoding === "none" ? "" : btoa(binary),
              encoding: input.blobEncoding ?? "base64",
            },
          };
        },
      },
    },
  };
  return client as unknown as GitHubTreeClient & { calls: string[] };
}

/** One minimal, real package per kind — the same four shapes leg 1 fixtures use. */
function fixtureFor(kind: string): StubEntry[] {
  const manifest = (extra: Record<string, unknown>) => ({
    path: "package.json",
    content: JSON.stringify({ name: `@acme/thing-${kind}`, version: "1.0.0", cinatra: { kind, ...extra } }),
  });
  if (kind === "agent") {
    return [
      manifest({ entrypoint: "cinatra/oas.json" }),
      { path: "cinatra/oas.json", content: '{"openapi":"3.1.0"}' },
    ];
  }
  if (kind === "skill") {
    return [manifest({}), { path: "skills/do-it/SKILL.md", content: "---\nname: Do it\n---\nbody" }];
  }
  if (kind === "connector") {
    return [
      manifest({ serverEntry: "dist/server.js" }),
      { path: "dist/server.js", content: "export function register() {}" },
    ];
  }
  return [
    manifest({ entrypoint: "cinatra/artifact.json" }),
    { path: "cinatra/artifact.json", content: '{"kind":"artifact"}' },
  ];
}

// ---------------------------------------------------------------------------
// Criterion 6 + 7 + 8, ONE TEST PER KIND (criterion 30)
// ---------------------------------------------------------------------------

describe("the repository intake, one per kind (criteria 6, 7, 8 — criterion 30)", () => {
  for (const kind of ["agent", "skill", "connector", "artifact"] as const) {
    it(`resolves a ${kind.toUpperCase()} from the manifest, pins the ref to a commit sha, and applies the containment policy`, async () => {
      // 6 — the kind comes from the repository's own manifest.
      const client = makeClient({ entries: fixtureFor(kind), tags: { "release-a": { type: "commit", sha: COMMIT } } });
      const preview = await previewGitHubSuppliedPackage({
        client,
        owner: "owner",
        repo: "repo",
        ref: "release-a",
      });
      expect(preview.kind).toBe(kind);
      expect(preview.packageName).toBe(`@acme/thing-${kind}`);
      expect(preview.version).toBe("1.0.0");

      // 7 — the ref is pinned to ONE immutable 40-character commit sha, the
      // tree is fetched at exactly that sha, and the pin is what is handed back
      // for display and for the install.
      expect(preview.resolvedSha).toBe(COMMIT);
      expect(preview.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(preview.provenance).toMatchObject({
        type: "github",
        repo: "owner/repo",
        ref: "release-a",
        resolvedSha: COMMIT,
        contentDigest: preview.contentDigest,
      });
      expect(client.calls).toContain(`git.getCommit:${COMMIT}`);
      expect(preview.contentDigest).toMatch(/^[0-9a-f]{64}$/);

      // 8 — the containment policy is applied to THIS kind's tree too: a
      // submodule entry in an otherwise valid package is refused by name.
      const withSubmodule = makeClient({
        entries: [...fixtureFor(kind), { path: "vendor/dep", mode: "160000", type: "commit" }],
        tags: { "release-a": { type: "commit", sha: COMMIT } },
      });
      await expect(
        previewGitHubSuppliedPackage({ client: withSubmodule, owner: "owner", repo: "repo", ref: "release-a" }),
      ).rejects.toThrow(/submodule/i);
    });
  }
});

// ---------------------------------------------------------------------------
// Criterion 6 — the SHARED predicate, and the shared refusal set
// ---------------------------------------------------------------------------

describe("the kind predicate is SHARED with the archive reader (criterion 6)", () => {
  it("uses one kind list, not a re-typed copy", () => {
    // Identity, not equality: the intake exposes the SAME frozen list the
    // archive reader resolves through, so a kind can never be added on one road
    // and forgotten on the other.
    expect(GITHUB_INTAKE_KINDS).toBe(SUPPLIED_PACKAGE_KINDS);
    expect([...GITHUB_INTAKE_KINDS]).toEqual(["agent", "skill", "connector", "artifact"]);
  });

  it("reuses the archive caps rather than declaring its own numbers", () => {
    expect(GITHUB_INTAKE_ENTRY_CAP).toBe(MAX_SUPPLIED_TREE_ENTRIES);
    expect(GITHUB_INTAKE_ENTRY_BYTES_CAP).toBe(MAX_SUPPLIED_ENTRY_BYTES);
    expect(GITHUB_INTAKE_TOTAL_BYTES_CAP).toBe(MAX_SUPPLIED_TREE_BYTES);
  });

  const preview = (entries: StubEntry[]) =>
    previewGitHubSuppliedPackage({
      client: makeClient({ entries, branches: { main: COMMIT } }),
      owner: "owner",
      repo: "repo",
    });

  it("refuses a repository whose manifest declares NO kind, naming what is accepted", async () => {
    await expect(
      preview([{ path: "package.json", content: JSON.stringify({ name: "x", version: "1.0.0" }) }]),
    ).rejects.toThrow(/declares no cinatra\.kind[\s\S]*agent, skill, connector, artifact/);
  });

  it("refuses an UNKNOWN kind, naming what was found and what is accepted", async () => {
    await expect(
      preview([
        { path: "package.json", content: JSON.stringify({ name: "x", version: "1.0.0", cinatra: { kind: "widget" } }) },
      ]),
    ).rejects.toThrow(
      /"widget" is not an extension kind this product installs[\s\S]*agent, skill, connector, artifact/,
    );
  });

  it("refuses the retired WORKFLOW kind as retired, not as unknown", async () => {
    await expect(
      preview([
        {
          path: "package.json",
          content: JSON.stringify({ name: "x", version: "1.0.0", cinatra: { kind: "workflow" } }),
        },
      ]),
    ).rejects.toThrow(/"workflow" is a retired extension kind/);
  });

  it("names the REPOSITORY in its refusals, not an archive nobody uploaded", async () => {
    await expect(preview([{ path: "README.md", content: "hi" }])).rejects.toThrow(
      /Invalid repository: no package\.json found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — the ref is resolved ONCE to an immutable commit sha
// ---------------------------------------------------------------------------

describe("the ref is pinned to ONE immutable commit sha (criterion 7)", () => {
  it("resolves an ANNOTATED tag through its tag object to the commit sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), tags: { "v2": { type: "tag", sha: "tagobject" } } });
    const pin = await resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "v2" });
    expect(pin.resolvedSha).toBe(COMMIT);
    expect(client.calls).toContain("git.getTag:tagobject");
  });

  it("resolves a BRANCH to the commit sha, not to the tree sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), branches: { release: OTHER_COMMIT } });
    const pin = await resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "release" });
    expect(pin.resolvedSha).toBe(OTHER_COMMIT);
    expect(pin.resolvedSha).not.toBe(TREE);
  });

  it("expands a SHORT sha to the full 40-character commit sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), tags: {}, branches: {}, echoSha: COMMIT });
    const pin = await resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: COMMIT.slice(0, 7) });
    expect(pin.resolvedSha).toBe(COMMIT);
  });

  it("falls back to the DEFAULT branch when no ref was submitted, and says which one", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), defaultBranch: "trunk" });
    const preview = await previewGitHubSuppliedPackage({ client, owner: "owner", repo: "repo" });
    expect(preview.ref).toBe("trunk");
    expect(preview.resolvedSha).toBe(COMMIT);
  });

  it("refuses a ref that resolves to something that is not a 40-character commit sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), branches: { main: "short" } });
    await expect(
      resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "main" }),
    ).rejects.toThrow(/immutable 40-character commit sha/);
  });

  it("refuses a ref that resolves against nothing at all", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), tags: {}, branches: {} });
    await expect(
      resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "nope" }),
    ).rejects.toThrow(/could not be resolved against owner\/repo/);
  });

  it("REFUSES to stage at anything but a pinned commit sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill") });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: "main" }),
    ).rejects.toThrow(/refusing to stage/i);
  });

  it("refuses when the commit object comes back under a DIFFERENT sha", async () => {
    const client = makeClient({ entries: fixtureFor("skill"), echoSha: OTHER_COMMIT });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: COMMIT }),
    ).rejects.toThrow(new RegExp(`${COMMIT}[\\s\\S]*${OTHER_COMMIT}`));
  });
});

// ---------------------------------------------------------------------------
// Criterion 8 — the intake's own containment policy
// ---------------------------------------------------------------------------

describe("the repository road's containment policy (criterion 8)", () => {
  const stage = (entries: StubEntry[], over: Parameters<typeof makeClient>[0] | null = null) =>
    stageGitHubRepositoryTree({
      client: makeClient({ entries, ...(over ?? {}) }),
      owner: "owner",
      repo: "repo",
      commitSha: COMMIT,
    });

  it("REFUSES a submodule entry by name (never silently skipped)", async () => {
    await expect(stage([...fixtureFor("skill"), { path: "vendor/dep", mode: "160000", type: "commit" }])).rejects.toThrow(
      /"vendor\/dep".*submodule/,
    );
  });

  it("REFUSES an escaping symlink entry by name, rather than skipping it", async () => {
    await expect(stage([...fixtureFor("skill"), { path: "link", mode: "120000", content: "../../etc/passwd" }])).rejects.toThrow(
      /"link".*symlink/,
    );
  });

  it("REFUSES a Git LFS pointer instead of installing the pointer text as the file", async () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 12345\n";
    await expect(stage([...fixtureFor("skill"), { path: "big.bin", content: pointer }])).rejects.toThrow(
      /"big\.bin".*Git LFS/,
    );
  });

  it("REFUSES a traversing entry name", async () => {
    await expect(stage([...fixtureFor("skill"), { path: "../escape.md", content: "x" }])).rejects.toThrow(
      /traverses out of the repository root/,
    );
  });

  it("REFUSES more entries than the cap, BEFORE any blob is fetched", async () => {
    const client = makeClient({
      entries: [
        ...fixtureFor("skill"),
        ...Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })),
      ],
    });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: COMMIT, entryCap: 3 }),
    ).rejects.toThrow(/more than 3 entries/);
    expect(client.calls.filter((c) => c.startsWith("git.getBlob"))).toEqual([]);
  });

  it("REFUSES an entry over the per-entry byte cap, BEFORE any blob is fetched", async () => {
    const client = makeClient({ entries: [...fixtureFor("skill"), { path: "huge.bin", content: "x", size: 999 }] });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: COMMIT, entryBytesCap: 100 }),
    ).rejects.toThrow(/"huge\.bin".*100-byte per-file limit/);
    expect(client.calls.filter((c) => c.startsWith("git.getBlob"))).toEqual([]);
  });

  it("REFUSES a tree over the total byte cap, BEFORE any blob is fetched", async () => {
    const client = makeClient({ entries: [...fixtureFor("skill"), { path: "a.bin", content: "x", size: 90 }] });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: COMMIT, totalBytesCap: 100 }),
    ).rejects.toThrow(/over the 100-byte/);
    expect(client.calls.filter((c) => c.startsWith("git.getBlob"))).toEqual([]);
  });

  it("REFUSES a truncated tree rather than installing half a repository", async () => {
    await expect(stage(fixtureFor("skill"), { entries: fixtureFor("skill"), truncated: true })).rejects.toThrow(
      /truncated/i,
    );
  });

  it("REFUSES a blob the API will not hand over as bytes", async () => {
    await expect(stage(fixtureFor("skill"), { entries: fixtureFor("skill"), blobEncoding: "none" })).rejects.toThrow(
      /encoding "none"/,
    );
  });

  it("follows NO network-controlled path during materialization — the module has no filesystem at all", () => {
    const source = readFileSync(path.resolve(__dirname, "repository-package-intake.ts"), "utf8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    // No filesystem, no process, no execution: the staged tree lives in memory
    // and the only path it ever builds is the one inside the tarball.
    expect(body).not.toMatch(/node:fs/);
    expect(body).not.toMatch(/node:path/);
    expect(body).not.toMatch(/fs\/promises/);
    expect(body).not.toMatch(/\bwriteFile\b/);
    expect(body).not.toMatch(/\bmkdir\b/);
    expect(body).not.toMatch(/child_process/);
    expect(body).not.toMatch(/\beval\s*\(/);
    expect(body).not.toMatch(/new\s+Function\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE (round 1)
// ---------------------------------------------------------------------------

describe("the pin ladder follows a tag chain to the COMMIT (criterion 7)", () => {
  it("dereferences a NESTED annotated tag all the way to the commit, never pinning a tag object", async () => {
    const client = makeClient({
      entries: fixtureFor("skill"),
      tags: { release: { type: "tag", sha: "tagA" } },
      tagObjects: {
        tagA: { type: "tag", sha: "tagB" },
        tagB: { type: "commit", sha: COMMIT },
      },
    });
    const pin = await resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "release" });
    // A tag object's sha is forty hexadecimal characters too, so stopping at the
    // first hop yields an immutable sha that is NOT the commit being installed.
    expect(pin.resolvedSha).toBe(COMMIT);
    expect(client.calls).toContain("git.getTag:tagA");
    expect(client.calls).toContain("git.getTag:tagB");
  });

  it("REFUSES a tag that terminates on something other than a commit", async () => {
    const client = makeClient({
      entries: fixtureFor("skill"),
      tags: { blobtag: { type: "tag", sha: "tagA" } },
      tagObjects: { tagA: { type: "blob", sha: OTHER_COMMIT } },
    });
    await expect(
      resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "blobtag" }),
    ).rejects.toThrow(/not a commit/);
  });

  it("REFUSES an unbounded tag chain rather than following it forever", async () => {
    const client = makeClient({
      entries: fixtureFor("skill"),
      tags: { loop: { type: "tag", sha: "tagA" } },
      tagObjects: { tagA: { type: "tag", sha: "tagA" } },
    });
    await expect(
      resolveGitHubCommitSha({ client, owner: "owner", repo: "repo", ref: "loop" }),
    ).rejects.toThrow(/not a commit/);
  });
});

describe("every Git LFS pointer version the specification supports is refused (criterion 8)", () => {
  it("REFUSES a legacy hawser-URL pointer, which is still a supported pointer form", async () => {
    const pointer = "version https://hawser.github.com/spec/v1\noid sha256:" + "0".repeat(64) + "\nsize 12345\n";
    const client = makeClient({ entries: [...fixtureFor("skill"), { path: "big.bin", content: pointer }] });
    await expect(
      stageGitHubRepositoryTree({ client, owner: "owner", repo: "repo", commitSha: COMMIT }),
    ).rejects.toThrow(/"big\.bin".*Git LFS/);
  });
});
