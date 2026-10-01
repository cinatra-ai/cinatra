/**
 * THE REPOSITORY ROAD REACHES LEG 1's ENTRY (cinatra#3204 leg 2 — criteria 7,
 * 18, 19, 20 for the GitHub road).
 *
 * The claim under test is end-to-end and deliberately NOT stubbed in the middle:
 * a repository of each kind is staged from a fake GitHub client, packed into a
 * real npm-layout tarball, and driven through `installExtensionFromSuppliedSnapshot`
 * — and the pipeline's digest verification is wired to the REAL tarball, by
 * extracting it with node-tar (the same library the store's extractor uses) and
 * recomputing the content digest over what came out.
 *
 * That is what makes the pin mean something: if the packer lost a file, changed
 * a byte, or laid the tree out under a different root, the digest the intake
 * declared would not match the digest of what was materialized, and the pipeline
 * would refuse. It matching is the proof.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import { computeContentDigest } from "@cinatra-ai/extension-types";
import { installGitHubSuppliedPackage } from "@/lib/repository-supplied-install";
import { previewGitHubSuppliedPackage } from "@cinatra-ai/skills/repository-package-intake";
import { buildNpmLayoutTarball } from "@/lib/supplied-package-tarball";
import { makeTestSuppliedInstallPipelineDeps } from "@/lib/extension-install-pipeline-deps";
import type { SuppliedInstallPipelineDeps } from "@/lib/extension-install-pipeline";

const COMMIT = "9".repeat(40);
const OTHER_COMMIT = "8".repeat(40);
const TREE = "7".repeat(40);

type StubFile = { path: string; content: string };

function fixtureFor(kind: string): StubFile[] {
  const manifest = (extra: Record<string, unknown>) => ({
    path: "package.json",
    content: JSON.stringify({ name: `@acme/repo-${kind}`, version: "2.1.0", cinatra: { kind, ...extra } }),
  });
  if (kind === "agent") {
    return [manifest({ entrypoint: "cinatra/oas.json" }), { path: "cinatra/oas.json", content: '{"openapi":"3.1.0"}' }];
  }
  if (kind === "skill") {
    return [manifest({}), { path: "skills/do-it/SKILL.md", content: "---\nname: Do it\n---\nbody" }];
  }
  if (kind === "connector") {
    return [manifest({ serverEntry: "dist/server.js" }), { path: "dist/server.js", content: "export function register() {}" }];
  }
  return [manifest({ entrypoint: "cinatra/artifact.json" }), { path: "cinatra/artifact.json", content: '{"kind":"artifact"}' }];
}

function makeClient(files: StubFile[], over: { echoSha?: string } = {}) {
  const bySha = new Map<string, StubFile>();
  const tree = files.map((file, index) => {
    const sha = `blob${index}`;
    bySha.set(sha, file);
    return {
      path: file.path,
      mode: "100644",
      type: "blob",
      sha,
      size: new TextEncoder().encode(file.content).length,
    };
  });
  return {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getBranch: async () => ({ data: { commit: { sha: COMMIT, commit: { tree: { sha: TREE } } } } }),
      },
      git: {
        getRef: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
        getTag: async () => ({ data: { object: { sha: COMMIT } } }),
        getCommit: async ({ commit_sha }: { commit_sha: string }) => ({
          data: { sha: over.echoSha ?? commit_sha, tree: { sha: TREE } },
        }),
        getTree: async () => ({ data: { truncated: false, tree } }),
        getBlob: async ({ file_sha }: { file_sha: string }) => {
          const file = bySha.get(file_sha)!;
          const bytes = new TextEncoder().encode(file.content);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return { data: { content: btoa(binary), encoding: "base64" } };
        },
      },
    },
  } as unknown as Parameters<typeof previewGitHubSuppliedPackage>[0]["client"];
}

/** Extract the tarball with node-tar and recompute the digest over what landed. */
async function digestOfMaterializedTarball(tarball: Uint8Array): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cinatra-gh-supplied-"));
  try {
    const file = path.join(root, "package.tgz");
    const dest = path.join(root, "out");
    await mkdir(dest, { recursive: true });
    await writeFile(file, tarball);
    // `strip: 1` is exactly what the store's hardened extractor uses — the npm
    // layout's `package/` segment is removed on the way out.
    await tar.x({ file, cwd: dest, strip: 1 });

    const entries: { path: string; bytes: Uint8Array }[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
        if (item.isDirectory()) await walk(full, rel);
        else entries.push({ path: rel, bytes: new Uint8Array(await readFile(full)) });
      }
    };
    await walk(dest, "");
    return await computeContentDigest(entries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Pipeline deps whose digest verification runs against the REAL packed bytes.
 * `materializeSupplied` captures the tarball the driver built;
 * `computeStoreTreeDigest` extracts it and digests what came out.
 */
function realDigestDeps(over: Partial<SuppliedInstallPipelineDeps> = {}) {
  const captured: { tarball?: Uint8Array; expectedKind?: string } = {};
  const writes: Record<string, unknown>[] = [];
  const deps = makeTestSuppliedInstallPipelineDeps({
    materializeSupplied: async (i) => {
      captured.tarball = i.tarball;
      captured.expectedKind = i.expectedKind;
      return {
        storeDir: `/tmp/test-store/${i.packageName}/${i.version}`,
        digest: "testdigest",
        integrity: "sha512-x",
        contentHash: "testcontenthash",
      };
    },
    computeStoreTreeDigest: async () => digestOfMaterializedTarball(captured.tarball!),
    recordSuppliedProvenance: async (p) => {
      writes.push(p as unknown as Record<string, unknown>);
    },
    ...over,
  });
  return { deps, captured, writes };
}

async function previewOf(kind: string, over: { echoSha?: string } = {}) {
  const client = makeClient(fixtureFor(kind), over);
  const preview = await previewGitHubSuppliedPackage({ client, owner: "acme", repo: "pkg", ref: "main" });
  return { client, preview };
}

/**
 * The snapshot staging the driver performs, captured instead of written.
 *
 * Production stages under the host's supplied-snapshot root; these tests only
 * need to prove the row CARRIES a snapshot location, and that the location is
 * derived from the content digest rather than from anything the repository
 * supplies. The real writer has its own test.
 */
const stagedSnapshots = {
  entries: [] as Array<{ digest: string; bytes: Uint8Array }>,
  stage: async (digest: string, bytes: Uint8Array) => {
    stagedSnapshots.entries.push({ digest, bytes });
    return `${digest}.tgz`;
  },
};

beforeEach(() => {
  stagedSnapshots.entries = [];
});

// ---------------------------------------------------------------------------
// Criteria 18-20 — per kind, through leg 1's entry
// ---------------------------------------------------------------------------

describe("a GitHub-supplied package of each kind reaches leg 1's entry (criteria 18-20)", () => {
  // ALL FOUR live kinds, on the repository road as on the file road: the
  // upload road is an activation origin of the same standing as the store, so
  // the connector reaches this entry and installs like the other three.
  for (const kind of ["agent", "skill", "artifact", "connector"] as const) {
    it(`installs a ${kind.toUpperCase()} repository with honest github provenance and the digest`, async () => {
      const { client, preview } = await previewOf(kind);
      const { deps, captured, writes } = realDigestDeps();

      const { result, package: installed } = await installGitHubSuppliedPackage(
        {
          client,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
          orgId: null,
        },
        deps,
      );

      expect(result.installed).toBe(true);
      expect(installed.kind).toBe(kind);
      // The kind decides the store placement — it is threaded, not assumed.
      expect(captured.expectedKind).toBe(kind);
      // Honest provenance: the repository, the ref, the pinned sha and the
      // digest — and never a registry row.
      expect(writes).toHaveLength(1);
      expect(writes[0].provenance).toEqual({
        type: "github",
        repo: "acme/pkg",
        ref: "main",
        resolvedSha: COMMIT,
        contentDigest: preview.contentDigest,
        // The row NAMES its staged snapshot. `readSuppliedSnapshot` refuses a
        // github row that names none, so a row without this is a row that
        // installs once and can never be activated again.
        path: `${preview.contentDigest}.tgz`,
      });
      expect(stagedSnapshots.entries).toHaveLength(1);
      expect(stagedSnapshots.entries[0].digest).toBe(preview.contentDigest);
      expect(JSON.stringify(writes[0])).not.toContain("verdaccio");
      // The revision id and the content digest are different values answering
      // different questions, and BOTH are recorded.
      expect(preview.resolvedSha).not.toBe(preview.contentDigest);
    });
  }

  it("a repository CONNECTOR installs and its row is written — the road is the activation origin", async () => {
    const { client, preview } = await previewOf("connector");
    // The host policy of a deployment with NO configured marketplace: no
    // activation host at all, and the unsigned-bootstrap lever off. A store
    // install reaches nothing under it; the repository road stands on the
    // supply act itself, exactly as the file road does.
    const { deps, writes } = realDigestDeps({
      trustedActivationHosts: () => [],
      allowMarketplaceBootstrapTrust: () => false,
    });

    const { result, package: installed } = await installGitHubSuppliedPackage(
      {
        client,
        owner: "acme",
        repo: "pkg",
        ref: "main",
        stageSnapshot: stagedSnapshots.stage,
        pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
        orgId: null,
      },
      deps,
    );

    expect(result.installed).toBe(true);
    expect(installed.kind).toBe("connector");
    // THE ROW: honest github provenance, exactly as every other kind records it.
    expect(writes).toHaveLength(1);
    expect((writes[0].provenance as { type: string }).type).toBe("github");
    // Admitted for IMPORT, not for privilege: nothing self-granted.
    expect(result.grantStatus).not.toBe("approved");
  });

  it("the repository road never climbs to the privileged tier — its host-port grant is never self-approved", async () => {
    const { client, preview } = await previewOf("skill");
    let approved = false;
    const { deps } = realDigestDeps({
      readRequestedPorts: async () => ["settings"],
      approveGrant: async () => {
        approved = true;
      },
    });
    const { result } = await installGitHubSuppliedPackage(
      {
        client,
        owner: "acme",
        repo: "pkg",
        ref: "main",
        stageSnapshot: stagedSnapshots.stage,
        pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
      },
      deps,
    );
    expect(result.grantStatus).toBe("pending");
    expect(approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — the preview-to-install mismatch is REFUSED
// ---------------------------------------------------------------------------

describe("a preview-to-install mismatch is refused (criterion 7)", () => {
  it("refuses when the pinned commit comes back under a DIFFERENT sha at install time", async () => {
    const { preview } = await previewOf("skill");
    // The same repository, now serving the pinned commit id under another id.
    const movedClient = makeClient(fixtureFor("skill"), { echoSha: OTHER_COMMIT });
    const { deps, captured } = realDigestDeps();
    await expect(
      installGitHubSuppliedPackage(
        {
          client: movedClient,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
        },
        deps,
      ),
    ).rejects.toThrow(new RegExp(`${COMMIT}[\\s\\S]*${OTHER_COMMIT}`));
    expect(captured.tarball).toBeUndefined();
  });

  it("refuses a pin that names a commit the preview never resolved", async () => {
    const { client, preview } = await previewOf("skill");
    const { deps, captured } = realDigestDeps();
    await expect(
      installGitHubSuppliedPackage(
        {
          client,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          preview,
          pin: { resolvedSha: OTHER_COMMIT, contentDigest: preview.contentDigest },
        },
        deps,
      ),
    ).rejects.toThrow(/never previewed/);
    expect(captured.tarball).toBeUndefined();
  });

  it("refuses a DIFFERENT digest at install time, before anything is materialized", async () => {
    const { client, preview } = await previewOf("skill");
    const { deps, captured } = realDigestDeps();
    await expect(
      installGitHubSuppliedPackage(
        {
          client,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          pin: { resolvedSha: preview.resolvedSha, contentDigest: "f".repeat(64) },
        },
        deps,
      ),
    ).rejects.toThrow(/no longer delivers the previewed bytes/);
    expect(captured.tarball).toBeUndefined();
  });

  it("refuses a pin that is not an immutable commit sha at all, before any request", async () => {
    const { client, preview } = await previewOf("skill");
    const { deps } = realDigestDeps();
    await expect(
      installGitHubSuppliedPackage(
        {
          client,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          pin: { resolvedSha: "main", contentDigest: preview.contentDigest },
        },
        deps,
      ),
    ).rejects.toThrow(/not an immutable 40-character commit sha/);
  });

  it("refuses a malformed pinned digest before any request", async () => {
    const { client } = await previewOf("skill");
    const { deps } = realDigestDeps();
    await expect(
      installGitHubSuppliedPackage(
        {
          client,
          owner: "acme",
          repo: "pkg",
          ref: "main",
          stageSnapshot: stagedSnapshots.stage,
          pin: { resolvedSha: COMMIT, contentDigest: "not-a-digest" },
        },
        deps,
      ),
    ).rejects.toThrow(/not a well-formed digest/);
  });
});

// ---------------------------------------------------------------------------
// The packer, proven against the digest rather than against itself
// ---------------------------------------------------------------------------

describe("the packed tarball reproduces the previewed tree (criterion 20)", () => {
  it("extracts, under node-tar, to exactly the digest the intake declared", async () => {
    for (const kind of ["agent", "skill", "connector", "artifact"] as const) {
      const { preview } = await previewOf(kind);
      const tarball = buildNpmLayoutTarball(preview.deliveredEntries);
      expect(await digestOfMaterializedTarball(tarball)).toBe(preview.contentDigest);
    }
  });

  it("packs the same tree to the same bytes every time", async () => {
    const { preview } = await previewOf("skill");
    const first = buildNpmLayoutTarball(preview.deliveredEntries);
    const second = buildNpmLayoutTarball(preview.deliveredEntries);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
