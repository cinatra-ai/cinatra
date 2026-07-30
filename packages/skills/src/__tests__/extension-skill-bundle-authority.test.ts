/**
 * cinatra#2274 — the EXTENSION-SKILL REGISTRATION WRITER records the REAL
 * multi-file disk bundle as the skill's content authority.
 *
 * The defect: `registerColocatedWorkspaceSkills` -> `registerExtensionSkill` ->
 * `upsertSkill` read ONLY the router body and `buildUpsertRevisionWrite`
 * hard-coded a BUNDLE OF ONE for every caller. On a fresh instance every one of
 * the six multi-file bundles the disk ships therefore ended up under an
 * AUTHORITY-OWNED head describing a single file, which
 * `captureSkillBundleFromDisk` can never advance (`authorityOwnedDivergence`),
 * S2's fail-closed one-hop lint refuses as an upload candidate, and cinatra#2254
 * turns into a failed `initial-sync`.
 *
 * This is the ALWAYS-RUN tier: it pins the WRITER's contract (what reaches
 * `upsertSkill`), the PURE manifest resolution, the DELIVERY decision
 * (materialize the canonical dir from the authority, and only on drift), and the
 * registration post-condition — all on a real temp filesystem, no database. The
 * DB-level composition (head manifest ≡ disk set; a subsequent capture reports no
 * divergence; the S2 lint accepts; a `references/*` dropped upstream leaves no
 * residue) is pinned on a real Postgres in
 * `src/lib/__tests__/integration/skill-extension-writer-authority.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// `vi.mock` factories are hoisted above all top-level statements.
const { upsertSkillMock, headState, materializeMock } = vi.hoisted(() => ({
  upsertSkillMock: vi.fn(),
  // The registration POST-CONDITION re-reads the skill's bundle head; there is
  // no DB in this unit, so ONLY that one reader is stubbed.
  headState: { value: null as unknown },
  // ...and the delivery step materializes from DB blobs, so it is stubbed with a
  // filesystem stand-in that reproduces its CONTRACT: replace the destination
  // directory wholesale with the recorded file set.
  materializeMock: vi.fn(),
}));

// `../skills-store` is the sole DB collaborator; `../skills-registry` drags
// @/lib/agents-store. Both mocked so this stays a pure unit. The bundle WALKER
// and the digest in @/lib/skill-bundle-store stay REAL — reading the real
// directory with the real walker is exactly the property under test.
vi.mock("../skills-store", () => ({ upsertSkill: upsertSkillMock }));
vi.mock("../skills-registry", () => ({
  parseFrontmatter: (content: string) => ({
    attributes: { name: "Router", description: "A router." },
    body: content,
  }),
}));
vi.mock("@/lib/skill-bundle-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skill-bundle-store")>();
  return {
    ...actual,
    readAuthorityBundleHeadState: () => headState.value,
    materializeRevisionBundleToDirectory: materializeMock,
  };
});

import { registerExtensionSkill } from "../register-extension-skill";
import { buildUpsertRevisionWrite, resolveUpsertBundleFiles } from "../skill-source";
import { computeSkillSourceRevision } from "../skill-source";
import { bundleDigestForFiles } from "@/lib/skill-bundle-store";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const ROUTER_BODY =
  "---\nname: Router\ndescription: A router.\n---\n# Router\nSee [a](references/a.md) and [b](references/b.md).\n";

let root: string;
let sourceDir: string;
let storageDir: string;
let skillMdPath: string;

/** A realistic `extensions/<vendor>/<pkg>/skills/<slug>/` source bundle. */
async function materializeSourceBundle(files: Record<string, string>): Promise<void> {
  await rm(sourceDir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(sourceDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
}

/** Every file under `dir`, POSIX-relative, sorted — the shape capture walks. */
async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const e of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cinatra-2274-"));
  sourceDir = path.join(root, "extensions", "acme", "acme-skill", "skills", "router-skill");
  storageDir = path.join(root, "store", "workspace", "acme", "acme-skill", "skills", "router-skill");
  skillMdPath = path.join(sourceDir, "SKILL.md");
  await mkdir(storageDir, { recursive: true });
  upsertSkillMock.mockReset();
  headState.value = null;
  materializeMock.mockReset();
  // Contract stand-in for `materializeRevisionBundleToDirectory`: the recorded
  // file set REPLACES the destination directory (that wholesale replacement is
  // what makes a stale leaf impossible), sourced from the same snapshot the
  // writer handed to `upsertSkill`.
  materializeMock.mockImplementation(async (_skillId: string, _revisionId: string, dest: string) => {
    const call = upsertSkillMock.mock.calls.at(-1)![0] as {
      content: string;
      bundleFiles?: Array<{ path: string; bytes: Buffer }>;
    };
    const files = resolveUpsertBundleFiles(call.content, call.bundleFiles as never);
    await rm(dest, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(dest, f.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
    }
    return { bundleDigest: bundleDigestForFiles(files), fileCount: files.length };
  });
  upsertSkillMock.mockImplementation(
    async (input: { content: string; bundleFiles?: unknown }) => {
      // Stand in for the real store's disk write: the canonical SKILL.md is
      // written from `content`, which is what makes the manifest's router digest
      // and the on-disk router agree.
      await writeFile(path.join(storageDir, "SKILL.md"), input.content, "utf8");
      // ...and for the head its lifecycle write would have installed.
      headState.value = {
        headRevisionId: "rev-1",
        headBundleDigest: bundleDigestForFiles(
          resolveUpsertBundleFiles(input.content, input.bundleFiles as never),
        ),
        activeRevisionId: "rev-1",
        isAuthorityOwned: true,
      };
      return { id: "skill-1", sourcePath: path.join(storageDir, "SKILL.md") };
    },
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("registerExtensionSkill — the recorded bundle is the REAL disk bundle", () => {
  it("hands upsertSkill the WHOLE multi-file bundle, not a bundle of one", async () => {
    await materializeSourceBundle({
      "SKILL.md": ROUTER_BODY,
      "references/a.md": "# a\n",
      "references/b.md": "# b\n",
      "assets/logo.txt": "logo\n",
    });

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    const passed = upsertSkillMock.mock.calls[0][0] as {
      content: string;
      bundleFiles?: Array<{ path: string; bytes: Buffer }>;
    };
    // The router body still reaches the catalog payload as `content`...
    expect(passed.content).toBe(ROUTER_BODY);
    // ...and the file set is the whole directory (AC1 — a SET, not a count).
    expect((passed.bundleFiles ?? []).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "assets/logo.txt",
      "references/a.md",
      "references/b.md",
    ]);
    // ONE SNAPSHOT: the router bytes handed over ARE the bytes `content` was
    // decoded from, so the manifest can never describe a router the stored body
    // disagrees with.
    const router = (passed.bundleFiles ?? []).find((f) => f.path === "SKILL.md")!;
    expect(router.bytes.toString("utf8")).toBe(ROUTER_BODY);
  });

  it("a SINGLE-FILE bundle is unchanged — still exactly the router", async () => {
    await materializeSourceBundle({ "SKILL.md": "---\nname: Router\n---\n# Solo\n" });

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    const passed = upsertSkillMock.mock.calls[0][0] as {
      bundleFiles?: Array<{ path: string }>;
    };
    expect((passed.bundleFiles ?? []).map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("fails CLOSED on a symlinked bundle leaf rather than recording it", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    // A symlink inside the bundle is EXCLUDED by the walker (never followed out
    // of the bundle), so it is simply absent from the recorded authority.
    await writeFile(path.join(root, "outside.md"), "# outside\n", "utf8");
    await symlink(path.join(root, "outside.md"), path.join(sourceDir, "references", "link.md"));

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    const passed = upsertSkillMock.mock.calls[0][0] as { bundleFiles?: Array<{ path: string }> };
    expect((passed.bundleFiles ?? []).map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "references/a.md",
    ]);
  });
});

describe("delivery — the canonical dir is MATERIALIZED FROM THE AUTHORITY, on drift only", () => {
  it("is a pure READ in the steady state: nothing is re-materialized", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    // The canonical dir already IS the recorded bundle.
    await mkdir(path.join(storageDir, "references"), { recursive: true });
    await writeFile(path.join(storageDir, "references", "a.md"), "# a\n", "utf8");

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("MATERIALIZES the head revision into the canonical dir when the dir has drifted", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    // A stale leaf the authority never described, and no `references/a.md`.
    await writeFile(path.join(storageDir, "stale.md"), "# stale\n", "utf8");

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    expect(materializeMock).toHaveBeenCalledTimes(1);
    const [skillId, revisionId, destDir] = materializeMock.mock.calls[0];
    expect(skillId).toBe("skill-1");
    expect(revisionId).toBe("rev-1");
    expect(destDir).toBe(storageDir);
    // The stub materialization replaced the directory wholesale, so the stale
    // leaf is gone and the recorded set is what stands.
    expect(await listTree(storageDir)).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("THROWS when materialization does not converge the canonical dir", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    await writeFile(path.join(storageDir, "stale.md"), "# stale\n", "utf8");
    materializeMock.mockImplementation(async () => ({ bundleDigest: "x", fileCount: 0 }));

    await expect(
      registerExtensionSkill({
        skillId: "@acme/acme-skill:router-skill",
        packageName: "@acme/acme-skill",
        skillMdPath,
      }),
    ).rejects.toThrow(/does not walk back to it after materialization/);
  });
});

describe("resolveUpsertBundleFiles / buildUpsertRevisionWrite — the recorded manifest", () => {
  const content = "# Router\nSee [a](references/a.md).\n";
  const digest = computeSkillSourceRevision(content);
  const aBytes = Buffer.from("# a\n", "utf8");

  it("with no bundleFiles it is the cinatra#2088 BUNDLE OF ONE, unchanged", () => {
    const w = buildUpsertRevisionWrite({ id: "s1", content, source: { revision: { value: digest } } }, false);
    expect(w.bundleFiles).toHaveLength(1);
    expect(w.bundleFiles![0].path).toBe("SKILL.md");
    expect(w.bundleFiles![0].isRouter).toBe(true);
    expect(sha(w.bundleFiles![0].bytes)).toBe(digest);
  });

  it("with bundleFiles it records the whole set, router digest ≡ contentDigest", () => {
    const w = buildUpsertRevisionWrite(
      { id: "s1", content, source: { revision: { value: digest } } },
      false,
      null,
      undefined,
      [
        { path: "SKILL.md", bytes: Buffer.from("A DIFFERENT ROUTER\n", "utf8"), isRouter: true },
        { path: "references/a.md", bytes: aBytes },
      ],
    );
    expect(w.bundleFiles!.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
    // The caller's router entry is DROPPED and re-derived from `content`: the
    // revision's own content blob and its manifest's router MUST be the same
    // bytes, and `skill_revisions` is append-only so a mismatch is unhealable.
    const router = w.bundleFiles!.find((f) => f.path === "SKILL.md")!;
    expect(router.bytes.toString("utf8")).toBe(content);
    expect(sha(router.bytes)).toBe(w.contentDigest);
  });

  it("drops a `./SKILL.md`-shaped router entry too (normalized comparison)", () => {
    const files = resolveUpsertBundleFiles(content, [
      { path: "./SKILL.md", bytes: Buffer.from("stale\n", "utf8") },
      { path: "references/a.md", bytes: aBytes },
    ]);
    expect(files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
    expect(files[0].bytes.toString("utf8")).toBe(content);
  });

  it("records NO bundle at all when there is no content digest (never a mismatched pair)", () => {
    const w = buildUpsertRevisionWrite({ id: "s1", content, source: null }, false, null, undefined, [
      { path: "references/a.md", bytes: aBytes },
    ]);
    expect(w.bundleFiles).toBeNull();
  });

  it("THROWS on `isRouter` set for a non-router path rather than dropping the file", () => {
    // Silently dropping it would exclude a real bundled file from the manifest
    // while the mirror still materializes it on disk.
    expect(() =>
      resolveUpsertBundleFiles(content, [
        { path: "references/a.md", bytes: aBytes, isRouter: true },
      ]),
    ).toThrow(/is_router set on a non-router path/);
  });
});

describe("the registration POST-CONDITION refuses a result it did not achieve", () => {
  it("throws when the head the write left behind is not the bundle just read", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    // A concurrent writer moved the head to something else between the
    // redundancy check and the transaction (the documented TOCTOU window).
    upsertSkillMock.mockImplementation(async (input: { content: string }) => {
      await writeFile(path.join(storageDir, "SKILL.md"), input.content, "utf8");
      headState.value = {
        headRevisionId: "rev-other",
        headBundleDigest: "f".repeat(64),
        activeRevisionId: "rev-other",
        isAuthorityOwned: true,
      };
      return { id: "skill-1", sourcePath: path.join(storageDir, "SKILL.md") };
    });

    await expect(
      registerExtensionSkill({
        skillId: "@acme/acme-skill:router-skill",
        packageName: "@acme/acme-skill",
        skillMdPath,
      }),
    ).rejects.toThrow(/was not under its own authority head/);
  });

  it("HEALS a canonical SKILL.md that reached disk clobbered, from the authority", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    // The head is exactly right, but the router that reached disk is NOT the body
    // the authority recorded — stands in for a write that was truncated or
    // clobbered after the transaction committed. Materializing from the authority
    // is what repairs it; nothing about the SOURCE tree is consulted.
    upsertSkillMock.mockImplementation(
      async (input: { content: string; bundleFiles?: unknown }) => {
        await writeFile(path.join(storageDir, "SKILL.md"), "TRUNCATED\n", "utf8");
        headState.value = {
          headRevisionId: "rev-1",
          headBundleDigest: bundleDigestForFiles(
            resolveUpsertBundleFiles(input.content, input.bundleFiles as never),
          ),
          activeRevisionId: "rev-1",
          isAuthorityOwned: true,
        };
        return { id: "skill-1", sourcePath: path.join(storageDir, "SKILL.md") };
      },
    );

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(await listTree(storageDir)).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("REFUSES when another writer moved the head while this one was materializing", async () => {
    // The cross-process case `serializeBySkillId` cannot order (codex round-3):
    // the head was ours before delivery and somebody else's after it.
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    await writeFile(path.join(storageDir, "stale.md"), "# stale\n", "utf8");
    materializeMock.mockImplementation(async (_s: string, _r: string, dest: string) => {
      const call = upsertSkillMock.mock.calls.at(-1)![0] as {
        content: string;
        bundleFiles?: Array<{ path: string; bytes: Buffer }>;
      };
      const files = resolveUpsertBundleFiles(call.content, call.bundleFiles as never);
      await rm(dest, { recursive: true, force: true });
      for (const f of files) {
        const target = path.join(dest, f.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, f.bytes);
      }
      // ...and the competing writer commits its own authority right here.
      headState.value = {
        headRevisionId: "rev-other",
        headBundleDigest: "f".repeat(64),
        activeRevisionId: "rev-other",
        isAuthorityOwned: true,
      };
      return { bundleDigest: bundleDigestForFiles(files), fileCount: files.length };
    });

    await expect(
      registerExtensionSkill({
        skillId: "@acme/acme-skill:router-skill",
        packageName: "@acme/acme-skill",
        skillMdPath,
      }),
    ).rejects.toThrow(/ended not under its own authority head/);
  });

  it("removes a SYMLINK planted in the canonical dir instead of writing through it", async () => {
    await materializeSourceBundle({ "SKILL.md": ROUTER_BODY, "references/a.md": "# a\n" });
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "# outside\n", "utf8");
    await mkdir(path.join(storageDir, "references"), { recursive: true });
    await symlink(outside, path.join(storageDir, "references", "a.md"));

    await registerExtensionSkill({
      skillId: "@acme/acme-skill:router-skill",
      packageName: "@acme/acme-skill",
      skillMdPath,
    });

    // The walker skips the symlink, so the dir does not match and the whole
    // directory is REPLACED — the link is gone and its target is untouched.
    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(await listTree(storageDir)).toEqual(["SKILL.md", "references/a.md"]);
    expect(existsSync(outside)).toBe(true);
  });
});
