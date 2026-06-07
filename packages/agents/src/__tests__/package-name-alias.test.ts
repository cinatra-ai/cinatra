/**
 * aliasPackageNameToCanonicalScope unit tests.
 *
 * The alias function is the narrow operator-vendor -> `@cinatra-ai/` resolver
 * that bridges Verdaccio's rescoped publish name and agent_templates'
 * authored package_name. Critical correctness:
 *   - Only the EXACT current instance namespace triggers the alias
 *   - Arbitrary third-party scopes do NOT collapse to `@cinatra-ai/`
 *   - Already-canonical-scoped inputs (`@cinatra-ai/...`) return null
 *   - Malformed inputs return null (no crash)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const instanceIdentityMock = vi.hoisted(() => ({
  readInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-store", () => instanceIdentityMock);
vi.mock("server-only", () => ({}));

import { aliasPackageNameToCanonicalScope } from "../package-name-alias";

beforeEach(() => {
  instanceIdentityMock.readInstanceIdentity.mockReset();
});

describe("aliasPackageNameToCanonicalScope", () => {
  it("aliases operator-vendor scope -> cinatra when scopes match", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "operator-notebook-main",
    });
    const out = aliasPackageNameToCanonicalScope(
      "@operator-notebook-main/media-feed-lister-agent",
    );
    expect(out).toBe("@cinatra-ai/media-feed-lister-agent");
  });

  it("returns null when scope is already cinatra (no alias needed)", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "operator-notebook-main",
    });
    const out = aliasPackageNameToCanonicalScope(
      "@cinatra-ai/media-feed-lister-agent",
    );
    expect(out).toBeNull();
  });

  it("returns null when scope is a third-party vendor (NOT this instance's namespace)", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "operator-notebook-main",
    });
    const out = aliasPackageNameToCanonicalScope(
      "@somevendor/random-agent",
    );
    // Critical: third-party scope must NOT collapse to @cinatra. Arbitrary
    // scope coercion would let `@somevendor/foo` silently run `@cinatra/foo`
    // -- wrong agent, security risk.
    expect(out).toBeNull();
  });

  it("returns null when input has no @scope/ shape", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "operator-notebook-main",
    });
    expect(aliasPackageNameToCanonicalScope("just-a-name")).toBeNull();
    expect(aliasPackageNameToCanonicalScope("@onlyatoken")).toBeNull();
    expect(aliasPackageNameToCanonicalScope("")).toBeNull();
  });

  it("returns null when slug is empty (@scope/ alone)", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "operator-notebook-main",
    });
    expect(
      aliasPackageNameToCanonicalScope("@operator-notebook-main/"),
    ).toBeNull();
  });

  it("returns null when instance namespace can't be read", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue(null);
    const out = aliasPackageNameToCanonicalScope(
      "@anyvendor/some-agent",
    );
    expect(out).toBeNull();
  });

  it("returns null when readInstanceIdentity throws (lazy-load failure)", () => {
    instanceIdentityMock.readInstanceIdentity.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    const out = aliasPackageNameToCanonicalScope(
      "@anyvendor/some-agent",
    );
    // Must NOT crash the agent_run dispatch -- fail-soft to null so the
    // caller falls through to "Template not found" cleanly.
    expect(out).toBeNull();
  });

  it("returns null when instanceNamespace is undefined", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({});
    const out = aliasPackageNameToCanonicalScope(
      "@anyvendor/some-agent",
    );
    expect(out).toBeNull();
  });

  it("REJECTS embedded slashes in slug (strict @vendor/slug shape, matches wayflow-url.PACKAGE_NAME_RE)", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "instance-foo",
    });
    // wayflow-url.ts:14 enforces /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.
    // Keeping the same invariant here so the alias resolver doesn't admit a
    // shape that wayflow-url + downstream packageName consumers reject.
    expect(
      aliasPackageNameToCanonicalScope("@instance-foo/sub/path-agent"),
    ).toBeNull();
  });

  it("REJECTS uppercase / underscore in scope or slug (strict regex)", () => {
    instanceIdentityMock.readInstanceIdentity.mockReturnValue({
      instanceNamespace: "instance-foo",
    });
    expect(aliasPackageNameToCanonicalScope("@Instance-foo/agent")).toBeNull();
    expect(aliasPackageNameToCanonicalScope("@instance-foo/Agent-X")).toBeNull();
    expect(aliasPackageNameToCanonicalScope("@instance-foo/agent_name")).toBeNull();
  });
});
