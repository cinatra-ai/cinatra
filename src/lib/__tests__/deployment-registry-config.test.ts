// Contract tests for loadDeploymentRegistryConfig.
//
// The loader resolves its config source cohesively (all-or-none):
//   - a live env config wins;
//   - otherwise the in-repo fixture is served ONLY in development mode or under the
//     explicit CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE=true opt-in;
//   - otherwise (production, no live config, no opt-in) it FAILS CLOSED so the
//     fixture can never silently back a production deployment.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadDeploymentRegistryConfig,
  DeploymentRegistryConfigNotAvailableError,
  DeploymentRegistryConfigNotConfiguredError,
  DeploymentRegistryConfigIncoherentError,
  DEPLOYMENT_REGISTRY_ENV,
  ALLOW_FIXTURE_ENV,
} from "@/lib/deployment-registry-config";

const FIXTURE_URL = "https://registry.cinatra.ai";
// A DISTINCT live URL — proves the env path is used, not the fixture.
const LIVE_URL = "https://registry.example.test";

// Every env key the loader consults; snapshot + restore around each test so no
// state leaks between cases (and the suite is order-independent).
const MUTABLE_KEYS = [
  "CINATRA_RUNTIME_MODE",
  "APP_RUNTIME_MODE",
  ALLOW_FIXTURE_ENV,
  ...Object.values(DEPLOYMENT_REGISTRY_ENV),
] as const;

let snapshot: Record<string, string | undefined> = {};

function clearAll() {
  for (const key of MUTABLE_KEYS) delete process.env[key];
}

function setProd() {
  process.env.CINATRA_RUNTIME_MODE = "production";
}
function setDev() {
  process.env.CINATRA_RUNTIME_MODE = "development";
}

function setFullPublicEnv(url: string = LIVE_URL) {
  process.env[DEPLOYMENT_REGISTRY_ENV.publicUrl] = url;
  process.env[DEPLOYMENT_REGISTRY_ENV.publicReadToken] = "env-public-read";
  process.env[DEPLOYMENT_REGISTRY_ENV.routingMode] = "shared-acl";
}

beforeEach(() => {
  snapshot = {};
  for (const key of MUTABLE_KEYS) snapshot[key] = process.env[key];
  clearAll();
});

afterEach(() => {
  for (const key of MUTABLE_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
  vi.clearAllMocks();
});

describe("loadDeploymentRegistryConfig — fixture gating", () => {
  it("development mode with no env config returns the in-repo fixture", () => {
    setDev();
    const config = loadDeploymentRegistryConfig();
    expect(config.publicRegistryUrl).toBe(FIXTURE_URL);
    expect(config.privateDestinationConfigured).toBe(false);
    expect(config.routingMode).toBe("shared-acl");
  });

  it("PRODUCTION with no env config and no opt-in FAILS CLOSED (fixture never served)", () => {
    setProd();
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigNotConfiguredError,
    );
  });

  it("production + explicit CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE=true serves the fixture (loud bridge)", () => {
    setProd();
    process.env[ALLOW_FIXTURE_ENV] = "true";
    const config = loadDeploymentRegistryConfig();
    expect(config.publicRegistryUrl).toBe(FIXTURE_URL);
  });

  it("the fixture opt-in requires the EXACT string 'true' (no truthy coercion)", () => {
    setProd();
    for (const value of ["1", "TRUE", "yes", "", "false"]) {
      process.env[ALLOW_FIXTURE_ENV] = value;
      expect(() => loadDeploymentRegistryConfig()).toThrow(
        DeploymentRegistryConfigNotConfiguredError,
      );
    }
  });
});

