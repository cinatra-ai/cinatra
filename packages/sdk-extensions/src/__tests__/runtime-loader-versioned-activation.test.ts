import { describe, it, expect, vi } from "vitest";
import { runRuntimePackageActivation } from "../runtime-loader";
import type { PackageStoreRecord } from "../runtime-loader";

// cinatra#1040 S4 — VERSIONED activation identity. The runtime activation driver
// keys the duplicate fence on (packageName, version) instead of packageName, so
// SIDE-BY-SIDE versions of one package activate together; only a genuine identity
// collision (same name+version twice) or an un-versioned record fails closed. The
// DEFAULT version alone runs the bootstrap pass; a non-default sibling registers
// only (it activates against a side-effect-free host context wired by the host).

const fakeCtx = { __ctx: true } as never;
const makeContext = vi.fn(() => fakeCtx);

/** A server module that records register + bootstrap invocations by label. */
function serverModule(label: string, calls: string[]) {
  return {
    register: () => calls.push(`register:${label}`),
    bootstrap: () => calls.push(`bootstrap:${label}`),
  };
}

function rec(
  over: Partial<PackageStoreRecord> & { packageName: string; storeDir: string },
): PackageStoreRecord {
  return {
    serverEntry: "./register.mjs",
    requestedHostPorts: [],
    sdkAbiRange: "^2",
    ...over,
  } as PackageStoreRecord;
}

describe("runRuntimePackageActivation — (packageName, version) identity (cinatra#1040 S4)", () => {
  it("activates two SIDE-BY-SIDE versions of one package (the (name,version) fence does NOT refuse them)", async () => {
    const calls: string[] = [];
    const records: PackageStoreRecord[] = [
      rec({ packageName: "@x/dup", version: "0.1.4", isDefault: true, storeDir: "/store/x/v1" }),
      rec({ packageName: "@x/dup", version: "0.2.0", isDefault: false, storeDir: "/store/x/v2" }),
    ];
    const importModule = vi.fn(async (abs: string) =>
      serverModule(abs.includes("/v1/") ? "v1" : "v2", calls),
    );
    const res = await runRuntimePackageActivation("/store", {
      fs: {} as never,
      importModule,
      makeContext,
      records,
    });
    // Both versions registered — neither was fenced as an ambiguous name.
    expect(res.filter((r) => r.status === "registered").map((r) => r.packageName)).toEqual([
      "@x/dup",
      "@x/dup",
    ]);
    // Identity-aware import: each version imported from ITS OWN store dir.
    expect(importModule.mock.calls.map((c) => c[0])).toEqual([
      "/store/x/v1/register.mjs",
      "/store/x/v2/register.mjs",
    ]);
    expect(calls).toContain("register:v1");
    expect(calls).toContain("register:v2");
  });

  it("refuses a genuinely AMBIGUOUS identity — the SAME (name, version) twice — fail-closed (neither imported)", async () => {
    const records: PackageStoreRecord[] = [
      rec({ packageName: "@x/amb", version: "1.0.0", isDefault: true, storeDir: "/store/a/one" }),
      rec({ packageName: "@x/amb", version: "1.0.0", isDefault: true, storeDir: "/store/a/two" }),
    ];
    const importModule = vi.fn(async () => serverModule("x", []));
    const res = await runRuntimePackageActivation("/store", {
      fs: {} as never,
      importModule,
      makeContext,
      records,
    });
    expect(importModule).not.toHaveBeenCalled();
    expect(res).toEqual([
      { packageName: "@x/amb", status: "failed", error: expect.any(Error) },
    ]);
    expect((res[0] as { error: Error }).error.message).toContain("@x/amb@1.0.0");
  });

  it("fences the WHOLE package when ANY record carries no version — a legacy un-versioned record can't be disambiguated", async () => {
    const records: PackageStoreRecord[] = [
      rec({ packageName: "@x/legacy", version: "2.0.0", isDefault: false, storeDir: "/store/l/v2" }),
      rec({ packageName: "@x/legacy", storeDir: "/store/l/none" }), // no version
    ];
    const importModule = vi.fn(async () => serverModule("x", []));
    const res = await runRuntimePackageActivation("/store", {
      fs: {} as never,
      importModule,
      makeContext,
      records,
    });
    // The whole name is refused — NO version of it imports (fail-closed).
    expect(importModule).not.toHaveBeenCalled();
    expect(res).toEqual([
      { packageName: "@x/legacy", status: "failed", error: expect.any(Error) },
    ]);
    expect((res[0] as { error: Error }).error.message).toContain("no version identity");
  });

  it("runs bootstrap for the DEFAULT version ONLY — a non-default sibling registers but is not bootstrapped", async () => {
    const calls: string[] = [];
    const records: PackageStoreRecord[] = [
      rec({ packageName: "@x/svc", version: "2.0.0", isDefault: true, storeDir: "/store/s/def" }),
      rec({ packageName: "@x/svc", version: "1.0.0", isDefault: false, storeDir: "/store/s/old" }),
    ];
    const importModule = vi.fn(async (abs: string) =>
      serverModule(abs.includes("/def/") ? "default" : "sibling", calls),
    );
    await runRuntimePackageActivation("/store", {
      fs: {} as never,
      importModule,
      makeContext,
      records,
    });
    // Both register; only the default bootstraps.
    expect(calls).toContain("register:default");
    expect(calls).toContain("register:sibling");
    expect(calls).toContain("bootstrap:default");
    expect(calls).not.toContain("bootstrap:sibling");
  });

  it("still refuses the SAME (name, version) twice even when a THIRD distinct version is present (fence is per-identity)", async () => {
    const records: PackageStoreRecord[] = [
      rec({ packageName: "@x/mix", version: "1.0.0", isDefault: false, storeDir: "/store/m/a" }),
      rec({ packageName: "@x/mix", version: "1.0.0", isDefault: false, storeDir: "/store/m/b" }),
      rec({ packageName: "@x/mix", version: "2.0.0", isDefault: true, storeDir: "/store/m/c" }),
    ];
    const importModule = vi.fn(async (abs: string) => serverModule(abs, []));
    const res = await runRuntimePackageActivation("/store", {
      fs: {} as never,
      importModule,
      makeContext,
      records,
    });
    // The ambiguous 1.0.0 identity is refused; the distinct 2.0.0 default activates.
    expect(res.find((r) => r.status === "failed")).toMatchObject({ packageName: "@x/mix" });
    expect(importModule.mock.calls.map((c) => c[0])).toEqual(["/store/m/c/register.mjs"]);
    expect(res.some((r) => r.status === "registered")).toBe(true);
  });
});
