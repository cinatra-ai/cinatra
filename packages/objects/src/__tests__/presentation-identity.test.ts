// Presentation-identity resolver — pure tier-machine tests (epic #1883 slice
// A6, design D1).
//
// The resolver is presentation-ONLY: it layers a row's meaning assertions over
// the shared type-driven effective identity. Tier order:
//   1. highest-ranked eligible CLASSIC assertion (user > authoring_skill >
//      agent) whose extension is live (binding never competes here);
//   2. a matcher draft at/above its pack threshold — highest confidence wins,
//      tie ⇒ no auto-surface (chips only), org toggle disables the tier;
//   3. the claim-backed (eligible binding) identity, else the type-namespace
//      owner (the shared effective identity).
//
// The final `describe` is the CRITICAL-INVARIANT conformance pin: the shared
// resolver (`resolveEffectiveIdentity`, consumed by context selection #1430,
// replay pinning, Graphiti projection) is untouched — it never consults the
// assertion axis, so presentation identity diverges from it BY DESIGN.

import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";

import { objectTypeRegistry } from "../registry";
import type { EffectiveIdentity } from "../effective-identity";
import { resolveEffectiveIdentity, GENERIC_ARTIFACT_OBJECT_TYPE } from "../effective-identity";
import {
  resolvePresentationIdentity,
  type PresentationAssertion,
  type PresentationIdentityPolicy,
} from "../presentation-identity";

const GENERIC: EffectiveIdentity = { kind: "no-primary" };
const X = "@acme/x-artifact";
const Y = "@acme/y-artifact";
const Z = "@acme/z-artifact";

// A permissive default policy: every extension live, threshold 0.7, auto-surface
// on. Individual tests narrow it.
function policy(over: Partial<PresentationIdentityPolicy> = {}): PresentationIdentityPolicy {
  return {
    isExtensionLive: () => true,
    matcherThreshold: () => 0.7,
    autoSurfaceDisabled: false,
    ...over,
  };
}

function a(part: Partial<PresentationAssertion> & { extension: string }): PresentationAssertion {
  return {
    assertedBy: "user",
    eligibility: "eligible",
    assertionBasis: "classic",
    confidence: null,
    assertedAt: "2026-07-20T00:00:00.000Z",
    ...part,
  };
}

function resolve(
  assertions: PresentationAssertion[],
  over: Partial<PresentationIdentityPolicy> = {},
  base: EffectiveIdentity = GENERIC,
) {
  return resolvePresentationIdentity({ baseIdentity: base, assertions, policy: policy(over) });
}

describe("behavior-preserving fallthrough", () => {
  it("no assertions ⇒ the base (shared) identity, tier claim-backed, no chips", () => {
    expect(resolve([])).toEqual({ identity: GENERIC, tier: "claim-backed", suggestions: [] });
    const ext: EffectiveIdentity = { kind: "extension", extension: X };
    expect(resolve([], {}, ext)).toEqual({ identity: ext, tier: "claim-backed", suggestions: [] });
  });

  it("only archived assertions ⇒ base identity (archived never participates)", () => {
    const out = resolve([a({ extension: X, eligibility: "archived" })]);
    expect(out.identity).toEqual(GENERIC);
    expect(out.tier).toBe("claim-backed");
  });
});

