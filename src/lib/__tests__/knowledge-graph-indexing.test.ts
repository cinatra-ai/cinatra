// cinatra#2582 — "is knowledge-graph indexing on?" has ONE answer, and it comes
// from the app's stored provider configuration.
//
// The container used to be handed `${OPENAI_API_KEY:-}` from the shell, which is
// not where the app keeps its OpenAI key, so a normal install indexed nothing
// and said nothing. This module is what the bring-up, the boot log and the
// episode seam all ask instead.
//
// The read goes through the CANONICAL sealed-at-rest accessor (cinatra#2587),
// never a raw metadata read, and nothing here may leak the value: the tests
// assert that every operator-facing string is key-free.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const readUnsealedOpenAIConnectionRow = vi.fn();
const readRawOpenAIConnectionRow = vi.fn(() => null as unknown);
// cinatra#2591: the resolver now also reads the committed default provider and
// the stored Anthropic connection, both plain connector-config metadata rows.
const metadata = new Map<string, unknown>();
const readMetadataValueInternal = vi.fn(
  (key: string, fallback: unknown) => (metadata.has(key) ? metadata.get(key) : fallback),
);
vi.mock("@/lib/database-metadata", () => ({
  readUnsealedOpenAIConnectionRow: () => readUnsealedOpenAIConnectionRow(),
  readRawOpenAIConnectionRow: () => readRawOpenAIConnectionRow(),
  readMetadataValueInternal: (key: string, fallback: unknown) =>
    readMetadataValueInternal(key, fallback),
}));

import {
  resolveKnowledgeGraphProviderKey,
  readKnowledgeGraphProviderKeyState,
  describeKnowledgeGraphIndexing,
  __resetKnowledgeGraphIndexingCacheForTests,
} from "@/lib/knowledge-graph-indexing";

const STORED_KEY = "sk-fake-stored-2582";
const ENV_KEY = "sk-fake-env-2582";
const STORED_ANTHROPIC_KEY = "sk-ant-fake-stored-2591";

const DEFAULT_PROVIDER_KEY = "connector_config:llm_default_provider";
const ANTHROPIC_CONNECTION_KEY = "connector_config:anthropic_connection";

const originalEnvKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  __resetKnowledgeGraphIndexingCacheForTests();
  readUnsealedOpenAIConnectionRow.mockReset().mockReturnValue(null);
  readRawOpenAIConnectionRow.mockReset().mockReturnValue(null);
  metadata.clear();
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalEnvKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalEnvKey;
});

