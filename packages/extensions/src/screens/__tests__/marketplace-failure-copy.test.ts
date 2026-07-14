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
  extractContractCode,
  extractHttpStatus,
  appendDiagnosticReference,
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

  it("unavailable-version does NOT assert the false 'no longer available' cause (#1539)", () => {
    // The category is kept ONLY for codes that affirmatively mean "not available
    // to install at this version"; the copy must state that WITHOUT claiming the
    // version WAS available and is now GONE.
    const msg = marketplaceFailureCopy("unavailable-version", "install", "Acme Widget");
    expect(msg.toLowerCase()).not.toContain("no longer available");
    expect(msg.toLowerCase()).toContain("isn't available to install");
    expect(msg).toContain("Acme Widget");
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
    // #1539: unavailable-version SURVIVES only for codes that affirmatively mean
    // "not available to install at this version".
    ["cinatra.install_not_found", "unavailable-version"],
    ["cinatra.install_not_listed", "unavailable-version"],
    // #1539: re-bucketed to unrecoverable (generic) — none of these is a gone
    // version: a bad input, a dependency-closure failure, an integrity mismatch.
    ["cinatra.invalid_version", "unrecoverable"],
    ["cinatra.install_closure_unresolved", "unrecoverable"],
    ["cinatra.install_member_integrity_mismatch", "unrecoverable"],
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
    // #1539: install_closure_unresolved now re-buckets to unrecoverable.
    const mcpLike = Object.assign(new Error("Marketplace extension_install_authorize: HTTP 409"), {
      httpStatus: 409,
      responseBody: JSON.stringify({ code: "cinatra.install_closure_unresolved" }),
    });
    expect(classifyMarketplaceFailure(mcpLike)).toBe("unrecoverable");
  });

  it("classifies a kept unavailable-version code from a responseBody (install_not_found)", () => {
    const mcpLike = Object.assign(new Error("Marketplace install: HTTP 404"), {
      httpStatus: 404,
      responseBody: JSON.stringify({ code: "cinatra.install_not_found" }),
    });
    // The RECOGNIZED code wins and keeps unavailable-version — distinct from the
    // bare-404 path below, which has no code and must NOT be unavailable-version.
    expect(classifyMarketplaceFailure(mcpLike)).toBe("unavailable-version");
  });

  it("reads an explicit code field over a missing message token", () => {
    const errLike = { code: "cinatra.install_rate_limited", message: "request failed" };
    expect(classifyMarketplaceFailure(errLike)).toBe("retryable");
  });

  it("falls back to HTTP status only when no coarse code is present", () => {
    const transient = Object.assign(new Error("upstream returned an error"), { httpStatus: 503 });
    expect(classifyMarketplaceFailure(transient)).toBe("retryable");

    // A bare 403 is intentionally NOT mapped to missing-creds — it can mean
    // auth-setup OR entitlement OR a stale grant; stay safe (unrecoverable).
    const forbidden = Object.assign(new Error("forbidden"), { httpStatus: 403 });
    expect(classifyMarketplaceFailure(forbidden)).toBe("unrecoverable");
  });

  it("a bare 404 with NO recognized contract code is NOT unavailable-version (#1539 AC5)", () => {
    // The status-only 404 must fail SAFE to unrecoverable — it is NOT evidence
    // that "this version is no longer available" (that condition arrives as the
    // mapped code install_not_found). A misrouted request / wrong endpoint /
    // gateway 404 must never assert a gone version.
    const bare404 = Object.assign(new Error("not found"), { httpStatus: 404 });
    expect(classifyMarketplaceFailure(bare404)).toBe("unrecoverable");

    const bare404Nested = new Error("outer", {
      cause: Object.assign(new Error("inner"), { statusCode: 404 }),
    });
    expect(classifyMarketplaceFailure(bare404Nested)).toBe("unrecoverable");
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

describe("#1539 per-code copy audit — each code into unavailable-version gets truthful copy", () => {
  // AC4/AC8: enumerate EVERY code that used to yield unavailable-version and pin
  // BOTH its post-audit category AND the resulting end-user copy — the codes
  // that KEEP unavailable-version, and (separately) each code re-mapped AWAY.
  const KEEPS_UNAVAILABLE = ["install_not_listed", "install_not_found"] as const;
  const REMAPPED_AWAY = [
    "invalid_version",
    "install_closure_unresolved",
    "install_member_integrity_mismatch",
  ] as const;

  const copyFor = (code: string) =>
    marketplaceFailureCopy(
      classifyMarketplaceFailure(new Error(`install failed: cinatra.${code}`)),
      "install",
      "Acme Widget",
    );

  for (const code of KEEPS_UNAVAILABLE) {
    it(`${code} KEEPS unavailable-version and gets the "not available to install" copy`, () => {
      expect(classifyMarketplaceFailure(new Error(`cinatra.${code}`))).toBe("unavailable-version");
      const msg = copyFor(code);
      expect(msg.toLowerCase()).toContain("isn't available to install");
      expect(msg.toLowerCase()).not.toContain("no longer available");
    });
  }

  for (const code of REMAPPED_AWAY) {
    it(`${code} is re-mapped AWAY from unavailable-version → generic non-"gone" copy`, () => {
      expect(classifyMarketplaceFailure(new Error(`cinatra.${code}`))).toBe("unrecoverable");
      const msg = copyFor(code);
      // Generic, non-cause-asserting: never claims the version is gone/unavailable.
      expect(msg.toLowerCase()).not.toContain("no longer available");
      expect(msg.toLowerCase()).not.toContain("isn't available to install");
      expect(msg.toLowerCase()).toContain("contact your administrator");
      expect(msg).toContain("Acme Widget");
    });
  }
});

describe("extractContractCode / extractHttpStatus — sanitized operator diagnostics (#1539)", () => {
  it("extracts the bare contract code from a message, cause, responseBody, and code field", () => {
    expect(extractContractCode(new Error("install failed: cinatra.install_not_found"))).toBe(
      "install_not_found",
    );
    expect(
      extractContractCode(new Error("outer", { cause: new Error("cinatra.install_rate_limited") })),
    ).toBe("install_rate_limited");
    expect(
      extractContractCode(
        Object.assign(new Error("boom"), {
          responseBody: JSON.stringify({ code: "cinatra.install_not_entitled" }),
        }),
      ),
    ).toBe("install_not_entitled");
    expect(extractContractCode({ code: "cinatra.invalid_version", message: "x" })).toBe(
      "invalid_version",
    );
  });

  it("extracts a BARE (unprefixed) explicit code field, agreeing with the classifier (#1539)", () => {
    // The classifier accepts a bare `{ code: "install_not_found" }` (it strips a
    // leading cinatra. that isn't there and maps the bare token). The extractor
    // MUST agree — it previously returned null, disagreeing with the classifier.
    const bare = { code: "install_not_found", message: "boom" };
    expect(classifyMarketplaceFailure(bare)).toBe("unavailable-version");
    expect(extractContractCode(bare)).toBe("install_not_found");

    const prefixed = { code: "cinatra.install_not_found" };
    expect(extractContractCode(prefixed)).toBe("install_not_found");
  });

  it("returns the RAW code even for a code the classifier does not map (fidelity for operators)", () => {
    // classifyMarketplaceFailure fails safe to unrecoverable, but the operator
    // must still see the true contract code that was returned.
    expect(classifyMarketplaceFailure(new Error("cinatra.some_future_code"))).toBe("unrecoverable");
    expect(extractContractCode(new Error("cinatra.some_future_code"))).toBe("some_future_code");
  });

  it("logs the code that PRODUCED the category, skipping an earlier UNMAPPED token (#1539)", () => {
    // Drift shape: a new PHP-taxonomy code the TS map has not caught up with
    // (`cinatra.some_future_code`) sits AHEAD of a mapped code in the SAME
    // string. The classifier skips the unmapped token and classifies from the
    // mapped one — so the operator `code=` MUST be the mapped code that produced
    // the category, never the earlier unmapped token (that would be exactly the
    // misleading `code=X category=<from a different code>` diagnostic #1539 is
    // about). Same requirement when the two tokens are split across fields.
    const oneString = new Error("cinatra.some_future_code then cinatra.install_not_found");
    expect(classifyMarketplaceFailure(oneString)).toBe("unavailable-version");
    expect(extractContractCode(oneString)).toBe("install_not_found");

    const splitFields = Object.assign(new Error("boom cinatra.some_future_code"), {
      responseBody: JSON.stringify({ code: "cinatra.install_not_entitled" }),
    });
    expect(classifyMarketplaceFailure(splitFields)).toBe("denied-entitlement");
    expect(extractContractCode(splitFields)).toBe("install_not_entitled");

    // When NO code maps (the classifier truly fell safe), the operator still
    // sees the first unmapped code — the drift signal is not swallowed.
    const allUnmapped = new Error("cinatra.some_future_code and cinatra.another_future_code");
    expect(classifyMarketplaceFailure(allUnmapped)).toBe("unrecoverable");
    expect(extractContractCode(allUnmapped)).toBe("some_future_code");
  });

  it("does NOT log a BARE, unprefixed unmapped code the classifier classified AROUND (#1539 AC7)", () => {
    // A bare (non-`cinatra.`) code field the TS map does not know is NOT a
    // contract signal to the classifier: `probe`'s `sawUnmapped` gate fires only
    // for a `cinatra.`-prefixed field, so with a classifiable HTTP status present
    // the classifier classifies from the STATUS (retryable) and ignores the bare
    // code entirely. The operator log must therefore NOT carry that code, or it
    // would read `code=<bare> category=retryable` — implying a cause the code
    // never produced, the exact misleading diagnostic #1539 eliminates.
    const bareUnmappedWithStatus = Object.assign(new Error("boom"), {
      code: "future_taxonomy_code",
      httpStatus: 503,
    });
    expect(classifyMarketplaceFailure(bareUnmappedWithStatus)).toBe("retryable");
    expect(extractContractCode(bareUnmappedWithStatus)).toBe(null);

    // A RECOGNIZED-SHAPE (`cinatra.`-prefixed) unmapped code, by contrast, IS a
    // contract signal: it forces the classifier SAFE to `unrecoverable` (a
    // contract code it does not map yet, NOT an HTTP-status guess) and MUST still
    // be logged so PHP-taxonomy drift stays visible — and it agrees with the
    // category it produced.
    const prefixedUnmappedWithStatus = Object.assign(new Error("boom"), {
      code: "cinatra.future_taxonomy_code",
      httpStatus: 503,
    });
    expect(classifyMarketplaceFailure(prefixedUnmappedWithStatus)).toBe("unrecoverable");
    expect(extractContractCode(prefixedUnmappedWithStatus)).toBe("future_taxonomy_code");
  });

  it("does NOT trim-then-map a whitespace-padded code the classifier leaves unmapped (#1539 AC7)", () => {
    // The classifier's `probe` does NOT trim an explicit code field (it mirrors
    // the PHP contract, whose map is keyed on untrimmed tokens), so a padded
    // token like `"install_not_found "` is UNMAPPED there and — with a
    // classifiable status present — classified from the STATUS. The extractor
    // must parse identically (no trim) so it does not map-then-report the padded
    // token, which would log `code=install_not_found category=retryable` — the
    // same provenance mismatch under a whitespace normalization difference.
    const paddedMappedWithStatus = Object.assign(new Error("boom"), {
      code: "install_not_found ",
      httpStatus: 503,
    });
    expect(classifyMarketplaceFailure(paddedMappedWithStatus)).toBe("retryable");
    expect(extractContractCode(paddedMappedWithStatus)).toBe(null);

    // A padded `cinatra.`-prefixed token is recognized-shape (forces the
    // classifier SAFE to `unrecoverable`) but is malformed as a logged value, so
    // it is reported as `code=null` — never misattributing a code to a category.
    const paddedPrefixedWithStatus = Object.assign(new Error("boom"), {
      code: "cinatra.install_not_found ",
      httpStatus: 503,
    });
    expect(classifyMarketplaceFailure(paddedPrefixedWithStatus)).toBe("unrecoverable");
    expect(extractContractCode(paddedPrefixedWithStatus)).toBe(null);
  });

  it("returns null when no coarse code is present (a bare 404)", () => {
    expect(extractContractCode(Object.assign(new Error("not found"), { httpStatus: 404 }))).toBe(
      null,
    );
    expect(extractContractCode(undefined)).toBe(null);
  });

  it("extracts the first HTTP status from the chain (httpStatus/status/statusCode)", () => {
    expect(extractHttpStatus(Object.assign(new Error("x"), { httpStatus: 404 }))).toBe(404);
    expect(
      extractHttpStatus(new Error("outer", { cause: Object.assign(new Error("y"), { statusCode: 503 }) })),
    ).toBe(503);
    expect(extractHttpStatus(new Error("no status here"))).toBe(null);
  });
});

describe("appendDiagnosticReference — single source of the user-visible reference suffix (#1539)", () => {
  it("appends the reference when present, and is a no-op when absent", () => {
    const base = "Acme Widget can't be installed right now — this version isn't available to install.";
    expect(appendDiagnosticReference(base, "REF-1A2B3C4D")).toBe(`${base} (Ref: REF-1A2B3C4D)`);
    expect(appendDiagnosticReference(base, undefined)).toBe(base);
    expect(appendDiagnosticReference(base, "")).toBe(base);
  });
});
