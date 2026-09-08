/**
 * THE FILE ROAD'S DRIVER (cinatra#3204 leg 3 — criteria 1, 2, 4, 5, 18, 19, 20).
 *
 * The claims under test:
 *   - a supplied ARCHIVE of any of the four live kinds reaches leg 1's pipeline
 *     entry, carrying honest `local` provenance and the digest over the bytes
 *     that actually arrived;
 *   - the retired `workflow` kind and an undeclared kind are refused BY NAME,
 *     with nothing staged and nothing installed;
 *   - the resolved kind's OWN validator runs BEFORE any mutation, and a package
 *     it rejects stages no snapshot and installs nothing;
 *   - a preview-to-install byte swap is refused.
 */
import { describe, expect, it, vi } from "vitest";

import { buildStoredZip } from "@cinatra-ai/agents/upload-archive";
import {
  installSuppliedArchivePackage,
  previewSuppliedArchive,
  validateSuppliedPackageForKind,
} from "@/lib/archive-supplied-install";
import { makeTestSuppliedInstallPipelineDeps } from "@/lib/extension-install-pipeline-deps";

const OAS = JSON.stringify({ component_type: "Flow", agentspec_version: "26.1.0", name: "A" });

function zipFor(kind: string): ArrayBuffer {
  const manifest: Record<string, unknown> = {
    name: `@acme/thing-${kind}`,
    version: "1.0.0",
    cinatra: { kind },
  };
  const files: { name: string; content: string }[] = [];
  if (kind === "agent") {
    files.push({ name: "cinatra/oas.json", content: OAS });
  } else if (kind === "skill") {
    files.push({ name: "skills/one/SKILL.md", content: "---\nname: one\n---\nbody" });
  } else if (kind === "connector") {
    (manifest.cinatra as Record<string, unknown>).serverEntry = "dist/server.js";
    files.push({ name: "dist/server.js", content: "export function register() {}" });
  } else if (kind === "artifact") {
    files.push({ name: "cinatra/artifact.json", content: JSON.stringify({ accepts: [] }) });
  }
  files.unshift({ name: "package.json", content: JSON.stringify(manifest) });
  const bytes = buildStoredZip(files);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function zipWith(manifest: unknown, extra: { name: string; content: string }[] = []): ArrayBuffer {
  const bytes = buildStoredZip([
    { name: "package.json", content: JSON.stringify(manifest) },
    ...extra,
  ]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Deps whose store dir reports back exactly the digest the caller declared. */
function depsAgreeingWithDigest(digest: string, over: Record<string, unknown> = {}) {
  return makeTestSuppliedInstallPipelineDeps({
    treeDigest: digest,
    ...over,
  } as never);
}

describe("the File road reads every live kind (criteria 1, 2)", () => {
  for (const kind of ["agent", "skill", "connector", "artifact"] as const) {
    it(`resolves a ${kind} archive and produces local provenance over its digest`, async () => {
      const preview = await previewSuppliedArchive(zipFor(kind));
      expect(preview.kind).toBe(kind);
      expect(preview.packageName).toBe(`@acme/thing-${kind}`);
      expect(preview.provenance.type).toBe("local");
      expect(preview.provenance.contentDigest).toBe(preview.contentDigest);
      expect(preview.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    });
  }
});

describe("the File road's refusals leave nothing written (criteria 1, 3)", () => {
  it("refuses the retired workflow kind by name", async () => {
    await expect(previewSuppliedArchive(zipWith({ name: "@acme/w", version: "1.0.0", cinatra: { kind: "workflow" } }))).rejects.toThrow(
      /retired extension kind/,
    );
  });

  it("refuses an archive that declares no kind", async () => {
    await expect(previewSuppliedArchive(zipWith({ name: "@acme/w", version: "1.0.0" }))).rejects.toThrow(
      /declares no cinatra\.kind/,
    );
  });

  it("stages nothing when the archive is refused", async () => {
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      installSuppliedArchivePackage(
        { archive: zipWith({ name: "@acme/w", version: "1.0.0", cinatra: { kind: "workflow" } }), stageSnapshot },
        depsAgreeingWithDigest("0".repeat(64)),
      ),
    ).rejects.toThrow(/retired extension kind/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });
});

describe("the kind's own validator runs before any mutation (criterion 4)", () => {
  it("refuses when the kind's validator rejects, and stages nothing", async () => {
    const stageSnapshot = vi.fn(async () => "never.tgz");
    const resolveValidator = async () => async () => ({
      valid: false,
      errors: ["package name does not match the kind-at-end convention"],
    });
    await expect(
      installSuppliedArchivePackage(
        { archive: zipFor("artifact"), stageSnapshot, resolveValidator },
        depsAgreeingWithDigest("0".repeat(64)),
      ),
    ).rejects.toThrow(/did not pass the artifact validator/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });

  it("reports honestly when a kind declares no validator", async () => {
    const outcome = await validateSuppliedPackageForKind({
      kind: "agent",
      packageJson: JSON.stringify({ name: "@acme/a", cinatra: { kind: "agent" } }),
      resolveValidator: async () => null,
    });
    expect(outcome.ran).toBe(false);
  });

  it("runs the validator on the parsed manifest, never on package code", async () => {
    const seen: unknown[] = [];
    await validateSuppliedPackageForKind({
      kind: "connector",
      packageJson: JSON.stringify({ name: "@acme/x-connector", cinatra: { kind: "connector" } }),
      resolveValidator: async () => async (spec) => {
        seen.push(spec);
        return { valid: true };
      },
    });
    expect(seen).toEqual([{ name: "@acme/x-connector", cinatra: { kind: "connector" } }]);
  });
});

describe("the File road feeds leg 1's pipeline entry (criteria 18, 20)", () => {
  it("installs a skill archive with honest local provenance and a staged snapshot", async () => {
    const preview = await previewSuppliedArchive(zipFor("skill"));
    const recorded: Record<string, unknown>[] = [];
    const outcome = await installSuppliedArchivePackage(
      {
        archive: zipFor("skill"),
        orgId: null,
        stageSnapshot: async (digest) => `${digest}.tgz`,
        resolveValidator: async () => null,
      },
      depsAgreeingWithDigest(preview.contentDigest, {
        recordSuppliedProvenance: async (write: Record<string, unknown>) => {
          recorded.push(write);
        },
      }),
    );
    expect(outcome.result.installed).toBe(true);
    expect(outcome.package.provenance).toEqual({
      type: "local",
      path: `${preview.contentDigest}.tgz`,
      contentDigest: preview.contentDigest,
    });
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { provenance: { type: string } }).provenance.type).toBe("local");
  });

  it("refuses a preview-to-install byte swap before any write", async () => {
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      installSuppliedArchivePackage(
        {
          archive: zipFor("artifact"),
          expectedContentDigest: "c".repeat(64),
          stageSnapshot,
          resolveValidator: async () => null,
        },
        depsAgreeingWithDigest("c".repeat(64)),
      ),
    ).rejects.toThrow(/is not the digest of the bytes that arrived/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });
});
