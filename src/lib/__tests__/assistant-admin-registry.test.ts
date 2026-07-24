import { describe, it, expect } from "vitest";
import {
  classifyPreferredTagState,
  projectLaunchKind,
  projectPreferredTag,
  projectDisplayName,
} from "@/lib/assistant-admin-registry";

// Pure projection + classification helpers behind the /configuration/assistants
// admin registry read (cinatra#1880 W5). No DB.

describe("classifyPreferredTagState (cinatra#1880 W5)", () => {
  const PKG = "@x/foo-assistant";
  const PRINCIPAL = "p-1";

  it("no preferredTag or no package → none", () => {
    expect(classifyPreferredTagState(null, PKG, PRINCIPAL, undefined, undefined)).toBe("none");
    expect(classifyPreferredTagState("foo", null, PRINCIPAL, undefined, undefined)).toBe("none");
  });

  it("alias maps the token to THIS package → claimed", () => {
    expect(classifyPreferredTagState("foo", PKG, PRINCIPAL, PKG, undefined)).toBe("claimed");
  });

  it("token owned by ANOTHER package's alias → collision", () => {
    expect(classifyPreferredTagState("foo", PKG, PRINCIPAL, "@y/other", undefined)).toBe("collision");
  });

  it("token owned by ANOTHER principal's handle → collision", () => {
    expect(classifyPreferredTagState("foo", PKG, PRINCIPAL, undefined, "p-other")).toBe("collision");
  });

  it("token unclaimed entirely → collision (unclaimed — collision)", () => {
    expect(classifyPreferredTagState("foo", PKG, PRINCIPAL, undefined, undefined)).toBe("collision");
  });

  it("token is THIS principal's own handle with no alias row → claimed", () => {
    expect(classifyPreferredTagState("foo", PKG, PRINCIPAL, undefined, PRINCIPAL)).toBe("claimed");
  });
});

describe("declaration projectors (fail-safe)", () => {
  const envelope = (block: unknown) => ({ formatVersion: 1, block, assistantConfig: {} });

  it("projectLaunchKind honors local/remote, else null", () => {
    expect(projectLaunchKind(envelope({ launch: { kind: "local" } }))).toBe("local");
    expect(projectLaunchKind(envelope({ launch: { kind: "remote" } }))).toBe("remote");
    expect(projectLaunchKind(envelope({ launch: { kind: "bogus" } }))).toBeNull();
    expect(projectLaunchKind(null)).toBeNull();
    expect(projectLaunchKind({})).toBeNull();
  });

  it("projectPreferredTag returns the token or null", () => {
    expect(projectPreferredTag(envelope({ preferredTag: "gemini" }))).toBe("gemini");
    expect(projectPreferredTag(envelope({ preferredTag: "" }))).toBeNull();
    expect(projectPreferredTag(envelope({}))).toBeNull();
    expect(projectPreferredTag(null)).toBeNull();
  });

  it("projectDisplayName returns the string or null", () => {
    expect(projectDisplayName(envelope({ displayName: "Gemini" }))).toBe("Gemini");
    expect(projectDisplayName(envelope({ displayName: "" }))).toBeNull();
    expect(projectDisplayName(null)).toBeNull();
  });
});
