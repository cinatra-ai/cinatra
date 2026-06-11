// Unit contract of the standardized degraded-result guard (cinatra#7).
//
// The LOAD-BEARING boundary under test: a guarded loader degrades ONLY on a
// confirmed "target module absent" failure (module-not-found class naming the
// guarded package) — every other failure RETHROWS unchanged, preserving the
// fail-loud contract of the map consumers for PRESENT-but-broken modules
// (top-level throw, missing TRANSITIVE dependency). The generated test
// (src/lib/generated/__tests__/guarded-optional-loaders.test.ts) proves every
// emitted guardedOptional entry routes through this guard; this suite proves
// what routing through the guard MEANS.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExtensionModuleAbsentError,
  extensionPackageNameOf,
  guardedExtensionImport,
  isAbsentModuleError,
  isDegradedExtensionLoad,
  isGuardedExtensionLoader,
} from "../extension-load-guard";

const PKG = "@cinatra-ai/media-feeds-connector";
const SPEC = `${PKG}/mcp-module`;

function nodeNotFound(message: string, code = "ERR_MODULE_NOT_FOUND"): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extensionPackageNameOf", () => {
  it("extracts the scoped package from a subpath specifier", () => {
    expect(extensionPackageNameOf(SPEC)).toBe(PKG);
    expect(extensionPackageNameOf(PKG)).toBe(PKG);
    expect(extensionPackageNameOf("lodash/fp")).toBe("lodash");
  });
});

describe("isAbsentModuleError", () => {
  it("accepts node not-found codes naming the guarded package", () => {
    expect(isAbsentModuleError(nodeNotFound(`Cannot find module '${SPEC}'`), PKG)).toBe(true);
    expect(
      isAbsentModuleError(nodeNotFound(`Cannot find module '${SPEC}'`, "MODULE_NOT_FOUND"), PKG),
    ).toBe(true);
    expect(
      isAbsentModuleError(
        nodeNotFound(
          `Package subpath './mcp-module' is not defined by "exports" in /app/node_modules/${PKG}/package.json`,
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
        ),
        PKG,
      ),
    ).toBe(true);
  });

  it("accepts code-less bundler-runtime phrasings quoting the guarded specifier", () => {
    expect(isAbsentModuleError(new Error(`Cannot find module '${SPEC}'`), PKG)).toBe(true);
    expect(isAbsentModuleError(new Error(`Module not found: Can't resolve '${SPEC}'`), PKG)).toBe(
      true,
    );
  });

  it("accepts resolved-path forms whose missing FILE lives inside the package's own tree", () => {
    // ESM subpath dangle: package present, the target file gone (#109/#110 class).
    expect(
      isAbsentModuleError(
        nodeNotFound(
          `Cannot find module '/app/extensions/cinatra-ai/media-feeds-connector/src/mcp/module.ts' imported from /app/src/lib/generated/extensions.server.ts`,
        ),
        PKG,
      ),
    ).toBe(true);
    expect(
      isAbsentModuleError(
        nodeNotFound(`Cannot find module '/app/node_modules/${PKG}/dist/mcp/module.js'`),
        PKG,
      ),
    ).toBe(true);
  });

  it("rejects a not-found error naming a DIFFERENT package (missing transitive dep)", () => {
    expect(
      isAbsentModuleError(nodeNotFound("Cannot find module 'left-pad'"), PKG),
    ).toBe(false);
  });

  it("rejects a transitive-dep miss whose REQUIRE STACK / importer path names the guarded package (regression: no whole-message containment)", () => {
    // Node CJS: the missing module is the transitive dep; the require stack
    // names the guarded package. Must RETHROW (present-but-broken).
    expect(
      isAbsentModuleError(
        nodeNotFound(
          `Cannot find module 'some-transitive-dep'\nRequire stack:\n- /app/node_modules/${PKG}/dist/index.js\n- /app/src/lib/mcp-server.ts`,
          "MODULE_NOT_FOUND",
        ),
        PKG,
      ),
    ).toBe(false);
    // Node ESM: imported from a file INSIDE the guarded package.
    expect(
      isAbsentModuleError(
        nodeNotFound(
          `Cannot find package 'left-pad' imported from /app/extensions/cinatra-ai/media-feeds-connector/src/index.ts`,
        ),
        PKG,
      ),
    ).toBe(false);
  });

  it("rejects an exports-map gap of a DIFFERENT package (package.json path is the identification)", () => {
    expect(
      isAbsentModuleError(
        nodeNotFound(
          `Package subpath './x' is not defined by "exports" in /app/node_modules/@cinatra-ai/other-connector/package.json`,
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
        ),
        PKG,
      ),
    ).toBe(false);
  });

  it("rejects a not-found-shaped message with NO quoted missing specifier (cannot confirm the target)", () => {
    expect(isAbsentModuleError(new Error(`Module not found: ${SPEC}`), PKG)).toBe(false);
  });

  it("rejects non-not-found failures (top-level throw of a present module)", () => {
    expect(isAbsentModuleError(new Error(`boom from ${PKG} top-level`), PKG)).toBe(false);
    expect(isAbsentModuleError(null, PKG)).toBe(false);
    expect(isAbsentModuleError("Cannot find module", PKG)).toBe(false);
  });
});

