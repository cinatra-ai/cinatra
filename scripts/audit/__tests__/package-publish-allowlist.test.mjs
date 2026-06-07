import { describe, expect, it } from "vitest";
import {
  PUBLISH_ALLOWLIST,
  validatePackageTag,
} from "../package-publish-allowlist.mjs";

// The default allowlist is INTENTIONALLY EMPTY: the
// internal SDK/app packages are not marketplace extensions and must not be
// published to registry.cinatra.ai. The semver/parse happy-path tests below
// therefore pass an explicit allowlist to exercise the validator's accept
// branch (which is independent of the default allowlist contents).
const TEST_ALLOWLIST = Object.freeze(["@cinatra-ai/design"]);

describe("PUBLISH_ALLOWLIST", () => {
  it("is empty — no monorepo package is publishable to the cinatra registry", () => {
    expect([...PUBLISH_ALLOWLIST]).toStrictEqual([]);
  });

  it("is frozen — accidental mutation throws", () => {
    expect(() => {
      // @ts-expect-error — proving runtime immutability
      PUBLISH_ALLOWLIST.push("@cinatra/agents");
    }).toThrow();
  });

  it("rejects every internal SDK/app package by default", () => {
    for (const pkg of [
      "@cinatra-ai/design",
      "@cinatra-ai/sdk-ui",
      "@cinatra-ai/marketplace-mcp-contract",
    ]) {
      const result = validatePackageTag(`${pkg}@1.0.0`);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not in publish allowlist");
    }
  });
});

describe("validatePackageTag — happy paths (explicit allowlist)", () => {
  it("accepts @cinatra-ai/design@0.1.0", () => {
    expect(
      validatePackageTag("@cinatra-ai/design@0.1.0", TEST_ALLOWLIST),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/design",
      version: "0.1.0",
    });
  });

  it("accepts @cinatra-ai/sdk-ui@1.4.2", () => {
    expect(
      validatePackageTag("@cinatra-ai/sdk-ui@1.4.2", ["@cinatra-ai/sdk-ui"]),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/sdk-ui",
      version: "1.4.2",
    });
  });

  it("accepts @cinatra-ai/marketplace-mcp-contract@2.0.0-alpha.1", () => {
    expect(
      validatePackageTag("@cinatra-ai/marketplace-mcp-contract@2.0.0-alpha.1", [
        "@cinatra-ai/marketplace-mcp-contract",
      ]),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/marketplace-mcp-contract",
      version: "2.0.0-alpha.1",
    });
  });

  it("accepts pre-release identifiers with dot + hyphen", () => {
    // 0.1.0-rc.1.beta-test is a valid SemVer pre-release identifier
    const result = validatePackageTag(
      "@cinatra-ai/design@0.1.0-rc.1.beta-test",
      TEST_ALLOWLIST,
    );
    expect(result).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/design",
      version: "0.1.0-rc.1.beta-test",
    });
  });
});

describe("validatePackageTag — allowlist rejection", () => {
  it("rejects a workspace-internal package (@cinatra/agents)", () => {
    const result = validatePackageTag("@cinatra/agents@1.0.0", TEST_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in publish allowlist");
    expect(result.reason).toContain("@cinatra/agents");
  });

  it("rejects an unscoped package", () => {
    const result = validatePackageTag("design@0.1.0", TEST_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("must be a scoped name");
  });

  it("rejects a typo'd scope (@cinatra-ai-typo/design)", () => {
    const result = validatePackageTag(
      "@cinatra-ai-typo/design@0.1.0",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in publish allowlist");
  });

  it("rejects a typo'd name (@cinatra-ai/desig)", () => {
    const result = validatePackageTag(
      "@cinatra-ai/desig@0.1.0",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in publish allowlist");
  });

  it("rejects against an empty allowlist (the default)", () => {
    const result = validatePackageTag("@cinatra-ai/design@0.1.0", []);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in publish allowlist");
  });
});

describe("validatePackageTag — semver rejection", () => {
  it("rejects a dev-only version", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@0.0.0-dev.abc123",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("dev version not publishable");
  });

  it("rejects a non-semver string", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@v0.1.0",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  it("rejects leading-zero major", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@01.0.0",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  it("rejects missing patch", () => {
    const result = validatePackageTag("@cinatra-ai/design@0.1", TEST_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  // These cases ground the semver.org-suggested regex against real
  // spec compliance (an earlier non-strict regex accepted these).
  it("rejects double-dot in pre-release (1.0.0-alpha..1)", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@1.0.0-alpha..1",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  it("rejects leading-zero in pre-release numeric identifier (1.0.0-01)", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@1.0.0-01",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  it("rejects leading-zero in pre-release identifier (1.0.0-alpha.01)", () => {
    const result = validatePackageTag(
      "@cinatra-ai/design@1.0.0-alpha.01",
      TEST_ALLOWLIST,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid semver");
  });

  it("accepts build metadata (1.0.0+build.1)", () => {
    expect(
      validatePackageTag("@cinatra-ai/design@1.0.0+build.1", TEST_ALLOWLIST),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/design",
      version: "1.0.0+build.1",
    });
  });

  it("accepts pre-release + build metadata (1.0.0-alpha.1+exp.sha.5114f85)", () => {
    expect(
      validatePackageTag(
        "@cinatra-ai/design@1.0.0-alpha.1+exp.sha.5114f85",
        TEST_ALLOWLIST,
      ),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/design",
      version: "1.0.0-alpha.1+exp.sha.5114f85",
    });
  });

  it("accepts large major version", () => {
    expect(
      validatePackageTag("@cinatra-ai/design@10.20.30", TEST_ALLOWLIST),
    ).toStrictEqual({
      valid: true,
      pkg: "@cinatra-ai/design",
      version: "10.20.30",
    });
  });
});

describe("validatePackageTag — parse failures", () => {
  it("rejects an empty string", () => {
    expect(validatePackageTag("")).toStrictEqual({
      valid: false,
      reason: "tag is empty or non-string",
    });
  });

  it("rejects a non-string", () => {
    // @ts-expect-error — exercising runtime guard
    expect(validatePackageTag(undefined)).toStrictEqual({
      valid: false,
      reason: "tag is empty or non-string",
    });
  });

  it("rejects a tag with no version separator", () => {
    const result = validatePackageTag("@cinatra-ai/design");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("does not contain a version-separating");
  });

  it("rejects a tag that starts with @ but no slash", () => {
    const result = validatePackageTag("@only-scope@1.0.0", TEST_ALLOWLIST);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in publish allowlist");
  });
});
