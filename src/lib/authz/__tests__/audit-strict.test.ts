/**
 * logAuditEventStrict unit tests.
 *
 * The strict variant of logAuditEvent is a NEW sibling that:
 *   1. Propagates DB insert errors (no .catch swallow).
 *   2. Returns the inserted row id via Drizzle's .returning().
 *   3. Reuses sanitizeMetadata for SENSITIVE_KEYS stripping.
 *   4. Skips the denied-cooldown logic (helper boundary always logs allowed).
 *
 * The existing fail-silent logAuditEvent body MUST be unchanged — these
 * tests assert only the new sibling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg.Pool so we can drive the underlying query() return value /
// rejection without a live DB. Mirrors the pattern in audit.test.ts.
const queryMock = vi.fn();
vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  class MockPool {
    on() { return this; }
    listenerCount() { return 1; }
    query(...args: unknown[]) { return queryMock(...args); }
    connect() { return Promise.resolve({ release: () => {}, query: queryMock }); }
    end() { return Promise.resolve(); }
  }
  return { ...actual, Pool: MockPool };
});

// Import AFTER vi.mock so the audit module's `new Pool(...)` resolves to MockPool.
import { logAuditEventStrict } from "@/lib/authz/audit";

describe("logAuditEventStrict", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  // Helper — extract the (text, values) from however the drizzle pg driver
  // invoked the mocked pool.query. Newer drizzle uses a QueryConfig
  // ({ text, values, ... }); older code paths use positional args.
  function extractCall(call: unknown[]): { text: string; values: unknown[] } {
    const a0 = call[0];
    // Drizzle pg driver invokes `pool.query(config, valuesArray)` where
    // config = { text, rowMode, types } and the values are positional in
    // call[1]. Older drivers may inline values into config.values.
    if (a0 && typeof a0 === "object" && "text" in (a0 as object)) {
      const cfg = a0 as { text: string; values?: unknown[] };
      const positional = (call[1] as unknown[]) ?? [];
      return {
        text: cfg.text,
        values: positional.length > 0 ? positional : (cfg.values ?? []),
      };
    }
    return { text: String(a0), values: (call[1] as unknown[]) ?? [] };
  }

  it("S1 — returns { id } resolved from RETURNING clause on success", async () => {
    // Drizzle pg driver issues queries with `rowMode: "array"`, so rows
    // come back as positional arrays — not as objects. The single
    // returning column "id" lands at index 0.
    queryMock.mockResolvedValue({
      rows: [["audit-evt-99"]],
      rowCount: 1,
    });
    const out = await logAuditEventStrict({
      decision: "allowed",
      actorPrincipalId: "u-1",
    });
    expect(out).toEqual({ id: "audit-evt-99" });
  });

  it("S2 — propagates DB insert errors (no swallow)", async () => {
    const dbErr = new Error("pg-down");
    queryMock.mockRejectedValue(dbErr);
    // Drizzle wraps thrown driver errors in a DrizzleQueryError with the
    // original error attached on `.cause`. The strict variant must NOT
    // swallow — the rejection propagates out of logAuditEventStrict.
    await expect(
      logAuditEventStrict({ decision: "allowed", actorPrincipalId: "u-1" }),
    ).rejects.toMatchObject({ cause: dbErr });
  });

  it("S3 — reuses sanitizeMetadata; SENSITIVE_KEYS are stripped", async () => {
    queryMock.mockResolvedValue({
      rows: [["audit-evt-1"]],
      rowCount: 1,
    });
    await logAuditEventStrict({
      decision: "allowed",
      actorPrincipalId: "u-1",
      metadata: {
        bypass: true,
        reason: "moderation",
        password: "leak-me",
        token: "tk",
        keep: "yes",
      },
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const { text, values } = extractCall(queryMock.mock.calls[0]);
    expect(text.toLowerCase()).toContain("insert");
    // Drizzle serializes the metadata jsonb column to a JSON string and
    // appends it to the parameter array. Find that string and parse it
    // back to a real object so we can assert structural equality
    // (key-by-key) rather than fragile substring matching against
    // double-escaped JSON.
    const metadataParam = values
      .filter((v): v is string => typeof v === "string")
      .find((s) => s.startsWith("{") && s.includes("bypass"));
    expect(metadataParam, "metadata jsonb param missing from query").toBeDefined();
    const metadata = JSON.parse(metadataParam as string) as Record<string, unknown>;
    expect(metadata).toEqual({
      bypass: true,
      reason: "moderation",
      keep: "yes",
    });
    // SENSITIVE_KEYS must be stripped — none should appear in the
    // serialized parameter at all.
    expect(metadataParam).not.toContain("password");
    expect(metadataParam).not.toContain("leak-me");
    expect(metadataParam).not.toContain("token");
  });
});
