import { describe, it, expect } from "vitest";
import { runStaticBundleActivation, type LoaderRecord, type LoaderDeps } from "../loader";
import type { ExtensionHostContext } from "../host-context";

// cinatra#1392 Gap 1 — the driver's per-record settle hook. `onRegisterSettled`
// must fire ONCE for every record that reached `makeContext`, carrying the exact
// record + a `registered` boolean that is true ONLY on a successful register
// pass. It is what lets the host COMMIT a non-default side-by-side version's
// version-keyed serving on success and DISCARD it on any skip/failure.

const ctx = { abiVersion: "1.0.0", packageName: "x" } as unknown as ExtensionHostContext;

function deps(over: Partial<LoaderDeps> = {}): LoaderDeps {
  return {
    importServerEntry: () => Promise.resolve({ register: () => {} }),
    makeContext: () => ctx,
    abiCompatible: () => true,
    ...over,
  };
}
const rec = (packageName: string, over: Partial<LoaderRecord> = {}): LoaderRecord => ({
  packageName,
  serverEntry: "./register",
  ...over,
});

describe("runStaticBundleActivation — onRegisterSettled (cinatra#1392 Gap 1)", () => {
  it("fires registered=true after a successful register", async () => {
    const settled: Array<{ pkg: string; version?: string; registered: boolean }> = [];
    await runStaticBundleActivation(
      [rec("@x/a", { version: "1.0.0", isDefault: false })],
      deps({
        onRegisterSettled: (r, registered) =>
          settled.push({ pkg: r.packageName, version: r.version, registered }),
      }),
    );
    expect(settled).toEqual([{ pkg: "@x/a", version: "1.0.0", registered: true }]);
  });

  it("fires registered=false when register THROWS (partial/failed register is discarded)", async () => {
    const settled: Array<[string, boolean]> = [];
    const results = await runStaticBundleActivation(
      [rec("@x/bad", { version: "2.0.0", isDefault: false })],
      deps({
        importServerEntry: () =>
          Promise.resolve({
            register: () => {
              throw new Error("boom");
            },
          }),
        onRegisterSettled: (r, registered) => settled.push([r.packageName, registered]),
      }),
    );
    expect(settled).toEqual([["@x/bad", false]]);
    expect(results.find((r) => r.packageName === "@x/bad")?.status).toBe("failed");
  });

  it("fires registered=false on a config-disabled skip (post-makeContext skip still settles)", async () => {
    const settled: Array<[string, boolean]> = [];
    await runStaticBundleActivation(
      [rec("@x/off", { version: "3.0.0", isDefault: false })],
      deps({
        importServerEntry: () =>
          Promise.resolve({ register: () => {}, config: { enabled: false } }),
        onRegisterSettled: (r, registered) => settled.push([r.packageName, registered]),
      }),
    );
    expect(settled).toEqual([["@x/off", false]]);
  });

  it("does NOT fire for a record that never reached makeContext (no serverEntry)", async () => {
    const settled: string[] = [];
    await runStaticBundleActivation(
      [rec("@x/none", { serverEntry: null })],
      deps({ onRegisterSettled: (r) => settled.push(r.packageName) }),
    );
    expect(settled).toEqual([]);
  });

  it("fires once per record, carrying each record's own identity, across a mixed batch", async () => {
    const settled: Array<[string, string | undefined, boolean]> = [];
    await runStaticBundleActivation(
      [
        rec("@x/default", { version: "1.0.0", isDefault: true }),
        rec("@x/sibling", { version: "2.0.0", isDefault: false }),
      ],
      deps({
        onRegisterSettled: (r, registered) => settled.push([r.packageName, r.version, registered]),
      }),
    );
    expect(settled).toEqual([
      ["@x/default", "1.0.0", true],
      ["@x/sibling", "2.0.0", true],
    ]);
  });
});
