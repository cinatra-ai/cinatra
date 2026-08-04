/**
 * cinatra#2359 — post-login redirect target preservation.
 *
 * `isSafeNextPath` / `sanitizeNextPath` are the ONE security boundary this fix
 * introduces: every `next` value that ever reaches a redirect Location or a
 * `redirectTo` prop passes through here first. These tests pin both directions
 * — legitimate relative paths pass through unchanged, and every open-redirect
 * vector the issue calls out (protocol-relative `//`, absolute/scheme URLs,
 * the backslash trick, control-character smuggling) is rejected and falls
 * back to `/`, never thrown as an error.
 */
import { describe, expect, it } from "vitest";
import {
  isSafeNextPath,
  sanitizeNextPath,
  buildSignInPath,
  buildSignUpPath,
  buildSetupSignUpPath,
  resolvePostAuthDestination,
} from "../auth-redirect-target";

describe("isSafeNextPath — accepts legitimate same-origin relative paths", () => {
  it.each([
    "/",
    "/artifacts",
    "/connectors/abc-123",
    "/agents/vendor/pkg/instance/review/task",
    "/artifacts?id=1&tab=history",
    "/configuration/workspace/settings",
  ])("accepts %s", (candidate) => {
    expect(isSafeNextPath(candidate)).toBe(true);
  });
});

describe("isSafeNextPath — rejects open-redirect vectors (SECURITY, cinatra#2359 AC)", () => {
  it.each([
    ["//evil.com", "protocol-relative"],
    ["///evil.com", "protocol-relative, extra slash"],
    ["https://evil.com", "absolute URL with scheme"],
    ["http://evil.com", "absolute URL with scheme"],
    ["HTTPS://evil.com", "absolute URL, uppercase scheme"],
    ["/\\evil.com", "backslash trick — browsers normalize \\ to /"],
    ["\\\\evil.com", "double backslash trick"],
    ["\\evil.com", "leading backslash, no leading slash at all"],
    ["evil.com", "no leading slash — not a relative path"],
    ["javascript:alert(1)", "javascript scheme, no leading slash"],
    ["/redirect:to/evil", "colon in the first path segment"],
    ["/foo\r\nSet-Cookie: evil=1", "CRLF header-splitting attempt"],
    ["/foo\nLocation: https://evil.com", "LF header-splitting attempt"],
    ["", "empty string"],
  ])("rejects %s (%s)", (candidate) => {
    expect(isSafeNextPath(candidate)).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isSafeNextPath(null)).toBe(false);
    expect(isSafeNextPath(undefined)).toBe(false);
  });
});

describe("sanitizeNextPath", () => {
  it("returns the candidate unchanged when safe", () => {
    expect(sanitizeNextPath("/connectors/abc")).toBe("/connectors/abc");
  });

  it("returns undefined for every rejected vector, never throws", () => {
    expect(sanitizeNextPath("//evil.com")).toBeUndefined();
    expect(sanitizeNextPath("https://evil.com")).toBeUndefined();
    expect(sanitizeNextPath("/\\evil.com")).toBeUndefined();
    expect(sanitizeNextPath(null)).toBeUndefined();
    expect(sanitizeNextPath(undefined)).toBeUndefined();
  });
});

describe("buildSignInPath", () => {
  it("appends the encoded next path when safe", () => {
    expect(buildSignInPath("/artifacts")).toBe("/sign-in?next=%2Fartifacts");
  });

  it("encodes a path with its own query string as one opaque value", () => {
    expect(buildSignInPath("/connectors/abc?tab=x")).toBe(
      "/sign-in?next=%2Fconnectors%2Fabc%3Ftab%3Dx",
    );
  });

  it("falls back to the bare path when next is absent", () => {
    expect(buildSignInPath(undefined)).toBe("/sign-in");
    expect(buildSignInPath(null)).toBe("/sign-in");
  });

  it("falls back to the bare path — never echoes a hostile target — for every rejected vector", () => {
    expect(buildSignInPath("//evil.com")).toBe("/sign-in");
    expect(buildSignInPath("https://evil.com")).toBe("/sign-in");
    expect(buildSignInPath("/\\evil.com")).toBe("/sign-in");
    expect(buildSignInPath("\\\\evil.com")).toBe("/sign-in");
  });
});

describe("buildSignUpPath", () => {
  it("appends the encoded next path when safe (preserves next across the sign-in <-> sign-up hop)", () => {
    expect(buildSignUpPath("/artifacts")).toBe("/sign-up?next=%2Fartifacts");
  });

  it("falls back to the bare path for a hostile target", () => {
    expect(buildSignUpPath("https://evil.com")).toBe("/sign-up");
  });
});

describe("buildSetupSignUpPath (cinatra#2386)", () => {
  it("appends the encoded next path when safe (preserves next across the inverted sign-in -> /setup/sign-up hop)", () => {
    expect(buildSetupSignUpPath("/artifacts")).toBe("/setup/sign-up?next=%2Fartifacts");
  });

  it("falls back to the bare path when next is absent", () => {
    expect(buildSetupSignUpPath(undefined)).toBe("/setup/sign-up");
    expect(buildSetupSignUpPath(null)).toBe("/setup/sign-up");
  });

  it("falls back to the bare path — never echoes a hostile target — for every rejected vector", () => {
    expect(buildSetupSignUpPath("//evil.com")).toBe("/setup/sign-up");
    expect(buildSetupSignUpPath("https://evil.com")).toBe("/setup/sign-up");
    expect(buildSetupSignUpPath("/\\evil.com")).toBe("/setup/sign-up");
  });
});

describe("resolvePostAuthDestination", () => {
  it("returns the sanitized next path when safe", () => {
    expect(resolvePostAuthDestination("/artifacts")).toBe("/artifacts");
  });

  it("defaults to / when next is absent", () => {
    expect(resolvePostAuthDestination(undefined)).toBe("/");
    expect(resolvePostAuthDestination(null)).toBe("/");
  });

  it("defaults to / — never redirects off-site — for every rejected vector", () => {
    expect(resolvePostAuthDestination("//evil.com")).toBe("/");
    expect(resolvePostAuthDestination("https://evil.com")).toBe("/");
    expect(resolvePostAuthDestination("/\\evil.com")).toBe("/");
  });
});
