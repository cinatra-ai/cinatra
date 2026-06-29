// cinatra#685 — the marketplace install/update/restore failure copy must be
// classified from the merged install-failure taxonomy (marketplace#152) into
// plain-language, ACTIONABLE, NON-technical end-user copy.
//
// This is the source/component test for the category→copy mapping + the
// classifier. It guards three contracts:
//   1. classification — representative public coarse codes (and HTTP-status
//      fallbacks) classify to the SAME category the PHP taxonomy assigns; an
//      unknown code fails safe to `unrecoverable`; the code is found in the
//      message, the `cause` chain, AND a MarketplaceMcpError-shaped responseBody.
//   2. no jargon — no message for any category/operation leaks operator wording
//      (registry / bearer / MCP / HTTP status / verdaccio / grant / token /
//      closure / npm).
//   3. actionable + named — every message tells the user what to do next and
//      includes the extension display name.

import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_FAILURE_CATEGORIES,
  classifyMarketplaceFailure,
  marketplaceFailureCopy,
  buildMarketplaceFailureCopy,
  type MarketplaceFailureCategory,
  type MarketplaceFailureOperation,
} from "../marketplace-failure-copy";

const OPERATIONS: MarketplaceFailureOperation[] = ["install", "update", "restore"];

// Words an end user must NEVER see — operator jargon and internal mechanics.
// Matched case-insensitively as whole-ish tokens.
const BANNED = [
  "registry",
  "bearer",
  "mcp",
  "verdaccio",
  "grant",
  "token",
  "closure",
  "npm",
  "tarball",
  "http",
  "404",
  "403",
  "401",
  "409",
  "429",
  "500",
  "502",
  "503",
  "504",
  "cinatra.",
  "broker",
  "entitlement", // a user-facing message should say "not available", not "entitlement"
];

describe("marketplaceFailureCopy — no operator jargon, actionable, names the extension", () => {
  for (const op of OPERATIONS) {
    for (const category of MARKETPLACE_FAILURE_CATEGORIES) {
      it(`[${op}/${category}] is non-technical, actionable, and includes the name`, () => {
        const name = "Acme Widget";
        const msg = marketplaceFailureCopy(category, op, name);
        const lower = msg.toLowerCase();

        for (const banned of BANNED) {
          expect(lower, `"${msg}" must not contain "${banned}"`).not.toContain(banned);
        }

        // Names the specific extension.
        expect(msg).toContain(name);

        // Actionable: tells the user what to do next (try again / contact admin /
        // reconnect / check back). At least one imperative cue must be present.
        expect(
          /try again|contact your administrator|ask your administrator|reconnect|check back/i.test(
            msg,
          ),
          `"${msg}" must be actionable`,
        ).toBe(true);

        // Never asserts the misleading old catch-all cause.
        expect(lower).not.toContain("may be unavailable in the connected registry");
      });
    }
  }

  it("denied-entitlement does not blame the user — points at the administrator", () => {
    const msg = marketplaceFailureCopy("denied-entitlement", "install", "Acme Widget");
    expect(msg.toLowerCase()).toContain("administrator");
    // Does not assert the package is missing/gone (a usually-wrong cause).
    expect(msg.toLowerCase()).not.toContain("no longer available");
  });

  it("unavailable-version does not tell the user to pick a version (no version picker exists)", () => {
    const msg = marketplaceFailureCopy("unavailable-version", "install", "Acme Widget");
    expect(msg.toLowerCase()).not.toContain("pick a different version");
    expect(msg.toLowerCase()).not.toContain("choose");
  });

  it("restore collapses marketplace-shaped categories to generic, non-cause-asserting copy", () => {
    // Restore never round-trips the marketplace, so it must not assert a
    // marketplace cause. denied-entitlement / unavailable-version / missing-creds
    // all collapse to the generic "try again / contact admin" guidance.
    for (const category of ["missing-creds", "denied-entitlement", "unavailable-version", "unrecoverable"] as const) {
      const msg = marketplaceFailureCopy(category, "restore", "Acme Widget");
      expect(msg).toBe(
        "Couldn't restore Acme Widget. Please try again, and contact your administrator if it keeps happening.",
      );
    }
    // retryable keeps the softer "in a moment" phrasing.
    expect(marketplaceFailureCopy("retryable", "restore", "Acme Widget")).toBe(
      "Couldn't restore Acme Widget right now. Please try again in a moment.",
    );
  });

  it("buildMarketplaceFailureCopy returns one entry per taxonomy category", () => {
    const map = buildMarketplaceFailureCopy("install", "Acme Widget");
    expect(Object.keys(map).sort()).toEqual([...MARKETPLACE_FAILURE_CATEGORIES].sort());
    for (const category of MARKETPLACE_FAILURE_CATEGORIES) {
      expect(map[category]).toBe(marketplaceFailureCopy(category, "install", "Acme Widget"));
    }
  });
});

