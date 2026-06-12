/**
 * Dev mode auto-connect idempotency.
 *
 * The SUT `src/lib/a2a-dev-auto-connect.ts` uses a "bypass-Nango-API"
 * pattern: it writes records directly via `saveNangoConnectionRecord` and
 * reads existing connections via `listSavedNangoConnections` from
 * `@cinatra-ai/nango-connector` instead of calling `importNangoConnection`.
 *
 * Behavioral contracts under test during synchronous boot:
 *   - `NODE_ENV !== "development"` → no-op.
 *   - `CINATRA_A2A_DEV_PEER_URLS` missing or empty → no-op.
 *   - Idempotent: existing connections (returned by `listSavedNangoConnections`)
 *     are NOT re-saved.
 *   - Invalid URL schemes (non http/https) are skipped with a console.warn.
 *   - A single failed save must not abort the loop for subsequent URLs.
 *   - URLs are normalized case- and trailing-slash-insensitively for dedupe.
 *
 * Deferred docker exec / fetch behavior is outside the contract under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — lets each test drive nango behaviour without re-import.
// ---------------------------------------------------------------------------

const nango = vi.hoisted(() => ({
  // The list of saved connections that listSavedNangoConnections returns.
  // Each test can override this to seed an "already-connected" state.
  listSavedNangoConnectionsResult: [] as Array<{ connectionId: string; providerConfigKey?: string; metadata?: Record<string, unknown> }>,
  // Recording calls to saveNangoConnectionRecord — the direct persistence path
  // used by the SUT.
  saveNangoConnectionRecordCalls: [] as Array<{
    connectorKey: string;
    record: Record<string, unknown>;
    options?: Record<string, unknown>;
  }>,
  saveNangoConnectionRecordImpl: null as null | (() => Promise<unknown>),
}));

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: {
    a2aServer: "cinatra-a2a-server",
  },
  // SUT calls this synchronously to seed existingIds.
  listSavedNangoConnections: vi.fn((_connectorKey: string) => nango.listSavedNangoConnectionsResult),
  // SUT calls this to persist a new connection record (bypassing the Nango API).
  saveNangoConnectionRecord: vi.fn(
    async (
      connectorKey: string,
      record: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      nango.saveNangoConnectionRecordCalls.push({ connectorKey, record, options });
      if (nango.saveNangoConnectionRecordImpl) {
        return nango.saveNangoConnectionRecordImpl();
      }
      return undefined;
    },
  ),
  // Unused by the SUT; still mocked so any indirect import does not break.
  ensureNangoIntegration: vi.fn(async () => null),
  getNangoConnection: vi.fn(async () => null),
  importNangoConnection: vi.fn(async (input: Record<string, unknown>) => ({
    connection_id: input.connectionId,
  })),
  isNangoConfigured: () => true,
}));

// SUT imports @cinatra-ai/agents. The barrel pulls in @cinatra-ai/objects which
// isn't declared as a dep on @cinatra-ai/agents — so we mock the surface used by
// the SUT.
vi.mock("@cinatra-ai/agents", () => ({
  upsertExternalAgentTemplate: vi.fn(async () => undefined),
  renameExternalAgentTemplateRemoteId: vi.fn(async () => undefined),
  readAgentTemplateByConnectorAndRemoteId: vi.fn(async () => null),
}));

vi.mock("@cinatra-ai/gemini-connector", () => ({
  getConfiguredGeminiAPIKey: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const setNodeEnv = (v: string) => { (process.env as Record<string, string>).NODE_ENV = v; };

function resetEnv() {
  // Restore a clean snapshot between tests so NODE_ENV / peer URL gating
  // stays deterministic.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CINATRA_A2A_DEV_PEER_URLS;
}

function resetState() {
  nango.listSavedNangoConnectionsResult = [];
  nango.saveNangoConnectionRecordCalls = [];
  nango.saveNangoConnectionRecordImpl = null;
}

describe("ensureA2ADevPeerConnections idempotency", () => {
  beforeEach(() => {
    resetEnv();
    resetState();
    vi.clearAllMocks();
  });

  it("no-ops in production (NODE_ENV !== development)", async () => {
    setNodeEnv("production");
    process.env.CINATRA_A2A_DEV_PEER_URLS = "http://localhost:10001";

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );
    await ensureA2ADevPeerConnections();

    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(0);
  });

  it("no-ops when CINATRA_A2A_DEV_PEER_URLS is unset", async () => {
    setNodeEnv("development");
    delete process.env.CINATRA_A2A_DEV_PEER_URLS;

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );
    await ensureA2ADevPeerConnections();

    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(0);
  });

  it("is idempotent — second call does not re-import existing connections", async () => {
    setNodeEnv("development");
    process.env.CINATRA_A2A_DEV_PEER_URLS = "http://localhost:10001";

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );

    // First call: no existing connections → save once.
    nango.listSavedNangoConnectionsResult = [];
    await ensureA2ADevPeerConnections();
    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(1);

    // Capture the connectionId the SUT used so we can simulate it being already
    // present on the second call.
    const persistedConnectionId = nango.saveNangoConnectionRecordCalls[0].record
      .connectionId as string;
    expect(persistedConnectionId).toBeTruthy();

    // Second call: connection now exists → no additional save.
    nango.listSavedNangoConnectionsResult = [
      { connectionId: persistedConnectionId },
    ];
    await ensureA2ADevPeerConnections();
    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(1);
  });

  it("skips non-http(s) URLs and warns to console", async () => {
    setNodeEnv("development");
    process.env.CINATRA_A2A_DEV_PEER_URLS =
      "http://good.test, ftp://bad, http://also-good.test";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );
    await ensureA2ADevPeerConnections();

    // Two http URLs should have been saved; the ftp one skipped.
    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(2);
    // A warning should have been emitted about the invalid scheme.
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("continues on per-URL save failure without aborting the loop", async () => {
    setNodeEnv("development");
    process.env.CINATRA_A2A_DEV_PEER_URLS =
      "http://first.test, http://second.test";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let callIdx = 0;
    nango.saveNangoConnectionRecordImpl = async () => {
      callIdx += 1;
      if (callIdx === 1) {
        throw new Error("nango 500");
      }
      return undefined;
    };

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );
    await ensureA2ADevPeerConnections();

    // Both URLs attempted despite the first throwing.
    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(2);
    // And a warning was logged for the failure.
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("normalizes URLs case- and trailing-slash-insensitively for dedupe", async () => {
    setNodeEnv("development");
    // Two syntactically-different URLs that normalize to the same key:
    // uppercase scheme/host + trailing slash vs. lowercase + no slash.
    process.env.CINATRA_A2A_DEV_PEER_URLS =
      "http://Example.TEST:10001/, http://example.test:10001";

    const { ensureA2ADevPeerConnections } = await import(
      "@/lib/a2a-dev-auto-connect"
    );
    await ensureA2ADevPeerConnections();

    // Only ONE save call — the second URL is a dedupe no-op because it
    // normalizes to the same idempotency key as the first.
    expect(nango.saveNangoConnectionRecordCalls).toHaveLength(1);
  });
});
