/**
 * cinatra#4264 slice A1b: the CLI install road (`cli/install-from-package-cli.ts`)
 * runs no OAS compile and writes no lifecycle column, so it can neither check a
 * `cinatra.lifecycle.regenerate` declaration against the flow nor store it. It
 * refuses a package that declares one, before any template row is written, and
 * names the registry install road that does both.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/install-from-package-cli-regenerate-4264.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PKG = "@cinatra-ai/regen-cli-agent";

const { extracted, createLocalCli, cleanup } = vi.hoisted(() => ({
  extracted: { manifest: {} as Record<string, unknown> },
  createLocalCli: vi.fn(async (..._a: unknown[]) => ({ templateId: "tpl-cli", versionId: "ver-cli" })),
  cleanup: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("../cli/extract-agent-package-cli", () => ({
  extractAgentPackageCli: async () => ({
    packageName: PKG,
    packageVersion: "1.0.0",
    tempDir: "/tmp/regen-cli-fixture",
    manifest: extracted.manifest,
    payload: {
      title: "Regen CLI agent",
      description: "d",
      template: { name: "Regen CLI agent", description: "d", sourceNl: "src" },
      version: { snapshot: { nodes: [] } },
    },
  }),
  cleanupExtractedAgentPackageCli: cleanup,
}));
vi.mock("../cli/create-agent-template-cli", () => ({
  createLocalAgentTemplateVersionCli: createLocalCli,
}));
vi.mock("../verdaccio/package-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../verdaccio/package-contract")>();
  // The fail-closed metadata contract is covered by its own suite; this one
  // isolates the lifecycle refusal.
  return { ...actual, parseAgentPackageManifestForInstall: (x: unknown) => x };
});

import { installAgentFromPackage } from "../cli/install-from-package-cli";

const manifest = (lifecycle?: Record<string, unknown>) => ({
  name: PKG,
  version: "1.0.0",
  cinatra: {
    packageType: "agent",
    manifestVersion: 1,
    type: "leaf",
    ...(lifecycle ? { lifecycle } : {}),
  },
});

beforeEach(() => {
  createLocalCli.mockClear();
  cleanup.mockClear();
});

describe("cinatra#4264 A1b — the CLI install refuses a regenerate declaration", () => {
  it("a package declaring cinatra.lifecycle.regenerate is refused before any template row is written", async () => {
    extracted.manifest = manifest({
      repairCapable: true,
      regenerate: [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }],
    });
    await expect(installAgentFromPackage({ packageName: PKG })).rejects.toThrow(
      /cinatra\.lifecycle\.regenerate[\s\S]*registry install/,
    );
    expect(createLocalCli).not.toHaveBeenCalled();
    // The extracted temp directory is still cleaned up.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("any declared value refuses, even one the schema would reject (the CLI checks nothing)", async () => {
    extracted.manifest = manifest({ regenerate: "not-a-list" });
    await expect(installAgentFromPackage({ packageName: PKG })).rejects.toThrow(/regenerate/);
    expect(createLocalCli).not.toHaveBeenCalled();
  });

  it("a package without the key installs as before (control)", async () => {
    extracted.manifest = manifest({ repairCapable: true });
    await expect(installAgentFromPackage({ packageName: PKG })).resolves.toMatchObject({ templateId: "tpl-cli" });
    expect(createLocalCli).toHaveBeenCalledTimes(1);
  });
});
