import { describe, it, expect, vi } from "vitest";
import {
  classifyServerEntryArtifact,
  discoverPackageStoreRecords,
  recordDeclaresHostMigrations,
  recordFromManifest,
  resolveDeclaredServerEntry,
  resolveExportsSubpath,
  resolveServerEntryPath,
  runRuntimePackageActivation,
  type PackageStoreFs,
  type PackageStoreRecord,
} from "../runtime-loader";

// --- in-memory package store --------------------------------------------------
// files: absolute path -> contents (string). dirs: set of dir paths.
function makeFs(files: Record<string, string>, dirs: string[]): PackageStoreFs {
  const dirSet = new Set(dirs);
  return {
    exists: async (p) => p in files || dirSet.has(p),
    isDirectory: async (p) => dirSet.has(p),
    readdir: async (p) => {
      const prefix = p.replace(/\/+$/, "") + "/";
      const children = new Set<string>();
      for (const key of [...Object.keys(files), ...dirSet]) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length).split("/")[0];
          if (rest) children.add(rest);
        }
      }
      return [...children];
    },
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

function manifest(
  name: string,
  cinatra: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify(cinatra ? { name, ...extra, cinatra } : { name, ...extra });
}

// --- the shared exports resolver (pinned Cinatra semantics, cinatra#161) ------
describe("resolveExportsSubpath (pinned Cinatra resolver semantics)", () => {
  it("resolves an exact string key", () => {
    expect(resolveExportsSubpath({ "./register": "./register.mjs" }, "./register")).toBe("./register.mjs");
    expect(resolveExportsSubpath({ ".": "./index.mjs" }, ".")).toBe("./index.mjs");
  });

  it("resolves a ONE-level conditional entry picking import → default → require", () => {
    expect(
      resolveExportsSubpath({ "./register": { import: "./a.mjs", require: "./a.cjs" } }, "./register"),
    ).toBe("./a.mjs");
    expect(resolveExportsSubpath({ "./register": { default: "./d.mjs" } }, "./register")).toBe("./d.mjs");
    expect(resolveExportsSubpath({ "./register": { require: "./r.cjs" } }, "./register")).toBe("./r.cjs");
  });

  it("returns null for a missing key, a non-object map, or a null/undefined map", () => {
    expect(resolveExportsSubpath({ "./other": "./o.mjs" }, "./register")).toBeNull();
    expect(resolveExportsSubpath("not-a-map", "./register")).toBeNull();
    expect(resolveExportsSubpath(undefined, "./register")).toBeNull();
    expect(resolveExportsSubpath(null, "./register")).toBeNull();
  });

  it("refuses everything outside the pinned language: arrays, wildcards, nested conditions, null targets, non-./ targets", () => {
    // array targets
    expect(resolveExportsSubpath({ "./register": ["./a.mjs"] }, "./register")).toBeNull();
    expect(resolveExportsSubpath(["./register.mjs"], "./register")).toBeNull();
    // wildcard patterns: exact-key lookup only — `./*` never matches `./register`
    expect(resolveExportsSubpath({ "./*": "./dist/*.mjs" }, "./register")).toBeNull();
    // nested condition objects (one level deep only)
    expect(
      resolveExportsSubpath({ "./register": { import: { node: "./n.mjs" } } }, "./register"),
    ).toBeNull();
    // null targets
    expect(resolveExportsSubpath({ "./register": null }, "./register")).toBeNull();
    expect(resolveExportsSubpath({ "./register": { import: null, default: null } }, "./register")).toBeNull();
    // targets not starting with `./`
    expect(resolveExportsSubpath({ "./register": "register.mjs" }, "./register")).toBeNull();
    expect(resolveExportsSubpath({ "./register": "/abs/register.mjs" }, "./register")).toBeNull();
    expect(resolveExportsSubpath({ "./register": { import: "register.mjs" } }, "./register")).toBeNull();
  });
});

