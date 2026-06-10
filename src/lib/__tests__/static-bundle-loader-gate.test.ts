import { describe, it, expect, vi, beforeEach } from "vitest";
import { gateStaticRecordsToLiveRows } from "@/lib/static-bundle-loader";

// Split-brain guard — the StaticBundleLoader lifecycle gate, a STRICT
// active|locked allow-list (the static-bundle lifecycle-correctness contract,
// IOC-34/IOC-35). A serverEntry record activates ONLY when its package's
// effective canonical status is "active" (>= 1 active|locked row). BOTH an
// archived tombstone ("archived") AND a hard uninstall ("no row" / absent
// from the map) are skipped — archive and uninstall converge on the same
// inactive end-state. Records without a serverEntry pass through ungated
// (the shared driver skips them itself). The fail-open path on a THROWING
// status read lives in loadStaticBundleExtensions (covered below).

const entry = (packageName: string): { packageName: string; serverEntry: string | null } => ({
  packageName,
  serverEntry: "./register",
});

const recs = [
  entry("@cinatra-ai/uninstalled-ext"), // no row at all
  entry("@cinatra-ai/some-archived-ext"),
  entry("@cinatra-ai/some-active-ext"),
  entry("@cinatra-ai/some-locked-ext"),
];

describe("gateStaticRecordsToLiveRows (pure decision function)", () => {
  it("live row → active (an 'active' effective status keeps the record)", () => {
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-active-ext", "active"],
    ]);
    const { active, skipped } = gateStaticRecordsToLiveRows(
      [entry("@cinatra-ai/some-active-ext")],
      status,
    );
    expect(skipped).toEqual([]);
    expect(active.map((r) => r.packageName)).toEqual(["@cinatra-ai/some-active-ext"]);
  });

  it("locked row → active (the canonical aggregate maps locked rows to 'active')", () => {
    // readEffectiveStatusByPackageNames maps any active|locked row to "active";
    // this case pins the allow-list intent: locked (required-in-prod) rows count
    // as live.
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-locked-ext", "active"],
    ]);
    const { active, skipped } = gateStaticRecordsToLiveRows(
      [entry("@cinatra-ai/some-locked-ext")],
      status,
    );
    expect(skipped).toEqual([]);
    expect(active).toHaveLength(1);
  });

  it("archived row → skipped", () => {
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-archived-ext", "archived"],
    ]);
    const { active, skipped } = gateStaticRecordsToLiveRows(
      [entry("@cinatra-ai/some-archived-ext")],
      status,
    );
    expect(active).toEqual([]);
    expect(skipped).toEqual(["@cinatra-ai/some-archived-ext"]);
  });

  it("NO row (absent from the map) → skipped — hard uninstall does not re-activate", () => {
    // THE behavior change of this contract: previously absence was kept
    // (fail-open on absence); with bundled serverEntry packages
    // lifecycle-anchored, absence means retired (or factory reset) and must
    // NOT activate (IOC-34).
    const { active, skipped } = gateStaticRecordsToLiveRows(
      [entry("@cinatra-ai/uninstalled-ext")],
      new Map(),
    );
    expect(active).toEqual([]);
    expect(skipped).toEqual(["@cinatra-ai/uninstalled-ext"]);
  });

  it("archive and uninstall converge: both end states are skipped (IOC-35)", () => {
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-archived-ext", "archived"],
      ["@cinatra-ai/some-active-ext", "active"],
      ["@cinatra-ai/some-locked-ext", "active"],
      // uninstalled-ext absent
    ]);
    const { active, skipped } = gateStaticRecordsToLiveRows(recs, status);
    expect(skipped.sort()).toEqual(
      ["@cinatra-ai/some-archived-ext", "@cinatra-ai/uninstalled-ext"].sort(),
    );
    expect(active.map((r) => r.packageName).sort()).toEqual(
      ["@cinatra-ai/some-active-ext", "@cinatra-ai/some-locked-ext"].sort(),
    );
  });

  it("records WITHOUT a serverEntry pass through ungated (not activation-relevant)", () => {
    const noEntry = { packageName: "@cinatra-ai/ui-only-ext", serverEntry: null };
    const { active, skipped } = gateStaticRecordsToLiveRows([noEntry], new Map());
    expect(skipped).toEqual([]);
    expect(active).toEqual([noEntry]);
  });

  it("empty record list → empty result", () => {
    const { active, skipped } = gateStaticRecordsToLiveRows([], new Map());
    expect(active).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Loader-level behavior: seeding-before-read ordering and the FAIL-OPEN path
// (a throwing canonical status read activates ALL records — a boot-time DB
// outage never silently drops live extensions).
// ---------------------------------------------------------------------------

const readEffectiveStatusByPackageNames = vi.fn();
const ensureStaticBundleLifecycleAnchors = vi.fn(async () => ({
  seededLive: [] as string[],
  seededArchived: [] as string[],
  failed: [] as string[],
}));
const runStaticBundleActivation = vi.fn(async (records: Array<{ packageName: string }>) =>
  records.map((r) => ({ packageName: r.packageName, status: "registered" as const })),
);

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions", () => ({
  readEffectiveStatusByPackageNames: (...args: unknown[]) =>
    readEffectiveStatusByPackageNames(...args),
}));
vi.mock("@/lib/static-bundle-lifecycle", () => ({
  ensureStaticBundleLifecycleAnchors: () => ensureStaticBundleLifecycleAnchors(),
}));
vi.mock("@cinatra-ai/sdk-extensions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@cinatra-ai/sdk-extensions")>();
  return {
    ...original,
    runStaticBundleActivation: (records: Array<{ packageName: string }>, deps: unknown) => {
      void deps; // the driver deps are not under test here
      return runStaticBundleActivation(records);
    },
  };
});
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_RECORDS: [
    {
      packageName: "@cinatra-ai/live-connector",
      serverEntry: "./register",
      requestedHostPorts: [],
      sdkAbiRange: null,
    },
    {
      packageName: "@cinatra-ai/retired-connector",
      serverEntry: "./register",
      requestedHostPorts: [],
      sdkAbiRange: null,
    },
  ],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
}));
vi.mock("@/lib/extension-host-context", () => ({
  createExtensionHostContext: vi.fn(() => ({})),
}));

