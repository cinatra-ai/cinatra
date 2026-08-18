import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#2762 round 5 — "RETRY ACTIVATION" IS BOUND TO THE ROW IT RESOLVED.
//
// `activateInstalledRowInProcess` used to take only `(packageName, orgId)`. The
// activation path then re-derives its trust anchor from that pair, and for an
// org-NULL row that means PLATFORM-GLOBAL selection
// (`pickSingleLiveRowAcrossOrgs`) — a SECOND resolution, from a coarser key than
// the lifecycle resolver used to pick the row and pass the standing gate. The
// two agree on every row set seen so far, so this is hardening, not a live bug:
// the point is that a disagreement must REFUSE rather than silently activate the
// other row.

vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorResolver: vi.fn(),
}));

import { makeDefaultInstallAnchorResolver } from "@/lib/extension-install-anchor";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

// The heavy activation pass itself — spied on the module under test's own
// export, so this file exercises the real `activateInstalledRowInProcess` body
// (the guard) without booting a package store.
const activatePass = vi.fn();
vi.mock("@/lib/runtime-package-loader", () => ({
  loadRuntimePackageExtensions: (...a: unknown[]) => activatePass(...(a as [])),
}));
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => "/data/extensions",
}));
vi.mock("@cinatra-ai/extensions", () => ({
  fireExtensionCapabilityTeardown: vi.fn(async () => undefined),
}));
vi.mock("@/lib/extension-activation-generation", () => ({
  bumpActivationGeneration: vi.fn(),
}));

const anchorFor = (installId: string | null | undefined) =>
  vi.fn(async () => ({
    installId,
    integrity: "i",
    contentHash: "h",
    registryUrl: "http://127.0.0.1:4873",
  }));

beforeEach(() => {
  vi.clearAllMocks();
  activatePass.mockResolvedValue([{ packageName: PKG, status: "registered" }]);
  vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(
    anchorFor("iext_installed") as never,
  );
});

describe("activateInstalledRowInProcess is bound to the resolved row", () => {
  it("ACTIVATES when the anchor binds the row the caller resolved", async () => {
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(true);
    expect(activatePass).toHaveBeenCalled();
  });

  it("REFUSES when the anchor binds a DIFFERENT row, and never activates it", async () => {
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(
      anchorFor("iext_some_other_row") as never,
    );
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toContain("row-drift");
    // The load-bearing half: the OTHER row was not activated behind the
    // operator's back.
    expect(activatePass).not.toHaveBeenCalled();
  });

  it("allows a LEGACY anchor that reports no row id — it cannot contradict anything", async () => {
    // `installId` is optional on InstallTrustAnchor (legacy resolvers and pure
    // fixtures omit it). An absent id is not a disagreement, so refusing on it
    // would break activation for those anchors instead of catching drift.
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(anchorFor(null) as never);
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(true);
  });

  it("an anchor read that THROWS is not a drift verdict", async () => {
    // The activation pass below re-resolves the anchor anyway and reports its
    // own refusal with the better message; turning a read failure into
    // "row-drift" would mislabel it.
    vi.mocked(makeDefaultInstallAnchorResolver).mockRejectedValue(
      new Error("canonical store down") as never,
    );
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.reason ?? "").not.toContain("row-drift");
  });

  it("WITHOUT expectRowId the guard never runs — pre-existing callers are unchanged", async () => {
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({ packageName: PKG, orgId: null });
    expect(out.activated).toBe(true);
    // Only the activation pass's OWN resolver build, never the guard's extra one.
    expect(vi.mocked(makeDefaultInstallAnchorResolver)).toHaveBeenCalledTimes(1);
  });

  it("WITH expectRowId the guard resolves the anchor for the ROW's org", async () => {
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: "org-7",
      expectRowId: "iext_installed",
    });
    expect(vi.mocked(makeDefaultInstallAnchorResolver)).toHaveBeenCalledWith("org-7");
  });
});