// cinatra#2591 deliverable 2 — the indexer's provider derives from the app's
// stored configuration, per install, and is no longer hardcoded to OpenAI.
describe("multi-provider extraction (cinatra#2591)", () => {
  it("runs extraction on ANTHROPIC when that is the committed default", () => {
    metadata.set(DEFAULT_PROVIDER_KEY, "anthropic");
    metadata.set(ANTHROPIC_CONNECTION_KEY, { apiKey: STORED_ANTHROPIC_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.key).toBe(STORED_ANTHROPIC_KEY);
    expect(resolved.source).toBe("stored-connection");
  });

  it("reports OPENAI as the provider on an OpenAI install", () => {
    metadata.set(DEFAULT_PROVIDER_KEY, "openai");
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBe("openai");
    expect(resolved.key).toBe(STORED_KEY);
  });

  it("prefers the COMMITTED provider when BOTH are configured", () => {
    metadata.set(DEFAULT_PROVIDER_KEY, "anthropic");
    metadata.set(ANTHROPIC_CONNECTION_KEY, { apiKey: STORED_ANTHROPIC_KEY });
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.key).toBe(STORED_ANTHROPIC_KEY);
  });

  it("NEVER substitutes the other vendor for a COMMITTED one — extraction stays off", () => {
    // Committed to Anthropic, but only OpenAI was ever configured. Extraction
    // sends ROW CONTENT to whichever vendor runs it, so the operator's choice is
    // binding: a stale OpenAI connection must NOT quietly start receiving object
    // bodies. Off, with the cause named, is the correct answer here.
    metadata.set(DEFAULT_PROVIDER_KEY, "anthropic");
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBeNull();
    expect(resolved.key).toBeNull();
    // The OpenAI key was present and was deliberately left unused.
    expect(resolved.reason).toContain("anthropic");
    expect(resolved.reason).toContain("NOT substituted");
  });

  it("the same rule holds in the other direction (committed OpenAI, only Anthropic stored)", () => {
    metadata.set(DEFAULT_PROVIDER_KEY, "openai");
    metadata.set(ANTHROPIC_CONNECTION_KEY, { apiKey: STORED_ANTHROPIC_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBeNull();
    expect(resolved.key).toBeNull();
    expect(resolved.reason).toContain("openai");
  });

  it("tries BOTH vendors only while nothing is committed yet", () => {
    // A fresh install before the setup saga's commit step. There is no operator
    // choice to violate, so a configured vendor should still index.
    metadata.delete(DEFAULT_PROVIDER_KEY);
    metadata.set(ANTHROPIC_CONNECTION_KEY, { apiKey: STORED_ANTHROPIC_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.key).toBe(STORED_ANTHROPIC_KEY);
    expect(resolved.reason).toContain("no default provider is committed yet");
  });

  it("coerces an unsupported committed provider back to OpenAI", () => {
    // gemini/groq/azure are upstream-supported but cinatra stores no connection
    // for them, so there is no key to resolve and the indexer must not claim one.
    metadata.set(DEFAULT_PROVIDER_KEY, "gemini");
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBe("openai");
    expect(resolved.key).toBe(STORED_KEY);
  });

  it("reports NO provider when neither vendor is configured", () => {
    metadata.set(DEFAULT_PROVIDER_KEY, "anthropic");

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.provider).toBeNull();
    expect(resolved.key).toBeNull();
  });
});

describe("resolveKnowledgeGraphProviderKey", () => {
  it("prefers the app's STORED provider configuration — the thing an operator sets", () => {
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });
    process.env.OPENAI_API_KEY = ENV_KEY;

    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.key).toBe(STORED_KEY);
    expect(resolved.source).toBe("stored-connection");
  });

  it("takes the VALUE only from the canonical unsealed accessor", () => {
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });
    const resolved = resolveKnowledgeGraphProviderKey();
    // The key is sealed at rest since cinatra#2587; taking the value from the
    // raw row would hand the ciphertext envelope to the container as if it were
    // a credential. The raw row is consulted ONLY to tell "unreadable" from
    // "absent", and only when the unsealed read produced nothing.
    expect(resolved.key).toBe(STORED_KEY);
    expect(readUnsealedOpenAIConnectionRow).toHaveBeenCalledTimes(1);
    expect(readRawOpenAIConnectionRow).not.toHaveBeenCalled();
  });

  it("tells a key that will not DECRYPT from a key that is not there", () => {
    // The unseal is fail-closed: a rotated CINATRA_ENCRYPTION_KEY drops the
    // field, which downstream looks exactly like "never configured". Only the
    // raw row separates them — and the difference decides whether the bring-up
    // preserves or clears an already-materialized credential.
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: undefined });
    readRawOpenAIConnectionRow.mockReturnValue({
      apiKey: { __enc: true, ciphertext: "opaque", iv: "opaque" },
    });
    const undecryptable = resolveKnowledgeGraphProviderKey();
    expect(undecryptable.key).toBeNull();
    expect(undecryptable.storedReadFailed).toBe(true);
    expect(undecryptable.reason).toContain("could not be decrypted");

    readUnsealedOpenAIConnectionRow.mockReturnValue(null);
    readRawOpenAIConnectionRow.mockReturnValue(null);
    const reallyAbsent = resolveKnowledgeGraphProviderKey();
    expect(reallyAbsent.key).toBeNull();
    expect(reallyAbsent.storedReadFailed).toBe(false);
  });

  it("falls back to the environment — the legacy path CI arms still use", () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.key).toBe(ENV_KEY);
    expect(resolved.source).toBe("environment");
  });

  it("treats a still-sealed or blank stored value as absent", () => {
    // A failed unseal drops the field; a blank one is not a credential.
    for (const apiKey of [undefined, "", "   ", { __enc: true, ciphertext: "x", iv: "y" }]) {
      readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey });
      expect(resolveKnowledgeGraphProviderKey().key).toBeNull();
    }
  });

  it("degrades to the env fallback when the database is unreachable", () => {
    // A cold bring-up starts Postgres in the same command as this resolution.
    readUnsealedOpenAIConnectionRow.mockImplementation(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    });
    process.env.OPENAI_API_KEY = ENV_KEY;
    expect(resolveKnowledgeGraphProviderKey().key).toBe(ENV_KEY);
  });

  it("reports a read failure by CLASS only — never the error's payload", () => {
    readUnsealedOpenAIConnectionRow.mockImplementation(() => {
      throw new Error(`decrypt failed for ${STORED_KEY}`);
    });
    const resolved = resolveKnowledgeGraphProviderKey();
    expect(resolved.key).toBeNull();
    expect(resolved.reason).toContain("Error");
    expect(resolved.reason).not.toContain(STORED_KEY);
  });
});

