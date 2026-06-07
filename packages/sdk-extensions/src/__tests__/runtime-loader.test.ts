import { describe, it, expect, vi } from "vitest";
import {
  discoverPackageStoreRecords,
  recordFromManifest,
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

function manifest(name: string, cinatra: Record<string, unknown> | null): string {
  return JSON.stringify(cinatra ? { name, cinatra } : { name });
}

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
});

describe("resolveServerEntryPath", () => {
  it("resolves ./register against the store dir", () => {
    const rec = {
      packageName: "@x/srv",
      serverEntry: "./register",
      storeDir: "/data/extensions/packages/x",
    } as PackageStoreRecord;
    expect(resolveServerEntryPath(rec)).toBe("/data/extensions/packages/x/register");
  });
  it("returns null when there is no serverEntry", () => {
    expect(resolveServerEntryPath({ serverEntry: null, storeDir: "/d" } as PackageStoreRecord)).toBeNull();
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
      { packageName: "@x/srv", serverEntry: "./register", requestedHostPorts: ["capabilities"], sdkAbiRange: "^2", storeDir: "/store/srv" },
    ];
    const importModule = vi.fn(async (abs: string) => {
      expect(abs).toBe("/store/srv/register");
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
      { packageName: "@x/future", serverEntry: "./register", sdkAbiRange: ">=99", storeDir: "/store/future" },
      // With the host ABI now 2.0.0, an extension pinned to the stale "^1"
      // (i.e. >=1 <2) is ABI-refused — host above the ^1 ceiling.
      { packageName: "@x/legacy", serverEntry: "./register", sdkAbiRange: "^1", storeDir: "/store/legacy" },
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
      { packageName: "@x/tampered", serverEntry: "./register", sdkAbiRange: "^2", storeDir: "/store/tampered" },
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
      { [`${root}/srv/package.json`]: manifest("@x/dropped", { serverEntry: "./register", sdkAbiRange: "^2" }) },
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
      { packageName: "@x/dup", serverEntry: "./register", sdkAbiRange: "^2", storeDir: "/store/dup/sha-a" },
      { packageName: "@x/dup", serverEntry: "./register", sdkAbiRange: "^2", storeDir: "/store/dup/sha-b" },
      { packageName: "@x/ok", serverEntry: "./register", sdkAbiRange: "^2", storeDir: "/store/ok" },
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
});
