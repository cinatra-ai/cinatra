import { describe, expect, it } from "vitest";

import {
  DEFAULT_SANDBOX_NETWORK,
  EgressGatewayRequiredError,
  gatewayEnvironment,
  hostMatchesAllowlist,
  resolveEgress,
} from "../egress";

const gateway = { host: "cinatra-exec-gateway", port: 3128 };

describe("hostMatchesAllowlist", () => {
  it("matches exact hosts and dot-suffixes only", () => {
    const allow = ["pypi.org", "files.pythonhosted.org"];
    expect(hostMatchesAllowlist("pypi.org", allow)).toBe(true);
    expect(hostMatchesAllowlist("PYPI.ORG", allow)).toBe(true);
    expect(hostMatchesAllowlist("simple.pypi.org", allow)).toBe(true);
    expect(hostMatchesAllowlist("notpypi.org", allow)).toBe(false);
    expect(hostMatchesAllowlist("pypi.org.evil.example", allow)).toBe(false);
    expect(hostMatchesAllowlist("", allow)).toBe(false);
  });

  it("tolerates wildcard-prefixed and trailing-dot entries", () => {
    expect(hostMatchesAllowlist("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatchesAllowlist("example.com.", ["example.com"])).toBe(true);
  });
});

describe("resolveEgress", () => {
  it("none needs no gateway and yields the kernel-level deny", () => {
    expect(resolveEgress({ mode: "none" }, { jobToken: "t" })).toEqual({
      kind: "none",
    });
  });

  it("gateway modes FAIL CLOSED without a configured gateway", () => {
    expect(() =>
      resolveEgress({ mode: "default_internet" }, { jobToken: "t" }),
    ).toThrow(EgressGatewayRequiredError);
    expect(() =>
      resolveEgress({ mode: "allowlist", allowlist: ["pypi.org"] }, { jobToken: "t" }),
    ).toThrow(EgressGatewayRequiredError);
  });

  it("gateway modes bind the job token and the internal network", () => {
    const resolved = resolveEgress(
      { mode: "allowlist", allowlist: ["pypi.org"] },
      { jobToken: "job-1", gateway },
    );
    expect(resolved).toEqual({
      kind: "gateway",
      mode: "allowlist",
      network: DEFAULT_SANDBOX_NETWORK,
      gateway,
      jobToken: "job-1",
    });
  });
});

describe("gatewayEnvironment", () => {
  it("maps the policy + control secret onto the gateway process env", () => {
    expect(
      gatewayEnvironment(
        { mode: "allowlist", allowlist: ["pypi.org", "npmjs.org"], maxBytesPerJob: 5 },
        3128,
        3129,
        "ctrl-secret",
      ),
    ).toEqual({
      EGRESS_CONTROL_SECRET: "ctrl-secret",
      EGRESS_MODE: "allowlist",
      EGRESS_ALLOWLIST: "pypi.org,npmjs.org",
      EGRESS_MAX_BYTES_PER_JOB: "5",
      EGRESS_PROXY_PORT: "3128",
      EGRESS_ADMIN_PORT: "3129",
    });
    expect(gatewayEnvironment({ mode: "default_internet" }, 1, 2, "s").EGRESS_MODE).toBe(
      "allow_all",
    );
  });
});
