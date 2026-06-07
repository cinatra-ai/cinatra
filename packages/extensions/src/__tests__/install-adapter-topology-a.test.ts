// Independent Topology A (scope-based) install adapter test suite.
//
// Do not let same-interface framing erase the difference.
// This file tests ONLY the scope-based npm config adapter — distinct from topology-b.test.ts.
//
// Topology A contract:
//   args[0]: "--@<scope>:registry=<url>"   (scope-prefixed flag)
//   args[1]: "--//<host>/:_authToken=<token>"
//   routingMode: "scope-based"
//
// Publish token decrypted with aad "destination.<id>.publish-token";
// read token (when present) decrypted with aad "destination.<id>.read-token".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionOrigin } from "@cinatra-ai/agents/schema";

vi.mock("server-only", () => ({}));

const FIXTURE_DEST_ID = "fixture-dest-01";
const PRIVATE_REGISTRY_URL = "https://private.registry.example.com";
const PRIVATE_HOST = "private.registry.example.com";

// Base topology A deployment config fixture
const TOPOLOGY_A_FIXTURE = {
  publicRegistryUrl: "https://registry.cinatra.ai",
  publicReadToken: "fixture-public-read",
  publicPublishToken: null,
  privateRegistryUrl: PRIVATE_REGISTRY_URL,
  privateReadToken: "fixture-private-read",
  privatePublishToken: "fixture-private-publish",
  privateDestinationConfigured: true,
  privateDestinationId: FIXTURE_DEST_ID,
  routingMode: "scope-based" as const,
};

// Base credential row (publish token only)
const BASE_CREDENTIAL = {
  id: FIXTURE_DEST_ID,
  label: "Private Registry",
  registryUrl: PRIVATE_REGISTRY_URL,
  tokenCiphertext: "ciphertext-publish",
  tokenIv: "iv-publish",
  tokenAlgo: "aes-256-gcm",
  readTokenCiphertext: null as string | null,
  readTokenIv: null as string | null,
};

// Private origin JSONB
const PRIVATE_ORIGIN = {
  packageName: "@acme/test-agent",
  version: "1.0.0",
  destinationId: FIXTURE_DEST_ID,
  scope: "@acme",
  visibility: "private" as const,
  registryUrl: PRIVATE_REGISTRY_URL,
};

// ---------------------------------------------------------------------------
// Helper: set up all mocks needed for a private extension install
// ---------------------------------------------------------------------------
function setupTopologyAMocks(overrides?: {
  identity?: { vendorName?: string; instanceNamespace?: string } | null;
  credential?: typeof BASE_CREDENTIAL | null;
  origin?: ExtensionOrigin | null;
  decryptFn?: (input: { ciphertext: string; iv: string }, aad: string) => string;
}) {
  const identity = overrides?.identity !== undefined
    ? overrides.identity
    : { vendorName: "acme", instanceNamespace: "acme" };

  const credential = overrides?.credential !== undefined
    ? overrides.credential
    : BASE_CREDENTIAL;

  const origin = overrides?.origin !== undefined
    ? overrides.origin
    : PRIVATE_ORIGIN;

  const decryptFn = overrides?.decryptFn ?? (() => "decrypted-token");

  vi.doMock("@/lib/deployment-registry-config", () => ({
    loadDeploymentRegistryConfig: () => TOPOLOGY_A_FIXTURE,
    DeploymentRegistryConfigNotAvailableError: class DeploymentRegistryConfigNotAvailableError extends Error {
      readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
      constructor() {
        super("deployment config malformed — routingMode missing");
        this.name = "DeploymentRegistryConfigNotAvailableError";
      }
    },
  }));

  vi.doMock("@/lib/instance-identity-store", () => ({
    readInstanceIdentity: () => identity,
  }));

  const decryptMock = vi.fn(decryptFn);
  vi.doMock("@/lib/instance-secrets", () => ({
    decryptSecret: decryptMock,
  }));

  vi.doMock("@/lib/drizzle-store", () => ({
    readDestinationCredential: vi.fn(async () => credential),
  }));

  vi.doMock("@cinatra-ai/agents/store", () => ({
    readAgentTemplateOrigin: vi.fn(async () => origin),
    updateAgentTemplateOrigin: vi.fn(async () => {}),
  }));

  return { decryptMock };
}

