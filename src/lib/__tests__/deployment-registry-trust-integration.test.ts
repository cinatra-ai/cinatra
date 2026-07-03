// Integration: the REAL deployment-registry loader wired into the REAL
// extension-trust host-allowlist seam (no loader mock). Proves the acceptance
// property end-to-end: production extension-trust never derives its activation
// host from the in-repo fixture — it uses a live env config, an explicitly
// opted-in fixture bridge, or nothing (fail-closed []).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// Real loader (not mocked) is imported transitively by extension-trust-config.
import { trustedActivationHosts } from "@/lib/extension-trust-config";
import { DEPLOYMENT_REGISTRY_ENV, ALLOW_FIXTURE_ENV } from "@/lib/deployment-registry-config";

const FIXTURE_HOST = "registry.cinatra.ai";
const LIVE_URL = "https://registry.example.test";
const LIVE_HOST = "registry.example.test";

const MUTABLE_KEYS = [
  "CINATRA_RUNTIME_MODE",
  "APP_RUNTIME_MODE",
  ALLOW_FIXTURE_ENV,
  ...Object.values(DEPLOYMENT_REGISTRY_ENV),
] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of MUTABLE_KEYS) snapshot[key] = process.env[key];
  for (const key of MUTABLE_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of MUTABLE_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
  vi.clearAllMocks();
});

describe("trustedActivationHosts over the real deployment-registry loader", () => {
  it("development: the fixture host backs trust (dev convenience)", () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    expect(trustedActivationHosts()).toEqual([FIXTURE_HOST]);
  });

  it("PRODUCTION with no config: the fixture host does NOT feed trust — fail-closed []", () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    expect(trustedActivationHosts()).toEqual([]);
  });

  it("production with a live env config: trust derives from the LIVE host, not the fixture", () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    process.env[DEPLOYMENT_REGISTRY_ENV.publicUrl] = LIVE_URL;
    process.env[DEPLOYMENT_REGISTRY_ENV.publicReadToken] = "env-public-read";
    process.env[DEPLOYMENT_REGISTRY_ENV.routingMode] = "shared-acl";
    const hosts = trustedActivationHosts();
    expect(hosts).toEqual([LIVE_HOST]);
    expect(hosts).not.toContain(FIXTURE_HOST);
  });

  it("production with the explicit fixture opt-in: the fixture host is a LOUD, deliberate choice", () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    process.env[ALLOW_FIXTURE_ENV] = "true";
    expect(trustedActivationHosts()).toEqual([FIXTURE_HOST]);
  });

  it("production with an incoherent env config: fail-closed [] (never falls back to the fixture host)", () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    process.env[DEPLOYMENT_REGISTRY_ENV.publicUrl] = LIVE_URL; // URL only — incomplete
    expect(trustedActivationHosts()).toEqual([]);
  });
});
