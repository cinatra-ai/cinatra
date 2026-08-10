// Dev-only local-Verdaccio PUBLISH fallback for resolvePublishDestination
// (cinatra#2644 — install/publish parity).
//
// Covers the branch added so agent upload works on a fresh dev instance: when
// the PRIVATE destination is not configured AND CINATRA_RUNTIME_MODE ===
// "development" AND loadVerdaccioConfigForServer() yields a token, the resolver
// returns the local-Verdaccio VerdaccioConfig instead of throwing
// PublishDestinationNotConfiguredError. Mirrors the install path's
// resolveDevLocalVerdaccioInstallEnvironment (install-adapter-dev-fallback
// suite). Outside dev mode, and for the PUBLIC visibility, the throw is
// preserved.
//
// Also covers isPrivatePublishDestinationAvailable — the UI availability probe
// parent RSCs thread into PublishDestinationPicker (previously the prop was
// never threaded, so the picker always showed the not-configured notice).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const LOCAL_VERDACCIO_URL = "http://127.0.0.1:4873";
const DEV_TOKEN = "dev-verdaccio-token";
const CONFIG_SCOPE = "@operator-notebook-main-260508-084754";

// deployment config WITHOUT a configured private destination — the precondition
// for the dev fallback branch (the fresh-dev-instance fixture default).
const NO_PRIVATE_DEST_FIXTURE = {
  publicRegistryUrl: "https://registry.cinatra.ai",
  publicReadToken: "fixture-public-read",
  publicPublishToken: null as string | null,
  privateRegistryUrl: null as string | null,
  privateReadToken: null as string | null,
  privatePublishToken: null as string | null,
  privateDestinationConfigured: false,
  privateDestinationId: null as string | null,
  routingMode: "shared-acl" as const,
};

function setupMocks(overrides?: {
  deployConfig?: Record<string, unknown>;
  verdaccioToken?: string | null;
  verdaccioThrows?: boolean;
  destinationCredential?: Record<string, unknown> | null;
}) {
  const token =
    overrides?.verdaccioToken !== undefined ? overrides.verdaccioToken : DEV_TOKEN;

  vi.doMock("@/lib/deployment-registry-config", () => ({
    loadDeploymentRegistryConfig: () =>
      overrides?.deployConfig ?? NO_PRIVATE_DEST_FIXTURE,
    DeploymentRegistryConfigNotAvailableError: class DeploymentRegistryConfigNotAvailableError extends Error {
      readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
      constructor() {
        super("deployment config malformed — routingMode missing");
        this.name = "DeploymentRegistryConfigNotAvailableError";
      }
    },
  }));

  // The dev fallback dynamically imports this.
  vi.doMock("@/lib/verdaccio-config", () => ({
    loadVerdaccioConfigForServer: vi.fn(async () => {
      if (overrides?.verdaccioThrows) {
        throw new Error("no instance identity — vendor not provisioned");
      }
      return {
        registryUrl: LOCAL_VERDACCIO_URL,
        token,
        packageScope: CONFIG_SCOPE,
        uiUrl: LOCAL_VERDACCIO_URL,
      };
    }),
  }));

  vi.doMock("@/lib/extension-destinations-store", () => ({
    readDestinationCredential: vi.fn(
      async () => overrides?.destinationCredential ?? null,
    ),
  }));

  vi.doMock("@/lib/instance-identity-store", () => ({
    readInstanceIdentity: vi.fn(() => null),
  }));

  vi.doMock("@/lib/instance-secrets", () => ({
    decryptSecret: vi.fn(
      ({ ciphertext }: { ciphertext: string }) =>
        ciphertext.replace(/^enc\(/, "").replace(/\)$/, ""),
    ),
  }));
}