describe("tier 1 — classic eligible assertions", () => {
  it("a single live user classic wins", () => {
    const out = resolve([a({ extension: X })]);
    expect(out).toEqual({ identity: { kind: "extension", extension: X }, tier: "classic", suggestions: [] });
  });

  it("rank order: user > authoring_skill > agent", () => {
    const out = resolve([
      a({ extension: Z, assertedBy: "agent" }),
      a({ extension: Y, assertedBy: "authoring_skill" }),
      a({ extension: X, assertedBy: "user" }),
    ]);
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
  });

  it("authoring_skill beats agent when no user assertion present", () => {
    const out = resolve([
      a({ extension: Z, assertedBy: "agent" }),
      a({ extension: Y, assertedBy: "authoring_skill" }),
    ]);
    expect(out.identity).toEqual({ kind: "extension", extension: Y });
  });

  it("same-rank tie-break: newest asserted_at, then lexicographic extension", () => {
    const newer = resolve([
      a({ extension: Y, assertedBy: "user", assertedAt: "2026-07-20T00:00:00.000Z" }),
      a({ extension: X, assertedBy: "user", assertedAt: "2026-07-21T00:00:00.000Z" }),
    ]);
    expect(newer.identity).toEqual({ kind: "extension", extension: X }); // newer wins

    const sameTime = resolve([
      a({ extension: Y, assertedBy: "user", assertedAt: "2026-07-20T00:00:00.000Z" }),
      a({ extension: X, assertedBy: "user", assertedAt: "2026-07-20T00:00:00.000Z" }),
    ]);
    expect(sameTime.identity).toEqual({ kind: "extension", extension: X }); // lexicographic
  });

  it("EXCLUDES an uninstalled extension — falls to the next live classic", () => {
    const out = resolve(
      [
        a({ extension: X, assertedBy: "user" }), // higher rank but NOT live
        a({ extension: Y, assertedBy: "agent" }), // lower rank, live
      ],
      { isExtensionLive: (e) => e === Y },
    );
    expect(out.identity).toEqual({ kind: "extension", extension: Y });
  });

  it("all classics uninstalled ⇒ falls through to tier 3 base identity", () => {
    const out = resolve([a({ extension: X, assertedBy: "user" })], { isExtensionLive: () => false });
    expect(out.identity).toEqual(GENERIC);
    expect(out.tier).toBe("claim-backed");
  });
});

describe("tier 1 vs binding — binding never competes in tier 1", () => {
  it("a classic agent assertion OUTRANKS an eligible binding (binding is tier 3)", () => {
    const out = resolve([
      a({ extension: X, assertedBy: "agent", assertionBasis: "classic" }),
      a({ extension: Y, assertedBy: "system", assertionBasis: "binding" }),
    ]);
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
  });
});

describe("tier 2 — matcher draft auto-surface", () => {
  const draft = (extension: string, confidence: number) =>
    a({ extension, assertedBy: "matcher", eligibility: "draft", confidence });

  it("a single threshold-passing draft auto-surfaces", () => {
    const out = resolve([draft(X, 0.9)]);
    expect(out).toEqual({ identity: { kind: "extension", extension: X }, tier: "matcher", suggestions: [] });
  });

  it("highest confidence wins; the loser becomes a suggestion chip", () => {
    const out = resolve([draft(X, 0.75), draft(Y, 0.95)]);
    expect(out.identity).toEqual({ kind: "extension", extension: Y });
    expect(out.tier).toBe("matcher");
    expect(out.suggestions).toEqual([X]);
  });

  it("TIE at the top confidence ⇒ NO auto-surface (both stay chips), tier 3", () => {
    const out = resolve([draft(X, 0.9), draft(Y, 0.9)]);
    expect(out.identity).toEqual(GENERIC);
    expect(out.tier).toBe("claim-backed");
    expect(out.suggestions).toEqual([X, Y]);
  });

  it("a sub-threshold draft never surfaces — it is a suggestion chip only", () => {
    const out = resolve([draft(X, 0.5)]); // threshold 0.7
    expect(out.identity).toEqual(GENERIC);
    expect(out.tier).toBe("claim-backed");
    expect(out.suggestions).toEqual([X]);
  });

  it("per-pack threshold is honored", () => {
    const out = resolve([draft(X, 0.6)], { matcherThreshold: (e) => (e === X ? 0.5 : 0.7) });
    expect(out.identity).toEqual({ kind: "extension", extension: X });
  });

  it("an uninstalled matcher draft neither surfaces NOR becomes a chip", () => {
    const out = resolve([draft(X, 0.99)], { isExtensionLive: () => false });
    expect(out.identity).toEqual(GENERIC);
    expect(out.suggestions).toEqual([]);
  });

  it("the org auto-surface toggle disables the tier — a would-be winner stays a chip", () => {
    const out = resolve([draft(X, 0.99)], { autoSurfaceDisabled: true });
    expect(out.identity).toEqual(GENERIC);
    expect(out.tier).toBe("claim-backed");
    expect(out.suggestions).toEqual([X]);
  });
});

