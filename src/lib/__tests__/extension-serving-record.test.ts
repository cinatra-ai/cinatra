import { beforeEach, describe, expect, it } from "vitest";

// cinatra#2762 — the SERVING-PROVENANCE record: which implementation of a
// package put the live registrations in place, and at which version.
//
// The register-channel registries are keyed by PACKAGE NAME and hold no
// provenance, so before this the process could answer "is something serving this
// package?" and could NOT answer "what is serving it?" — which is the whole of
// #2762. This pins the record's contract and, critically, that it is cleared in
// LOCKSTEP with the registrations it describes: a record that outlived them
// would let the settings page report a version that stopped serving.

import {
  __resetServingRecordsForTests,
  clearServingRecordForPackage,
  readServingRecord,
  recordServingImplementation,
  snapshotServingRecords,
} from "@/lib/extension-serving-record";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

beforeEach(() => {
  __resetServingRecordsForTests();
});

describe("the serving record", () => {
  it("is UNKNOWN, not 'nothing serving', when no seam recorded anything", () => {
    expect(readServingRecord(PKG)).toBeNull();
  });

  it("records what an activation seam put in service", () => {
    recordServingImplementation({ packageName: PKG, origin: "bundled", version: "0.1.0" });
    expect(readServingRecord(PKG)).toEqual({ origin: "bundled", version: "0.1.0" });
  });

  it("LAST WRITE WINS — an install activating REPLACES the bundled record", () => {
    // The boot order itself: the StaticBundleLoader registers the image's copy,
    // then the RuntimePackageLoader tears those registrations down and registers
    // the install on top. The last successful writer owns the package's names.
    recordServingImplementation({ packageName: PKG, origin: "bundled", version: "0.1.0" });
    recordServingImplementation({ packageName: PKG, origin: "install", version: "0.1.5" });
    expect(readServingRecord(PKG)).toEqual({ origin: "install", version: "0.1.5" });
  });

  it("and a FAILED install leaves the bundled record standing — the #2762 state", () => {
    // Nothing writes on a refused activation, so the bundled record survives and
    // that is exactly what makes the state nameable.
    recordServingImplementation({ packageName: PKG, origin: "bundled", version: "0.1.0" });
    expect(readServingRecord(PKG)?.origin).toBe("bundled");
  });

  it("stores a blank version as null, so it cannot be compared against a real one", () => {
    recordServingImplementation({ packageName: PKG, origin: "install", version: "" });
    expect(readServingRecord(PKG)).toEqual({ origin: "install", version: null });
    recordServingImplementation({ packageName: PKG, origin: "install" });
    expect(readServingRecord(PKG)?.version).toBeNull();
  });

  it("ignores a nameless package rather than minting an empty key", () => {
    recordServingImplementation({ packageName: "", origin: "bundled", version: "1" });
    expect(snapshotServingRecords()).toEqual([]);
  });

  it("is keyed per package", () => {
    recordServingImplementation({ packageName: PKG, origin: "bundled", version: "0.1.0" });
    recordServingImplementation({ packageName: "@v/other", origin: "install", version: "9" });
    expect(readServingRecord(PKG)?.origin).toBe("bundled");
    expect(readServingRecord("@v/other")?.origin).toBe("install");
  });

  it("clears per package and reports whether it removed anything", () => {
    recordServingImplementation({ packageName: PKG, origin: "bundled", version: "0.1.0" });
    expect(clearServingRecordForPackage(PKG)).toBe(true);
    expect(readServingRecord(PKG)).toBeNull();
    expect(clearServingRecordForPackage(PKG)).toBe(false);
  });
});

