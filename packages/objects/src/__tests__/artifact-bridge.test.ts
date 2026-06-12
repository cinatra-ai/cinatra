import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// register-artifact-extensions.ts is `import "server-only"` (fs + bridge);
// neutralise the RSC guard for the node test env (same pattern as the
// extensions package tests).
vi.mock("server-only", () => ({}));

import { objectTypeRegistry } from "../registry";
import { registerArtifactExtensions } from "../integration/register-artifact-extensions";

// Proves the pluggability guarantee: a brand-new artifact type (a NOVEL
// artifactType string that appears NOWHERE in core code) is discovered and
// surfaced via `listArtifacts()` purely by dropping a `kind:"artifact"`
// extension dir — zero core per-type branches.

function writeExt(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
): void {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(
    path.join(root, dir, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
}

describe("registerArtifactExtensions — descriptor bridge", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-bridge-"));
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("registers a NOVEL artifact type discovered purely from the extension dir", () => {
    writeExt(root, "fixture-thing-artifact", {
      name: "@cinatra-ai/fixture-thing-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          satisfies: ["@cinatra-ai/marketing-icp-artifact"],
          skills: { matchers: ["@cinatra-ai/fixture-matcher:skill"] },
        },
      },
    });

    const count = registerArtifactExtensions(root);
    expect(count).toBe(1);

    const artifacts = objectTypeRegistry.listArtifacts();
    const entry = artifacts.find(
      (d) => d.type === "@cinatra-ai/fixture-thing-artifact:artifact",
    );
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("@cinatra-ai/fixture-thing-artifact:artifact");
    expect(entry?.isArtifact?.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(entry?.isArtifact?.satisfies).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
    ]);
    // resolve() returns it generically — no per-type branch anywhere.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/fixture-thing-artifact:artifact"),
    ).not.toBeNull();
  });

  it("registers a manifest carrying the cross-kind dependencies + roles keys (cinatra#151 Stage 5)", () => {
    writeExt(root, "roled-artifact", {
      name: "@cinatra-ai/roled-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        roles: ["artifact-roled-summary"],
        dependencies: [],
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/roled-artifact:artifact"),
    ).not.toBeNull();
  });

  it("skips a kind:'artifact' package with an invalid/missing descriptor", () => {
    writeExt(root, "broken-artifact", {
      name: "@cinatra-ai/broken-artifact",
      version: "0.0.1",
      cinatra: { kind: "artifact", artifact: { artifactType: "legacy-substrate" } },
    });
    writeExt(root, "nodesc-artifact", {
      name: "@cinatra-ai/nodesc-artifact",
      version: "0.0.1",
      cinatra: { kind: "artifact" },
    });
    expect(registerArtifactExtensions(root)).toBe(0);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });

  it("ignores non-artifact dirs and is idempotent (replace-by-id)", () => {
    writeExt(root, "some-connector", {
      name: "@cinatra-ai/some-connector",
      version: "0.0.1",
      cinatra: { kind: "connector" },
    });
    writeExt(root, "real-artifact", {
      name: "@cinatra-ai/real-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    // second pass = idempotent replace, still exactly one artifact entry
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(1);
  });
});