describe("loadDeploymentRegistryConfig — live env config (cohesive, all-or-none)", () => {
  it("production + full public env returns the env config with the DISTINCT live URL (not the fixture)", () => {
    setProd();
    setFullPublicEnv(LIVE_URL);
    const config = loadDeploymentRegistryConfig();
    expect(config.publicRegistryUrl).toBe(LIVE_URL);
    expect(config.publicRegistryUrl).not.toBe(FIXTURE_URL);
    expect(config.publicReadToken).toBe("env-public-read");
    expect(config.routingMode).toBe("shared-acl");
    expect(config.privateDestinationConfigured).toBe(false);
    expect(config.privateRegistryUrl).toBeNull();
  });

  it("env config wins over the fixture even in development mode (env is authoritative)", () => {
    setDev();
    setFullPublicEnv(LIVE_URL);
    const config = loadDeploymentRegistryConfig();
    expect(config.publicRegistryUrl).toBe(LIVE_URL);
  });

  it("env config wins even when the fixture opt-in is also set", () => {
    setProd();
    process.env[ALLOW_FIXTURE_ENV] = "true";
    setFullPublicEnv(LIVE_URL);
    const config = loadDeploymentRegistryConfig();
    expect(config.publicRegistryUrl).toBe(LIVE_URL);
  });

  it("scope-based routing mode from env is honoured", () => {
    setProd();
    setFullPublicEnv(LIVE_URL);
    process.env[DEPLOYMENT_REGISTRY_ENV.routingMode] = "scope-based";
    expect(loadDeploymentRegistryConfig().routingMode).toBe("scope-based");
  });

  it("a full private destination set is read all-or-none into a configured config", () => {
    setProd();
    setFullPublicEnv(LIVE_URL);
    process.env[DEPLOYMENT_REGISTRY_ENV.privateUrl] = "https://private.example.test";
    process.env[DEPLOYMENT_REGISTRY_ENV.privateReadToken] = "env-private-read";
    process.env[DEPLOYMENT_REGISTRY_ENV.privateDestinationId] = "dest-01";
    const config = loadDeploymentRegistryConfig();
    expect(config.privateDestinationConfigured).toBe(true);
    expect(config.privateRegistryUrl).toBe("https://private.example.test");
    expect(config.privateReadToken).toBe("env-private-read");
    expect(config.privateDestinationId).toBe("dest-01");
  });
});

describe("loadDeploymentRegistryConfig — incoherent env config never falls back to the fixture", () => {
  it("a URL-only env config throws Incoherent (never pairs an env URL with fixture tokens)", () => {
    setProd();
    process.env[DEPLOYMENT_REGISTRY_ENV.publicUrl] = LIVE_URL;
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigIncoherentError,
    );
  });

  it("a set-but-empty required key is invalid (present → fails loud, no fixture fallback)", () => {
    setProd();
    process.env[DEPLOYMENT_REGISTRY_ENV.publicUrl] = "";
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigIncoherentError,
    );
  });

  it("an invalid routingMode value throws Incoherent", () => {
    setProd();
    setFullPublicEnv(LIVE_URL);
    process.env[DEPLOYMENT_REGISTRY_ENV.routingMode] = "bogus-mode";
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigIncoherentError,
    );
  });

  it("a non-URL publicRegistryUrl throws Incoherent", () => {
    setProd();
    setFullPublicEnv("not a url");
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigIncoherentError,
    );
  });

  it("a partial private destination set throws Incoherent (all-or-none)", () => {
    setProd();
    setFullPublicEnv(LIVE_URL);
    process.env[DEPLOYMENT_REGISTRY_ENV.privateUrl] = "https://private.example.test";
    expect(() => loadDeploymentRegistryConfig()).toThrow(
      DeploymentRegistryConfigIncoherentError,
    );
  });

  it("the incoherent-config error names KEYS only, never a token value", () => {
    setProd();
    const secret = "super-secret-sentinel-value";
    // read token + routingMode present, public URL missing → message names the URL key.
    process.env[DEPLOYMENT_REGISTRY_ENV.publicReadToken] = secret;
    process.env[DEPLOYMENT_REGISTRY_ENV.routingMode] = "shared-acl";
    try {
      loadDeploymentRegistryConfig();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeploymentRegistryConfigIncoherentError);
      expect((err as Error).message).toContain(DEPLOYMENT_REGISTRY_ENV.publicUrl);
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("loadDeploymentRegistryConfig — locked shape + fixture invariants", () => {
  it("throws DeploymentRegistryConfigNotAvailableError shape when routingMode missing (locked guard)", () => {
    const err = new DeploymentRegistryConfigNotAvailableError();
    expect(err.code).toBe("DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE");
    expect(err.message).toContain("routingMode");
  });

  it("with-private fixture has privateDestinationConfigured: true", async () => {
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationConfigured).toBe(true);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateRegistryUrl).not.toBeNull();
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationId).not.toBeNull();
  });

  it("topology A fixture has routingMode: 'scope-based'", async () => {
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.routingMode).toBe("scope-based");
  });

  it("topology B (with-private) fixture has routingMode: 'shared-acl'", async () => {
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.routingMode).toBe("shared-acl");
  });
});
