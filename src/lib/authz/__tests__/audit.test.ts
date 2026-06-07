import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pg.Pool to control insert behavior across tests. The audit module
// imports `Pool` from "pg"; intercepting at the pg layer lets us assert
// insert call counts (cooldown tests) and force rejection (fire-and-forget
// test) without needing a live DB.
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
// These imports are the public audit helpers covered by this test file.
import {
  logAuditEvent,
  sanitizeMetadata,
  isDeniedCoolingDown,
  _resetDeniedCooldownForTests,
  type AuditEventInput,
} from "@/lib/authz/audit";

describe("logAuditEvent audit helpers", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    _resetDeniedCooldownForTests();
  });

  describe("sanitizeMetadata", () => {
    it("strips a single sensitive key (prompt)", () => {
      const out = sanitizeMetadata({ prompt: "secret prompt", safe: 1 });
      expect(out).toEqual({ safe: 1 });
    });

    it("strips ALL 11 SENSITIVE_KEYS, preserves others", () => {
      const input = {
        prompt: "x", content: "x", body: "x", draft: "x", email: "x",
        password: "x", token: "x", secret: "x", key: "x",
        credential: "x", payload: "x",
        runId: "keep", actor: "keep", resourceType: "keep",
      };
      const out = sanitizeMetadata(input);
      expect(out).toEqual({ runId: "keep", actor: "keep", resourceType: "keep" });
    });

    it("returns undefined for undefined input", () => {
      expect(sanitizeMetadata(undefined)).toBeUndefined();
    });
  });

  describe("denied-event cooldown", () => {
    const sharedDenied: AuditEventInput = {
      actorPrincipalId: "user-1",
      resourceType: "agent_template",
      operation: "create",
      decision: "denied",
      policyVersion: "v1",
    };

    it("suppresses duplicate denied events within 60s window", async () => {
      await logAuditEvent(sharedDenied);
      await logAuditEvent(sharedDenied);
      // Only ONE insert query, not two.
      expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT suppress allowed events", async () => {
      const allowed: AuditEventInput = { ...sharedDenied, decision: "allowed" };
      await logAuditEvent(allowed);
      await logAuditEvent(allowed);
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it("uses (actorPrincipalId, resourceType, operation) as the cooldown key", async () => {
      await logAuditEvent({ ...sharedDenied, operation: "create" });
      await logAuditEvent({ ...sharedDenied, operation: "delete" });
      // Different operation → different key → both insert.
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it("isDeniedCoolingDown returns true after a denied insert, false for unknown keys", async () => {
      await logAuditEvent(sharedDenied);
      expect(isDeniedCoolingDown("user-1:agent_template:create")).toBe(true);
      expect(isDeniedCoolingDown("user-1:agent_template:delete")).toBe(false);
    });
  });

  describe("fire-and-forget — never throws", () => {
    it("resolves to undefined even when the DB insert rejects", async () => {
      queryMock.mockRejectedValueOnce(new Error("simulated DB failure"));
      await expect(
        logAuditEvent({
          actorPrincipalId: "user-1",
          resourceType: "agent_template",
          operation: "create",
          decision: "allowed",
          policyVersion: "v1",
        }),
      ).resolves.toBeUndefined();
    });
  });
});