describe("resolveDeclaredServerEntry (three-way: exports hit / literal fallback / declared-but-invalid)", () => {
  it("resolves through a declared exports key", () => {
    expect(
      resolveDeclaredServerEntry({ "./register": "./dist/register.mjs" }, "./register"),
    ).toEqual({ kind: "resolved", rel: "./dist/register.mjs", viaExports: true });
  });
  it("falls back to the literal path ONLY when the key is NOT declared", () => {
    expect(resolveDeclaredServerEntry({ ".": "./index.mjs" }, "./register.mjs")).toEqual({
      kind: "resolved",
      rel: "./register.mjs",
      viaExports: false,
    });
    expect(resolveDeclaredServerEntry(undefined, "./register.mjs")).toEqual({
      kind: "resolved",
      rel: "./register.mjs",
      viaExports: false,
    });
  });
  it("REFUSES a DECLARED key whose target is outside the pinned language — never a silent literal fallback", () => {
    for (const target of ["/abs/evil.mjs", "register.mjs", null, ["./a.mjs"], { import: { node: "./n.mjs" } }]) {
      expect(
        resolveDeclaredServerEntry({ "./register.mjs": target }, "./register.mjs"),
        JSON.stringify(target),
      ).toEqual({ kind: "invalid-exports-target" });
    }
  });
});

describe("classifyServerEntryArtifact (built-artifacts-only contract)", () => {
  it("classifies .mjs/.cjs/.js as importable", () => {
    expect(classifyServerEntryArtifact("./register.mjs")).toBe("importable");
    expect(classifyServerEntryArtifact("./dist/register.cjs")).toBe("importable");
    expect(classifyServerEntryArtifact("/store/pkg/register.js")).toBe("importable");
  });
  it("classifies .ts/.tsx/.mts/.cts as source", () => {
    expect(classifyServerEntryArtifact("./src/register.ts")).toBe("source");
    expect(classifyServerEntryArtifact("./src/register.tsx")).toBe("source");
    expect(classifyServerEntryArtifact("./src/register.mts")).toBe("source");
    expect(classifyServerEntryArtifact("./src/register.cts")).toBe("source");
  });
  it("classifies extensionless / unknown extensions as unresolved", () => {
    expect(classifyServerEntryArtifact("./register")).toBe("unresolved");
    expect(classifyServerEntryArtifact("./register.json")).toBe("unresolved");
    expect(classifyServerEntryArtifact("./register.wasm")).toBe("unresolved");
  });
});

