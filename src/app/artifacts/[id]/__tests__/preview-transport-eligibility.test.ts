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

  // Required MIME-base expansion (epic #1883 A1). The four new system bases are
  // in the real generated map. text-artifact + json-artifact are INLINE (their
  // detail renderers fetch urls.preview), so their MIMEs must be added to the
  // safe-transport allowlist to be byte-eligible. zip-artifact + document-artifact
  // are DOWNLOAD SHELLS (their detail renderers never touch urls.preview), so
  // their MIMEs stay OUT of the allowlist and remain byte-INELIGIBLE — a system
  // base shipping a detail renderer does NOT auto-open the byte route unless the
  // type is in the safe-transport bound.
  it("admits the inline text/JSON bases (text/csv, application/json) via the allowlist", () => {
    expect(isInlineTransportEligible(ORG, "text/csv")).toBe(true);
    expect(isInlineTransportEligible(ORG, "application/json")).toBe(true);
    // The pre-existing text floor stays eligible; text-artifact now also backs them.
    expect(isInlineTransportEligible(ORG, "text/plain")).toBe(true);
    expect(isInlineTransportEligible(ORG, "text/markdown")).toBe(true);
  });

  it("keeps the download-shell bases (zip, office documents) byte-INELIGIBLE (not allowlisted)", () => {
    // zip-artifact is now a system base declaring `application/zip`, yet the type
    // is NOT in the safe-transport allowlist, so no provider binds ⇒ 415. This is
    // the download-shell contract (the renderer serves `actions.download`, never
    // `urls.preview`).
    expect(isInlineTransportEligible(ORG, "application/zip")).toBe(false);
    expect(isInlineTransportEligible(ORG, "application/x-zip-compressed")).toBe(false);
    for (const office of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
    ]) {
      expect(isInlineTransportEligible(ORG, office), office).toBe(false);
    }
  });
});
