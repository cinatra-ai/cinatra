// Regression for cinatra#386 — the dev-setup step that seeds the on-disk
// first-party extensions into the LOCAL bundled Verdaccio so they resolve +
// install out of the box (the installer is registry-only; a fresh local
// registry starts empty → 404 → uninstallable).
//
// These pin the pure, deterministic GUARDRAILS without a live registry:
//   - loopback-only publish target (a remote/production URL is refused)
//   - on-disk enumeration filters private / shapeless packages
//   - non-loopback target → "skipped-not-loopback" (no publish attempted)
//   - unreachable local registry → "skipped-unreachable" (loud-but-non-fatal)
// The live-wire publish → 200 resolution proof is exercised on the real
// surface during `cinatra setup dev`.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_REGISTRY_URL,
  compareVersionCores,
  enumeratePublishableExtensions,
  isLoopbackRegistryUrl,
  registryHasAtLeast,
  seedLocalRegistryExtensions,
} from "../seed-local-registry.mjs";

describe("isLoopbackRegistryUrl", () => {
  it("accepts loopback hosts", () => {
    expect(isLoopbackRegistryUrl("http://127.0.0.1:4873")).toBe(true);
    expect(isLoopbackRegistryUrl("http://localhost:4873")).toBe(true);
    expect(isLoopbackRegistryUrl("http://[::1]:4873")).toBe(true);
    expect(isLoopbackRegistryUrl(LOCAL_REGISTRY_URL)).toBe(true);
  });

  it("rejects non-loopback / remote / production hosts", () => {
    expect(isLoopbackRegistryUrl("https://registry.cinatra.ai")).toBe(false);
    expect(isLoopbackRegistryUrl("http://10.0.0.5:4873")).toBe(false);
    expect(isLoopbackRegistryUrl("https://registry.npmjs.org/")).toBe(false);
  });

  it("rejects malformed / non-http inputs (fail-closed)", () => {
    expect(isLoopbackRegistryUrl("")).toBe(false);
    expect(isLoopbackRegistryUrl("not a url")).toBe(false);
    expect(isLoopbackRegistryUrl("ftp://127.0.0.1/")).toBe(false);
    expect(isLoopbackRegistryUrl(null)).toBe(false);
    expect(isLoopbackRegistryUrl(undefined)).toBe(false);
  });
});

describe("compareVersionCores", () => {
  it("orders numeric version cores", () => {
    expect(compareVersionCores("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersionCores("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersionCores("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersionCores("0.2.0", "0.1.9")).toBe(1);
  });

  it("ignores pre-release/build metadata and missing segments", () => {
    expect(compareVersionCores("1.2.0-rc.1", "1.2.0")).toBe(0);
    expect(compareVersionCores("1.2", "1.2.0")).toBe(0);
    expect(compareVersionCores("2", "1.9.9")).toBe(1);
  });
});

describe("registryHasAtLeast", () => {
  it("is true when an equal or higher version is published", () => {
    expect(registryHasAtLeast({ versions: { "0.1.0": {} } }, "0.1.0")).toBe(true);
    expect(registryHasAtLeast({ versions: { "0.1.4": {} } }, "0.1.0")).toBe(true);
    expect(
      registryHasAtLeast({ versions: { "0.1.2": {}, "0.1.3": {} } }, "0.1.0"),
    ).toBe(true);
  });

  it("is FALSE when only lower versions exist (a bump must still publish)", () => {
    // The on-disk version was bumped past everything published → publish it.
    expect(registryHasAtLeast({ versions: { "0.1.0": {} } }, "0.1.1")).toBe(false);
    expect(
      registryHasAtLeast({ versions: { "0.0.9": {}, "0.1.0": {} } }, "0.2.0"),
    ).toBe(false);
  });

  it("is false for an empty / missing packument (treated as not present)", () => {
    expect(registryHasAtLeast(null, "0.1.0")).toBe(false);
    expect(registryHasAtLeast({ versions: {} }, "0.1.0")).toBe(false);
  });
});

describe("enumeratePublishableExtensions", () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), "seed-enum-"));
    const writePkg = (vendor, name, manifest) => {
      const dir = path.join(repoRoot, "extensions", vendor, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    };
    writePkg("cinatra-ai", "blog-content-workflow", {
      name: "@cinatra-ai/blog-content-workflow",
      version: "0.1.0",
    });
    writePkg("cinatra-ai", "crm-connector", {
      name: "@cinatra-ai/crm-connector",
      version: "0.1.0",
    });
    // Filtered: private
    writePkg("cinatra-ai", "secret-pkg", {
      name: "@cinatra-ai/secret-pkg",
      version: "1.0.0",
      private: true,
    });
    // Filtered: missing version
    writePkg("cinatra-ai", "no-version", { name: "@cinatra-ai/no-version" });
    // Filtered: missing name
    writePkg("cinatra-ai", "no-name", { version: "1.0.0" });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns only publishable packages, sorted by name", () => {
    const found = enumeratePublishableExtensions(repoRoot);
    expect(found.map((e) => e.name)).toEqual([
      "@cinatra-ai/blog-content-workflow",
      "@cinatra-ai/crm-connector",
    ]);
    expect(found.every((e) => e.private === false)).toBe(true);
  });

  it("returns [] when no extensions/ tree exists", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "seed-empty-"));
    try {
      expect(enumeratePublishableExtensions(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("seedLocalRegistryExtensions guardrails", () => {
  const origFetch = globalThis.fetch;
  let prevExitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  it("refuses a non-loopback registry target without attempting any publish", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const summary = await seedLocalRegistryExtensions({
      repoRoot: "/nonexistent",
      registryUrl: "https://registry.cinatra.ai",
    });
    expect(summary.status).toBe("skipped-not-loopback");
    expect(summary.published).toEqual([]);
    // Never even probed the network for a non-loopback target.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips (loud-but-non-fatal) when the local registry is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const summary = await seedLocalRegistryExtensions({
      repoRoot: "/nonexistent",
      registryUrl: "http://127.0.0.1:4873",
    });
    expect(summary.status).toBe("skipped-unreachable");
    expect(summary.published).toEqual([]);
  });
});