describe("loadStaticBundleExtensions (loader-level lifecycle behavior)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ensures lifecycle anchors BEFORE the status read, then gates to live rows", async () => {
    const order: string[] = [];
    ensureStaticBundleLifecycleAnchors.mockImplementationOnce(async () => {
      order.push("seed");
      return { seededLive: [], seededArchived: [], failed: [] };
    });
    readEffectiveStatusByPackageNames.mockImplementationOnce(async () => {
      order.push("read");
      return new Map([["@cinatra-ai/live-connector", "active"]]);
    });
    const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
    await loadStaticBundleExtensions();
    expect(order).toEqual(["seed", "read"]);
    expect(runStaticBundleActivation).toHaveBeenCalledTimes(1);
    const gatedRecords = runStaticBundleActivation.mock.calls[0][0];
    expect(gatedRecords.map((r: { packageName: string }) => r.packageName)).toEqual([
      "@cinatra-ai/live-connector",
    ]);
  });

  it("read-throws → FAIL-OPEN: all bundled records reach the activation driver", async () => {
    readEffectiveStatusByPackageNames.mockRejectedValueOnce(new Error("db down"));
    const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
    await loadStaticBundleExtensions();
    const records = runStaticBundleActivation.mock.calls[0][0];
    expect(records.map((r: { packageName: string }) => r.packageName).sort()).toEqual([
      "@cinatra-ai/live-connector",
      "@cinatra-ai/retired-connector",
    ]);
  });

  it("a throwing seeder is non-fatal: the gate still runs on the status read", async () => {
    ensureStaticBundleLifecycleAnchors.mockRejectedValueOnce(new Error("seed exploded"));
    readEffectiveStatusByPackageNames.mockResolvedValueOnce(
      new Map([["@cinatra-ai/live-connector", "active"]]),
    );
    const { loadStaticBundleExtensions } = await import("@/lib/static-bundle-loader");
    await loadStaticBundleExtensions();
    const records = runStaticBundleActivation.mock.calls[0][0];
    expect(records.map((r: { packageName: string }) => r.packageName)).toEqual([
      "@cinatra-ai/live-connector",
    ]);
  });
});