describe("recordFromManifest", () => {
  it("parses a server-only extension manifest", () => {
    const rec = recordFromManifest(
      "/data/extensions/packages/x",
      manifest("@x/srv", {
        kind: "connector",
        serverEntry: "./register",
        requestedHostPorts: ["capabilities"],
        sdkAbiRange: "^2",
      }),
    );
    expect(rec).toMatchObject({
      packageName: "@x/srv",
      serverEntry: "./register",
      requestedHostPorts: ["capabilities"],
      sdkAbiRange: "^2",
      storeDir: "/data/extensions/packages/x",
    });
  });

  it("returns a record with serverEntry=null when none is declared", () => {
    const rec = recordFromManifest("/d/x", manifest("@x/data", { kind: "artifact" }));
    expect(rec?.serverEntry).toBeNull();
  });

  it("returns null for non-extension or invalid json", () => {
    expect(recordFromManifest("/d/x", manifest("@x/plain", null))).toBeNull();
    expect(recordFromManifest("/d/x", "{not json")).toBeNull();
    expect(recordFromManifest("/d/x", JSON.stringify({ cinatra: {} }))).toBeNull(); // no name
  });

  it("round-trips a schema-config connector's uiSurface + configSchema onto the runtime record", () => {
    const schema = { title: "T", fields: [{ kind: "secret", key: "apiKey", label: "API key" }] };
    const rec = recordFromManifest(
      "/data/extensions/packages/sc",
      manifest("@x/schema-config", {
        kind: "connector",
        serverEntry: "./register",
        requestedHostPorts: ["ui", "secrets"],
        uiSurface: "schema-config",
        configSchema: schema,
      }),
    );
    // The MARKETPLACE-INSTALLED schema-config connector's setup surface must
    // survive discovery so the dispatch route can branch on it without a rebuild.
    expect(rec?.uiSurface).toBe("schema-config");
    expect(rec?.configSchema).toEqual(schema);
  });

  it("omits configSchema/uiSurface from a record that declares neither (parity with the static null)", () => {
    const rec = recordFromManifest(
      "/d/none",
      manifest("@x/none", { kind: "connector", serverEntry: "./register" }),
    );
    expect(rec?.uiSurface).toBeUndefined();
    expect(rec?.configSchema).toBeUndefined();
  });

  it("ignores a non-object configSchema (e.g. an array) — fail-closed to undefined", () => {
    const rec = recordFromManifest(
      "/d/bad",
      manifest("@x/bad", { kind: "connector", uiSurface: "schema-config", configSchema: [1, 2] }),
    );
    expect(rec?.configSchema).toBeUndefined();
  });

  it("carries cinatra.migrationsDir (#118) and counts it as a host-migration declaration", () => {
    const rec = recordFromManifest(
      "/d/mig",
      manifest("@x/mig", { kind: "connector", serverEntry: "./register", migrationsDir: "cinatra/migrations" }),
    );
    expect(rec?.migrationsDir).toBe("cinatra/migrations");
    expect(rec?.legacyMigrationsDeclared).toBeUndefined();
    expect(recordDeclaresHostMigrations(rec!)).toBe(true);
  });

  it("flags the RETIRED legacy cinatra.migrations field in ANY form (incl. malformed) — it must never vanish into 'no migrations'", () => {
    for (const legacy of [
      [{ id: "0001", path: "m/0001.json" }], // well-formed legacy
      [], // empty array
      "m", // wrong type
      null, // null
    ]) {
      const rec = recordFromManifest(
        "/d/legacy",
        manifest("@x/legacy", { kind: "connector", migrations: legacy }),
      );
      expect(rec?.legacyMigrationsDeclared, JSON.stringify(legacy)).toBe(true);
      expect(recordDeclaresHostMigrations(rec!), JSON.stringify(legacy)).toBe(true);
    }
  });

  it("treats a record declaring neither field as no host migrations", () => {
    const rec = recordFromManifest("/d/none2", manifest("@x/none2", { kind: "connector" }));
    expect(rec?.migrationsDir).toBeUndefined();
    expect(rec?.legacyMigrationsDeclared).toBeUndefined();
    expect(recordDeclaresHostMigrations(rec!)).toBe(false);
  });

  it("a PRESENT-but-malformed migrationsDir still COUNTS as a declaration (fail-closed downstream, never silent 'no migrations')", () => {
    for (const bad of ["  ", 7, null, ["a"]]) {
      const rec = recordFromManifest(
        "/d/badmig",
        manifest("@x/badmig", { kind: "connector", migrationsDir: bad }),
      );
      expect(rec?.migrationsDir, JSON.stringify(bad)).toBeUndefined();
      expect(rec?.invalidMigrationsDirDeclared, JSON.stringify(bad)).toBe(true);
      expect(recordDeclaresHostMigrations(rec!), JSON.stringify(bad)).toBe(true);
    }
  });

  it("carries serverEntryRel when serverEntry is an exports-map KEY (string + conditional forms)", () => {
    const str = recordFromManifest(
      "/d/exp",
      manifest("@x/exp", { kind: "connector", serverEntry: "./register" }, {
        exports: { ".": "./index.mjs", "./register": "./dist/register.mjs" },
      }),
    );
    expect(str?.serverEntry).toBe("./register");
    expect(str?.serverEntryRel).toBe("./dist/register.mjs");

    const cond = recordFromManifest(
      "/d/expcond",
      manifest("@x/expcond", { kind: "connector", serverEntry: "./register" }, {
        exports: { "./register": { import: "./dist/register.mjs", require: "./dist/register.cjs" } },
      }),
    );
    expect(cond?.serverEntryRel).toBe("./dist/register.mjs");
  });

  it("flags a DECLARED exports key with an out-of-contract target (invalidExportsTargetDeclared) instead of falling back to the literal", () => {
    const rec = recordFromManifest(
      "/d/badtarget",
      manifest("@x/badtarget", { kind: "connector", serverEntry: "./register.mjs" }, {
        exports: { "./register.mjs": "/abs/evil.mjs" },
      }),
    );
    expect(rec?.serverEntryRel).toBeUndefined();
    expect(rec?.invalidExportsTargetDeclared).toBe(true);
  });

  it("omits serverEntryRel when there is no exports map, no key hit, or no serverEntry (literal fallback)", () => {
    const noMap = recordFromManifest("/d/nomap", manifest("@x/nomap", { serverEntry: "./register.mjs" }));
    expect(noMap?.serverEntryRel).toBeUndefined();
    const noKey = recordFromManifest(
      "/d/nokey",
      manifest("@x/nokey", { serverEntry: "./register.mjs" }, { exports: { ".": "./index.mjs" } }),
    );
    expect(noKey?.serverEntryRel).toBeUndefined();
    const noEntry = recordFromManifest("/d/noentry", manifest("@x/noentry", { kind: "artifact" }, { exports: { ".": "./i.mjs" } }));
    expect(noEntry?.serverEntryRel).toBeUndefined();
  });
});

