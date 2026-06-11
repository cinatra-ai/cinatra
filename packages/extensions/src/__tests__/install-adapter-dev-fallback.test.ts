// Dev-only local-Verdaccio install fallback for resolveInstallEnvironment.
//
// Covers the branch added so the dev publish->install loop works: when a
// PRIVATE extension has no configured destination AND CINATRA_RUNTIME_MODE ===
// "development" AND loadVerdaccioConfigForServer() yields a token, the resolver
// returns a topology-aware InstallEnvironment pointing at local Verdaccio
// instead of throwing PublishDestinationNotConfiguredError. Mirrors the publish
// paths' dev fallback (parity). Outside dev mode the throw is preserved.
//
// This is fix #1 nit 2 (the focused dev-fallback test) + exercises nit 1
// (the no-slash / empty-scope guard in scope derivation).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionOrigin } from "@cinatra-ai/agents/schema";

vi.mock("server-only", () => ({}));

const LOCAL_VERDACCIO_URL = "http://127.0.0.1:4873";
const LOCAL_VERDACCIO_HOST = "127.0.0.1:4873";
const DEV_TOKEN = "dev-verdaccio-token";
const CONFIG_SCOPE = "@operator-notebook-main-260508-084754";

// deployment config WITHOUT a configured private destination — the precondition
// for the dev fallback branch.
const NO_PRIVATE_DEST_FIXTURE = {
  publicRegistryUrl: "https://registry.cinatra.ai",
  publicReadToken: "fixture-public-read",
  publicPublishToken: null,
  privateRegistryUrl: null as string | null,
  privateReadToken: null as string | null,
  privatePublishToken: null as string | null,
  privateDestinationConfigured: false,
  privateDestinationId: null as string | null,
  routingMode: "scope-based" as const,
};

const PRIVATE_ORIGIN: ExtensionOrigin = {
  packageName: "@cinatra-ai/web-scrape-agent",
  version: "0.1.4",
  destinationId: null as unknown as string,
  scope: "@cinatra-ai",
  visibility: "private",
  registryUrl: LOCAL_VERDACCIO_URL,
};

function setupDevFallbackMocks(overrides?: {
  origin?: ExtensionOrigin | null;
  verdaccioToken?: string | null;
  verdaccioPackageScope?: string;
}) {
  const origin = overrides?.origin !== undefined ? overrides.origin : PRIVATE_ORIGIN;
  const token = overrides?.verdaccioToken !== undefined ? overrides.verdaccioToken : DEV_TOKEN;
  const packageScope = overrides?.verdaccioPackageScope ?? CONFIG_SCOPE;

  vi.doMock("@/lib/deployment-registry-config", () => ({
    loadDeploymentRegistryConfig: () => NO_PRIVATE_DEST_FIXTURE,
    DeploymentRegistryConfigNotAvailableError: class DeploymentRegistryConfigNotAvailableError extends Error {
      readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
      constructor() {
        super("deployment config malformed — routingMode missing");
        this.name = "DeploymentRegistryConfigNotAvailableError";
      }
    },
  }));

  // origin read drives visibility === "private"
  vi.doMock("@cinatra-ai/agents/store", () => ({
    readAgentTemplateOrigin: vi.fn(async () => origin),
    updateAgentTemplateOrigin: vi.fn(async () => {}),
  }));

  // the dev fallback dynamically imports this
  vi.doMock("@/lib/verdaccio-config", () => ({
    loadVerdaccioConfigForServer: vi.fn(async () => ({
      registryUrl: LOCAL_VERDACCIO_URL,
      token,
      packageScope,
      uiUrl: LOCAL_VERDACCIO_URL,
    })),
  }));

  // Reached only if the fallback does NOT short-circuit — mocked defensively.
  vi.doMock("@/lib/extension-destinations-store", () => ({
    readDestinationCredential: vi.fn(async () => null),
  }));
}

describe("resolveInstallEnvironment — dev-only local Verdaccio fallback", () => {
  const PRIOR_MODE = process.env.CINATRA_RUNTIME_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CINATRA_RUNTIME_MODE = "development";
  });

  afterEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    if (PRIOR_MODE === undefined) delete process.env.CINATRA_RUNTIME_MODE;
    else process.env.CINATRA_RUNTIME_MODE = PRIOR_MODE;
  });

  it("returns a local-Verdaccio InstallEnvironment for a private pkg with no configured destination (dev mode)", async () => {
    setupDevFallbackMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@cinatra-ai/web-scrape-agent");

    expect(env.routingMode).toBe("scope-based");
    expect(env.registryUrl).toBe(LOCAL_VERDACCIO_URL);
    // Topology A: routes by the package's OWN scope (@cinatra-ai), not the config scope.
    expect(env.args).toContain(`--@cinatra-ai:registry=${LOCAL_VERDACCIO_URL}`);
    expect(env.args.some((a) => a.startsWith(`--//${LOCAL_VERDACCIO_HOST}/:_authToken=`))).toBe(true);
    expect(env.args).toHaveLength(2);
  });

  it("throws PublishDestinationNotConfiguredError when NOT in development mode (prod posture preserved)", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupDevFallbackMocks();
    const { resolveInstallEnvironment, PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    await expect(resolveInstallEnvironment("@cinatra-ai/web-scrape-agent")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("throws PublishDestinationNotConfiguredError when the dev Verdaccio token is absent", async () => {
    setupDevFallbackMocks({ verdaccioToken: null });
    const { resolveInstallEnvironment, PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    await expect(resolveInstallEnvironment("@cinatra-ai/web-scrape-agent")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("nit 1: a no-slash extensionId falls back to the config packageScope (no truncation)", async () => {
    // extensionId "@nslash" has no "/" — the guard must NOT slice it to "@nslas".
    setupDevFallbackMocks({
      origin: { ...PRIVATE_ORIGIN, packageName: "@nslash" },
      verdaccioPackageScope: CONFIG_SCOPE,
    });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@nslash");

    // Falls back to the config scope, NOT the truncated "@nslas".
    expect(env.args).toContain(`--${CONFIG_SCOPE}:registry=${LOCAL_VERDACCIO_URL}`);
    expect(env.args.every((a) => !a.includes("@nslas:"))).toBe(true);
  });
});
