// DI contract: the A2A connection provider is host-injected at boot via
// setA2AConnectionProvider and resolved by the connector's "use server" actions
// via requireA2AConnectionProvider. It MUST fail closed (throw) when unwired —
// an unbound provider is a boot-wiring bug, never a silent no-op.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setA2AConnectionProvider,
  requireA2AConnectionProvider,
  _resetA2AConnectionProviderForTests,
  type A2AConnectionProvider,
} from "../a2a-connection-contract";

function stubProvider(over: Partial<A2AConnectionProvider> = {}): A2AConnectionProvider {
  return {
    providerConfigKeyFor: () => "cinatra-a2a-server",
    importConnection: async () => ({ ok: true }),
    saveConnectionRecord: async () => undefined,
    removeConnectionRecord: async () => undefined,
    upsertExternalAgentTemplate: async () => ({ id: "tmpl-1" }),
    deleteExternalAgentTemplatesByConnectorSlug: async () => 1,
    ...over,
  };
}

afterEach(() => {
  _resetA2AConnectionProviderForTests();
});

describe("a2a-connection-contract — host-injected DI provider", () => {
  it("fails CLOSED (throws) when the host never wired a provider", () => {
    _resetA2AConnectionProviderForTests();
    expect(() => requireA2AConnectionProvider()).toThrow(/wired the A2A connection provider/);
  });

  it("resolves the wired provider after setA2AConnectionProvider", () => {
    const impl = stubProvider();
    setA2AConnectionProvider(impl);
    expect(requireA2AConnectionProvider()).toBe(impl);
  });

  it("re-wiring replaces the previous provider (boot idempotency / test swap)", () => {
    const first = stubProvider();
    const second = stubProvider({ deleteExternalAgentTemplatesByConnectorSlug: async () => 9 });
    setA2AConnectionProvider(first);
    setA2AConnectionProvider(second);
    expect(requireA2AConnectionProvider()).toBe(second);
  });

  it("forwards calls to the bound impl (the connector action path)", async () => {
    const save = vi.fn(async () => undefined);
    setA2AConnectionProvider(stubProvider({ saveConnectionRecord: save }));
    const p = requireA2AConnectionProvider();
    expect(p.providerConfigKeyFor("a2aServer")).toBe("cinatra-a2a-server");
    await p.saveConnectionRecord("a2aServer", { connectionId: "c1", providerConfigKey: "k" }, { multiple: true });
    expect(save).toHaveBeenCalledWith("a2aServer", { connectionId: "c1", providerConfigKey: "k" }, { multiple: true });
  });
});