describe("resolveServerEntryPath", () => {
  it("resolves a literal ./register.mjs against the store dir", () => {
    const rec = {
      packageName: "@x/srv",
      serverEntry: "./register.mjs",
      storeDir: "/data/extensions/packages/x",
    } as PackageStoreRecord;
    expect(resolveServerEntryPath(rec)).toBe("/data/extensions/packages/x/register.mjs");
  });
  it("prefers the exports-map resolution (serverEntryRel) over the literal serverEntry", () => {
    const rec = {
      packageName: "@x/srv",
      serverEntry: "./register",
      serverEntryRel: "./dist/register.mjs",
      storeDir: "/data/extensions/packages/x",
    } as PackageStoreRecord;
    expect(resolveServerEntryPath(rec)).toBe("/data/extensions/packages/x/dist/register.mjs");
  });
  it("returns null when there is no serverEntry", () => {
    expect(resolveServerEntryPath({ serverEntry: null, storeDir: "/d" } as PackageStoreRecord)).toBeNull();
  });
  it("SAFETY: guards the RESULT of resolution — a hostile exports TARGET is unsafe even when the declared key looks benign", () => {
    for (const hostile of ["../../evil.mjs", "/abs/evil.mjs"]) {
      const rec = {
        packageName: "@x/evil",
        serverEntry: "./register",
        serverEntryRel: hostile,
        storeDir: "/store/evil",
      } as PackageStoreRecord;
      expect(resolveServerEntryPath(rec), hostile).toBeNull();
    }
  });
});

// Parity note (cinatra#161): the host materializer imports the SAME
// resolveExportsSubpath this suite pins (one shared resolver — drift between
// the install-time scanner and this loader is impossible by construction).
// The cross-scanner agreement over real materialized fixtures is proven in
// src/lib/__tests__/runtime-package-loader-parity.test.ts.
describe("recordFromManifest × resolveServerEntryPath (exports-aware end-to-end)", () => {
  it("the REAL first-party shape — serverEntry './register' as an exports KEY over a built target — resolves to the built file", () => {
    const rec = recordFromManifest(
      "/store/fp",
      manifest("@x/first-party", { kind: "connector", serverEntry: "./register", sdkAbiRange: "^2" }, {
        exports: { ".": "./dist/index.mjs", "./register": "./dist/register.mjs" },
      }),
    );
    expect(rec?.serverEntryRel).toBe("./dist/register.mjs");
    expect(resolveServerEntryPath(rec!)).toBe("/store/fp/dist/register.mjs");
  });
});