describe("readKnowledgeGraphIndexingState", () => {
  it("answers configured/absent by PRESENCE and never carries the key", () => {
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });
    const on = readKnowledgeGraphProviderKeyState();
    expect(on.providerKey).toBe("configured");
    expect(JSON.stringify(on)).not.toContain(STORED_KEY);

    __resetKnowledgeGraphIndexingCacheForTests();
    readUnsealedOpenAIConnectionRow.mockReturnValue(null);
    expect(readKnowledgeGraphProviderKeyState().providerKey).toBe("absent");
  });

  it("answers UNKNOWN — not absent — when the configuration could not be READ", () => {
    // "I could not ask" and "the operator has no key" are different facts, and
    // the metering gate acts on them differently: unknown books the episode
    // (invisible spend is the defect being fixed), off books nothing.
    readUnsealedOpenAIConnectionRow.mockImplementation(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    });
    const state = readKnowledgeGraphProviderKeyState();
    expect(state.providerKey).toBe("unknown");
  });

  it("reports storedReadFailed so the bring-up knows preserve from clear", () => {
    readUnsealedOpenAIConnectionRow.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(resolveKnowledgeGraphProviderKey().storedReadFailed).toBe(true);

    readUnsealedOpenAIConnectionRow.mockReset().mockReturnValue(null);
    // Read fine, no key: an intentional disconnect, which MUST reach the
    // container rather than leaving a revoked credential materialized.
    expect(resolveKnowledgeGraphProviderKey().storedReadFailed).toBe(false);
  });

  it("caches the ANSWER so an outbox drain does not re-query per episode", () => {
    readUnsealedOpenAIConnectionRow.mockReturnValue({ apiKey: STORED_KEY });
    const t0 = 1_000_000;
    readKnowledgeGraphProviderKeyState({ now: t0 });
    readKnowledgeGraphProviderKeyState({ now: t0 + 1_000 });
    readKnowledgeGraphProviderKeyState({ now: t0 + 59_000 });
    expect(readUnsealedOpenAIConnectionRow).toHaveBeenCalledTimes(1);

    // …and expires, so configuring a key becomes visible without a restart.
    readKnowledgeGraphProviderKeyState({ now: t0 + 61_000 });
    expect(readUnsealedOpenAIConnectionRow).toHaveBeenCalledTimes(2);
  });
});

describe("describeKnowledgeGraphIndexing", () => {
  it("states the OFF case in the operator's terms, without overstating it", () => {
    const line = describeKnowledgeGraphIndexing({ providerKey: "absent", reason: "no key" });
    // EXTRACTION, not "indexing" (cinatra#2591). Saying "indexing OFF" is now
    // itself the overstatement this test guards against: a keyless install still
    // seeds every projected row as a deterministic anchor node and still RANKS it
    // on the local embedder floor. What it cannot do is extract entities.
    expect(line).toContain("knowledge-graph EXTRACTION OFF");
    expect(line).not.toContain("knowledge-graph indexing OFF");
    expect(line).toContain("no provider key");
    // Objects still work — the doc claim this issue also corrects.
    expect(line).toContain("Objects are still saved and listed");
    // And the operator is told BOTH vendors are options (deliverable 2).
    expect(line).toContain("Anthropic");
  });

  it("distinguishes unknown from absent", () => {
    expect(
      describeKnowledgeGraphIndexing({ providerKey: "unknown", reason: "no database" }),
    ).toContain("UNKNOWN");
  });

  it("never claims the INDEXER is running with the key — only that the app has one", () => {
    // The app cannot see inside the running container, and the pinned wrapper
    // reports no readiness. Saying "indexing ON" here would be the same class of
    // overstatement this issue exists to remove.
    const line = describeKnowledgeGraphIndexing({
      providerKey: "configured",
      reason: "resolved from the app's stored OpenAI provider configuration",
    });
    expect(line).toContain("provider key CONFIGURED");
    expect(line).not.toContain("indexing ON");
    // …and it says what to do to make the container agree.
    expect(line).toContain("next bring-up");
  });
});