describe("resolvePublishDestination — dev-only local Verdaccio fallback (cinatra#2644)", () => {
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

  it("returns the local-Verdaccio config for 'private' with no configured destination (dev mode)", async () => {
    setupMocks();
    const { resolvePublishDestination } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    const config = await resolvePublishDestination("private");

    expect(config.registryUrl).toBe(LOCAL_VERDACCIO_URL);
    expect(config.token).toBe(DEV_TOKEN);
    // No override — the fallback config's own scope is preserved verbatim
    // (exactly what the MCP handlers' catch-based fallback produced).
    expect(config.packageScope).toBe(CONFIG_SCOPE);
  });

  it("propagates the dev-mode vendorScopeOverride onto the fallback config", async () => {
    setupMocks();
    const { resolvePublishDestination } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    const config = await resolvePublishDestination("private", {
      vendorScopeOverride: "acme",
    });

    expect(config.registryUrl).toBe(LOCAL_VERDACCIO_URL);
    expect(config.packageScope).toBe("@acme");
  });

  it("falls back when the destination is CONFIGURED but the stored credential is missing (dev mode)", async () => {
    setupMocks({
      deployConfig: {
        ...NO_PRIVATE_DEST_FIXTURE,
        privateRegistryUrl: "https://private.registry.example.com",
        privateReadToken: "fixture-private-read",
        privatePublishToken: "fixture-private-publish",
        privateDestinationConfigured: true,
        privateDestinationId: "fixture-dest-01",
      },
      destinationCredential: null,
    });
    const { resolvePublishDestination } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    const config = await resolvePublishDestination("private");
    expect(config.registryUrl).toBe(LOCAL_VERDACCIO_URL);
  });

  it("still throws PublishDestinationNotConfiguredError outside development mode", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupMocks();
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } =
      await import("@cinatra-ai/extensions/destination-resolver");

    await expect(resolvePublishDestination("private")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("distinguishes the credential-missing reason outside dev mode (codex round 0)", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupMocks({
      deployConfig: {
        ...NO_PRIVATE_DEST_FIXTURE,
        privateRegistryUrl: "https://private.registry.example.com",
        privateReadToken: "fixture-private-read",
        privateDestinationConfigured: true,
        privateDestinationId: "fixture-dest-01",
      },
      destinationCredential: null,
    });
    const { resolvePublishDestination } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    const err = await resolvePublishDestination("private").catch((e) => e);
    expect(err.code).toBe("PUBLISH_DESTINATION_NOT_CONFIGURED");
    expect(err.reason).toBe("credential-missing");
    expect(err.message).toContain("credential");
    // The env keys alone do NOT fix a missing credential — the message must
    // not send the operator to them for this case.
    expect(err.message).not.toContain("CINATRA_DEPLOYMENT_REGISTRY_PRIVATE_URL");
  });

  it("still throws when the Verdaccio loader itself fails (dev mode, no seeded registry)", async () => {
    setupMocks({ verdaccioThrows: true });
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } =
      await import("@cinatra-ai/extensions/destination-resolver");

    await expect(resolvePublishDestination("private")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("still throws when the Verdaccio config has no token (dev mode)", async () => {
    setupMocks({ verdaccioToken: null });
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } =
      await import("@cinatra-ai/extensions/destination-resolver");

    await expect(resolvePublishDestination("private")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("does NOT fall back for 'public' — public publishing still requires the publish token (dev mode)", async () => {
    setupMocks();
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } =
      await import("@cinatra-ai/extensions/destination-resolver");

    await expect(resolvePublishDestination("public")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });
});

describe("isPrivatePublishDestinationAvailable (cinatra#2644 UI probe)", () => {
  const PRIOR_MODE = process.env.CINATRA_RUNTIME_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    if (PRIOR_MODE === undefined) delete process.env.CINATRA_RUNTIME_MODE;
    else process.env.CINATRA_RUNTIME_MODE = PRIOR_MODE;
  });

  it("true when the config declares a private destination AND its credential is stored (any mode)", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupMocks({
      deployConfig: {
        ...NO_PRIVATE_DEST_FIXTURE,
        privateRegistryUrl: "https://private.registry.example.com",
        privateReadToken: "fixture-private-read",
        privateDestinationConfigured: true,
        privateDestinationId: "fixture-dest-01",
      },
      destinationCredential: {
        registryUrl: "https://private.registry.example.com",
        tokenCiphertext: "enc(fixture-private-publish)",
        tokenIv: "mock-iv",
      },
    });
    const { isPrivatePublishDestinationAvailable } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    expect(await isPrivatePublishDestinationAvailable()).toBe(true);
  });

  it("false in production when the destination is configured but its credential is MISSING (codex round 0)", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupMocks({
      deployConfig: {
        ...NO_PRIVATE_DEST_FIXTURE,
        privateRegistryUrl: "https://private.registry.example.com",
        privateReadToken: "fixture-private-read",
        privateDestinationConfigured: true,
        privateDestinationId: "fixture-dest-01",
      },
      destinationCredential: null,
    });
    const { isPrivatePublishDestinationAvailable } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    expect(await isPrivatePublishDestinationAvailable()).toBe(false);
  });

  it("true in dev mode when only the local-Verdaccio fallback is available", async () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    setupMocks();
    const { isPrivatePublishDestinationAvailable } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    expect(await isPrivatePublishDestinationAvailable()).toBe(true);
  });

  it("false outside dev mode with no configured destination", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    setupMocks();
    const { isPrivatePublishDestinationAvailable } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    expect(await isPrivatePublishDestinationAvailable()).toBe(false);
  });

  it("false in dev mode when the Verdaccio loader fails (no seeded registry)", async () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    setupMocks({ verdaccioThrows: true });
    const { isPrivatePublishDestinationAvailable } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    expect(await isPrivatePublishDestinationAvailable()).toBe(false);
  });
});
