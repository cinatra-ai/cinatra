// DI contract: the Google-OAuth connection provider is host-injected at boot via
// setGoogleOAuthConnectionProvider and resolved by the connector's "use server"
// save action via requireGoogleOAuthConnectionProvider. It MUST fail closed
// (throw) when unwired — an unbound provider is a boot-wiring bug, never a silent
// no-op that could drop a credential save.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setGoogleOAuthConnectionProvider,
  requireGoogleOAuthConnectionProvider,
  _resetGoogleOAuthConnectionProviderForTests,
  type GoogleOAuthConnectionProvider,
} from "../google-oauth-connection-contract";

function stubProvider(over: Partial<GoogleOAuthConnectionProvider> = {}): GoogleOAuthConnectionProvider {
  return {
    getSettings: async () => ({ clientId: "id", clientSecret: "secret" }),
    getStatus: async () => ({ status: "connected" as const }),
    getOAuthCallbackUrl: () => "https://example.test/oauth/callback",
    saveSettings: async (input) => input,
    ...over,
  };
}

afterEach(() => {
  _resetGoogleOAuthConnectionProviderForTests();
});

describe("google-oauth-connection-contract — host-injected DI provider", () => {
  it("fails CLOSED (throws) when the host never wired a provider", () => {
    _resetGoogleOAuthConnectionProviderForTests();
    expect(() => requireGoogleOAuthConnectionProvider()).toThrow(
      /wired the Google-OAuth connection provider/,
    );
  });

  it("resolves the wired provider after setGoogleOAuthConnectionProvider", () => {
    const impl = stubProvider();
    setGoogleOAuthConnectionProvider(impl);
    expect(requireGoogleOAuthConnectionProvider()).toBe(impl);
  });

  it("re-wiring replaces the previous provider (boot idempotency / test swap)", () => {
    const first = stubProvider();
    const second = stubProvider({ getOAuthCallbackUrl: () => "https://second.test/cb" });
    setGoogleOAuthConnectionProvider(first);
    setGoogleOAuthConnectionProvider(second);
    expect(requireGoogleOAuthConnectionProvider()).toBe(second);
  });

  it("forwards calls to the bound impl (the connector action path)", async () => {
    const save = vi.fn(async (input: { clientId?: string; clientSecret?: string }) => input);
    setGoogleOAuthConnectionProvider(stubProvider({ saveSettings: save }));
    const p = requireGoogleOAuthConnectionProvider();
    expect(p.getOAuthCallbackUrl()).toBe("https://example.test/oauth/callback");
    await p.saveSettings({ clientId: "new-id", clientSecret: "new-secret" });
    expect(save).toHaveBeenCalledWith({ clientId: "new-id", clientSecret: "new-secret" });
  });
});
