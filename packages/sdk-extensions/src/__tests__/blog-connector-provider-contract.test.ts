import { describe, it, expect, beforeEach } from "vitest";
import type { BlogConnector } from "../blog-connector-contract";
import {
  setBlogConnectorProvider,
  registerBlogConnectorViaProvider,
  getBlogConnectorProviderOrNull,
  _resetBlogConnectorProviderForTests,
} from "../blog-connector-provider-contract";

function fakeConnector(id: string): BlogConnector {
  return {
    definition: { connectorId: id, name: id, slug: id, description: id },
    buildDraftPayload: async () => ({ createPayload: {} as never }),
  };
}

describe("blog-connector provider slot (host-injected DI seam)", () => {
  beforeEach(() => _resetBlogConnectorProviderForTests());

  it("routes registrations to the host-bound provider", () => {
    const registered: string[] = [];
    setBlogConnectorProvider({ registerBlogConnector: (c) => registered.push(c.definition.connectorId) });
    registerBlogConnectorViaProvider(fakeConnector("alpha"));
    registerBlogConnectorViaProvider(fakeConnector("beta"));
    expect(registered).toEqual(["alpha", "beta"]);
  });

  it("BOOT-ORDER INDEPENDENCE: a registration BEFORE the host binds is QUEUED and replayed on bind", () => {
    // The bundled connector's register(ctx) activates before the host binder runs.
    registerBlogConnectorViaProvider(fakeConnector("early-1"));
    registerBlogConnectorViaProvider(fakeConnector("early-2"));
    const registered: string[] = [];
    // Host binds later — the queue flushes in order, then live registrations pass through.
    setBlogConnectorProvider({ registerBlogConnector: (c) => registered.push(c.definition.connectorId) });
    expect(registered).toEqual(["early-1", "early-2"]);
    registerBlogConnectorViaProvider(fakeConnector("live"));
    expect(registered).toEqual(["early-1", "early-2", "live"]);
  });

  it("does not double-replay the queue on a second setBlogConnectorProvider", () => {
    registerBlogConnectorViaProvider(fakeConnector("once"));
    const first: string[] = [];
    setBlogConnectorProvider({ registerBlogConnector: (c) => first.push(c.definition.connectorId) });
    const second: string[] = [];
    setBlogConnectorProvider({ registerBlogConnector: (c) => second.push(c.definition.connectorId) });
    expect(first).toEqual(["once"]);
    expect(second).toEqual([]); // queue already drained — not replayed into the new provider
  });

  it("getBlogConnectorProviderOrNull is null until bound", () => {
    expect(getBlogConnectorProviderOrNull()).toBeNull();
    setBlogConnectorProvider({ registerBlogConnector: () => {} });
    expect(getBlogConnectorProviderOrNull()).not.toBeNull();
  });
});