describe("guardedExtensionImport", () => {
  it("resolves the imported namespace when the module loads", async () => {
    const ns = { createThing: () => "thing" };
    const load = guardedExtensionImport(SPEC, async () => ns);
    await expect(load()).resolves.toBe(ns);
  });

  it("degrades a confirmed target-module absence to the standardized absent result (loud, never a throw)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = guardedExtensionImport(SPEC, async () => {
      throw nodeNotFound(`Cannot find module '${SPEC}'`);
    });
    const result = await load();
    expect(isDegradedExtensionLoad(result)).toBe(true);
    if (!isDegradedExtensionLoad(result)) throw new Error("unreachable");
    expect(result.status).toBe("absent");
    expect(result.specifier).toBe(SPEC);
    expect(result.packageName).toBe(PKG);
    expect(result.reason).toContain(SPEC);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("RETHROWS a top-level throw from a present module (fail-loud preserved)", async () => {
    const boom = new Error("present module exploded at import time");
    const load = guardedExtensionImport(SPEC, async () => {
      throw boom;
    });
    await expect(load()).rejects.toBe(boom);
  });

  it("RETHROWS a missing TRANSITIVE dependency (not-found naming another package)", async () => {
    const dep = nodeNotFound("Cannot find module 'some-transitive-dep'", "MODULE_NOT_FOUND");
    const load = guardedExtensionImport(SPEC, async () => {
      throw dep;
    });
    await expect(load()).rejects.toBe(dep);
  });

  it("brands the loader (guard-owned marking, not source-shape inference)", () => {
    const load = guardedExtensionImport(SPEC, async () => ({}));
    expect(isGuardedExtensionLoader(load)).toBe(true);
    expect(load.specifier).toBe(SPEC);
    expect(load.packageName).toBe(PKG);
    expect(isGuardedExtensionLoader(() => Promise.resolve({}))).toBe(false);
    expect(isGuardedExtensionLoader(undefined)).toBe(false);
  });

  it("the degraded result is branded and frozen; plain look-alikes do not pass the brand check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = guardedExtensionImport(SPEC, async () => {
      throw nodeNotFound(`Cannot find module '${SPEC}'`);
    });
    const result = await load();
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      isDegradedExtensionLoad({ status: "absent", specifier: SPEC, packageName: PKG, reason: "x" }),
    ).toBe(false);
  });
});

describe("ExtensionModuleAbsentError", () => {
  it("carries the specifier and a typed name", () => {
    const err = new ExtensionModuleAbsentError(SPEC, "gone");
    expect(err.name).toBe("ExtensionModuleAbsentError");
    expect(err.specifier).toBe(SPEC);
    expect(err.message).toContain(SPEC);
    expect(err.message).toContain("gone");
  });
});
