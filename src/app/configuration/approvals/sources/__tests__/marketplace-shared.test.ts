/**
 * Unit proof for the marketplace ApprovalSource shared plumbing:
 *  - #1046 decision-error classification (SoD 409 → readable refusal; 403 →
 *    forbidden; 404 → refused; 429/503 → transient) + error-code parsing;
 *  - the capped ~60s count cache + invalidation (a decision clears it; a failed
 *    load is NOT cached);
 *  - the LOCAL credential predicates that gate every remote call (env + one
 *    mocked identity read; nothing touches the network);
 *  - the optional row-eligibility passthrough (#1045) — graceful when absent.
 *
 * The credential/identity dependencies are mocked so nothing hits a DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";

const h = vi.hoisted(() => ({
  adminToken: undefined as string | undefined,
  hasVendor: false,
  vendorToken: undefined as string | undefined,
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveMarketplaceAdminToken: vi.fn(() => {
    if (!h.adminToken) throw new Error("MARKETPLACE_ADMIN_TOKEN_MISSING");
    return h.adminToken;
  }),
  hasConsumerOrVendorMarketplaceToken: vi.fn(() => h.hasVendor),
  resolveConsumerOrVendorMarketplaceToken: vi.fn(() => {
    if (!h.vendorToken) throw new Error("VENDOR_CREDENTIALS_MISSING");
    return h.vendorToken;
  }),
}));

import {
  anyMarketplaceCredential,
  cachedMarketplaceCount,
  cappedCount,
  classifyMarketplaceDecideError,
  hasAdminToken,
  hasInstanceToken,
  hasVendorToken,
  invalidateMarketplaceApprovalCounts,
  parseMarketplaceErrorCode,
  REMOTE_COUNT_CAP,
  resolveAdminToken,
  toRowEligibility,
} from "../marketplace-shared";

const ENV_KEYS = ["MARKETPLACE_INSTANCE_TOKEN", "MARKETPLACE_ADMIN_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.adminToken = undefined;
  h.hasVendor = false;
  h.vendorToken = undefined;
  invalidateMarketplaceApprovalCounts();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("classifyMarketplaceDecideError (#1046)", () => {
  it("maps a 409 separation-of-duties refusal to a readable business refusal", () => {
    const err = new MarketplaceMcpError(
      "cinatra.approver_separation_violation: submitter may not approve",
      409,
      JSON.stringify({ code: "cinatra.approver_separation_violation" }),
    );
    const r = classifyMarketplaceDecideError(err);
    expect(r).toMatchObject({ ok: false, kind: "refused", httpStatus: 409 });
    expect(r.code).toContain("approver_separation");
    // Readable explanation, not the raw WP error string.
    expect(r.message.toLowerCase()).toContain("someone else must review");
  });

  it("maps 403 to a forbidden refusal (capability missing)", () => {
    const err = new MarketplaceMcpError("forbidden", 403, "");
    const r = classifyMarketplaceDecideError(err);
    expect(r).toMatchObject({ ok: false, kind: "forbidden", httpStatus: 403 });
  });

  it("maps 404 to a refused (already decided / gone)", () => {
    const err = new MarketplaceMcpError("not found", 404, "");
    expect(classifyMarketplaceDecideError(err)).toMatchObject({ ok: false, kind: "refused", httpStatus: 404 });
  });

  it("marks 429 and 503 transient (retryable)", () => {
    for (const status of [429, 503]) {
      const r = classifyMarketplaceDecideError(new MarketplaceMcpError("busy", status, ""));
      expect(r).toMatchObject({ ok: false, kind: "transient" });
    }
  });

  it("treats an unclassified / non-marketplace error as transient, never a policy denial", () => {
    expect(classifyMarketplaceDecideError(new Error("socket hangup"))).toMatchObject({
      ok: false,
      kind: "transient",
      code: "unknown",
    });
  });
});

describe("parseMarketplaceErrorCode", () => {
  it("extracts a top-level code from the JSON body", () => {
    expect(parseMarketplaceErrorCode(JSON.stringify({ code: "cinatra.x" }), "msg")).toBe("cinatra.x");
  });
  it("extracts a nested data.error_code from the JSON body", () => {
    const body = JSON.stringify({ data: { error_code: "approver_separation_violation" } });
    expect(parseMarketplaceErrorCode(body, "msg")).toBe("approver_separation_violation");
  });
  it("falls back to a code-shaped token in the message", () => {
    expect(parseMarketplaceErrorCode("", "approver_separation_violation happened")).toContain("separation");
  });
  it("returns null when neither carries a code and never throws on bad JSON", () => {
    expect(parseMarketplaceErrorCode("{not json", "totally opaque")).toBeNull();
  });
});

describe("cachedMarketplaceCount", () => {
  it("caches a successful load within the TTL and recomputes after invalidation", async () => {
    const loader = vi.fn().mockResolvedValue(3);
    expect(await cachedMarketplaceCount("k", loader)).toBe(3);
    expect(await cachedMarketplaceCount("k", loader)).toBe(3);
    expect(loader).toHaveBeenCalledTimes(1); // second read is cached

    invalidateMarketplaceApprovalCounts();
    expect(await cachedMarketplaceCount("k", loader)).toBe(3);
    expect(loader).toHaveBeenCalledTimes(2); // recomputed after invalidation
  });

  it("does NOT cache a failed load (a transient error must not pin a 0)", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(5);
    await expect(cachedMarketplaceCount("k2", loader)).rejects.toThrow("boom");
    expect(await cachedMarketplaceCount("k2", loader)).toBe(5);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("cappedCount", () => {
  it("caps at REMOTE_COUNT_CAP and floors at 0", () => {
    expect(cappedCount(0)).toBe(0);
    expect(cappedCount(REMOTE_COUNT_CAP - 1)).toBe(REMOTE_COUNT_CAP - 1);
    expect(cappedCount(REMOTE_COUNT_CAP + 100)).toBe(REMOTE_COUNT_CAP);
    expect(cappedCount(-4)).toBe(0);
  });
});

describe("credential predicates (local, no network)", () => {
  it("hasInstanceToken reflects MARKETPLACE_INSTANCE_TOKEN", () => {
    expect(hasInstanceToken()).toBe(false);
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(hasInstanceToken()).toBe(true);
  });

  it("resolveAdminToken / hasAdminToken reflect the admin resolver", () => {
    expect(hasAdminToken()).toBe(false);
    expect(resolveAdminToken()).toBeUndefined();
    h.adminToken = "admin-tok";
    expect(hasAdminToken()).toBe(true);
    expect(resolveAdminToken()).toBe("admin-tok");
  });

  it("hasVendorToken reflects the consumer/vendor resolver (never throws)", () => {
    expect(hasVendorToken()).toBe(false);
    h.hasVendor = true;
    expect(hasVendorToken()).toBe(true);
  });

  it("anyMarketplaceCredential is false only when NOTHING resolves", () => {
    expect(anyMarketplaceCredential()).toBe(false);
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(anyMarketplaceCredential()).toBe(true);
    delete process.env.MARKETPLACE_INSTANCE_TOKEN;
    h.adminToken = "admin";
    expect(anyMarketplaceCredential()).toBe(true);
    h.adminToken = undefined;
    h.hasVendor = true;
    expect(anyMarketplaceCredential()).toBe(true);
  });
});

describe("toRowEligibility passthrough (#1045)", () => {
  it("returns undefined when the marketplace supplies no eligibility (graceful)", () => {
    expect(toRowEligibility(undefined)).toBeUndefined();
    expect(toRowEligibility({})).toBeUndefined();
  });
  it("maps present boolean/reason fields and ignores wrong types", () => {
    expect(toRowEligibility({ can_approve: false, can_reject: true, reason: "SoD" })).toEqual({
      can_approve: false,
      can_reject: true,
      reason: "SoD",
    });
    // Empty reason dropped; missing fields omitted.
    expect(toRowEligibility({ can_approve: true, reason: "" })).toEqual({ can_approve: true });
  });
});
