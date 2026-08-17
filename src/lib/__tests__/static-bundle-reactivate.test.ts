// The targeted bundled-reactivation seam, driven against a REAL bundled record.
//
// This is the path that puts the version shipped in the image back in service
// after a product install is archived, and it is what makes "roll back to
// bundled" and the post-commit compensation actually recover something rather
// than merely report. Its failure modes are all silent ones, so each is pinned:
// the wrong package, a package with nothing to register, a teardown that throws,
// a driver that refuses, and the happy path.
import { describe, it, expect, vi, beforeEach } from "vitest";

// A real record shape from the generated static manifest: a bundled connector
// with a serverEntry, plus one that ships no server module at all.
const SERVER_ENTRY_PKG = "@cinatra-ai/bundled-with-entry";
const METADATA_ONLY_PKG = "@cinatra-ai/bundled-metadata-only";

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_RECORDS: [
    {
      packageName: SERVER_ENTRY_PKG,
      serverEntry: "./register",
      requestedHostPorts: ["ui"],
      sdkAbiRange: "^2",
      envOverrides: null,
      resolution: "guardedOptional",
    },
    {
      packageName: METADATA_ONLY_PKG,
      serverEntry: null,
      requestedHostPorts: [],
      sdkAbiRange: "^2",
      envOverrides: null,
      resolution: "guardedOptional",
    },
  ],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
  STATIC_EXTENSION_MANIFEST: {},
}));

const activation = vi.fn();
vi.mock("@cinatra-ai/sdk-extensions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runStaticBundleActivation: (...a: unknown[]) => activation(...a),
}));

const teardown = vi.fn(async () => {});
vi.mock("@cinatra-ai/extensions", () => ({
  fireExtensionCapabilityTeardown: () => teardown(),
  readEffectiveStatusByPackageNames: async () => new Map(),
}));

const locked: string[] = [];
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (p: string, fn: () => Promise<unknown>) => {
    locked.push(p);
    return fn();
  },
}));

beforeEach(() => {
  activation.mockReset();
  teardown.mockClear();
  locked.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("reactivateBundledFallbackInProcess", () => {
  it("activates the bundled record and reports success", async () => {
    activation.mockResolvedValue([{ packageName: SERVER_ENTRY_PKG, status: "registered" }]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await expect(reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).resolves.toEqual({ ok: true });
    // Exactly ONE record was driven, not the whole image.
    const records = activation.mock.calls[0]?.[0] as { packageName: string }[];
    expect(records.map((r) => r.packageName)).toEqual([SERVER_ENTRY_PKG]);
  });

  it("accepts a bootstrapped result as serving", async () => {
    activation.mockResolvedValue([{ packageName: SERVER_ENTRY_PKG, status: "bootstrapped" }]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await expect(reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).resolves.toEqual({ ok: true });
  });

  it("TEARS DOWN the failed override's registrations BEFORE the bundled module registers", async () => {
    // Order is the whole point: registering underneath a live override would
    // leave two registrations racing for the same global names.
    const order: string[] = [];
    teardown.mockImplementation(async () => {
      order.push("teardown");
    });
    activation.mockImplementation(async () => {
      order.push("activate");
      return [{ packageName: SERVER_ENTRY_PKG, status: "registered" }];
    });
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG);
    expect(order).toEqual(["teardown", "activate"]);
  });

  it("holds the package install lock for the whole operation", async () => {
    activation.mockResolvedValue([{ packageName: SERVER_ENTRY_PKG, status: "registered" }]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG);
    expect(locked).toEqual([SERVER_ENTRY_PKG]);
  });

  it("a package that does NOT ship in the image is refused, not faked", async () => {
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    const r = await reactivateBundledFallbackInProcess("@cinatra-ai/not-bundled");
    expect(r).toMatchObject({ ok: false });
    expect(activation).not.toHaveBeenCalled();
  });

  it("a metadata-only bundled record needs no registration and reports success", async () => {
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await expect(reactivateBundledFallbackInProcess(METADATA_ONLY_PKG)).resolves.toEqual({ ok: true });
    expect(activation).not.toHaveBeenCalled();
  });

  it("a driver refusal is reported with its reason, never as success", async () => {
    activation.mockResolvedValue([
      { packageName: SERVER_ENTRY_PKG, status: "failed", reason: "register-threw" },
    ]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    expect(await reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).toEqual({
      ok: false,
      reason: "register-threw",
    });
  });

  it("a SKIPPED record is not serving, so it is not success", async () => {
    activation.mockResolvedValue([{ packageName: SERVER_ENTRY_PKG, status: "skipped", reason: "no-server-entry" }]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    expect(await reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).toMatchObject({ ok: false });
  });

  it("a THROWING driver is reported, never allowed to escape", async () => {
    activation.mockRejectedValue(new Error("boom"));
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    expect(await reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).toEqual({
      ok: false,
      reason: "boom",
    });
  });

  it("a teardown that throws does not stop the bundled module coming back", async () => {
    teardown.mockRejectedValue(new Error("teardown failed"));
    activation.mockResolvedValue([{ packageName: SERVER_ENTRY_PKG, status: "registered" }]);
    const { reactivateBundledFallbackInProcess } = await import("@/lib/static-bundle-loader");
    await expect(reactivateBundledFallbackInProcess(SERVER_ENTRY_PKG)).resolves.toEqual({ ok: true });
  });
});
