// A saved Google OAuth client still reaches Better Auth's social provider.
//
// The authentication module reads its boot-time Google OAuth settings lazily,
// once, behind the social-provider factory: Better Auth awaits that factory
// while it builds the auth context, so the settings are in hand before their
// first use. `scripts/__tests__/auth-module-cjs-load.test.mjs` drives the arm an
// install without Google sign-in takes — no saved client, no social provider.
// This file drives the other arm, the one whose shape the factory has to
// preserve: with a client saved, Better Auth registers Google, exactly Google,
// with the saved id and secret, so an authorization URL it builds names that
// client.
//
// The module is imported by its own path rather than as `@/lib/auth`: the root
// suite maps that specifier to a small stub (vitest.config.ts) and the real
// module is the subject here. `BETTER_AUTH_SECRET` is set the way the module's
// other load test sets it, because the module refuses to construct without one.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type SavedGoogleOAuthSettings = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
};

/** What the settings reader answers for the case currently running. */
const saved = vi.hoisted(() => ({
  settings: {} as SavedGoogleOAuthSettings,
}));

vi.mock("@cinatra-ai/google-oauth-connection", () => ({
  getGoogleOAuthSettings: async () => saved.settings,
}));

const SAVED_CLIENT = {
  clientId: "saved-google-client-id",
  clientSecret: "saved-google-client-secret",
  redirectUri: "https://cinatra.test/api/auth/callback/google",
};

const NO_CLIENT: SavedGoogleOAuthSettings = {
  clientId: undefined,
  clientSecret: undefined,
  redirectUri: undefined,
};

/** The provider Better Auth registers, as much of it as this file reads. */
type RegisteredProvider = {
  id: string;
  options: { clientId: string | string[]; clientSecret: string };
  createAuthorizationURL: (input: {
    state: string;
    codeVerifier: string;
    redirectURI: string;
  }) => Promise<URL>;
};

/** The settings are read once per module instance, so each case gets its own. */
async function registeredProviders(settings: SavedGoogleOAuthSettings) {
  saved.settings = settings;
  vi.resetModules();
  const { auth } = await import("../auth");
  const context = await auth.$context;
  return context.socialProviders as unknown as RegisteredProvider[];
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ??= "auth-google-social-provider-test-secret";
});

beforeEach(() => {
  saved.settings = NO_CLIENT;
});

describe("the social provider Better Auth registers from the saved settings", () => {
  it("registers Google, and only Google, with the saved client id and secret", async () => {
    const providers = await registeredProviders(SAVED_CLIENT);

    expect(providers.map((provider) => provider.id)).toEqual(["google"]);
    expect(providers[0].options.clientId).toBe(SAVED_CLIENT.clientId);
    expect(providers[0].options.clientSecret).toBe(SAVED_CLIENT.clientSecret);
  });

  it("builds an authorization URL that names the saved client", async () => {
    const [google] = await registeredProviders(SAVED_CLIENT);

    const authorizationUrl = await google.createAuthorizationURL({
      state: "state-value",
      codeVerifier: "code-verifier-value",
      redirectURI: SAVED_CLIENT.redirectUri,
    });

    const query = new URL(String(authorizationUrl)).searchParams;
    expect(query.get("client_id")).toBe(SAVED_CLIENT.clientId);
    expect(query.get("redirect_uri")).toBe(SAVED_CLIENT.redirectUri);
  });

  it("registers no social provider at all when no client is saved", async () => {
    const providers = await registeredProviders(NO_CLIENT);

    expect(providers).toEqual([]);
  });
});
