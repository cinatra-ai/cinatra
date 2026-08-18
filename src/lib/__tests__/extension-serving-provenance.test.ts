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
  __resetServingRecords,
  clearServingRecordForPackage,
  readServingRecord,
  recordServingImplementation,
} from "@/lib/extension-capabilities-registry";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

beforeEach(() => {
  __resetServingRecords();
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
    expect(readServingRecord("")).toBeNull();
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

  it("the module-wide reset clears it too, so no state bleeds between tests", async () => {
    const { __resetCapabilityRegistry } = await import(
      "@/lib/extension-capabilities-registry"
    );
    recordServingImplementation({ packageName: PKG, origin: "install", version: "0.1.5" });
    __resetCapabilityRegistry();
    expect(readServingRecord(PKG)).toBeNull();
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
    expect(src).toContain(
      'import { recordServingImplementation } from "@/lib/extension-capabilities-registry"',
    );
    expect(src).toContain("recordBundledActivations(records, results)");
    expect(src).toMatch(/origin:\s*"bundled"/);
  });

  it("it COSTS NO NEW MODULE — it is co-located, never a standalone file", async () => {
    // The route-graph ratchet (cinatra#732) baselines four locked routes and its
    // ceilings may only ever SHRINK. A standalone `extension-serving-record`
    // module added exactly +1 reachable module to all four, because the analyzer
    // follows a literal `import("…")` too — a dynamic import buys nothing here.
    // It lives with the signed-activated markers instead, whose own comment
    // records the same reason.
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    expect(existsSync(path.resolve(__dirname, "../extension-serving-record.ts"))).toBe(false);
    const registry = await read("../extension-capabilities-registry.ts");
    expect(registry).toContain("export function recordServingImplementation");
    expect(registry).toContain("export function readServingRecord");
    expect(registry).toContain("export function clearServingRecordForPackage");
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

  it("the RuntimePackageLoader records the version of the record that REGISTERED", async () => {
    // Round-5 convergence. This used to be a name-keyed pre-pass lookup over
    // `orderedActivatable`, last-write-wins — so with more than one DEFAULT
    // record for a package (the permitted ownership scopes can produce that)
    // the reported version was whichever default came last in discovery order,
    // not the one whose registration succeeded. The version is now read off the
    // settled record at the per-record settle hook, which is the only place
    // record identity and register outcome are both in hand.
    const src = await read("../runtime-package-loader.ts");
    expect(src).toContain("recordServingImplementation,");
    expect(src).toMatch(/origin:\s*"install"/);
    // Captured AT the settle hook, from that record.
    expect(src).toMatch(
      /onRegisterSettled:\s*\(record,\s*registered\)\s*=>\s*\{[\s\S]*?servingVersionByPackage\.set\(\s*record\.packageName,\s*record\.version \?\? null,?\s*\)/,
    );
    // DEFAULTS only — the version that owns the package's unversioned global
    // names, which is what a request reaches.
    expect(src).toMatch(/registered && record\.isDefault !== false/);
    // …and the pre-pass side lookup is GONE, not merely unused.
    expect(src).not.toContain("defaultVersionByPackage");
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

  // -------------------------------------------------------------------------
  // WHAT THE NEXT TWO TESTS CAN AND CANNOT PROVE (round-5 convergence).
  //
  // They are a SOURCE SCAN. A scan proves that no first-party file under the
  // scanned roots textually names a way to reach the record — which covers a
  // plain import, a `const { readServingRecord } = await import(...)`, and an
  // ALIASED import (`readServingRecord as x`), because the alias form still
  // contains the accessor's own name at the import site.
  //
  // It CANNOT prove there is no reflective read: the record lives behind a
  // `Symbol.for(...)` global, so `globalThis[Symbol.for("…")]` reaches it
  // without naming any accessor. That is why the SYMBOL STRING is scanned for
  // too, and why the first test below keeps the export surface to a single
  // accessor — the fewer named doors there are, the more of the surface the
  // scan actually covers. Nor can it prove anything about the compiled output,
  // a dynamic `import(variable)`, or a consumer outside these roots.
  // -------------------------------------------------------------------------

  /** Every named way to reach the serving record, plus the singleton key
   *  itself. A new accessor MUST be added here — that is the point. */
  const SERVING_RECORD_DOORS = [
    "readServingRecord",
    "recordServingImplementation",
    "clearServingRecordForPackage",
    "@cinatra-ai/host:extension-serving-record",
  ];

  const walkFirstPartySources = async (
    visit: (abs: string, src: string) => void,
  ): Promise<void> => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const roots = [
      path.resolve(__dirname, "../.."),
      path.resolve(__dirname, "../../../packages/extensions/src"),
    ];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
        const abs = path.join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (/\.tsx?$/.test(abs) && !abs.endsWith("extension-capabilities-registry.ts")) {
          visit(abs, readFileSync(abs, "utf8"));
        }
      }
    };
    for (const root of roots) walk(root);
  };

  it("the record has exactly ONE read accessor, so the scan below covers the read side", async () => {
    // The enforcement is a source scan over named accessors, so a SECOND
    // exported accessor is a second door the scan must know about. There was
    // one — `snapshotServingRecords`, exported and imported by nothing but its
    // own test — and it is gone rather than merely added to the scanned set:
    // an export nobody needs is surface, not diagnostics.
    const registry = await read("../extension-capabilities-registry.ts");
    const exportedAccessors = [
      ...registry.matchAll(/export function (\w+)\(/g),
    ]
      .map((m) => m[1])
      .filter((name) => /Serving/i.test(name));
    expect(exportedAccessors.sort()).toEqual([
      "__resetServingRecords",
      "clearServingRecordForPackage",
      "readServingRecord",
      "recordServingImplementation",
    ]);
  });

  it("nothing GATES on the record — it is descriptive only", async () => {
    // A load-bearing read would make a descriptive, best-effort, process-local
    // signal into a control-flow input, and a missing record (a fresh process, a
    // metadata-only package) would then change behaviour rather than copy.
    //
    // Scanned over EVERY door (see the note above), not just `readServingRecord`
    // — the previous version scanned that one literal, so a second accessor or a
    // reflective read through the singleton key escaped it entirely.
    const path = await import("node:path");
    const touchers = new Map<string, string[]>();
    await walkFirstPartySources((abs, src) => {
      const hit = SERVING_RECORD_DOORS.filter((door) => src.includes(door));
      if (hit.length > 0) touchers.set(path.basename(abs), hit.sort());
    });
    // The WRITE side is the two activation seams and the teardown chokepoint;
    // the READ side is exactly one file: the settings loader, which turns the
    // record into copy.
    expect(Object.fromEntries([...touchers].sort())).toEqual({
      "extension-capability-teardown.ts": ["clearServingRecordForPackage"],
      "extension-settings-screen.tsx": ["readServingRecord"],
      "runtime-package-loader.ts": ["recordServingImplementation"],
      "static-bundle-loader.ts": ["recordServingImplementation"],
    });
  });
});
