// cinatra#2582 — every episode handed to the knowledge-graph indexer becomes
// ONE usage-ledger row, and a keyless install books nothing.
//
// The defect: Graphiti fans out many OpenAI requests per episode in its own
// container, so no adapter call exists here to meter and the spend was entirely
// invisible to `/analytics/llm` (the Graphiti line item of cinatra#2578). The
// hand-over is the only seam this repo owns, so it is where the row is minted.
//
// The row is deliberately UNPRICED (no tokens, no model): the pinned wrapper
// reports no usage back. These tests pin that shape, because "counted" quietly
// becoming "estimated" is the failure mode that would make the ledger lie in a
// new way.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const emitUsageEvent = vi.fn();
vi.mock("@cinatra-ai/metric-contracts", () => ({
  emitUsageEvent: (...args: unknown[]) => emitUsageEvent(...args),
  onUsageEvent: () => () => {},
}));

const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/client", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

function mcpText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

const EPISODE = {
  name: "Acme Corp",
  episode_body: '{"name":"Acme Corp"}',
  source: "json" as const,
  group_id: "cinatra-org-org-1",
};

async function loadClient() {
  const mod = await import("../graphiti-client");
  mod.__resetKnowledgeGraphIndexingWarningForTests();
  mod.setKnowledgeGraphIndexingProbe(null);
  return mod;
}

beforeEach(() => {
  emitUsageEvent.mockReset();
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockClose.mockReset().mockResolvedValue(undefined);
  mockCallTool.mockReset().mockResolvedValue(mcpText({ message: "Episode added" }));
});

describe("one episode = one usage row", () => {
  it("publishes a counted, UNPRICED graphiti row per episode sent", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({ providerKey: "configured", reason: "key configured" }));

    await addEpisode(EPISODE);

    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
    const event = emitUsageEvent.mock.calls[0]![0] as Record<string, unknown>;
    expect(event).toMatchObject({
      source: "graphiti",
      provider: "openai",
      operation: "episode",
      // Unknown, and said so — NOT a zero standing in for a number nobody has.
      model: null,
    });
    expect(typeof event.occurredAt).toBe("string");
    // No token fields at all: the contract cannot express a made-up count.
    expect(event).not.toHaveProperty("inputTokens");
    expect(event).not.toHaveProperty("outputTokens");
    // It must never masquerade as an adapter-metered row — exactly one module
    // constructs those (cinatra#2578).
    expect(event.source).not.toBe("llm");
  });

  it("mints a fresh idempotency key per episode so two sends are two rows", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({ providerKey: "configured", reason: "key configured" }));

    await addEpisode(EPISODE);
    await addEpisode(EPISODE);

    expect(emitUsageEvent).toHaveBeenCalledTimes(2);
    const first = emitUsageEvent.mock.calls[0]![0] as { idempotencyKey: string };
    const second = emitUsageEvent.mock.calls[1]![0] as { idempotencyKey: string };
    expect(first.idempotencyKey).toMatch(/^graphiti:episode:/);
    // Both sends really billed a fan-out; a shared key would make the ledger
    // silently drop the second at the DB's onConflictDoNothing.
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("books nothing when the hand-over itself fails", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({ providerKey: "configured", reason: "key configured" }));
    mockCallTool.mockRejectedValue(new Error("connection refused"));

    await expect(addEpisode(EPISODE)).rejects.toThrow("connection refused");
    expect(emitUsageEvent).not.toHaveBeenCalled();
  });

  it("still books an episode whose ACKNOWLEDGEMENT shape we fail to parse", async () => {
    // The hand-over is what causes the billed fan-out. An acknowledgement we
    // cannot parse is a shape surprise, not a refund — dropping the row there
    // would put the spend back where it was: invisible.
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({ providerKey: "configured", reason: "key configured" }));
    mockCallTool.mockResolvedValue(mcpText({ unexpected: ["shape"] }));

    await addEpisode(EPISODE).catch(() => {
      /* the parse may reject; the accounting must not depend on it */
    });
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("never lets a metering failure break the projection path", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({ providerKey: "configured", reason: "key configured" }));
    emitUsageEvent.mockImplementation(() => {
      throw new Error("bus exploded");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(addEpisode(EPISODE)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a keyless install books no spend and says why — once", () => {
  it("emits nothing and warns when the provider key is ABSENT", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe } = await loadClient();
    setKnowledgeGraphIndexingProbe(() => ({
      providerKey: "absent",
      reason: "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await addEpisode(EPISODE);
    await addEpisode(EPISODE);

    // No key means no provider fan-out, so booking a row would invent spend.
    expect(emitUsageEvent).not.toHaveBeenCalled();
    // Said once per process, not once per episode — the outbox drains in bursts.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("knowledge-graph indexing is OFF");
    expect(line).toContain("no provider key");
    warn.mockRestore();
  });

  it("fails OPEN for the ledger when no probe is bound", async () => {
    // An unbound probe means "the question was not answerable in this process",
    // not "there is no key". The defect being fixed is INVISIBLE spend, so an
    // unattributed row beats a dropped one.
    const { addEpisode } = await loadClient();
    await addEpisode(EPISODE);
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing probe as unknown rather than absent", async () => {
    const { addEpisode, setKnowledgeGraphIndexingProbe, readKnowledgeGraphProviderKeyState } =
      await loadClient();
    setKnowledgeGraphIndexingProbe(() => {
      throw new Error("database unreachable");
    });

    expect(readKnowledgeGraphProviderKeyState().providerKey).toBe("unknown");
    await addEpisode(EPISODE);
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
  });
});
