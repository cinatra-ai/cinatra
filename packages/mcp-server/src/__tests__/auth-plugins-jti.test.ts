/**
 * #1195 — access-token mint uniqueness.
 *
 * Better Auth derives `iat` at one-second granularity and emits no `jti`, so
 * two same-second client_credentials exchanges could produce byte-identical
 * JWTs. The durable run-context binding keys on sha256(access token) and
 * REQUIRES every mint to be unique (a collision would let concurrent runs
 * alias each other's binding). These tests lock in:
 *   (a) the jti claim generator is cryptographically random per signed mint,
 *   (b) it stays SILENT for resource-less invocations — Better Auth calls the
 *       same hook when building RFC 7662 introspection responses for opaque
 *       tokens (no `resource` in its info); a random jti there would report a
 *       different, never-minted claim on every introspection of the same
 *       token (codex round-1), and
 *   (c) buildMcpAuthPlugins actually wires it into oauthProvider's
 *       customAccessTokenClaims (the token-endpoint mint hook).
 */
import { describe, it, expect, vi } from "vitest";

const { oauthProviderMock } = vi.hoisted(() => ({
  oauthProviderMock: vi.fn((options: Record<string, unknown>) => ({
    id: "oauth-provider-fake",
    options,
  })),
}));

vi.mock("better-auth/plugins", () => ({
  jwt: vi.fn(() => ({ id: "jwt-fake" })),
}));
vi.mock("@better-auth/oauth-provider", () => ({
  oauthProvider: oauthProviderMock,
}));

import {
  buildMcpAuthPlugins,
  mintAccessTokenJtiClaims,
} from "../auth-plugins";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A signed JWT mint always carries the requested resource (no resource ⇒ no
// audience ⇒ Better Auth mints an OPAQUE token, which is random-unique anyway).
const MINT_INFO = { resource: "http://localhost:3000/api/mcp" };

describe("access-token jti claims (#1195)", () => {
  it("mints a distinct random jti on every signed mint — same-tick calls never collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const claims = mintAccessTokenJtiClaims(MINT_INFO);
      expect(claims.jti).toMatch(UUID_RE);
      seen.add(claims.jti as string);
    }
    expect(seen.size).toBe(100);
  });

  it("emits NO jti without a resource — opaque-token introspection payloads stay stable", () => {
    // Better Auth's introspection site invokes the hook WITHOUT `resource`;
    // a random jti there would fabricate a never-minted, per-call claim.
    expect(mintAccessTokenJtiClaims({})).toEqual({});
    expect(mintAccessTokenJtiClaims({ resource: undefined })).toEqual({});
    expect(mintAccessTokenJtiClaims({ resource: "" })).toEqual({});
  });

  it("buildMcpAuthPlugins wires the jti generator into oauthProvider.customAccessTokenClaims", () => {
    buildMcpAuthPlugins({
      validAudiences: ["http://localhost:3000/api/mcp"],
      scopes: ["mcp:connect"],
      loginPage: "/login",
      consentPage: "/consent",
      signupPage: "/signup",
    });
    expect(oauthProviderMock).toHaveBeenCalledTimes(1);
    const options = oauthProviderMock.mock.calls[0][0];
    expect(options.customAccessTokenClaims).toBe(mintAccessTokenJtiClaims);
    // The wired hook itself yields unique claims per signed mint.
    const hook = options.customAccessTokenClaims as (info: {
      resource?: string;
    }) => { jti?: string };
    expect(hook(MINT_INFO).jti).not.toBe(hook(MINT_INFO).jti);
  });
});
