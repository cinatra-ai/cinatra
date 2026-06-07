// Hermetic vitest for the pure MCP auth-plugin builder.
//
// The pure module imports ONLY `better-auth/plugins` and
// `@better-auth/oauth-provider` — no React, no Next.js, no `server-only`, no
// `@/` aliases. This test exercises the builder shape + schema invariance,
// independent of the runtime wrapper in packages/mcp-server/src/index.tsx.

import { describe, expect, it } from "vitest";
import { getSchema } from "better-auth/db";

import {
  DEFAULT_MCP_SCOPES,
  buildMcpAuthPlugins,
  type McpAuthPluginsOptions,
} from "../auth-plugins";

// Better Auth's `getSchema()` recreates closure-bound default-value /
// onUpdate generators on every call (identical code, fresh ref). Deep-equal
// on raw output therefore false-fails. This normalizer replaces every
// function with its `toString()` body so identical-by-CODE generators
// compare equal while still pinning their presence + position.
function normalizeSchemaForCompare(value: unknown): unknown {
  if (typeof value === "function") {
    return `<fn ${value.toString()}>`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSchemaForCompare(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeSchemaForCompare(v);
    }
    return out;
  }
  return value;
}

const baseOptions: McpAuthPluginsOptions = {
  validAudiences: ["http://localhost:3000/api/mcp"],
  scopes: DEFAULT_MCP_SCOPES,
  loginPage: "/api/mcp/auth/sign-in",
  consentPage: "/api/mcp/consent",
  signupPage: "/api/mcp/auth/sign-up",
};

describe("buildMcpAuthPlugins", () => {
  it("returns a length-2 tuple (jwt, oauthProvider) in that order", () => {
    const plugins = buildMcpAuthPlugins(baseOptions);
    expect(plugins).toHaveLength(2);
    expect(plugins[0]?.id).toBe("jwt");
    expect(plugins[1]?.id).toBe("oauth-provider");
  });

  it("produces the same Better Auth schema regardless of behavioral inputs", () => {
    // Schema must depend ONLY on plugin presence + schema-bearing options
    // (none on this pair today). Any behavioral knob change must leave the
    // schema invariant.
    const schemaA = getSchema({
      appName: "test",
      plugins: buildMcpAuthPlugins({
        ...baseOptions,
        validAudiences: ["http://localhost:3000/api/mcp"],
        accessTokenExpiresIn: 30 * 24 * 60 * 60,
        refreshTokenExpiresIn: 365 * 24 * 60 * 60,
        scopes: ["openid", "profile", "email", "offline_access", "mcp:connect"],
      }),
    });
    const schemaB = getSchema({
      appName: "test",
      plugins: buildMcpAuthPlugins({
        ...baseOptions,
        validAudiences: [
          "http://localhost:3000/api/mcp",
          "https://public.example.test/api/mcp",
        ],
        accessTokenExpiresIn: 60,
        refreshTokenExpiresIn: 120,
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "mcp:connect",
          "a2a:connect",
        ],
        allowDynamicClientRegistration: false,
        allowPublicClientPrelogin: false,
        allowUnauthenticatedClientRegistration: false,
        silenceOauthAuthServerConfigWarning: false,
        grantTypes: ["authorization_code"],
        loginPage: "/x",
        consentPage: "/y",
        signupPage: "/z",
      }),
    });
    expect(normalizeSchemaForCompare(schemaA)).toEqual(
      normalizeSchemaForCompare(schemaB),
    );
  });

  it("contributes the MCP auth contract tables to the Better Auth schema", () => {
    const schema = getSchema({
      appName: "test",
      plugins: buildMcpAuthPlugins(baseOptions),
    }) as Record<string, unknown>;
    // jwt() adds jwks; oauthProvider() adds the OAuth set.
    for (const table of [
      "jwks",
      "oauthClient",
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
    ]) {
      expect(schema[table], `missing MCP auth model: ${table}`).toBeDefined();
    }
  });
});
