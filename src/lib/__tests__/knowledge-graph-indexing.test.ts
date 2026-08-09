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
vi.mock("@/lib/database-metadata", () => ({
  readUnsealedOpenAIConnectionRow: () => readUnsealedOpenAIConnectionRow(),
  readRawOpenAIConnectionRow: () => readRawOpenAIConnectionRow(),
}));

import {
  resolveKnowledgeGraphProviderKey,
  readKnowledgeGraphProviderKeyState,
  describeKnowledgeGraphIndexing,
  __resetKnowledgeGraphIndexingCacheForTests,
} from "@/lib/knowledge-graph-indexing";

const STORED_KEY = "sk-fake-stored-2582";
const ENV_KEY = "sk-fake-env-2582";

const originalEnvKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  __resetKnowledgeGraphIndexingCacheForTests();
  readUnsealedOpenAIConnectionRow.mockReset().mockReturnValue(null);
  readRawOpenAIConnectionRow.mockReset().mockReturnValue(null);
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalEnvKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalEnvKey;
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
    expect(line).toContain("knowledge-graph indexing OFF");
    expect(line).toContain("no provider key");
    // Objects still work — the doc claim this issue also corrects.
    expect(line).toContain("Objects are still saved and listed");
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