describe("tier ordering — classic beats matcher", () => {
  it("a live classic wins even when a matcher draft is above threshold; the draft is a chip", () => {
    const out = resolve([
      a({ extension: X, assertedBy: "user", assertionBasis: "classic" }),
      a({ extension: Y, assertedBy: "matcher", eligibility: "draft", confidence: 0.99 }),
    ]);
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("classic");
    expect(out.suggestions).toEqual([Y]);
  });
});

describe("tier 3 — claim-backed identity", () => {
  it("an eligible binding whose extension is live resolves as the identity", () => {
    const out = resolve([a({ extension: X, assertedBy: "system", assertionBasis: "binding" })]);
    expect(out.identity).toEqual({ kind: "extension", extension: X });
    expect(out.tier).toBe("claim-backed");
  });

  it("a binding whose extension is NOT live falls back to the base identity", () => {
    const out = resolve([a({ extension: X, assertedBy: "system", assertionBasis: "binding" })], {
      isExtensionLive: () => false,
    });
    expect(out.identity).toEqual(GENERIC);
  });

  it("no binding ⇒ the type-namespace owner (base identity) stands", () => {
    const ext: EffectiveIdentity = { kind: "extension", extension: X };
    const out = resolve([], {}, ext);
    expect(out.identity).toEqual(ext);
  });
});

describe("suggestions are deterministic (deduped + sorted)", () => {
  it("sorts and de-duplicates the live matcher-draft chip set", () => {
    const out = resolve([
      a({ extension: Z, assertedBy: "matcher", eligibility: "draft", confidence: 0.5 }),
      a({ extension: X, assertedBy: "matcher", eligibility: "draft", confidence: 0.5 }),
      a({ extension: Y, assertedBy: "matcher", eligibility: "draft", confidence: 0.5 }),
    ]);
    expect(out.suggestions).toEqual([X, Y, Z].sort());
  });
});

// ---------------------------------------------------------------------------
// CRITICAL INVARIANT (conformance pin): presentation identity diverges from the
// SHARED effective identity by design; the shared resolver — the one context
// selection (#1430), replay pinning, and Graphiti projection consume — is
// untouched by the assertion axis that moves presentation identity.
// ---------------------------------------------------------------------------
describe("conformance pin — shared effective-identity resolver is untouched", () => {
  beforeEach(() => objectTypeRegistry._clearForTests());

  it("a classic user assertion moves PRESENTATION identity but NOT the shared effective identity", () => {
    // The generic base type has no defining extension ⇒ effective identity is
    // no-primary, whatever assertions exist.
    const base = resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE);
    expect(base).toEqual({ kind: "no-primary" });

    // With a live classic user assertion for X, presentation DIVERGES to X…
    const present = resolvePresentationIdentity({
      baseIdentity: base,
      assertions: [a({ extension: X, assertedBy: "user" })],
      policy: policy(),
    });
    expect(present.identity).toEqual({ kind: "extension", extension: X });

    // …while the SHARED resolver STILL returns the identical type-driven answer
    // (it never reads assertions). This is the pinned divergence.
    expect(resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE)).toEqual(base);
  });

  it("the shared resolver ignores matcher drafts and bindings alike (type axis only)", () => {
    const before = resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE);
    resolvePresentationIdentity({
      baseIdentity: before,
      assertions: [
        a({ extension: X, assertedBy: "matcher", eligibility: "draft", confidence: 0.99 }),
        a({ extension: Y, assertedBy: "system", assertionBasis: "binding" }),
      ],
      policy: policy(),
    });
    expect(resolveEffectiveIdentity(GENERIC_ARTIFACT_OBJECT_TYPE)).toEqual(before);
  });
});