describe("classifyMarketplaceFailure — mirrors the marketplace#152 taxonomy categories", () => {
  // [coarse code, expected category] — one representative per category from the
  // PHP InstallFailureTaxonomy::MAP.
  const CASES: Array<[string, MarketplaceFailureCategory]> = [
    ["cinatra.install_not_entitled", "denied-entitlement"],
    ["cinatra.instance_attach_proof_mismatch", "missing-creds"],
    ["cinatra.install_unauthenticated", "missing-creds"],
    ["cinatra.app_passwords_unavailable", "missing-creds"],
    ["cinatra.install_upstream_unavailable", "retryable"],
    ["cinatra.broker_unavailable", "retryable"],
    ["cinatra.install_rate_limited", "retryable"],
    ["cinatra.install_not_found", "unavailable-version"],
    ["cinatra.install_closure_unresolved", "unavailable-version"],
    ["cinatra.install_member_integrity_mismatch", "unavailable-version"],
    ["cinatra.install_signing_unavailable", "unrecoverable"],
    ["cinatra.install_grant_invalid", "unrecoverable"],
    ["cinatra.invalid_package_name", "unrecoverable"],
  ];

  for (const [code, expected] of CASES) {
    it(`${code} → ${expected}`, () => {
      expect(classifyMarketplaceFailure(new Error(`install failed: ${code}`))).toBe(expected);
    });
  }

  it("an unknown / unmapped code fails safe to unrecoverable", () => {
    expect(classifyMarketplaceFailure(new Error("cinatra.some_brand_new_code"))).toBe(
      "unrecoverable",
    );
    expect(classifyMarketplaceFailure(new Error("a totally unstructured failure"))).toBe(
      "unrecoverable",
    );
    expect(classifyMarketplaceFailure(undefined)).toBe("unrecoverable");
    expect(classifyMarketplaceFailure(null)).toBe("unrecoverable");
  });

  it("finds the coarse code in a chained cause", () => {
    const inner = new Error("cinatra.install_not_entitled");
    const outer = new Error("batch member install failed", { cause: inner });
    expect(classifyMarketplaceFailure(outer)).toBe("denied-entitlement");
  });

  it("finds the coarse code in a MarketplaceMcpError-shaped responseBody", () => {
    const mcpLike = Object.assign(new Error("Marketplace extension_install_authorize: HTTP 409"), {
      httpStatus: 409,
      responseBody: JSON.stringify({ code: "cinatra.install_closure_unresolved" }),
    });
    expect(classifyMarketplaceFailure(mcpLike)).toBe("unavailable-version");
  });

  it("reads an explicit code field over a missing message token", () => {
    const errLike = { code: "cinatra.install_rate_limited", message: "request failed" };
    expect(classifyMarketplaceFailure(errLike)).toBe("retryable");
  });

  it("falls back to HTTP status only when no coarse code is present", () => {
    const transient = Object.assign(new Error("upstream returned an error"), { httpStatus: 503 });
    expect(classifyMarketplaceFailure(transient)).toBe("retryable");

    const notFound = Object.assign(new Error("not found"), { httpStatus: 404 });
    expect(classifyMarketplaceFailure(notFound)).toBe("unavailable-version");

    // A bare 403 is intentionally NOT mapped to missing-creds — it can mean
    // auth-setup OR entitlement OR a stale grant; stay safe (unrecoverable).
    const forbidden = Object.assign(new Error("forbidden"), { httpStatus: 403 });
    expect(classifyMarketplaceFailure(forbidden)).toBe("unrecoverable");
  });

  it("the coarse code wins over a conflicting HTTP status", () => {
    // 503 would suggest retryable, but the entitlement code is authoritative.
    const err = Object.assign(new Error("cinatra.install_not_entitled"), { httpStatus: 503 });
    expect(classifyMarketplaceFailure(err)).toBe("denied-entitlement");
  });

  it("a recognized-but-UNMAPPED cinatra.<code> fails safe to unrecoverable, ignoring HTTP status", () => {
    // A future contract code we don't classify yet must NOT be guessed from a
    // co-present HTTP status — it fails safe to unrecoverable (matches PHP classify()).
    const err = Object.assign(new Error("cinatra.some_future_code"), { httpStatus: 503 });
    expect(classifyMarketplaceFailure(err)).toBe("unrecoverable");
    // Same when the unmapped code is in an explicit code field.
    expect(
      classifyMarketplaceFailure(
        Object.assign(new Error("boom"), { code: "cinatra.some_future_code", httpStatus: 404 }),
      ),
    ).toBe("unrecoverable");
  });
});
