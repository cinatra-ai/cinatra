// Hermetic vitest for the pure MCP auth-plugin builder.
//
// The pure module imports ONLY `better-auth/plugins` and
// `@better-auth/oauth-provider` — no React, no Next.js, no `server-only`, no
// `@/` aliases. This test exercises the builder shape + schema invariance,
// independent of the runtime wrapper in packages/mcp-server/src/index.tsx.

import { describe, expect, it } from "vitest";
import { getSchema } from "better-auth/db";
// Imported DIRECTLY (not only through the builder) by the audience-freeze
// suite below — the freeze lives in the provider's own option handling, so the
// pin has to reach the provider, not just our wrapper.
import { oauthProvider } from "@better-auth/oauth-provider";

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

/**
 * Public base URL audience freeze (cinatra#2173).
 *
 * The dev tunnel tab persists a public base URL; `src/lib/auth.ts` derives the
 * OAuth `validAudiences` from it at MODULE EVAL. The tab, its server action,
 * and this suite state the SAME contract: a save requires an app restart before
 * an external MCP client can mint a token against the new URL.
 *
 * These tests pin the MECHANISM that makes the restart unavoidable, so "just
 * derive the audiences lazily" cannot be adopted as a silent no-op. Both
 * lazy-derivation hatches are closed, and each is pinned at the layer that
 * actually closes it:
 *
 *   1. THE PROVIDER. `oauthProvider` materializes `validAudiences` into its own
 *      internal options object at construction. Asserted against the provider
 *      DIRECTLY (not through `buildMcpAuthPlugins`, which would consume an
 *      accessor before the provider ever sees it): a getter-backed option is
 *      read once, and what the request handlers read back is a plain data
 *      property, not an accessor.
 *   2. OUR BUILDER. `buildMcpAuthPlugins` copies the caller's array, so the
 *      "mutate a shared array in place" hatch is closed on our side too.
 *
 * Honest limit: (1) pins materialization, not the absence of a per-request
 * re-read — proving that needs a live token exchange. A version that stops
 * materializing (keeps an accessor or a callable) fails here, which is the
 * signal to re-verify the restart wording on the tunnel tab and
 * `setMcpPublicBaseUrlAction`, not to relax the assertion.
 */
describe("public base URL audience freeze (#2173)", () => {
  const LOCAL_AUDIENCE = "http://localhost:3000/api/mcp";

  it("oauthProvider materializes validAudiences at construction", () => {
    let reads = 0;
    const plugin = oauthProvider({
      scopes: [...DEFAULT_MCP_SCOPES],
      loginPage: baseOptions.loginPage,
      consentPage: baseOptions.consentPage,
      signup: { page: baseOptions.signupPage },
      get validAudiences() {
        reads += 1;
        return [LOCAL_AUDIENCE, `https://public-${reads}.example.test/api/mcp`];
      },
    });

    expect(plugin.id).toBe("oauth-provider");
    // Read exactly once — at construction. A lazily-derived audience list
    // would be evaluated here and never again.
    expect(reads).toBe(1);

    // …and what the provider's request handlers read back is a PLAIN data
    // property carrying that single snapshot, not the accessor we passed in.
    const providerOptions = (plugin as unknown as { options: Record<string, unknown> }).options;
    const descriptor = Object.getOwnPropertyDescriptor(providerOptions, "validAudiences");
    expect(descriptor?.get, "provider kept an accessor — re-verify the restart contract").toBeUndefined();
    expect(descriptor?.value).toEqual([
      LOCAL_AUDIENCE,
      "https://public-1.example.test/api/mcp",
    ]);
    expect(reads).toBe(1);
  });

  it("buildMcpAuthPlugins copies the caller's array (no shared-mutation hatch)", () => {
    const live = [LOCAL_AUDIENCE];
    const plugins = buildMcpAuthPlugins({ ...baseOptions, validAudiences: live });

    live.push("https://saved-after-boot.example.test/api/mcp");

    const providerOptions = (plugins[1] as unknown as {
      options?: { validAudiences?: string[] };
    }).options;
    expect(providerOptions?.validAudiences).toEqual([LOCAL_AUDIENCE]);
  });
});
