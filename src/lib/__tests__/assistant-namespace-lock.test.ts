import { describe, it, expect, vi } from "vitest";
import {
  ASSISTANT_NAMESPACE_LOCK_KEY,
  nextFreeSuffixedCandidate,
  withAssistantNamespaceLock,
  acquireAssistantNamespaceLock,
} from "@/lib/assistant-namespace-lock";

describe("ASSISTANT_NAMESPACE_LOCK_KEY", () => {
  it("is a stable positive 32-bit-safe integer constant", () => {
    expect(typeof ASSISTANT_NAMESPACE_LOCK_KEY).toBe("number");
    expect(Number.isInteger(ASSISTANT_NAMESPACE_LOCK_KEY)).toBe(true);
    expect(ASSISTANT_NAMESPACE_LOCK_KEY).toBeGreaterThan(0);
    // pin the value so a drift is caught (a changed key would split the lock).
    expect(ASSISTANT_NAMESPACE_LOCK_KEY).toBe(618_741_037);
  });
});

describe("nextFreeSuffixedCandidate — deterministic suffixing", () => {
  it("returns the base when free", () => {
    expect(nextFreeSuffixedCandidate("gemini", new Set())).toBe("gemini");
  });
  it("skips taken candidates in order base, base-2, base-3, …", () => {
    expect(nextFreeSuffixedCandidate("gemini", new Set(["gemini"]))).toBe("gemini-2");
    expect(nextFreeSuffixedCandidate("gemini", new Set(["gemini", "gemini-2"]))).toBe("gemini-3");
    expect(nextFreeSuffixedCandidate("gemini", new Set(["gemini", "gemini-2", "gemini-3"]))).toBe("gemini-4");
  });
  it("is cross-table-correct: a taken alias suffixes the handle just like a taken handle", () => {
    // caller unions both tables into `taken`
    expect(nextFreeSuffixedCandidate("cinatra", new Set(["cinatra"]))).toBe("cinatra-2");
  });
  it("returns null when the bound is exhausted", () => {
    const taken = new Set<string>(["x"]);
    for (let i = 1; i < 5; i++) taken.add(`x-${i + 1}`);
    expect(nextFreeSuffixedCandidate("x", taken, 5)).toBeNull();
  });
});

describe("withAssistantNamespaceLock — acquires the lock before fn, inside one tx", () => {
  it("runs the advisory-lock SELECT then the callback on the same tx", async () => {
    const calls: string[] = [];
    const fakeTx = {
      execute: vi.fn(async (q: unknown) => {
        calls.push(`execute:${String((q as { queryChunks?: unknown }) ? "sql" : q)}`);
        return { rows: [] };
      }),
    };
    const fakeDb = {
      transaction: async <R>(fn: (tx: typeof fakeTx) => Promise<R>): Promise<R> => {
        calls.push("begin");
        const out = await fn(fakeTx);
        calls.push("commit");
        return out;
      },
    };
    const result = await withAssistantNamespaceLock(fakeDb, async (tx) => {
      expect(tx).toBe(fakeTx);
      calls.push("fn");
      return 42;
    });
    expect(result).toBe(42);
    // lock SELECT executes before the callback body, within the transaction.
    expect(calls[0]).toBe("begin");
    expect(calls[1]?.startsWith("execute:")).toBe(true);
    expect(calls[2]).toBe("fn");
    expect(calls[3]).toBe("commit");
    expect(fakeTx.execute).toHaveBeenCalledTimes(1);
  });

  it("acquireAssistantNamespaceLock issues exactly one execute", async () => {
    const tx = { execute: vi.fn(async () => ({ rows: [] })) };
    await acquireAssistantNamespaceLock(tx);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
});
