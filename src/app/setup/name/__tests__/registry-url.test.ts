// Regression coverage for the dev-vs-prod registry default.
//
// The setup wizard provisions a Verdaccio user against this URL. A fresh
// `make setup` dev install must target the LOCAL Verdaccio (anonymous
// self-registration enabled) instead of the hosted registry (self-registration
// disabled), or the wizard dead-ends. These cases pin that resolution and the
// precedence of an explicit override.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_REGISTRY_URL,
  PROD_REGISTRY_URL,
  resolveRegistryUrl,
} from "../registry-url";

describe("resolveRegistryUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an explicit CINATRA_AGENT_REGISTRY_URL, overriding the mode default", () => {
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "https://registry.example.test");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    expect(resolveRegistryUrl()).toBe("https://registry.example.test");
  });

  it("trims surrounding whitespace on the explicit override", () => {
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "  https://registry.example.test  ");
    expect(resolveRegistryUrl()).toBe("https://registry.example.test");
  });

  it("defaults to the local Verdaccio in development mode", () => {
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    expect(resolveRegistryUrl()).toBe(LOCAL_REGISTRY_URL);
  });

  it("treats an unset runtime mode as development (matches isAppDevelopmentMode)", () => {
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "");
    vi.stubEnv("APP_RUNTIME_MODE", "");
    expect(resolveRegistryUrl()).toBe(LOCAL_REGISTRY_URL);
  });

  it("defaults to the hosted registry in production mode", () => {
    vi.stubEnv("CINATRA_AGENT_REGISTRY_URL", "");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    expect(resolveRegistryUrl()).toBe(PROD_REGISTRY_URL);
  });
});
