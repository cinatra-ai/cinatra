import { describe, it, expect } from "vitest";
import { SDK_EXTENSIONS_ABI_VERSION } from "../register";
import type {
  HostNangoPort,
  ExtensionHostContext,
} from "../index";
import type {
  ExtensionMcpToolServer,
  ExtensionPrimitiveRequest,
} from "../mcp-connector-contract";
import type { SemanticArtifactManifest } from "../artifact-contract";
import type { AgentIOSpec } from "../agent-io-contract";

// SDK foundation. Locks the single MINOR bump and asserts the new
// additive surface is OPTIONAL (so a host pinned to an older minor still type-checks).

describe("SDK ABI 2.2.0 foundation", () => {
  it("is at 2.2.0", () => {
    expect(SDK_EXTENSIONS_ABI_VERSION).toBe("2.2.0");
  });

  it("declares the new nango render getters as OPTIONAL (additive minor)", () => {
    // A HostNangoPort with ONLY the pre-2.2.0 required methods must still satisfy
    // the type — proving the five new getters are optional.
    const legacyNango: HostNangoPort = {
      isConfigured: async () => false,
      getConnection: async () => null,
      ensureConnectSession: async () => ({}),
    };
    expect(legacyNango.getStatus).toBeUndefined();
    expect(legacyNango.getFrontendConfig).toBeUndefined();
    expect(legacyNango.getPrimarySavedConnection).toBeUndefined();
    expect(legacyNango.getPrimarySavedConnections).toBeUndefined();
    expect(legacyNango.listConnectionRecords).toBeUndefined();
  });

  it("exposes the structural mcp + artifact contracts (compile-time)", () => {
    const server: ExtensionMcpToolServer = {
      registerTool: () => undefined,
    };
    const req: ExtensionPrimitiveRequest<{ x: number }> = {
      primitiveName: "thing_action",
      input: { x: 1 },
      actor: null,
      mode: "agentic",
    };
    const manifest: SemanticArtifactManifest = { accepts: { dashboard: true } };
    const io: AgentIOSpec = { input: [], output: [] };
    expect(typeof server.registerTool).toBe("function");
    expect(req.primitiveName).toBe("thing_action");
    expect(manifest.accepts.dashboard).toBe(true);
    expect(io.input).toHaveLength(0);
  });

  it("keeps the ABI version on the ExtensionHostContext type", () => {
    const ctxAbi: ExtensionHostContext["abiVersion"] = "2.2.0";
    expect(ctxAbi).toBe("2.2.0");
  });
});
