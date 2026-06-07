// Dev version and publish authority tests.
import { describe, expect, it } from "vitest";

import {
  devVersionForSha,
  isDevVersion,
  shaFromDevVersion,
} from "../dev-version";
import {
  PublishAuthorityError,
  assertPublishableSemver,
  assertReleaseManagerAuthority,
  authorizePublish,
} from "../publish-authority";

describe("dev version helpers", () => {
  it("formats and round-trips 0.0.0-dev.<sha>", () => {
    const v = devVersionForSha("abc1234");
    expect(v).toBe("0.0.0-dev.abc1234");
    expect(isDevVersion(v)).toBe(true);
    expect(shaFromDevVersion(v)).toBe("abc1234");
  });

  it("isDevVersion is false for real semver", () => {
    expect(isDevVersion("1.2.3")).toBe(false);
    expect(shaFromDevVersion("1.2.3")).toBeNull();
  });
});

describe("semver enforcement", () => {
  it("accepts valid semver incl. pre-release", () => {
    expect(() => assertPublishableSemver("1.0.0")).not.toThrow();
    expect(() => assertPublishableSemver("2.3.4-alpha.1")).not.toThrow();
    expect(() => assertPublishableSemver("0.1.0-beta.2")).not.toThrow();
  });

  it("rejects dev compile versions", () => {
    expect(() => assertPublishableSemver("0.0.0-dev.abc123")).toThrow(PublishAuthorityError);
  });

  it("rejects malformed versions", () => {
    expect(() => assertPublishableSemver("1.2")).toThrow(PublishAuthorityError);
    expect(() => assertPublishableSemver("version-1.2.3")).toThrow(PublishAuthorityError);
    expect(() => assertPublishableSemver("latest")).toThrow(PublishAuthorityError);
  });
});

describe("release-manager gate", () => {
  it("allows release_manager", () => {
    expect(() =>
      assertReleaseManagerAuthority({ source: "ci", roles: ["release_manager"] }),
    ).not.toThrow();
  });

  it("allows platform_admin (dominates)", () => {
    expect(() =>
      assertReleaseManagerAuthority({ source: "ui", roles: ["platform_admin"] }),
    ).not.toThrow();
  });

  it("rejects member / developer / no-role", () => {
    for (const roles of [["member"], ["developer"], []]) {
      expect(() => assertReleaseManagerAuthority({ source: "ui", roles })).toThrow(
        PublishAuthorityError,
      );
    }
  });
});

describe("authorizePublish - composed gate + audit event", () => {
  it("returns success audit event for valid semver + release_manager", () => {
    const ev = authorizePublish({
      actor: { source: "ci", userId: "u1", roles: ["release_manager"] },
      packageName: "@cinatra-ai/foo-agent",
      version: "1.2.3",
    });
    expect(ev.outcome).toBe("success");
    expect(ev.operation).toBe("extension_publish");
  });

  it("returns failure audit event when role missing", () => {
    const ev = authorizePublish({
      actor: { source: "ui", roles: ["member"] },
      packageName: "@cinatra-ai/foo-agent",
      version: "1.2.3",
    });
    expect(ev.outcome).toBe("failure");
    expect(ev.reason).toContain("release_manager");
  });

  it("returns failure audit event when version is a dev version", () => {
    const ev = authorizePublish({
      actor: { source: "ci", roles: ["release_manager"] },
      packageName: "@cinatra-ai/foo-agent",
      version: "0.0.0-dev.abc",
    });
    expect(ev.outcome).toBe("failure");
  });
});
