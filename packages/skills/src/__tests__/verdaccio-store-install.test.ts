/**
 * cinatra#793 — the verdaccio skill installer consumes the FINALIZED
 * unified-store payload (materialized by the dispatcher's store pipeline
 * BEFORE this handler runs) instead of extracting its own tarball.
 *
 * DI-unit slice: the host store-payload resolver + the skills-store upsert are
 * mocked; the temp payload dir on disk carries the real manifest bytes the
 * installer validates.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));

// The host read seam onto the unified store (dynamic import inside the
// installer — mocked at module granularity).
const resolveFinalizedStorePayload = vi.fn();
vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: (...a: unknown[]) =>
    resolveFinalizedStorePayload(...(a as [unknown])),
}));

// The catalog writer — capture its input; its containment/scan semantics are
// pinned in the skills-store tests.
const upsertRepositoryBackedSkillPackage = vi.fn(async (_input: unknown) => ({
  skillPackage: { id: "verdaccio:@acme/skills" },
  skills: [],
}));
vi.mock("../skills-store", () => ({
  upsertRepositoryBackedSkillPackage: (...a: unknown[]) =>
    upsertRepositoryBackedSkillPackage(...(a as [unknown])),
}));

import { installSkillPackageFromVerdaccio } from "../verdaccio";

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-skill-store-payload-"));

function makePayloadDir(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpBase, "digest-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installSkillPackageFromVerdaccio (unified store payload)", () => {
  it("registers the catalog rows against the FINALIZED store digest dir", async () => {
    const storeDir = makePayloadDir({
      name: "@acme/skills",
      version: "1.2.0",
      description: "Acme skills",
      license: "MIT",
      cinatra: { kind: "skill" },
    });
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "a".repeat(128),
      version: "1.2.0",
      registryUrl: "https://registry.cinatra.ai",
    });

    await installSkillPackageFromVerdaccio({
      packageName: "@acme/skills",
      packageVersion: "1.2.0",
      orgId: "org-1",
    });

    // Resolved at the SAME org scope + skill kind.
    expect(resolveFinalizedStorePayload).toHaveBeenCalledWith({
      packageName: "@acme/skills",
      expectedKind: "skill",
      orgId: "org-1",
    });
    // The catalog registration anchors in the store digest dir.
    expect(upsertRepositoryBackedSkillPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: "verdaccio:@acme/skills",
        catalogSkillIdPrefix: "@acme/skills",
        repositoryPath: storeDir,
        license: "MIT",
      }),
    );
  });

  it("fails LOUD when no finalized store payload exists (the pipeline runs before the handler)", async () => {
    resolveFinalizedStorePayload.mockResolvedValue(null);
    await expect(
      installSkillPackageFromVerdaccio({ packageName: "@acme/skills", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/no FINALIZED store payload/);
    expect(upsertRepositoryBackedSkillPackage).not.toHaveBeenCalled();
  });

  it("refuses a payload whose finalized version differs from the requested install version", async () => {
    const storeDir = makePayloadDir({
      name: "@acme/skills",
      version: "9.9.9",
      cinatra: { kind: "skill" },
    });
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "b".repeat(128),
      version: "9.9.9",
      registryUrl: null,
    });
    await expect(
      installSkillPackageFromVerdaccio({ packageName: "@acme/skills", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/refusing to register a different version's payload/);
    expect(upsertRepositoryBackedSkillPackage).not.toHaveBeenCalled();
  });

  it("refuses a payload whose manifest kind is not \"skill\"", async () => {
    const storeDir = makePayloadDir({
      name: "@acme/skills",
      version: "1.0.0",
      cinatra: { kind: "agent" },
    });
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "c".repeat(128),
      version: "1.0.0",
      registryUrl: null,
    });
    await expect(
      installSkillPackageFromVerdaccio({ packageName: "@acme/skills", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/cinatra\.kind=agent, expected "skill"/);
    expect(upsertRepositoryBackedSkillPackage).not.toHaveBeenCalled();
  });
});
