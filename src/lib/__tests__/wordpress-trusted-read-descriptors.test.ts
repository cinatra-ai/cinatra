import { describe, expect, it } from "vitest";
import {
  TRUSTED_READ_DESCRIPTOR_SET,
  TRUSTED_SITE_DISCLOSURE_VERSION,
  canonicalizeTrustedReadDescriptorEntries,
  computeTrustedReadDescriptorSetHash,
  resolveShippedTrustedSiteConsent,
  type TrustedReadDescriptorEntry,
} from "@/lib/wordpress-trusted-read-descriptors";

// cinatra#2019 S4 — the shipped trusted-read descriptor set + the
// consent-stamp derivation. v1 ships EMPTY (the pinned community stack
// exposes the default server triad-only, so no entry can carry the required
// capture proof); these pins make (a) the emptiness an ASSERTED state, (b)
// the canonical-entries hash deterministic and content-sensitive (the
// persisted consent stamps ride on it), and (c) the shipped-stamp derivation
// single-sourced. The capture-consistency gate (loading the committed
// e2e captures and proving every entry against them) lands with the verifier
// slice; nothing here substitutes for it.

const ENTRY_A: TrustedReadDescriptorEntry = {
  name: "alpha-read",
  fingerprint: "f".repeat(64),
  hasOutputSchema: true,
};
const ENTRY_B: TrustedReadDescriptorEntry = {
  name: "beta-read",
  fingerprint: "e".repeat(64),
  hasOutputSchema: false,
  note: "example",
};

describe("shipped set (v1)", () => {
  it("is version 1, tsr1, pinned to the captured community-stack tuple, and EMPTY", () => {
    expect(TRUSTED_READ_DESCRIPTOR_SET.version).toBe(1);
    expect(TRUSTED_READ_DESCRIPTOR_SET.fingerprintAlgorithm).toBe("tsr1");
    expect(TRUSTED_READ_DESCRIPTOR_SET.pinnedTuple).toEqual({
      wp: "6.9",
      mcpAdapter: "0.5.0",
      eafm: "2.0.20",
    });
    // EMPTY BY CONSTRUCTION on the pinned stack (triad-only default server).
    // Populating this set is a reviewed change that MUST bump `version` and
    // must carry capture proof — if this assertion is failing on a
    // population PR, bump the version and land the capture-consistency
    // evidence with it rather than editing this expectation alone.
    expect(TRUSTED_READ_DESCRIPTOR_SET.entries).toEqual([]);
  });

  it("ships disclosure version v1", () => {
    expect(TRUSTED_SITE_DISCLOSURE_VERSION).toBe("v1");
  });
});

describe("canonicalizeTrustedReadDescriptorEntries", () => {
  it("is key-order and entry-order invariant", () => {
    const shuffledKeys = [
      { hasOutputSchema: false, note: "example", fingerprint: ENTRY_B.fingerprint, name: "beta-read" },
      { fingerprint: ENTRY_A.fingerprint, name: "alpha-read", hasOutputSchema: true },
    ] as TrustedReadDescriptorEntry[];
    expect(canonicalizeTrustedReadDescriptorEntries(shuffledKeys)).toBe(
      canonicalizeTrustedReadDescriptorEntries([ENTRY_A, ENTRY_B]),
    );
  });

  it("drops undefined optional members and keeps a present note", () => {
    const canonical = canonicalizeTrustedReadDescriptorEntries([
      { ...ENTRY_A, note: undefined },
      ENTRY_B,
    ]);
    expect(canonical).toContain('"note":"example"');
    expect(canonical).not.toContain('"note":undefined');
    expect(canonical.indexOf('"name":"alpha-read"')).toBeLessThan(
      canonical.indexOf('"name":"beta-read"'),
    );
  });

  it("throws on a duplicate name (the set is an enumeration of exact names)", () => {
    expect(() =>
      canonicalizeTrustedReadDescriptorEntries([ENTRY_A, { ...ENTRY_B, name: "alpha-read" }]),
    ).toThrow(/duplicate entry name/);
  });

  it("canonicalizes the empty set to the empty array literal", () => {
    expect(canonicalizeTrustedReadDescriptorEntries([])).toBe("[]");
  });
});

describe("computeTrustedReadDescriptorSetHash (the consent-stamp content hash)", () => {
  it("is a deterministic sha256 hex, invariant to entry/key order", () => {
    const a = computeTrustedReadDescriptorSetHash([ENTRY_A, ENTRY_B]);
    const b = computeTrustedReadDescriptorSetHash([ENTRY_B, ENTRY_A]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes on ANY content change (name, fingerprint, output-schema presence, note)", () => {
    const base = computeTrustedReadDescriptorSetHash([ENTRY_A]);
    expect(computeTrustedReadDescriptorSetHash([{ ...ENTRY_A, name: "alpha-read-2" }])).not.toBe(base);
    expect(
      computeTrustedReadDescriptorSetHash([{ ...ENTRY_A, fingerprint: "0".repeat(64) }]),
    ).not.toBe(base);
    expect(
      computeTrustedReadDescriptorSetHash([{ ...ENTRY_A, hasOutputSchema: false }]),
    ).not.toBe(base);
    expect(computeTrustedReadDescriptorSetHash([{ ...ENTRY_A, note: "changed" }])).not.toBe(base);
  });
});

describe("resolveShippedTrustedSiteConsent (the stamp source)", () => {
  it("derives all three values from the shipped constants through the shared helper", () => {
    const shipped = resolveShippedTrustedSiteConsent();
    expect(shipped).toEqual({
      descriptorSetVersion: TRUSTED_READ_DESCRIPTOR_SET.version,
      descriptorSetHash: computeTrustedReadDescriptorSetHash(TRUSTED_READ_DESCRIPTOR_SET.entries),
      disclosureVersion: TRUSTED_SITE_DISCLOSURE_VERSION,
    });
    // The v1 empty-set hash, pinned literally: sha256("[]"). A change here
    // means the canonicalization or the shipped content changed — both
    // require a version bump + a fresh acknowledgement ceremony downstream.
    expect(shipped.descriptorSetHash).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });
});
