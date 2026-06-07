// Verdaccio config immutability gate.
import { describe, expect, it } from "vitest";
import path from "node:path";

import { verifyVerdaccioImmutability } from "../registry-immutability";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONFIG_PATH = path.join(REPO_ROOT, "docker", "verdaccio", "config.yaml");

describe("Verdaccio immutable-on-publish", () => {
  it("the shipped docker/verdaccio/config.yaml sets unpublish: nobody for every glob", () => {
    const result = verifyVerdaccioImmutability(CONFIG_PATH);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  });

  it("rejects a config that uses unpublish: $authenticated", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verdaccio-test-"));
    const badConfig = path.join(dir, "config.yaml");
    fs.writeFileSync(
      badConfig,
      `packages:\n  '**':\n    access: $all\n    publish: $authenticated\n    unpublish: $authenticated\n`,
    );
    const result = verifyVerdaccioImmutability(badConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join("\n")).toContain("permissive");
    }
  });

  it("rejects a config with no unpublish directive at all", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verdaccio-test-"));
    const badConfig = path.join(dir, "config.yaml");
    fs.writeFileSync(badConfig, `packages:\n  '**':\n    access: $all\n    publish: $authenticated\n`);
    const result = verifyVerdaccioImmutability(badConfig);
    expect(result.ok).toBe(false);
  });
});
