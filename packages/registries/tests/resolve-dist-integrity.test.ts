import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pacote", () => ({ packument: vi.fn() }));

import * as pacote from "pacote";
import { resolveExtensionDistIntegrity } from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.cinatra.ai",
  packageScope: "@cinatra-ai",
  token: "tok",
  uiUrl: null,
};

const packumentMock = vi.mocked(pacote.packument);
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

beforeEach(() => packumentMock.mockReset());

describe("resolveExtensionDistIntegrity", () => {
  it("resolves an exact version's sha512 dist.integrity", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.2.0": { dist: { integrity: "sha512-AAA" } } },
      "dist-tags": { latest: "1.2.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity(
      { packageName: "@cinatra-ai/x", packageVersion: "1.2.0" },
      CONFIG,
    );
    expect(r).toMatchObject({ integrity: "sha512-AAA", registryUrl: CONFIG.registryUrl });
  });

  it("resolves a DIST-TAG passed as packageVersion (the prior bug: 'latest' threw)", async () => {
    packumentMock.mockResolvedValue({
      versions: {
        "1.2.0": { dist: { integrity: "sha512-AAA" } },
        "2.0.0": { dist: { integrity: "sha512-BBB" } },
      },
      "dist-tags": { latest: "2.0.0", beta: "1.2.0" },
    } as never);
    expect(
      (await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "latest" }, CONFIG)).integrity,
    ).toBe("sha512-BBB");
    expect(
      (await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "beta" }, CONFIG)).integrity,
    ).toBe("sha512-AAA");
  });

  it("falls back to dist-tags.latest when no version is given", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { dist: { integrity: "sha512-ONE" } } },
      "dist-tags": { latest: "1.0.0" },
    } as never);
    expect((await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x" }, CONFIG)).integrity).toBe("sha512-ONE");
  });

  it("returns ONLY the sha512 token from a multi-hash SRI + extracts sha256 as additive", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { dist: { integrity: `sha512-AAA sha256-${b64("deadbeef")}` } } },
      "dist-tags": { latest: "1.0.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "1.0.0" }, CONFIG);
    expect(r.integrity).toBe("sha512-AAA");
    expect(r.sha256).toBe("deadbeef");
  });

  it("REJECTS a sha256-only dist.integrity (model B requires sha512 as the trust root)", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { dist: { integrity: `sha256-${b64("deadbeef")}` } } },
      "dist-tags": { latest: "1.0.0" },
    } as never);
    await expect(
      resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "1.0.0" }, CONFIG),
    ).rejects.toThrow(/sha512/i);
  });

  it("throws on an unknown version/tag", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { dist: { integrity: "sha512-AAA" } } },
      "dist-tags": { latest: "1.0.0" },
    } as never);
    await expect(
      resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "9.9.9" }, CONFIG),
    ).rejects.toThrow(/not found/i);
  });

  it("returns the packument dist.cinatraSignature + the resolved version (exact version)", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.2.0": { dist: { integrity: "sha512-AAA", cinatraSignature: "SIG-B64" } } },
      "dist-tags": { latest: "1.2.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "1.2.0" }, CONFIG);
    expect(r.signature).toBe("SIG-B64");
    expect(r.resolvedVersion).toBe("1.2.0");
  });

  it("returns signature:null (and the resolved version) when the packument carries no signature", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.2.0": { dist: { integrity: "sha512-AAA" } } },
      "dist-tags": { latest: "1.2.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "1.2.0" }, CONFIG);
    expect(r.signature).toBeNull();
    expect(r.resolvedVersion).toBe("1.2.0");
  });

  it("binds the RESOLVED concrete version for a DIST-TAG install — signature + resolvedVersion come from the resolved entry, not the tag", async () => {
    packumentMock.mockResolvedValue({
      versions: {
        "1.2.0": { dist: { integrity: "sha512-AAA", cinatraSignature: "SIG-1.2.0" } },
        "2.0.0": { dist: { integrity: "sha512-BBB", cinatraSignature: "SIG-2.0.0" } },
      },
      "dist-tags": { latest: "2.0.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "latest" }, CONFIG);
    expect(r.resolvedVersion).toBe("2.0.0");
    expect(r.integrity).toBe("sha512-BBB");
    expect(r.signature).toBe("SIG-2.0.0");
  });

  it("normalizes a blank/non-string cinatraSignature to null (defensive)", async () => {
    packumentMock.mockResolvedValue({
      versions: { "1.0.0": { dist: { integrity: "sha512-AAA", cinatraSignature: "   " } } },
      "dist-tags": { latest: "1.0.0" },
    } as never);
    const r = await resolveExtensionDistIntegrity({ packageName: "@cinatra-ai/x", packageVersion: "1.0.0" }, CONFIG);
    expect(r.signature).toBeNull();
  });
});
