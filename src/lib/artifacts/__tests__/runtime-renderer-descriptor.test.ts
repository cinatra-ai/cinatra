/**
 * Runtime-renderer descriptor + pre-import checks + the fail-closed freshness
 * PREFLIGHT + the never-blank floor taxonomy (epic #1620 M1 Slice A —
 * cinatra#1630, plan §2.5–§2.7 / AC-5, AC-6, AC-9, AC-10).
 */
import { describe, expect, it } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import {
  RENDERER_ASSET_ROUTE_BASE,
  RUNTIME_RENDERER_FLOOR_REASONS,
  buildDigestPinnedUrl,
  checkAbi,
  checkReactPeer,
  classifyImportFailure,
  evaluateFreshnessPreflight,
  preImportFloorReason,
  runtimeRendererFloorDiagnostic,
  type FreshnessAuthorityState,
  type RuntimeRendererFloorReason,
} from "../runtime-renderer-descriptor";

const DIGEST = "a".repeat(128);
const DIGEST2 = "b".repeat(128);

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: "@cinatra-ai/json-artifact",
    slot: "detail",
    digest: DIGEST,
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}

const HOST = {
  reactVersion: "19.2.7",
  reactDomVersion: "19.2.7",
  hostSdkAbi: "2.4.0",
  expectedPropsApiVersion: 1,
};

describe("digest-pinned immutable URL", () => {
  it("is content-addressed (digest-first) under the serving route base", () => {
    const url = buildDigestPinnedUrl(tuple());
    expect(url.startsWith(`${RENDERER_ASSET_ROUTE_BASE}/${DIGEST}/detail/`)).toBe(true);
    expect(url).toContain(encodeURIComponent("@cinatra-ai/json-artifact"));
    expect(url).toContain("client/detail.js");
  });

  it("strips a leading ./ and encodes each entry segment (no raw traversal)", () => {
    const url = buildDigestPinnedUrl(tuple({ entry: "./chunks/a b.js" }));
    expect(url).toContain("chunks/a%20b.js");
    expect(url).not.toContain("./chunks");
  });
});

describe("React-peer + ABI pre-import checks (AC-9/AC-10)", () => {
  it("host React 19 satisfies ^19.0.0", () => {
    expect(checkReactPeer(tuple(), HOST)).toBe(true);
  });
  it("a renderer pinned to React 18 is INCOMPATIBLE with host 19", () => {
    expect(checkReactPeer(tuple({ reactPeerRange: "^18.0.0" }), HOST)).toBe(false);
  });
  it("react-dom range is enforced independently (both ranges matter)", () => {
    expect(checkReactPeer(tuple({ reactDomPeerRange: "^18.0.0" }), HOST)).toBe(false);
  });
  it("ABI: host SDK satisfies range AND propsApiVersion matches", () => {
    expect(checkAbi(tuple(), HOST)).toBe(true);
    expect(checkAbi(tuple({ sdkAbiRange: "^3.0.0" }), HOST)).toBe(false);
    expect(checkAbi(tuple({ propsApiVersion: 2 }), HOST)).toBe(false);
  });
});

describe("preImportFloorReason — server-side resolution verdict (first failure wins)", () => {
  const base = {
    tuple: tuple(),
    digestQuarantined: false,
    installedActive: true,
    currentActiveDigest: DIGEST,
    signatureVerified: true,
    host: HOST,
  };
  it("returns null for a fully-admitted renderer", () => {
    expect(preImportFloorReason(base)).toBeNull();
  });
  it.each<[Partial<typeof base>, RuntimeRendererFloorReason]>([
    [{ digestQuarantined: true }, "quarantined"],
    [{ installedActive: false }, "archived"],
    [{ currentActiveDigest: DIGEST2 }, "archived"],
    [{ signatureVerified: false }, "signature-unverified"],
    [{ tuple: tuple({ sdkAbiRange: "^3.0.0" }) }, "abi-incompatible"],
    [{ tuple: tuple({ reactPeerRange: "^18.0.0" }) }, "react-peer-incompatible"],
  ])("%o floors as %s", (over, reason) => {
    expect(preImportFloorReason({ ...base, ...over })).toBe(reason);
  });
});

describe("fail-closed freshness preflight (plan §2.5, ruling 8) — archive positions", () => {
  const fresh: FreshnessAuthorityState = {
    installedActive: true,
    currentActiveDigest: DIGEST,
    signatureVerified: true,
    digestQuarantined: false,
  };
  it("green when still admitted (permits import)", () => {
    expect(evaluateFreshnessPreflight(tuple(), fresh)).toEqual({ ok: true });
  });
  it("REJECTS when the extension is archived/uninstalled (the revocation path)", () => {
    expect(evaluateFreshnessPreflight(tuple(), { ...fresh, installedActive: false })).toEqual({
      ok: false,
      reason: "archived",
    });
  });
  it("REJECTS a stale descriptor whose digest is no longer the active one", () => {
    expect(evaluateFreshnessPreflight(tuple(), { ...fresh, currentActiveDigest: DIGEST2 })).toEqual({
      ok: false,
      reason: "archived",
    });
  });
  it("REJECTS when the re-evaluated signature no longer verifies", () => {
    expect(evaluateFreshnessPreflight(tuple(), { ...fresh, signatureVerified: false })).toEqual({
      ok: false,
      reason: "signature-unverified",
    });
  });
  it("REJECTS a quarantined digest", () => {
    expect(evaluateFreshnessPreflight(tuple(), { ...fresh, digestQuarantined: true })).toEqual({
      ok: false,
      reason: "quarantined",
    });
  });
});

describe("never-blank floor taxonomy is exhaustive + diagnostics sanitized (AC-5)", () => {
  it("classifyImportFailure covers every client-side failure kind", () => {
    expect(classifyImportFailure("timeout")).toBe("import-timeout");
    expect(classifyImportFailure("import-rejected")).toBe("materializing");
    expect(classifyImportFailure("invalid-export")).toBe("invalid-export");
    expect(classifyImportFailure("render-failure")).toBe("render-failure");
  });
  it("every floor reason yields a sanitized diagnostic (no raw values)", () => {
    for (const reason of RUNTIME_RENDERER_FLOOR_REASONS) {
      const d = runtimeRendererFloorDiagnostic("@cinatra-ai/json-artifact", "detail", reason);
      expect(d).toContain(reason);
      expect(d).toContain("@cinatra-ai/json-artifact");
    }
    expect(RUNTIME_RENDERER_FLOOR_REASONS).toContain("react-peer-incompatible");
    expect(RUNTIME_RENDERER_FLOOR_REASONS).toContain("archived");
    expect(RUNTIME_RENDERER_FLOOR_REASONS).toContain("render-failure");
  });
});
