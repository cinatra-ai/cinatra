// Host-binding regression for the A2A connection provider (finding: removing an
// A2A server must SCRUB the imported Nango API_KEY bearer, not just drop the
// local pointer row). The host binds `deleteConnection` to the AUTHORITATIVE
// (fail-closed) Nango delete — `deleteNangoConnectionStrict` — which propagates
// a real failure so the connector's remove action can abort and retain its
// record rather than orphaning the bearer. This mirrors the tailscale Design C
// authoritative disconnect (cinatra-ai/tailscale-connector#23).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stable outer spy so the module-level provider binding (wired once at import
// via setA2AConnectionProvider) keeps calling THROUGH to a spy we can reset.
const deleteNangoConnectionStrict = vi.fn(async () => undefined);

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { a2aServer: "cinatra-a2a-server" },
  importNangoConnection: vi.fn(async () => null),
  saveNangoConnectionRecord: vi.fn(async () => undefined),
  removeNangoConnectionRecord: vi.fn(async () => undefined),
  deleteNangoConnectionStrict: (...a: unknown[]) =>
    (deleteNangoConnectionStrict as (...x: unknown[]) => Promise<void>)(...a),
}));

vi.mock("@cinatra-ai/agents", () => ({
  upsertExternalAgentTemplate: vi.fn(async () => ({ id: "tmpl-1" })),
  deleteExternalAgentTemplatesByConnectorSlug: vi.fn(async () => 1),
}));

import { requireA2AConnectionProvider } from "@cinatra-ai/sdk-extensions";

// Importing the registrar wires the host provider via its top-level
// `setA2AConnectionProvider(...)` side effect.
import "@/lib/register-a2a-connection-provider";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Do NOT _resetA2AConnectionProviderForTests here — the binding is wired once
  // at module import; a reset would unbind it for the remaining cases.
});

describe("register-a2a-connection-provider — deleteConnection binding", () => {
  it("scrubs via the AUTHORITATIVE deleteNangoConnectionStrict (not best-effort)", async () => {
    const p = requireA2AConnectionProvider();
    await p.deleteConnection({
      connectorKey: "a2aServer",
      providerConfigKey: "cinatra-a2a-server",
      connectionId: "peer-1",
    });
    expect(deleteNangoConnectionStrict).toHaveBeenCalledTimes(1);
    expect(deleteNangoConnectionStrict).toHaveBeenCalledWith("cinatra-a2a-server", "peer-1");
  });

  it("is UNCONDITIONAL — no isNangoConfigured short-circuit before the scrub", async () => {
    // The binding must not gate the strict scrub behind a config probe: config
    // drift (credential imported while configured, Nango later unconfigured)
    // must reach the strict delete so it can fail closed, not silently no-op.
    const p = requireA2AConnectionProvider();
    await p.deleteConnection({
      connectorKey: "a2aServer",
      providerConfigKey: "cinatra-a2a-server",
      connectionId: "peer-2",
    });
    expect(deleteNangoConnectionStrict).toHaveBeenCalledWith("cinatra-a2a-server", "peer-2");
  });

  it("FAIL-CLOSED: propagates a scrub failure (never swallows it)", async () => {
    deleteNangoConnectionStrict.mockRejectedValueOnce(
      new Error("Nango connection delete failed."),
    );
    const p = requireA2AConnectionProvider();
    await expect(
      p.deleteConnection({
        connectorKey: "a2aServer",
        providerConfigKey: "cinatra-a2a-server",
        connectionId: "peer-3",
      }),
    ).rejects.toThrow(/delete failed/);
  });
});
