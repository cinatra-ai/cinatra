// Built-in floor semantic artifact type.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// register-artifact-extensions.ts is `import "server-only"`; neutralise the
// RSC guard for the node test env (same pattern as artifact-bridge.test.ts).
vi.mock("server-only", () => ({}));

import {
  parseSemanticArtifactManifest,
  DEFAULT_ARTIFACT_EXTENSION,
  isDefaultArtifactType,
} from "../semantic-manifest";
import { registerArtifactExtensions } from "../integration/register-artifact-extensions";
import { objectTypeRegistry } from "../registry";

// The shipped package.json `cinatra.artifact` block is the source of truth.
const pkgJson = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../extensions/cinatra-ai/default-artifact/package.json"),
    "utf8",
  ),
);

describe("@cinatra-ai/default-artifact — built-in floor type", () => {
  it("constant + helper identify the floor type and reject others", () => {
    expect(DEFAULT_ARTIFACT_EXTENSION).toBe("@cinatra-ai/default-artifact");
    expect(isDefaultArtifactType("@cinatra-ai/default-artifact")).toBe(true);
    expect(isDefaultArtifactType("@cinatra-ai/marketing-icp-artifact")).toBe(false);
    expect(isDefaultArtifactType(null)).toBe(false);
    expect(isDefaultArtifactType(undefined)).toBe(false);
  });

  it("the shipped manifest is a valid semantic manifest (no substrate fields)", () => {
    expect(pkgJson.name).toBe("@cinatra-ai/default-artifact");
    expect(pkgJson.cinatra.kind).toBe("artifact");
    const r = parseSemanticArtifactManifest(pkgJson.cinatra.artifact);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // floor admits any form, satisfies nothing, no templates/skills
      expect(r.manifest.accepts.file?.mimeTypes).toEqual(["*/*"]);
      expect(r.manifest.accepts.connectorRef?.resolvedMimeTypes).toEqual(["*/*"]);
      expect(r.manifest.accepts.dashboard).toBe(true);
      expect(r.manifest.satisfies).toBeUndefined();
      expect(r.manifest.templates).toBeUndefined();
      expect(r.manifest.skills).toBeUndefined();
    }
  });

  it("registers through the semantic bridge from a fixture dir", () => {
    objectTypeRegistry._clearForTests();
    const root = mkdtempSync(join(tmpdir(), "default-art-"));
    const dir = join(root, "default-artifact");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
    expect(registerArtifactExtensions(root)).toBe(1);
    const entry = objectTypeRegistry
      .listArtifacts()
      .find((d) => d.type === "@cinatra-ai/default-artifact:artifact");
    expect(entry).toBeDefined();
    expect(entry?.isArtifact?.accepts.dashboard).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
