// Manifest-driven dev-CLI module discovery (cinatra#151 Stage 5c) pins.
//
// The CLI's tailscale provisioning reach into the extensions tree is now
// DISCOVERED from `cinatra.devCliModules` manifest declarations — the CLI
// names no extension. These tests pin: discovery against a fixture tree,
// the ERR_MODULE_NOT_FOUND absence posture (callers' degradation guards
// keep working), traversal confinement, and the REAL-TREE resolution of the
// tailscale keys when the connector is present.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  discoverDevCliModulePath,
  loadDevCliModule,
} from "../src/dev-cli-modules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let fixtureRoot = "";

function writePkg(scope, name, pkg, files = {}) {
  const dir = path.join(fixtureRoot, "extensions", scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "devcli-fixture-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("discoverDevCliModulePath", () => {
  it("finds the declared module file by KEY (no package name involved)", () => {
    writePkg("any-scope", "some-connector", {
      name: "@any-scope/some-connector",
      cinatra: { devCliModules: { "my-key": "./src/mod.mjs" } },
    }, { "src/mod.mjs": "export const ok = true;\n" });
    const p = discoverDevCliModulePath("my-key", fixtureRoot);
    expect(p).toBe(path.join(fixtureRoot, "extensions", "any-scope", "some-connector", "src", "mod.mjs"));
  });

  it("returns null when nothing declares the key or the tree is absent", () => {
    expect(discoverDevCliModulePath("my-key", fixtureRoot)).toBeNull();
    rmSync(fixtureRoot, { recursive: true, force: true });
    expect(discoverDevCliModulePath("my-key", fixtureRoot)).toBeNull();
  });

  it("REJECTS declared paths that traverse outside the declaring extension dir", () => {
    writePkg("s", "evil-connector", {
      name: "@s/evil-connector",
      cinatra: { devCliModules: { escape: "../../../package.json" } },
    });
    expect(discoverDevCliModulePath("escape", fixtureRoot)).toBeNull();
  });

  it("is deterministic: first sorted declarer wins on duplicate keys", () => {
    writePkg("s", "b-connector", {
      name: "@s/b-connector",
      cinatra: { devCliModules: { dup: "./b.mjs" } },
    }, { "b.mjs": "" });
    writePkg("s", "a-connector", {
      name: "@s/a-connector",
      cinatra: { devCliModules: { dup: "./a.mjs" } },
    }, { "a.mjs": "" });
    expect(discoverDevCliModulePath("dup", fixtureRoot)).toContain("a-connector");
  });
});

describe("loadDevCliModule", () => {
  it("imports the discovered module", async () => {
    writePkg("s", "mod-connector", {
      name: "@s/mod-connector",
      cinatra: { devCliModules: { loadme: "./src/loadme.mjs" } },
    }, { "src/loadme.mjs": "export const VALUE = 42;\n" });
    const mod = await loadDevCliModule("loadme", fixtureRoot);
    expect(mod.VALUE).toBe(42);
  });

  it("throws with code ERR_MODULE_NOT_FOUND when no declarer is present (degradation-guard parity)", async () => {
    await expect(loadDevCliModule("absent-key", fixtureRoot)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
  });
});

describe("real-tree resolution (the tailscale connector's declaration)", () => {
  // Presence-aware: the extensions tree is a gitignored clone-back target.
  // When present (dev/CI clone-back), the tailscale keys MUST resolve to real
  // files; when absent, discovery returns null (the fresh-checkout posture).
  it("tailscale-api / tailscale-hostname resolve to on-disk modules when the tree is present", () => {
    const extRoot = path.join(REAL_REPO_ROOT, "extensions");
    const api = discoverDevCliModulePath("tailscale-api", REAL_REPO_ROOT);
    const hostname = discoverDevCliModulePath("tailscale-hostname", REAL_REPO_ROOT);
    if (!existsSync(extRoot) || api === null) {
      expect(api).toBeNull();
      expect(hostname).toBeNull();
      return;
    }
    expect(existsSync(api)).toBe(true);
    expect(existsSync(hostname)).toBe(true);
  });
});