describe("resolveInstallEnvironment — topology A (scope-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Core contract: scope-prefixed registry flag
  // -------------------------------------------------------------------------

  it("returns scope-prefixed registry flag for private extension", async () => {
    setupTopologyAMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.routingMode).toBe("scope-based");
    expect(env.registryUrl).toBe(PRIVATE_REGISTRY_URL);
    // Topology A: scope-prefixed registry flag
    expect(env.args).toContain(`--@acme:registry=${PRIVATE_REGISTRY_URL}`);
    // Host-scoped auth token
    expect(env.args.some((a) => a.startsWith(`--//${PRIVATE_HOST}/:_authToken=`))).toBe(true);
    expect(env.args).toHaveLength(2);
  });

  it("does NOT emit a plain --registry= flag in topology A (must use scope-prefixed form)", async () => {
    // Topology A scope-prefixed routing MUST NOT fall back to --registry= for private packages.
    // The two topologies differ precisely here.
    setupTopologyAMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    // No scope-less --registry= flag for private extensions in topology A
    expect(env.args.every((a) => !/^--registry=/.test(a))).toBe(true);
  });

  it("uses @cinatra-ai fallback scope when instance identity is null", async () => {
    setupTopologyAMocks({ identity: null });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.routingMode).toBe("scope-based");
    expect(env.args.some((a) => a.startsWith("--@cinatra-ai:registry="))).toBe(true);
  });

  it("uses @cinatra-ai fallback scope when instance identity has no vendorName or instanceNamespace", async () => {
    setupTopologyAMocks({ identity: {} });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.args.some((a) => a.startsWith("--@cinatra-ai:registry="))).toBe(true);
  });

  it("uses vendorName from identity when set (preferred over instanceNamespace)", async () => {
    setupTopologyAMocks({
      identity: { vendorName: "myvendor", instanceNamespace: "other" },
    });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@myvendor/test-agent");

    expect(env.args.some((a) => a.startsWith("--@myvendor:registry="))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Per-field AAD binding
  // -------------------------------------------------------------------------

  it("decrypts publish token with AAD 'destination.<id>.publish-token' when readToken absent", async () => {
    const { decryptMock } = setupTopologyAMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    await resolveInstallEnvironment("@acme/test-agent");

    expect(decryptMock).toHaveBeenCalledTimes(1);
    const [cryptoInput, aad] = decryptMock.mock.calls[0];
    expect(cryptoInput).toMatchObject({ ciphertext: "ciphertext-publish", iv: "iv-publish" });
    expect(aad).toBe(`destination.${FIXTURE_DEST_ID}.publish-token`);
  });

  it("decrypts read token with AAD 'destination.<id>.read-token' when readToken present", async () => {
    const credWithReadToken = {
      ...BASE_CREDENTIAL,
      readTokenCiphertext: "ciphertext-read",
      readTokenIv: "iv-read",
    };
    const { decryptMock } = setupTopologyAMocks({ credential: credWithReadToken });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    await resolveInstallEnvironment("@acme/test-agent");

    expect(decryptMock).toHaveBeenCalledTimes(1);
    const [cryptoInput, aad] = decryptMock.mock.calls[0];
    expect(cryptoInput).toMatchObject({ ciphertext: "ciphertext-read", iv: "iv-read" });
    expect(aad).toBe(`destination.${FIXTURE_DEST_ID}.read-token`);
  });

  it("auth token in args matches decrypted token value", async () => {
    setupTopologyAMocks({
      decryptFn: () => "my-decrypted-install-token",
    });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.args.some((a) => a.includes("my-decrypted-install-token"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Public extension path (same for both topologies — uses public registry)
  // -------------------------------------------------------------------------

  it("returns public --registry= args (not scope-prefixed) when extension visibility is public", async () => {
    setupTopologyAMocks({
      origin: {
        packageName: "@cinatra/public-agent",
        version: "2.0.0",
        destinationId: null,
        scope: "@cinatra",
        visibility: "public" as const,
        registryUrl: "https://registry.cinatra.ai",
      },
    });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@cinatra/public-agent");

    expect(env.registryUrl).toBe("https://registry.cinatra.ai");
    // Public path uses plain --registry= regardless of topology
    expect(env.args.some((a) => a.startsWith("--registry="))).toBe(true);
    // No scope-prefixed flag for public packages
    expect(env.args.every((a) => !/^--@[^:]+:registry=/.test(a))).toBe(true);
  });

  it("treats null origin (grandfathered row) as public extension", async () => {
    setupTopologyAMocks({ origin: null });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@cinatra/old-agent");

    // Grandfathered = public; uses plain --registry=
    expect(env.args.some((a) => a.startsWith("--registry="))).toBe(true);
    expect(env.args.every((a) => !/^--@[^:]+:registry=/.test(a))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it("throws PublishDestinationNotConfiguredError when private not configured", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        ...TOPOLOGY_A_FIXTURE,
        privateDestinationConfigured: false,
        privateRegistryUrl: null,
        privateDestinationId: null,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
    }));
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: () => ({ vendorName: "acme" }),
    }));
    vi.doMock("@/lib/instance-secrets", () => ({ decryptSecret: vi.fn(() => "tok") }));
    vi.doMock("@/lib/drizzle-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => PRIVATE_ORIGIN),
    }));

    const { resolveInstallEnvironment, PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    await expect(resolveInstallEnvironment("@acme/test-agent")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  it("throws PublishDestinationNotConfiguredError when credential row absent", async () => {
    setupTopologyAMocks({ credential: null });
    const { resolveInstallEnvironment, PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    await expect(resolveInstallEnvironment("@acme/test-agent")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });
});
