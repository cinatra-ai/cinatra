import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#2762 round 5 (+ round-5 convergence) — "RETRY ACTIVATION" IS BOUND TO
// THE ROW IT RESOLVED.
//
// `activateInstalledRowInProcess` used to take only `(packageName, orgId)`. The
// activation path then re-derives its trust anchor from that pair, and for an
// org-NULL row that means PLATFORM-GLOBAL selection
// (`pickSingleLiveRowAcrossOrgs`) — a SECOND resolution, from a coarser key than
// the lifecycle resolver used to pick the row and pass the standing gate. The
// two agree on every row set seen so far, so this is hardening, not a live bug:
// the point is that a disagreement must REFUSE rather than silently activate the
// other row.
//
// ROUND-5 CONVERGENCE — WHERE THE CHECK LIVES IS THE WHOLE POINT. The first cut
// resolved the anchor TWICE: a best-effort pre-read that decided "drift / no
// drift", and then the activation's own independent resolution. That is a
// TOCTOU (the row can change between the two reads) AND it fails open — the
// pre-read returned "no drift" when the anchor carried no `installId` and when
// the read threw, so a caller that asked for a binding could reach activation
// having proved nothing. The binding now rides on the resolver the activation
// pass itself consumes; there is no second read to disagree with.

vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorResolver: vi.fn(),
}));

import { makeDefaultInstallAnchorResolver } from "@/lib/extension-install-anchor";

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

// The heavy activation pass itself. It RE-RESOLVES the anchor through the
// resolver it was handed, exactly as the real loader's trust filter does
// (`const anchors = await resolveAnchors(packageName)`) — so these tests prove
// the binding rides on the resolution activation actually consumes, not on a
// guard beside it.
const activatePass = vi.fn(
  async (
    _root: string,
    opts: { onlyPackage: string; resolveInstallAnchor: (p: string) => Promise<unknown> },
  ) => {
    await opts.resolveInstallAnchor(opts.onlyPackage);
    return [{ packageName: PKG, status: "registered" }];
  },
);
vi.mock("@/lib/runtime-package-loader", () => ({
  loadRuntimePackageExtensions: (...a: unknown[]) => activatePass(...(a as [never, never])),
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

const anchorWith = (installId: string | null | undefined) => ({
  installId,
  integrity: "i",
  contentHash: "h",
  registryUrl: "http://127.0.0.1:4873",
});
/** A resolver that answers the same way every time. */
const anchorFor = (installId: string | null | undefined) =>
  vi.fn(async () => anchorWith(installId));

beforeEach(() => {
  vi.clearAllMocks();
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

  it("REFUSES an anchor that cannot PROVE identity — an unprovable binding is not a pass", async () => {
    // Inverted in round-5 convergence. This used to be blessed as "a legacy
    // anchor cannot contradict anything, so allow it through", which made
    // `expectRowId` a hint exactly where it mattered: the caller asked to
    // activate ONE row, and an anchor with no `installId` cannot say which row
    // it binds. Every anchor the shipped resolver produces carries `installId`
    // (set from the resolved row's `id`), so this refuses nothing the product
    // produces — it refuses activating unbound.
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(anchorFor(null) as never);
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toContain("row-drift");
    expect(activatePass).not.toHaveBeenCalled();
  });

  it("an anchor read that THROWS during a BOUND activation is a FAILURE, not 'no drift'", async () => {
    // Also inverted. The old pre-read swallowed the throw and returned "no
    // drift", and the activation then proceeded with its own unbound
    // resolution — a read we could not complete is an identity we did not
    // prove.
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(
      vi.fn(async () => {
        throw new Error("canonical store down");
      }) as never,
    );
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toContain("canonical store down");
    expect(activatePass).not.toHaveBeenCalled();
  });

  it("a NULL anchor keeps the loader's OWN refusal — the binding does not overwrite it", async () => {
    // The resolver's own fail-closed answers (no live row, ambiguous multi-org,
    // unfinalized journal) are more specific than any binding message, so a
    // null anchor passes through and the loader refuses it and says why.
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(
      vi.fn(async () => null) as never,
    );
    activatePass.mockResolvedValueOnce([] as never);
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toBe("anchor-refused");
  });

  it("REFUSES a row that drifts BETWEEN reads — there is no unchecked second resolution", async () => {
    // THE TOCTOU THE PRE-READ GUARD HAD. Under the old shape the guard's read
    // agreed, and the activation's INDEPENDENT re-resolution then bound the
    // other row — the exact window a "resolve once, check once, activate on a
    // different resolution" guard leaves open. Every resolution the pass
    // consumes is now checked, so the second answer refuses.
    let call = 0;
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(
      vi.fn(async () => anchorWith(++call === 1 ? "iext_installed" : "iext_replaced")) as never,
    );
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
    expect(out.activated).toBe(false);
    expect(out.reason).toContain("row-drift");
    expect(call).toBeGreaterThan(1);
  });

  it("WITHOUT expectRowId nothing is bound — pre-existing callers are unchanged", async () => {
    vi.mocked(makeDefaultInstallAnchorResolver).mockResolvedValue(anchorFor(null) as never);
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    const out = await activateInstalledRowInProcess({ packageName: PKG, orgId: null });
    // An identity-less anchor activates fine for a caller that never resolved a
    // row and therefore asked for no binding.
    expect(out.activated).toBe(true);
  });

  it("resolves the anchor for the ROW's org, and builds ONE resolver for the pass", async () => {
    const { activateInstalledRowInProcess } = await import("@/lib/extension-runtime-activate");
    await activateInstalledRowInProcess({
      packageName: PKG,
      orgId: "org-7",
      expectRowId: "iext_installed",
    });
    expect(vi.mocked(makeDefaultInstallAnchorResolver)).toHaveBeenCalledWith("org-7");
    // ONE resolver for the whole pass — the separate guard read is gone.
    expect(vi.mocked(makeDefaultInstallAnchorResolver)).toHaveBeenCalledTimes(1);
  });
});
