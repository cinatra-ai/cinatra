import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure helpers of the DLQ writer (cinatra#341 F5). The DB insert
// (recordOutboundDeadLetter) is exercised here with `runPostgresQueriesSync`
// mocked so we can assert SCHEMA-QUALIFIED SQL (codex round-1 HIGH) without a
// live Postgres; the hygiene transforms that protect the table from leaking
// secrets are locked too.

// Capture every query passed to the sync runner.
const runQueriesMock = vi.fn().mockReturnValue([{ rows: [], rowCount: 0 }]);
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => runQueriesMock(...args),
}));

import {
  digestPayload,
  sanitizeTargetUrl,
  sanitizeError,
  recordOutboundDeadLetter,
} from "../webhook-outbound-deadletter.server";

// The default test schema from @/lib/database stub / postgres-config default.
import { postgresSchema } from "@/lib/database";

describe("digestPayload", () => {
  it("is a stable sha256 hex for a given value and never the raw payload", () => {
    const payload = { secretField: "whsec_topsecret", n: 1 };
    const d1 = digestPayload(payload);
    const d2 = digestPayload({ secretField: "whsec_topsecret", n: 1 });
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(d1).toBe(d2);
    expect(d1).not.toContain("whsec_topsecret");
  });

  it("does not throw on non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => digestPayload(circular)).not.toThrow();
    expect(digestPayload(circular)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sanitizeTargetUrl", () => {
  it("strips the query string (where URL tokens hide)", () => {
    expect(sanitizeTargetUrl("https://h.test/hook?token=secret123&x=1")).toBe(
      "https://h.test/hook",
    );
  });

  it("strips userinfo (basic-auth creds)", () => {
    expect(sanitizeTargetUrl("https://user:p@ss@h.test/hook")).toBe("https://h.test/hook");
  });

  it("keeps origin + pathname", () => {
    expect(sanitizeTargetUrl("https://h.test:8443/a/b/c")).toBe("https://h.test:8443/a/b/c");
  });

  it("best-effort scrubs an unparseable URL", () => {
    const out = sanitizeTargetUrl("not a url ?token=leak");
    expect(out).not.toContain("token=leak");
  });
});

describe("sanitizeError", () => {
  it("returns null for empty input", () => {
    expect(sanitizeError(null)).toBeNull();
    expect(sanitizeError(undefined)).toBeNull();
    expect(sanitizeError("")).toBeNull();
  });

  it("redacts whsec_ secrets", () => {
    expect(sanitizeError("signing failed for whsec_abc123DEF456")).toBe(
      "signing failed for whsec_[redacted]",
    );
  });

  it("redacts long high-entropy token blobs", () => {
    const token = "A".repeat(50);
    expect(sanitizeError(`bearer ${token} rejected`)).toContain("[redacted-token]");
  });

  it("truncates to the cap", () => {
    // Use short words so the long-token redaction does not collapse the string
    // before truncation runs.
    const long = "err ".repeat(500); // 2000 chars of benign words
    const out = sanitizeError(long)!;
    expect(out.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("passes a short benign message through", () => {
    expect(sanitizeError("HTTP 503")).toBe("HTTP 503");
  });

  // cinatra#341 codex round-1 HIGH: Node fetch/undici embeds the FULL target
  // URL in its thrown message, so a basic-auth password or a short `?token=`
  // query secret would otherwise survive past the whsec_/40+char redactions and
  // land in webhook_outbound_dead_letter.last_error (acceptance #3 violation).
  // NB the credentialed URL is ASSEMBLED at runtime so no userinfo-bearing URL
  // literal sits in source for the secret-scan-gate URI detector to flag.
  it("reduces an embedded URL to origin+pathname (strips userinfo creds)", () => {
    const cred = ["user", "topsecretpw"].join(":");
    const url = `https://${cred}@h.test/hook?token=abc123`;
    const out = sanitizeError(
      `Request cannot be constructed from a URL that includes credentials: ${url}`,
    )!;
    expect(out).not.toContain("topsecretpw");
    expect(out).not.toContain("token=abc123");
    expect(out).toContain("https://h.test/hook");
  });

  it("strips a short query secret embedded in an error URL", () => {
    const out = sanitizeError("HTTP 500 from https://hook.example.com/cb?signing_key=shhh")!;
    expect(out).not.toContain("signing_key");
    expect(out).not.toContain("shhh");
    expect(out).toContain("https://hook.example.com/cb");
  });
});

describe("recordOutboundDeadLetter — schema-qualified + sanitized insert", () => {
  beforeEach(() => {
    runQueriesMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allSql(): string {
    return runQueriesMock.mock.calls
      .flatMap((c) => (c[0] as { queries: { text: string }[] }).queries.map((q) => q.text))
      .join("\n");
  }

  it("every statement schema-qualifies the table (no unqualified write to public)", () => {
    recordOutboundDeadLetter({
      eventKind: "assistant.mention",
      messageId: "m-1",
      targetUrl: "https://h.test/hook?token=leak",
      payloadDigest: "abc",
      attempts: 5,
      lastStatus: 503,
      lastError: "boom",
    });
    const sql = allSql();
    // Bootstrap DDL + insert all reference the schema-qualified table name.
    expect(sql).toContain(`"${postgresSchema}"."webhook_outbound_dead_letter"`);
    // And NEVER an unqualified `webhook_outbound_dead_letter` table reference
    // (the index name is allowed to be bare; the table is not).
    expect(sql).not.toMatch(/(?<![."])\bwebhook_outbound_dead_letter\b(?!_)/);
  });

  it("ON CONFLICT DO NOTHING makes the insert idempotent (F4)", () => {
    recordOutboundDeadLetter({
      eventKind: "assistant.mention",
      messageId: "m-2",
      targetUrl: "https://h.test/hook",
      payloadDigest: "abc",
      attempts: 1,
    });
    expect(allSql()).toMatch(/ON CONFLICT \(event_kind, message_id\) DO NOTHING/);
  });

  it("sanitizes target_url (strips query) and last_error before binding values", () => {
    recordOutboundDeadLetter({
      eventKind: "assistant.mention",
      messageId: "m-3",
      targetUrl: "https://h.test/hook?token=secretLEAK",
      payloadDigest: "abc",
      attempts: 1,
      lastError: "failed using whsec_supersecret",
    });
    // The INSERT call is the LAST query batch; grab its bound values.
    const lastCall = runQueriesMock.mock.calls.at(-1)![0] as {
      queries: { text: string; values?: unknown[] }[];
    };
    const insert = lastCall.queries.find((q) => q.text.includes("INSERT INTO"))!;
    const values = insert.values as unknown[];
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain("secretLEAK");
    expect(serialized).not.toContain("whsec_supersecret");
    expect(serialized).toContain("https://h.test/hook");
  });
});
