import { afterEach, describe, expect, it, vi } from "vitest";

import { getMarketplaceTermsAcceptance } from "@/lib/marketplace-terms";

describe("getMarketplaceTermsAcceptance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits a full 64-char sha256 digest (not the legacy 16-char slice)", () => {
    const a = getMarketplaceTermsAcceptance();
    expect(a.termsDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same version+url", () => {
    vi.stubEnv("MARKETPLACE_TERMS_VERSION", "1.2.3");
    vi.stubEnv("MARKETPLACE_TERMS_URL", "https://marketplace.cinatra.ai/terms");
    const a = getMarketplaceTermsAcceptance();
    const b = getMarketplaceTermsAcceptance();
    expect(a.termsDigest).toBe(b.termsDigest);
    expect(a.termsVersion).toBe("1.2.3");
  });

  it("emits a different digest when the version changes", () => {
    vi.stubEnv("MARKETPLACE_TERMS_URL", "https://marketplace.cinatra.ai/terms");
    vi.stubEnv("MARKETPLACE_TERMS_VERSION", "1.0.0");
    const a = getMarketplaceTermsAcceptance();
    vi.stubEnv("MARKETPLACE_TERMS_VERSION", "1.1.0");
    const b = getMarketplaceTermsAcceptance();
    expect(a.termsDigest).not.toBe(b.termsDigest);
  });

  it("falls back to documented defaults when env unset", () => {
    vi.stubEnv("MARKETPLACE_TERMS_VERSION", "");
    vi.stubEnv("MARKETPLACE_TERMS_URL", "");
    const a = getMarketplaceTermsAcceptance();
    expect(a.termsVersion).toBe("0.1.0-DRAFT");
    expect(a.termsUrl).toBe("https://marketplace.cinatra.ai/terms");
  });
});
