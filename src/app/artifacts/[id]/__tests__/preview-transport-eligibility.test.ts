/**
 * `isInlineTransportEligible` — the preview BYTE route's capability-resolved
 * eligibility (cinatra#1630 AC-2). Exercised against the REAL arbitration
 * registries + the real generated build map (the four system `-artifact` bases),
 * so the security boundary is proven, not mocked:
 *
 *  - a `preview`-slot provider (system image/pdf, OR an admitted marketplace
 *    provider — capability EXPANSION) opens the byte route;
 *  - a detail-ONLY SYSTEM base (audio/video) opens it (their bytes are
 *    range-served) — but a THIRD-PARTY detail-only renderer does NOT (Codex
 *    convergence: shipping a detail view must not silently grant byte authority);
 *  - the markdown/text first-party floor stays eligible;
 *  - an unbound MIME (e.g. image/bmp, video/quicktime, application/zip) is
 *    ineligible; and retiring a marketplace provider FAILS CLOSED;
 *  - eligibility is org-scoped.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { isInlineTransportEligible, _resetFirstPartySeedForTests } from "../renderer-resolution";

const ORG = "org_elig";
const OTHER_ORG = "org_other";
const THIRD_PARTY = "@acme/thing-artifact"; // NOT in the generated map ⇒ not a system base

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

describe("isInlineTransportEligible — capability-resolved byte-route eligibility", () => {
  it("admits a system PREVIEW-slot base (image) — reconciled self-healing, no explicit setup", () => {
    // The four system bases reconcile inside the resolve; image-artifact ships a
    // `preview` renderer, so image/png is preview-eligible for any org.
    expect(isInlineTransportEligible(ORG, "image/png")).toBe(true);
    expect(isInlineTransportEligible(ORG, "application/pdf")).toBe(true);
  });

  it("admits a detail-ONLY system base (audio/video) via the system-detail branch (preview slot is genuinely empty)", () => {
    // audio/video ship detail-only (no preview renderer) AND pickHandler yields no
    // first-party preview default for them — so the `preview` slot has NO provider.
    // Eligibility MUST therefore come from the SYSTEM-detail branch (their bytes are
    // range-served). Prove BOTH: eligible, yet the preview slot resolves to nothing,
    // while the detail slot resolves the system base (so a future regression that
    // wrongly seeded a preview default, OR broke the detail branch, is caught).
    expect(isInlineTransportEligible(ORG, "audio/mpeg")).toBe(true);
    expect(isInlineTransportEligible(ORG, "video/mp4")).toBe(true);
    // The reconcile + first-party seed already ran inside isInlineTransportEligible:
    expect(representationProviderRegistry.resolve(ORG, "audio/mpeg", "preview")).toBeNull();
    expect(representationProviderRegistry.resolve(ORG, "audio/mpeg", "detail")?.tier).toBe("extension");
    expect(representationProviderRegistry.resolve(ORG, "video/mp4", "preview")).toBeNull();
    expect(representationProviderRegistry.resolve(ORG, "video/mp4", "detail")?.tier).toBe("extension");
  });

  it("keeps the markdown/text first-party floor eligible", () => {
    expect(isInlineTransportEligible(ORG, "text/plain")).toBe(true);
    expect(isInlineTransportEligible(ORG, "text/markdown")).toBe(true);
  });

  it("rejects an unbound MIME (fail closed) — bmp/quicktime/zip are never serveable", () => {
    // Within a system wildcard family but OUTSIDE the safe-transport bound, and a
    // wholly unhandled type: no effective provider ⇒ 415.
    expect(isInlineTransportEligible(ORG, "image/bmp")).toBe(false);
    expect(isInlineTransportEligible(ORG, "video/quicktime")).toBe(false);
    expect(isInlineTransportEligible(ORG, "application/zip")).toBe(false);
  });

  it("does NOT grant byte authority to a THIRD-PARTY detail-only renderer (Codex B)", () => {
    // A non-system extension shipping ONLY a `detail` provider must not open the
    // byte route — only `preview` providers or the host's own system bases do.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: THIRD_PARTY,
      pattern: "application/acme",
      slot: "detail",
      generation: 1,
    });
    expect(isInlineTransportEligible(ORG, "application/acme")).toBe(false);
  });

  it("admits a THIRD-PARTY PREVIEW provider — capability expansion with no host edit", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: THIRD_PARTY,
      pattern: "application/acme",
      slot: "preview",
      generation: 1,
    });
    expect(isInlineTransportEligible(ORG, "application/acme")).toBe(true);
  });

  it("FAILS CLOSED when a marketplace preview provider is retired (revocation-via-lifecycle)", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: THIRD_PARTY,
      pattern: "application/acme",
      slot: "preview",
      generation: 1,
    });
    expect(isInlineTransportEligible(ORG, "application/acme")).toBe(true);

    representationProviderRegistry.retireProvidersByPackage(THIRD_PARTY);
    // The reconcile inside the resolve re-heals SYSTEM bases only (not @acme), so
    // the retired marketplace provider stays gone ⇒ the stale preview URL 415s.
    expect(isInlineTransportEligible(ORG, "application/acme")).toBe(false);
  });

  it("is org-scoped — a marketplace preview provider in one org does not leak to another", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: THIRD_PARTY,
      pattern: "application/acme",
      slot: "preview",
      generation: 1,
    });
    expect(isInlineTransportEligible(ORG, "application/acme")).toBe(true);
    expect(isInlineTransportEligible(OTHER_ORG, "application/acme")).toBe(false);
  });
});
