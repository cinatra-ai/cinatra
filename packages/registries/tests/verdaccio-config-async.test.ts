// Tests for async Verdaccio config loading.
//
// `loadVerdaccioConfigAsync(readIdentity, decryptToken)` derives:
//   - packageScope = "@" + identity.instanceNamespace
//   - registryUrl in priority: env > identity.registryUrl > default
//   - throws InstanceNamespaceNotConfiguredError when readIdentity()→null AND no env override

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadVerdaccioConfigAsync,
  InstanceNamespaceNotConfiguredError,
  extractAgentPackage,
  getAgentPackage,
  listAgentPackages,
} from "@cinatra-ai/registries";
import type { InstanceIdentitySnapshot, VerdaccioConfig } from "@cinatra-ai/registries";

const ORIGINAL_ENV = {
  url: process.env.CINATRA_AGENT_REGISTRY_URL,
  token: process.env.CINATRA_AGENT_REGISTRY_TOKEN,
  scope: process.env.CINATRA_AGENT_REGISTRY_SCOPE,
};

function clearRegistryEnv(): void {
  delete process.env.CINATRA_AGENT_REGISTRY_URL;
  delete process.env.CINATRA_AGENT_REGISTRY_TOKEN;
  delete process.env.CINATRA_AGENT_REGISTRY_SCOPE;
}

function restoreEnv(): void {
  if (ORIGINAL_ENV.url === undefined) delete process.env.CINATRA_AGENT_REGISTRY_URL;
  else process.env.CINATRA_AGENT_REGISTRY_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token === undefined) delete process.env.CINATRA_AGENT_REGISTRY_TOKEN;
  else process.env.CINATRA_AGENT_REGISTRY_TOKEN = ORIGINAL_ENV.token;
  if (ORIGINAL_ENV.scope === undefined) delete process.env.CINATRA_AGENT_REGISTRY_SCOPE;
  else process.env.CINATRA_AGENT_REGISTRY_SCOPE = ORIGINAL_ENV.scope;
}

const SAMPLE_IDENTITY: InstanceIdentitySnapshot = {
  instanceNamespace: "example-namespace",
  tokenCiphertext: "ct-base64",
  tokenIv: "iv-base64",
};

const decryptTokenStub = (_input: { ciphertext: string; iv: string }) => "decrypted-token";

beforeEach(() => {
  clearRegistryEnv();
});

afterEach(() => {
  restoreEnv();
});

describe("loadVerdaccioConfigAsync instance identity resolution", () => {
  it("derives packageScope = '@' + instanceNamespace from injected reader", async () => {
    const readIdentity = () => SAMPLE_IDENTITY;
    const config = await loadVerdaccioConfigAsync(readIdentity, decryptTokenStub);
    expect(config.packageScope).toBe("@example-namespace");
  });

  it("populates token from decryptToken(identity.token{Ciphertext,Iv})", async () => {
    const readIdentity = () => SAMPLE_IDENTITY;
    const config = await loadVerdaccioConfigAsync(readIdentity, decryptTokenStub);
    expect(config.token).toBe("decrypted-token");
  });

  it("throws InstanceNamespaceNotConfiguredError when readIdentity() returns null and no env URL/token", async () => {
    const readIdentity = () => null;
    await expect(loadVerdaccioConfigAsync(readIdentity, decryptTokenStub)).rejects.toThrow(
      InstanceNamespaceNotConfiguredError,
    );
  });

  it("the thrown InstanceNamespaceNotConfiguredError carries code 'INSTANCE_NAMESPACE_NOT_CONFIGURED'", async () => {
    const readIdentity = () => null;
    let captured: unknown;
    try {
      await loadVerdaccioConfigAsync(readIdentity, decryptTokenStub);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(InstanceNamespaceNotConfiguredError);
    const errCode = (captured as { code?: string }).code;
    expect(errCode).toBe("INSTANCE_NAMESPACE_NOT_CONFIGURED");
  });
});

describe("loadVerdaccioConfigAsync registryUrl resolution", () => {
  it("defaults to 'https://registry.cinatra.ai' when identity has no registryUrl and no env override", async () => {
    const readIdentity = () => ({ ...SAMPLE_IDENTITY }); // no registryUrl field
    const config = await loadVerdaccioConfigAsync(readIdentity, decryptTokenStub);
    expect(config.registryUrl).toBe("https://registry.cinatra.ai");
  });

  it("env CINATRA_AGENT_REGISTRY_URL wins over identity.registryUrl", async () => {
    process.env.CINATRA_AGENT_REGISTRY_URL = "http://127.0.0.1:4873";
    const readIdentity = () => ({ ...SAMPLE_IDENTITY, registryUrl: "https://example.invalid" });
    const config = await loadVerdaccioConfigAsync(readIdentity, decryptTokenStub);
    expect(config.registryUrl).toBe("http://127.0.0.1:4873");
  });
});

// ---------------------------------------------------------------------------
// Explicit-DI fail-fast guard.
//
// Each server-context entry-point function in @cinatra-ai/registries (extract /
// get / list AgentPackage) accepts an optional `config?: VerdaccioConfig`.
// When called WITHOUT config, the body's `ensureConfig(...)` helper throws a
// typed error mentioning the missing DI requirement. This prevents silent
// failures when boot-time registry config has not been provided. The test
// asserts the typed-error path so a regression to implicit lookup fails the
// suite immediately.
// ---------------------------------------------------------------------------

const VALID_CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.cinatra.ai",
  packageScope: "@x",
  token: "t",
  uiUrl: "https://registry.cinatra.ai",
};

describe("DI fail-fast guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extractAgentPackage without config throws typed error mentioning DI requirement", async () => {
    await expect(
      extractAgentPackage({ packageName: "any-pkg", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/config parameter required/);
    await expect(
      extractAgentPackage({ packageName: "any-pkg", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/extractAgentPackage/);
  });

  it("getAgentPackage without config throws typed error mentioning DI requirement", async () => {
    await expect(
      getAgentPackage({ packageName: "any-pkg", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/config parameter required/);
    await expect(
      getAgentPackage({ packageName: "any-pkg", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/getAgentPackage/);
  });

  it("listAgentPackages without config throws typed error mentioning DI requirement", async () => {
    await expect(listAgentPackages({})).rejects.toThrow(/config parameter required/);
    await expect(listAgentPackages({})).rejects.toThrow(/listAgentPackages/);
  });

  it("extractAgentPackage with valid config does not throw the DI guard", async () => {
    // The DI guard triggers BEFORE pacote.extract is called. Calling with a
    // valid config skips that guard; the underlying network call may then fail
    // (registry unreachable in test env) — we only assert the DI message is
    // not the thrown one.
    let captured: unknown;
    try {
      await extractAgentPackage(
        { packageName: "any-pkg", packageVersion: "1.0.0" },
        VALID_CONFIG,
      );
    } catch (err) {
      captured = err;
    }
    if (captured instanceof Error) {
      expect(captured.message).not.toMatch(/config parameter required/);
    }
  });
});
