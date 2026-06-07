// Spoofing-guard for viewer scope resolution. The fix replaces the historical
// `viewerScope = "@" + identity.instanceNamespace` derivation, which let an
// unapproved consumer rename their instanceNamespace to impersonate a vendor's
// privileged view of `cinatra.origin: { visibility: "private" }` packages.
//
// Coverage matches the canonical migration spec scenarios:
//   1) consumer with editable instanceNamespace but vendorState=none → public-only
//   2) approved vendor with canonical vendorScope → private-scope view
//   3) applied/rejected/cancelled non-vendors → public-only
//   4) legacy vendor (tokenCiphertext + non-empty instanceNamespace,
//      no vendorState field yet) keeps its @instanceNamespace view via the
//      back-compat branch.

import { describe, expect, it } from "vitest";
import type { InstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";

const BASE_IDENTITY: InstanceIdentity = {
  instanceNamespace: "victim-vendor",
  instanceDisplayName: "Victim",
  tokenCiphertext: "",
  tokenIv: "",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct",
  passwordIv: "pw-iv",
  firstPublishedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
};

describe("getEffectiveViewerScope", () => {
  it("returns undefined for a null identity (pre-setup boot path)", () => {
    expect(getEffectiveViewerScope(null)).toBeUndefined();
  });

  it("returns undefined when an unapproved consumer renames to impersonate a vendor (spoof rejected)", () => {
    const spoofer: InstanceIdentity = {
      ...BASE_IDENTITY,
      instanceNamespace: "victim-vendor",
      vendorState: "none",
      vendorScope: null,
    };
    expect(getEffectiveViewerScope(spoofer)).toBeUndefined();
  });

  it("returns the canonical scope for an approved vendor", () => {
    const approved: InstanceIdentity = {
      ...BASE_IDENTITY,
      vendorState: "approved",
      vendorScope: "@acme",
    };
    expect(getEffectiveViewerScope(approved)).toBe("@acme");
  });

  it("returns undefined when vendorState is approved but vendorScope is missing/null", () => {
    const halfwayApproved: InstanceIdentity = {
      ...BASE_IDENTITY,
      vendorState: "approved",
      vendorScope: null,
    };
    expect(getEffectiveViewerScope(halfwayApproved)).toBeUndefined();
  });

  it("returns undefined for an applied (mid-application) consumer", () => {
    const applied: InstanceIdentity = {
      ...BASE_IDENTITY,
      vendorState: "applied",
      vendorScope: "@pending-scope",
    };
    expect(getEffectiveViewerScope(applied)).toBeUndefined();
  });

  it("returns undefined for a rejected consumer", () => {
    const rejected: InstanceIdentity = {
      ...BASE_IDENTITY,
      vendorState: "rejected",
      vendorScope: "@some-rejected-scope",
    };
    expect(getEffectiveViewerScope(rejected)).toBeUndefined();
  });

  it("preserves the vendor scope via the back-compat branch", () => {
    const legacyVendor: InstanceIdentity = {
      ...BASE_IDENTITY,
      instanceNamespace: "acme",
      tokenCiphertext: "ciphertext-here",
      tokenIv: "iv-here",
    };
    expect(getEffectiveViewerScope(legacyVendor)).toBe("@acme");
  });

  it("does NOT activate the back-compat branch when tokenCiphertext is empty", () => {
    const consumerOnly: InstanceIdentity = {
      ...BASE_IDENTITY,
      instanceNamespace: "acme",
      tokenCiphertext: "",
    };
    expect(getEffectiveViewerScope(consumerOnly)).toBeUndefined();
  });

  it("does NOT activate the back-compat branch when vendorState is set (non-undefined)", () => {
    const spoofAttempt: InstanceIdentity = {
      ...BASE_IDENTITY,
      instanceNamespace: "acme",
      tokenCiphertext: "ciphertext",
      tokenIv: "iv",
      vendorState: "none",
    };
    expect(getEffectiveViewerScope(spoofAttempt)).toBeUndefined();
  });
});
