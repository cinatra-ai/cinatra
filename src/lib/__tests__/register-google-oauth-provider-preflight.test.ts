import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  __resetCapabilityRegistry,
  invalidateProvidersForPackage,
  registerCapabilityProvider,
  resolveCapabilityProviders,
} from "@/lib/extension-capabilities-registry";

const provider = vi.hoisted(() => ({
  bind: vi.fn(), settings: vi.fn(), status: vi.fn(), save: vi.fn(),
  callback: vi.fn(), presence: vi.fn(),
}));
vi.mock("@cinatra-ai/sdk-extensions", () => ({ setGoogleOAuthConnectionProvider: provider.bind }));
vi.mock("@cinatra-ai/google-oauth-connection", () => ({
  getGoogleOAuthSettings: provider.settings,
  getGoogleOAuthStatus: provider.status,
  saveGoogleOAuthSettings: provider.save,
  readGoogleOAuthConfigurationPresenceForPreflight: provider.presence,
}));
vi.mock("@/lib/nango-system", () => ({ getNangoOAuthCallbackUrl: provider.callback }));

const capability = "connection-configuration-presence";
const owner = getConnectorDescriptorBySlug("google-oauth-connector")!;
const bind = () => import("@/lib/register-google-oauth-provider");

describe("the existing Google provider binder owns configuration presence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    __resetCapabilityRegistry();
    provider.presence.mockReset().mockResolvedValue({ state: "present" });
  });
  afterEach(() => __resetCapabilityRegistry());

  it("registers the actual owning reader without an eager read or a fabricated verdict", async () => {
    expect(resolveCapabilityProviders(capability)).toEqual([]);
    await bind();
    expect(owner.connectionConfigurationOnly).toBe(true);
    const readers = resolveCapabilityProviders(capability);
    expect(readers).toEqual([{ packageName: owner.packageId, impl: { readPresence: provider.presence } }]);
    expect(provider.presence).not.toHaveBeenCalled();
    const impl = readers[0].impl as { readPresence(): Promise<unknown> };
    expect(await impl.readPresence()).toEqual({ state: "present" });
    provider.presence.mockResolvedValue({ state: "unknown" });
    expect(await impl.readPresence()).toEqual({ state: "unknown" });
    expect(provider.presence).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing SDK facade binding and every settings/save function", async () => {
    await bind();
    expect(provider.bind).toHaveBeenCalledExactlyOnceWith({
      getSettings: provider.settings, getStatus: provider.status,
      getOAuthCallbackUrl: provider.callback, saveSettings: provider.save,
    });
    expect(provider.settings).not.toHaveBeenCalled();
    expect(provider.status).not.toHaveBeenCalled();
    expect(provider.save).not.toHaveBeenCalled();
    expect(provider.callback).not.toHaveBeenCalled();
  });

  it("preserves unrelated providers and remains idempotent on reactivation", async () => {
    const unrelated = { packageName: "unrelated-connector", impl: { readPresence: vi.fn() } };
    registerCapabilityProvider(capability, unrelated);
    await bind();
    vi.resetModules();
    await bind();
    expect(resolveCapabilityProviders(capability)).toHaveLength(2);
    expect(resolveCapabilityProviders(capability).filter(p => p.packageName === owner.packageId)).toHaveLength(1);
    expect(resolveCapabilityProviders(capability)).toContainEqual(unrelated);
    expect(provider.presence).not.toHaveBeenCalled();
  });

  it("uses the existing package teardown so removed readers cannot keep claiming presence", async () => {
    await bind();
    invalidateProvidersForPackage(owner.packageId);
    expect(resolveCapabilityProviders(capability)).toEqual([]);
    expect(provider.presence).not.toHaveBeenCalled();
  });
});
