/**
 * ENABLER 0.4 — per-display version negotiation. The contract-level acceptance
 * test (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE: "Per-display version negotiation: resolve the
 * display, read its declared props version, then build the snapshot at that
 * version" — fixing that "the version check is strict equality, so the day the
 * host emits a new version every existing display goes dark at once. This turns
 * a flag day into a per-extension ratchet."
 *
 * THE TWO SEAMS MOVE TOGETHER, and this file asserts both: the build-map loader
 * and the signed-bundle runtime admission. A build-map renderer and a runtime
 * renderer disagreeing about the negotiation rule would mean the same extension
 * renders on one host and floors on the other.
 */
import { describe, expect, it } from "vitest";

import {
  HOST_MIN_SUPPORTED_PROPS_API_VERSION,
  HOST_PROPS_API_VERSION,
  hostSupportedPropsApiVersions,
  isPropsApiVersionSupported,
  negotiatePropsApiVersion,
} from "@/lib/artifacts/props-version-negotiation";
import { checkAbi } from "@/lib/artifacts/runtime-renderer-descriptor";
import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

describe("enabler 0.4 — the ratchet, not the flag day", () => {
  it("admits EVERY version inside the host's window, at the display's OWN version", () => {
    for (const declared of hostSupportedPropsApiVersions()) {
      expect(negotiatePropsApiVersion(declared)).toEqual({ ok: true, version: declared });
    }
  });

  it("is NOT strict equality: a display one version behind a future host still renders", () => {
    // The scenario the enabler names. Simulate a host that has moved to v2 while
    // an extension still declares v1: under the old `!==` rule this display went
    // dark on deploy day; under the ratchet it is admitted AT v1.
    const futureHost = { min: 1, max: 2 };
    expect(negotiatePropsApiVersion(1, futureHost)).toEqual({ ok: true, version: 1 });
    expect(negotiatePropsApiVersion(2, futureHost)).toEqual({ ok: true, version: 2 });
  });

  it("holds the two refusals apart, because only one of them a host deploy can cause", () => {
    // Ahead of the deployment — the EXTENSION is fine, the host must catch up.
    expect(negotiatePropsApiVersion(HOST_PROPS_API_VERSION + 1)).toEqual({
      ok: false,
      reason: "too-new",
    });
    // Below the floor — the host has retired that snapshot shape. (A
    // non-positive integer is not "retired" but MALFORMED: no display ever
    // declared it, so it is a different fact and the case below covers it.)
    expect(negotiatePropsApiVersion(HOST_MIN_SUPPORTED_PROPS_API_VERSION, { min: 2, max: 3 })).toEqual({
      ok: false,
      reason: "retired",
    });
    expect(negotiatePropsApiVersion(2, { min: 3, max: 4 })).toEqual({ ok: false, reason: "retired" });
  });

  it("refuses a malformed declaration rather than defaulting it to the host's own", () => {
    for (const bad of [undefined, null, 0, -1, 1.5, Number.NaN, "1" as unknown as number]) {
      expect(negotiatePropsApiVersion(bad as number)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(isPropsApiVersionSupported(undefined)).toBe(false);
  });
});

describe("enabler 0.4 — the runtime seam moves in lockstep with the build map", () => {
  const tuple = (propsApiVersion: number): AdmittedClientBundleTuple =>
    ({
      digest: "d",
      slot: "detail",
      packageName: "@vendor/pkg",
      entry: "dist/detail.js",
      propsApiVersion,
      sdkAbiRange: "*",
      reactPeerRange: "*",
      reactDomPeerRange: "*",
    }) as unknown as AdmittedClientBundleTuple;

  it("admits a display inside the window and refuses one outside it — the same rule as the loader", () => {
    const host = { hostSdkAbi: "1.0.0", expectedPropsApiVersion: 2 };
    expect(checkAbi(tuple(1), host)).toBe(true);
    expect(checkAbi(tuple(2), host)).toBe(true);
    expect(checkAbi(tuple(3), host)).toBe(false);
    // And the two seams agree, case for case.
    for (const declared of [1, 2, 3]) {
      expect(checkAbi(tuple(declared), host)).toBe(
        isPropsApiVersionSupported(declared, { max: host.expectedPropsApiVersion }),
      );
    }
  });
});
