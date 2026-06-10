// Independent Topology B (shared-ACL) install adapter test suite.
//
// Locked decision: "do not let same-interface framing erase the difference."
// This file tests ONLY the shared-acl adapter — distinct from topology-a.test.ts.
//
// Topology B contract:
//   args[0]: "--registry=<url>"             (plain registry override — no scope prefix)
//   args[1]: "--//<host>/:_authToken=<token>"
//   routingMode: "shared-acl"
//
// Publish token decrypted with aad "destination.<id>.publish-token";
// read token (when present) decrypted with aad "destination.<id>.read-token".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionOrigin } from "@cinatra-ai/agents/schema";

vi.mock("server-only", () => ({}));

const FIXTURE_DEST_ID = "fixture-dest-01";
const PRIVATE_REGISTRY_URL = "https://private.registry.example.com";
const PRIVATE_HOST = "private.registry.example.com";

// Base topology B deployment config fixture
const TOPOLOGY_B_FIXTURE = {
  publicRegistryUrl: "https://registry.cinatra.ai",
  publicReadToken: "fixture-public-read",
  publicPublishToken: null,
  privateRegistryUrl: PRIVATE_REGISTRY_URL,
  privateReadToken: "fixture-private-read",
  privatePublishToken: "fixture-private-publish",
  privateDestinationConfigured: true,
  privateDestinationId: FIXTURE_DEST_ID,
  routingMode: "shared-acl" as const,
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
function setupTopologyBMocks(overrides?: {
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
    loadDeploymentRegistryConfig: () => TOPOLOGY_B_FIXTURE,
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

  vi.doMock("@/lib/extension-destinations-store", () => ({
    readDestinationCredential: vi.fn(async () => credential),
  }));

  vi.doMock("@cinatra-ai/agents/store", () => ({
    readAgentTemplateOrigin: vi.fn(async () => origin),
    updateAgentTemplateOrigin: vi.fn(async () => {}),
  }));

  return { decryptMock };
}

describe("resolveInstallEnvironment — topology B (shared-acl)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Core contract: plain --registry= flag (no scope prefix)
  // -------------------------------------------------------------------------

  it("returns plain --registry= flag and host-scoped auth flag for private extension", async () => {
    setupTopologyBMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.routingMode).toBe("shared-acl");
    expect(env.registryUrl).toBe(PRIVATE_REGISTRY_URL);
    // Topology B: plain --registry= flag
    expect(env.args).toContain(`--registry=${PRIVATE_REGISTRY_URL}`);
    // Host-scoped auth token
    expect(env.args.some((a) => a.startsWith(`--//${PRIVATE_HOST}/:_authToken=`))).toBe(true);
    expect(env.args).toHaveLength(2);
  });

  it("does NOT emit a scope-prefixed registry flag in topology B", async () => {
    // Topology B MUST NOT emit --@<scope>:registry= — that is topology A only.
    // The two topologies differ precisely here.
    setupTopologyBMocks();
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    // No scope-prefixed flag in topology B
    expect(env.args.every((a) => !/^--@[^:]+:registry=/.test(a))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Per-field AAD binding
  // -------------------------------------------------------------------------

  it("decrypts publish token with AAD 'destination.<id>.publish-token' when readToken absent", async () => {
    const { decryptMock } = setupTopologyBMocks();
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
    const { decryptMock } = setupTopologyBMocks({ credential: credWithReadToken });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    await resolveInstallEnvironment("@acme/test-agent");

    expect(decryptMock).toHaveBeenCalledTimes(1);
    const [cryptoInput, aad] = decryptMock.mock.calls[0];
    expect(cryptoInput).toMatchObject({ ciphertext: "ciphertext-read", iv: "iv-read" });
    expect(aad).toBe(`destination.${FIXTURE_DEST_ID}.read-token`);
  });

  it("auth token in args matches decrypted token value", async () => {
    setupTopologyBMocks({
      decryptFn: () => "my-shared-acl-token",
    });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@acme/test-agent");

    expect(env.args.some((a) => a.includes("my-shared-acl-token"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Topology B does not need scope — identity is irrelevant for routing
  // -------------------------------------------------------------------------

  it("emits the same --registry= flag regardless of instance identity (identity is irrelevant for topology B routing)", async () => {
    setupTopologyBMocks({ identity: null });
    const { resolveInstallEnvironment: resolveNull } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const envNoIdentity = await resolveNull("@acme/test-agent");
    vi.resetModules();

    setupTopologyBMocks({ identity: { vendorName: "somevendor" } });
    const { resolveInstallEnvironment: resolveWithIdentity } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const envWithIdentity = await resolveWithIdentity("@acme/test-agent");

    // Both cases emit the same registry flag (topology B doesn't scope-route)
    expect(envNoIdentity.args[0]).toBe(`--registry=${PRIVATE_REGISTRY_URL}`);
    expect(envWithIdentity.args[0]).toBe(`--registry=${PRIVATE_REGISTRY_URL}`);
    expect(envNoIdentity.args[0]).toBe(envWithIdentity.args[0]);
  });

  // -------------------------------------------------------------------------
  // Public extension path (same for both topologies — uses public registry)
  // -------------------------------------------------------------------------

  it("returns public --registry= args when extension visibility is public", async () => {
    setupTopologyBMocks({
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
    expect(env.args.some((a) => a.startsWith("--registry="))).toBe(true);
    expect(env.args.every((a) => !/^--@[^:]+:registry=/.test(a))).toBe(true);
  });

  it("treats null origin (grandfathered row) as public extension", async () => {
    setupTopologyBMocks({ origin: null });
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    const env = await resolveInstallEnvironment("@cinatra/old-agent");

    expect(env.args.some((a) => a.startsWith("--registry="))).toBe(true);
    expect(env.args.every((a) => !/^--@[^:]+:registry=/.test(a))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it("throws PublishDestinationNotConfiguredError when private not configured", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        ...TOPOLOGY_B_FIXTURE,
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
    vi.doMock("@/lib/extension-destinations-store", () => ({
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
    setupTopologyBMocks({ credential: null });
    const { resolveInstallEnvironment, PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );

    await expect(resolveInstallEnvironment("@acme/test-agent")).rejects.toBeInstanceOf(
      PublishDestinationNotConfiguredError,
    );
  });

  // -------------------------------------------------------------------------
  // Shared: DeploymentRegistryConfigNotAvailableError for missing routingMode
  // -------------------------------------------------------------------------

  it("throws when routingMode is missing from deployment config (both topologies share this gate)", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => {
      class DeploymentRegistryConfigNotAvailableError extends Error {
        readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
        constructor() {
          super("deployment config malformed — routingMode missing");
          this.name = "DeploymentRegistryConfigNotAvailableError";
        }
      }
      return {
        // Loader returns config WITH routingMode; the resolver checks it.
        // Simulate missing routingMode by returning a config without it:
        loadDeploymentRegistryConfig: () => ({
          ...TOPOLOGY_B_FIXTURE,
          routingMode: undefined as unknown as "shared-acl",
        }),
        DeploymentRegistryConfigNotAvailableError,
      };
    });
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: () => ({ vendorName: "acme" }),
    }));
    vi.doMock("@/lib/instance-secrets", () => ({ decryptSecret: vi.fn(() => "tok") }));
    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentTemplateOrigin: vi.fn(async () => PRIVATE_ORIGIN),
    }));

    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");

    await expect(resolveInstallEnvironment("@acme/test-agent")).rejects.toMatchObject({
      code: "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE",
    });
  });
});