describe("discoverPackageStoreRecords", () => {
  it("returns [] when the store root is absent (clean no-op, no /data volume)", async () => {
    const fs = makeFs({}, []);
    expect(await discoverPackageStoreRecords("/data/extensions/packages", fs)).toEqual([]);
  });

  it("discovers a FLAT layout (<root>/<pkg>/package.json)", async () => {
    const root = "/store";
    const fs = makeFs(
      { [`${root}/alpha/package.json`]: manifest("@x/alpha", { serverEntry: "./register" }) },
      [root, `${root}/alpha`],
    );
    const recs = await discoverPackageStoreRecords(root, fs);
    expect(recs.map((r) => r.packageName)).toEqual(["@x/alpha"]);
    expect(recs[0].storeDir).toBe(`${root}/alpha`);
  });

  it("discovers a DIGEST-PINNED layout (<root>/<pkg>/<digest>/package.json)", async () => {
    const root = "/store";
    const fs = makeFs(
      { [`${root}/beta/sha-abc/package.json`]: manifest("@x/beta", { serverEntry: "./register" }) },
      [root, `${root}/beta`, `${root}/beta/sha-abc`],
    );
    const recs = await discoverPackageStoreRecords(root, fs);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      packageName: "@x/beta",
      storeDir: `${root}/beta/sha-abc`,
      declaredDigest: "sha-abc",
    });
  });
});

