import { afterEach, describe, expect, it, vi } from "vitest";

import { detectMarketplaceEnvConflict } from "@/lib/marketplace-env-conflict";

describe("detectMarketplaceEnvConflict", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when MARKETPLACE_INSTANCE_TOKEN is unset", () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_TOKEN", "anything");
    expect(detectMarketplaceEnvConflict()).toBeNull();
  });

  it("returns null when only MARKETPLACE_INSTANCE_TOKEN is set (no conflict)", () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "mp-token");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_TOKEN", "");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_SCOPE", "");
    expect(detectMarketplaceEnvConflict()).toBeNull();
  });

  it("flags conflict when CINATRA_AGENT_REGISTRY_TOKEN is also set", () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "mp-token");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_TOKEN", "pre-provisioned");
    const result = detectMarketplaceEnvConflict();
    expect(result?.conflict).toBe(true);
    expect(result?.reason).toContain("CINATRA_AGENT_REGISTRY_TOKEN");
  });

  it("flags conflict listing all set env vars", () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "mp-token");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_TOKEN", "x");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "https://example");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_SCOPE", "@x");
    const result = detectMarketplaceEnvConflict();
    expect(result?.reason).toContain("CINATRA_AGENT_REGISTRY_TOKEN");
    expect(result?.reason).toContain("CINATRA_AGENT_REGISTRY_URL");
    expect(result?.reason).toContain("CINATRA_AGENT_REGISTRY_SCOPE");
  });

  it("treats whitespace-only env values as unset", () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "mp-token");
    vi.stubEnv("CINATRA_AGENT_REGISTRY_TOKEN", "   ");
    expect(detectMarketplaceEnvConflict()).toBeNull();
  });
});