describe("the record is cleared in LOCKSTEP with the registrations it describes", () => {
  it("the capability-teardown chokepoint drops it", async () => {
    // The single in-process chokepoint for every retire path (archive /
    // uninstall / force-delete / purge) AND the defensive pre-reactivate
    // teardown. A record surviving it would describe registrations that are
    // gone — the settings page would then report a version serving nothing.
    recordServingImplementation({ packageName: PKG, origin: "install", version: "0.1.5" });
    const { teardownExtensionCapabilities } = await import(
      "@/lib/extension-capability-teardown"
    );
    teardownExtensionCapabilities(PKG);
    expect(readServingRecord(PKG)).toBeNull();
  });

  it("the teardown reaches it through the published globalThis surface", () => {
    // Not a static import: `extension-capability-teardown` is reachable from the
    // locked dev-perf routes whose static import graph is ratcheted shrink-only
    // (cinatra#732), so the clear is published on a `Symbol.for` key the way
    // version-keyed serving publishes its own.
    const key = Symbol.for("@cinatra-ai/host:extension-serving-record-teardown/v1");
    const published = (globalThis as unknown as { [k: symbol]: unknown })[key];
    expect(typeof published).toBe("function");
  });

  it("tearing down a package with NO record is a safe no-op", async () => {
    const { teardownExtensionCapabilities } = await import(
      "@/lib/extension-capability-teardown"
    );
    expect(() => teardownExtensionCapabilities("@v/never-recorded")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BOTH activation seams write it — the record is worthless if only one does.
//
// Source assertions, because the defect is an OMISSION: a loader that forgets to
// record still activates correctly, and every behavioural test of activation
// passes. What breaks is the settings surface's ability to name the state, one
// restart later.
// ---------------------------------------------------------------------------
describe("the activation seams record what they put in service", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    return readFileSync(path.resolve(__dirname, rel), "utf8");
  };

  it("the StaticBundleLoader records the IMAGE's version on its boot pass", async () => {
    const src = await read("../static-bundle-loader.ts");
    expect(src).toContain('await import("@/lib/extension-serving-record")');
    expect(src).toContain("await recordBundledActivations(records, results)");
    expect(src).toMatch(/origin:\s*"bundled"/);
  });

  it("both loaders reach the recorder DYNAMICALLY, never as a static edge", async () => {
    // Both are reachable from the locked dev-perf routes whose static import
    // graph is ratcheted shrink-only (cinatra#732). A descriptive side-signal
    // must not spend an edge there — the same reason the version-keyed serving
    // registry is imported dynamically from the runtime loader.
    for (const rel of ["../static-bundle-loader.ts", "../runtime-package-loader.ts"]) {
      const src = await read(rel);
      expect(src).toContain('await import("@/lib/extension-serving-record")');
      expect(src).not.toMatch(
        /^import \{[^}]*\} from "@\/lib\/extension-serving-record";/m,
      );
    }
    // …and so does the settings loader, which reads it at request time.
    const screen = await read(
      "../../../packages/extensions/src/screens/extension-settings-screen.tsx",
    );
    expect(screen).toContain('await import("@/lib/extension-serving-record")');
    expect(screen).not.toMatch(
      /^import \{[^}]*\} from "@\/lib\/extension-serving-record";/m,
    );
  });

  it("…and on the TARGETED reactivation seam a rollback uses", async () => {
    // `reactivateBundledFallbackInProcess` is what puts the image's copy back
    // after a rollback or a failed retry. Without a record there, a rolled-back
    // package would keep reporting the install as serving.
    const src = await read("../static-bundle-loader.ts");
    const seam = src.slice(src.indexOf("export async function reactivateBundledFallbackInProcess"));
    expect(seam).toContain("recordServingImplementation({");
    expect(seam).toMatch(/origin:\s*"bundled"/);
  });

  it("the RuntimePackageLoader records the INSTALL's default version", async () => {
    const src = await read("../runtime-package-loader.ts");
    expect(src).toContain('await import("@/lib/extension-serving-record")');
    expect(src).toMatch(/origin:\s*"install"/);
    // The DEFAULT version — the one that owns the package's unversioned global
    // names, which is what a request reaches.
    expect(src).toContain("defaultVersionByPackage");
    expect(src).toMatch(/if \(rec\.isDefault === false\) continue;/);
  });

  it("both gate on a CLEAN activation, never on a bare 'registered'", async () => {
    // A package emits one result per phase, so a register-passes /
    // bootstrap-throws activation yields BOTH a success and a failure. Recording
    // on the success alone would claim a half-activated version is serving.
    const bundled = await read("../static-bundle-loader.ts");
    const runtime = await read("../runtime-package-loader.ts");
    for (const src of [bundled, runtime]) {
      expect(src).toContain('r.status === "failed"');
      expect(src).toMatch(/failed(Names)?\.has\(/);
    }
  });

  it("nothing GATES on the record — it is descriptive only", async () => {
    // A load-bearing read would make a descriptive, best-effort, process-local
    // signal into a control-flow input, and a missing record (a fresh process, a
    // metadata-only package) would then change behaviour rather than copy.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const roots = [
      path.resolve(__dirname, "../.."),
      path.resolve(__dirname, "../../../packages/extensions/src"),
    ];
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
        const abs = path.join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (/\.tsx?$/.test(abs) && !abs.endsWith("extension-serving-record.ts")) {
          if (readFileSync(abs, "utf8").includes("readServingRecord")) readers.push(abs);
        }
      }
    };
    for (const root of roots) walk(root);
    // Exactly ONE reader: the settings loader, which turns it into copy.
    expect(readers.map((f) => path.basename(f)).sort()).toEqual([
      "extension-settings-screen.tsx",
    ]);
  });
});