// --- the activation proof -----------------------------------------------------
describe("runRuntimePackageActivation (PNP proof: store -> activate via shared driver)", () => {
  const fakeCtx = { __ctx: true } as never;
  const makeContext = vi.fn(() => fakeCtx);

  function serverModule(onRegister: (ctx: unknown) => void) {
    return { register: (ctx: unknown) => onRegister(ctx) };
  }

  it("materialized server-only package is imported + registered WITHOUT a rebuild", async () => {
    const registered: string[] = [];
    const records: PackageStoreRecord[] = [
      { packageName: "@x/srv", serverEntry: "./register.mjs", requestedHostPorts: ["capabilities"], sdkAbiRange: "^2", storeDir: "/store/srv" },
    ];
    const importModule = vi.fn(async (abs: string) => {
      expect(abs).toBe("/store/srv/register.mjs");
      return serverModule(() => registered.push("@x/srv"));
    });
    const res = await runRuntimePackageActivation("/store", {
      fs: makeFs({}, []),
      importModule,
      makeContext,
      records,
    });
    expect(res.some((r) => r.packageName === "@x/srv" && r.status === "registered")).toBe(true);
    expect(registered).toEqual(["@x/srv"]);
    expect(makeContext).toHaveBeenCalledWith("@x/srv", ["capabilities"]);
  });

  it("skips a package with no serverEntry, and ABI-refuses an incompatible range BEFORE import", async () => {
    const importModule = vi.fn(async () => serverModule(() => {}));
    const records: PackageStoreRecord[] = [
      { packageName: "@x/data", serverEntry: null, storeDir: "/store/data" },
      { packageName: "@x/future", serverEntry: "./register.mjs", sdkAbiRange: ">=99", storeDir: "/store/future" },
      // With the host ABI now 2.0.0, an extension pinned to the stale "^1"
      // (i.e. >=1 <2) is ABI-refused — host above the ^1 ceiling.
      { packageName: "@x/legacy", serverEntry: "./register.mjs", sdkAbiRange: "^1", storeDir: "/store/legacy" },
    ];
    const res = await runRuntimePackageActivation("/store", { fs: makeFs({}, []), importModule, makeContext, records });
    // @x/data declares no serverEntry -> filtered out entirely (no result row).
    expect(res.some((r) => r.packageName === "@x/data")).toBe(false);
    // @x/future is ABI-refused BEFORE any import.
    expect(res.find((r) => r.packageName === "@x/future")).toMatchObject({
      status: "skipped",
      reason: "abi-incompatible",
    });
    // @x/legacy (^1) is also ABI-refused now that the host ABI is 2.0.0.
    expect(res.find((r) => r.packageName === "@x/legacy")).toMatchObject({
      status: "skipped",
      reason: "abi-incompatible",
    });
    expect(importModule).not.toHaveBeenCalled(); // none imported
  });

  it("refuses activation when the integrity gate fails (no code imported)", async () => {
    const importModule = vi.fn(async () => serverModule(() => {}));
    const records: PackageStoreRecord[] = [
      { packageName: "@x/tampered", serverEntry: "./register.mjs", sdkAbiRange: "^2", storeDir: "/store/tampered" },
    ];
    const res = await runRuntimePackageActivation("/store", {
      fs: makeFs({}, []),
      importModule,
      makeContext,
      records,
      verifyIntegrity: async () => false,
    });
    const r = res.find((x) => x.packageName === "@x/tampered");
    // importServerEntry throws on integrity failure -> the driver records "failed".
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/integrity check failed/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("end-to-end through real discovery: drop a package in the store, it activates", async () => {
    const root = "/data/extensions/packages";
    const fs = makeFs(
      { [`${root}/srv/package.json`]: manifest("@x/dropped", { serverEntry: "./register.mjs", sdkAbiRange: "^2" }) },
      [root, `${root}/srv`],
    );
    const registered: string[] = [];
    const res = await runRuntimePackageActivation(root, {
      fs,
      importModule: async () => serverModule(() => registered.push("@x/dropped")),
      makeContext,
      verifyIntegrity: async () => true,
    });
    expect(res.some((r) => r.packageName === "@x/dropped" && r.status === "registered")).toBe(true);
    expect(registered).toEqual(["@x/dropped"]);
  });

  it("FAIL-CLOSED: refuses every record for a duplicated package name (ambiguous identity)", async () => {
    const importModule = vi.fn(async () => serverModule(() => {}));
    const records: PackageStoreRecord[] = [
      { packageName: "@x/dup", serverEntry: "./register.mjs", sdkAbiRange: "^2", storeDir: "/store/dup/sha-a" },
      { packageName: "@x/dup", serverEntry: "./register.mjs", sdkAbiRange: "^2", storeDir: "/store/dup/sha-b" },
      { packageName: "@x/ok", serverEntry: "./register.mjs", sdkAbiRange: "^2", storeDir: "/store/ok" },
    ];
    const res = await runRuntimePackageActivation("/store", { fs: makeFs({}, []), importModule, makeContext, records });
    const dup = res.find((r) => r.packageName === "@x/dup");
    expect(dup?.status).toBe("failed");
    expect(String(dup?.error)).toMatch(/ambiguous package/);
    // The ambiguous package is never imported (only the unique @x/ok is).
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(res.some((r) => r.packageName === "@x/ok" && r.status === "registered")).toBe(true);
  });

  it("refuses a serverEntry that escapes the package dir (path traversal), without importing", async () => {
    const importModule = vi.fn(async () => serverModule(() => {}));
    const records: PackageStoreRecord[] = [
      { packageName: "@x/evil", serverEntry: "../../etc/register", sdkAbiRange: "^2", storeDir: "/store/evil" },
    ];
    const res = await runRuntimePackageActivation("/store", { fs: makeFs({}, []), importModule, makeContext, records });
    const r = res.find((x) => x.packageName === "@x/evil");
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/unsafe serverEntry/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("SAFETY: refuses a HOSTILE exports TARGET (key benign, target escapes) — relative and absolute forms, without importing", async () => {
    // `exports["./register"]: "../../x.mjs"` — a check the literal-only resolver
    // never needed: the abs/`..` guard must apply to the RESULT of exports
    // resolution. Discovery carries the hostile target via serverEntryRel.
    const importModule = vi.fn(async () => serverModule(() => {}));
    for (const hostile of ["../../escape/evil.mjs", "/abs/evil.mjs"]) {
      const records: PackageStoreRecord[] = [
        {
          packageName: "@x/hostile-exports",
          serverEntry: "./register",
          serverEntryRel: hostile,
          sdkAbiRange: "^2",
          storeDir: "/store/hostile",
        },
      ];
      const res = await runRuntimePackageActivation("/store", { fs: makeFs({}, []), importModule, makeContext, records });
      const r = res.find((x) => x.packageName === "@x/hostile-exports");
      expect(r?.status, hostile).toBe("failed");
      expect(String(r?.error), hostile).toMatch(/unsafe serverEntry/);
    }
    expect(importModule).not.toHaveBeenCalled();
  });

  it("FAIL-LOUD classification: a TS-source entry records an ACTIONABLE failed activation (legacy-store defense), not an opaque import error", async () => {
    // Simulates a store dir written by an OLDER installer (the new materializer
    // refuses this shape at install time): the entry resolves through exports to
    // TypeScript source. The loader must refuse BEFORE integrity/import with the
    // built-artifacts-only message.
    const importModule = vi.fn(async () => serverModule(() => {}));
    const verifyIntegrity = vi.fn(async () => true);
    const root = "/data/extensions/packages";
    const fs = makeFs(
      {
        [`${root}/legacy/package.json`]: JSON.stringify({
          name: "@x/legacy-source",
          exports: { "./register": "./src/register.ts" },
          cinatra: { kind: "connector", serverEntry: "./register", sdkAbiRange: "^2" },
        }),
      },
      [root, `${root}/legacy`],
    );
    const res = await runRuntimePackageActivation(root, { fs, importModule, makeContext, verifyIntegrity });
    const r = res.find((x) => x.packageName === "@x/legacy-source");
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/BUILT artifacts only/);
    expect(String(r?.error)).toMatch(/TypeScript source/);
    expect(String(r?.error)).toContain('"./src/register.ts"');
    expect(String(r?.error)).toMatch(/reinstall the package from the marketplace/);
    // classification fires BEFORE the integrity gate and BEFORE any import.
    expect(verifyIntegrity).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it("FAIL-LOUD: a DECLARED exports key with an out-of-contract target NEVER falls back to the literal path (codex AB-r0 finding 1)", async () => {
    // serverEntry "./register.mjs" looks like a fine literal AND the file could
    // exist — but the manifest DECLARES exports["./register.mjs"] with a hostile
    // non-./ target. Falling back to the literal would be fail-open; the loader
    // must refuse with the actionable message instead.
    const importModule = vi.fn(async () => serverModule(() => {}));
    const root = "/data/extensions/packages";
    const fs = makeFs(
      {
        [`${root}/badtarget/package.json`]: JSON.stringify({
          name: "@x/bad-exports-target",
          exports: { "./register.mjs": "/abs/evil.mjs" },
          cinatra: { kind: "connector", serverEntry: "./register.mjs", sdkAbiRange: "^2" },
        }),
      },
      [root, `${root}/badtarget`],
    );
    const res = await runRuntimePackageActivation(root, { fs, importModule, makeContext, verifyIntegrity: async () => true });
    const r = res.find((x) => x.packageName === "@x/bad-exports-target");
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/outside the supported exports forms/);
    expect(String(r?.error)).toMatch(/BUILT artifacts only/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("FAIL-LOUD classification: an EXTENSIONLESS resolution (today's first-party source-mirror shape) is refused with the actionable message", async () => {
    // `serverEntry: "./register"` with NO exports key (the drupal-mcp /
    // wordpress-mcp shape) — the literal fallback is extensionless, which under
    // the contract is `unresolved`, never an ENOENT at import time.
    const importModule = vi.fn(async () => serverModule(() => {}));
    const records: PackageStoreRecord[] = [
      { packageName: "@x/extensionless", serverEntry: "./register", sdkAbiRange: "^2", storeDir: "/store/el" },
    ];
    const res = await runRuntimePackageActivation("/store", { fs: makeFs({}, []), importModule, makeContext, records });
    const r = res.find((x) => x.packageName === "@x/extensionless");
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/BUILT artifacts only/);
    expect(String(r?.error)).toMatch(/not a concrete importable file/);
    expect(importModule).not.toHaveBeenCalled();
  });
});
