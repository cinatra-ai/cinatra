import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  diffCoupling,
  currentCoupling,
  baselineGrowth,
  staleAllowlistEntries,
  STRICT_SDK_ONLY_ALLOWLIST,
} from "../extension-import-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/extension-import-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
}

describe("diffCoupling (no-new-rot core)", () => {
  const baseline = {
    hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango", "@/lib/database"] },
    crossExtension: { "@cinatra-ai/gmail-connector": ["@cinatra-ai/email-connector"] },
  };

  it("passes when current == baseline (no new coupling, nothing stale)", () => {
    const { newViolations, stale } = diffCoupling(baseline, baseline);
    expect(newViolations).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("FAILS on a NEW @/ import not in the baseline", () => {
    const current = {
      hostInternal: {
        "@cinatra-ai/gmail-connector": ["@/lib/nango", "@/lib/database", "@/lib/secret-new-coupling"],
      },
      crossExtension: { "@cinatra-ai/gmail-connector": ["@cinatra-ai/email-connector"] },
    };
    const { newViolations } = diffCoupling(baseline, current);
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("@/lib/secret-new-coupling");
  });

  it("FAILS on a NEW cross-extension import (a freshly-coupled extension)", () => {
    const current = {
      hostInternal: baseline.hostInternal,
      crossExtension: {
        ...baseline.crossExtension,
        "@cinatra-ai/apollo-connector": ["@cinatra-ai/nango-connector"],
      },
    };
    const { newViolations } = diffCoupling(baseline, current);
    expect(newViolations.some((v) => v.includes("apollo-connector"))).toBe(true);
  });

  it("reports stale entries (decoupled — present in baseline, gone now)", () => {
    const current = {
      hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango"] }, // dropped @/lib/database
      crossExtension: {}, // dropped the cross-ext edge
    };
    const { newViolations, stale } = diffCoupling(baseline, current);
    expect(newViolations).toEqual([]); // shrinking is never a violation
    expect(stale.some((s) => s.includes("@/lib/database"))).toBe(true);
    expect(stale.some((s) => s.includes("email-connector"))).toBe(true);
  });
});

describe("diffCoupling strict-sdk-only flip + documented carve-out allowlist", () => {
  // Under --strict-sdk-only the baseline is ignored for the sdkOnly dimension:
  // EVERY current sdkOnly edge is a violation, EXCEPT documented allowlist edges.
  it("FAILS strict on a non-allowlisted sdkOnly edge even if it is in the baseline", () => {
    const baseline = { sdkOnly: { "@cinatra-ai/foo-connector": ["@cinatra-ai/bar"] } };
    const current = baseline;
    const { newViolations } = diffCoupling(baseline, current, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: new Set(), // empty allowlist
    });
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("@cinatra-ai/bar");
  });

  it("PASSES strict on an allowlisted edge (custom allowlist)", () => {
    const baseline = { sdkOnly: { "@cinatra-ai/foo-connector": ["@cinatra-ai/bar"] } };
    const current = baseline;
    const allow = new Set([JSON.stringify(["@cinatra-ai/foo-connector", "@cinatra-ai/bar"])]);
    const { newViolations } = diffCoupling(baseline, current, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: allow,
    });
    expect(newViolations).toEqual([]);
  });

  // Mechanism tests use a SYNTHETIC allowlist (crm->objects) because the DEFAULT
  // allowlist is now EMPTY (the objects-ctx follow-up closed the sole
  // crm-connector -> objects carve-out via the SDK requireObjectsProvider() DI slot).
  const CUSTOM_ALLOW = new Set([JSON.stringify(["@cinatra-ai/crm-connector", "@cinatra-ai/objects"])]);

  it("the DEFAULT allowlist is EMPTY (objects-ctx closed the crm-connector -> objects carve-out)", () => {
    expect(STRICT_SDK_ONLY_ALLOWLIST.size).toBe(0);
    // With the empty default, the once-carved-out edge FAILS strict.
    const cur = { sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } };
    const { newViolations } = diffCoupling({ sdkOnly: {} }, cur, { strictSdkOnly: true });
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("@cinatra-ai/objects");
  });

  it("PASSES strict on an allowlisted edge (custom allowlist — the carve-out mechanism still works)", () => {
    const cur = { sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } };
    const { newViolations } = diffCoupling({ sdkOnly: {} }, cur, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: CUSTOM_ALLOW,
    });
    expect(newViolations).toEqual([]);
  });

  it("SELF-POLICES: staleAllowlistEntries flags a carve-out whose edge is gone (forces the allowlist to shrink)", () => {
    // The mechanism (tested with a CUSTOM allowlist — the default is now empty): if a
    // follow-up removes the coupling but forgets to remove the allowlist entry,
    // staleAllowlistEntries (wired into main() as a hard failure) catches it so the
    // carve-out can't be left behind — and a later reintroduction can't silently ride
    // a forgotten allowlist entry.
    const gone = { sdkOnly: {} }; // crm->objects decoupled
    const out = staleAllowlistEntries(gone, CUSTOM_ALLOW);
    expect(out.some((v) => v.includes("STALE carve-out") && v.includes("@cinatra-ai/objects"))).toBe(true);
    // …and while the edge is still coupled, there is NO stale carve-out.
    const present = { sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } };
    expect(staleAllowlistEntries(present, CUSTOM_ALLOW)).toEqual([]);
    // The DEFAULT (empty) allowlist never reports a stale entry.
    expect(staleAllowlistEntries(gone)).toEqual([]);
  });

  it("still FAILS strict on a NEW non-allowlisted edge (the flip is real)", () => {
    const cur = {
      sdkOnly: {
        "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"], // custom-allowlisted → ok
        "@cinatra-ai/rogue-connector": ["@cinatra-ai/mcp-server"], // NOT allowlisted → fail
      },
    };
    const { newViolations } = diffCoupling({ sdkOnly: {} }, cur, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: CUSTOM_ALLOW,
    });
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("rogue-connector");
  });

  it("the allowlist is an EXACT edge — crm-connector -> mcp-server (source match, wrong target) still FAILS", () => {
    const cur = {
      sdkOnly: {
        // crm->objects is allowlisted; crm->mcp-server is a DIFFERENT edge and must fail.
        "@cinatra-ai/crm-connector": ["@cinatra-ai/objects", "@cinatra-ai/mcp-server"],
      },
    };
    const { newViolations } = diffCoupling({ sdkOnly: {} }, cur, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: CUSTOM_ALLOW,
    });
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("@cinatra-ai/mcp-server");
  });

  it("the allowlist is an EXACT edge — rogue-connector -> objects (target match, wrong source) still FAILS", () => {
    const cur = {
      sdkOnly: {
        "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"], // allowlisted
        "@cinatra-ai/rogue-connector": ["@cinatra-ai/objects"], // NOT allowlisted (wrong source)
      },
    };
    const { newViolations } = diffCoupling({ sdkOnly: {} }, cur, {
      strictSdkOnly: true,
      sdkOnlyAllowlist: CUSTOM_ALLOW,
    });
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("rogue-connector");
  });

  it("the allowlist is SCOPED to the sdkOnly dimension — the same edge as a crossExtension import still FAILS", () => {
    const cur = {
      crossExtension: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] },
      sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] },
    };
    // baseline has neither dimension populated → the cross-ext edge is NEW. Even with
    // the sdkOnly edge custom-allowlisted, the cross-extension edge still fails.
    const { newViolations } = diffCoupling({}, cur, { strictSdkOnly: true, sdkOnlyAllowlist: CUSTOM_ALLOW });
    expect(newViolations.some((v) => v.includes("cross-extension import") && v.includes("@cinatra-ai/objects"))).toBe(
      true,
    );
  });

  it("the allowlist is SCOPED to the sdkOnly dimension — the same key as a hostInternal (@/) import still FAILS", () => {
    // hostInternal keys are [ext, "@/lib/..."]; an allowlisted sdkOnly edge must NOT
    // leak into the @/ ratchet. A NEW @/ import is a violation regardless.
    const cur = {
      hostInternal: { "@cinatra-ai/crm-connector": ["@/lib/objects-store"] },
      sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] },
    };
    const { newViolations } = diffCoupling({}, cur, { strictSdkOnly: true, sdkOnlyAllowlist: CUSTOM_ALLOW });
    expect(newViolations.some((v) => v.includes("@/ import") && v.includes("@/lib/objects-store"))).toBe(true);
  });

  it("the DEFAULT allowlist is EMPTY (no dumping ground — adding a carve-out needs owner sign-off)", () => {
    // Locking the allowlist content: every extension is SDK-only-clean after
    // objects-ctx. Adding a new carve-out must be a deliberate, reviewed change to
    // BOTH the const and this test (owner sign-off per AGENTS.md).
    expect(STRICT_SDK_ONLY_ALLOWLIST.size).toBe(0);
  });
});

describe("baselineGrowth (monotonic-ratchet guard — closes the regenerate-to-pass bypass)", () => {
  const base = {
    hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango", "@/lib/database"] },
    crossExtension: {},
  };
  it("allows a SHRUNK committed baseline (decoupling)", () => {
    const committed = { hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango"] }, crossExtension: {} };
    expect(baselineGrowth(base, committed)).toEqual([]);
  });
  it("allows an identical baseline", () => {
    expect(baselineGrowth(base, base)).toEqual([]);
  });
  it("FAILS when the committed baseline added a new @/ entry (the attack)", () => {
    const committed = {
      hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango", "@/lib/database", "@/lib/sneaky-new"] },
      crossExtension: {},
    };
    const grew = baselineGrowth(base, committed);
    expect(grew).toHaveLength(1);
    expect(grew[0]).toContain("@/lib/sneaky-new");
  });
  it("FAILS when the committed baseline added a newly-coupled extension", () => {
    const committed = {
      hostInternal: { ...base.hostInternal, "@cinatra-ai/apollo-connector": ["@/lib/database"] },
      crossExtension: {},
    };
    expect(baselineGrowth(base, committed).some((g) => g.includes("apollo-connector"))).toBe(true);
  });

  it("ALLOWS introducing a whole new dimension absent on the base (sdkOnly's first landing)", () => {
    // base has NO sdkOnly key → this PR introduces the dimension → no growth
    // constraint for it (mirrors the whole-file 'absent on base' semantics).
    const committed = {
      hostInternal: base.hostInternal,
      crossExtension: {},
      sdkOnly: {
        "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server", "@cinatra-ai/mcp-client"],
        "@cinatra-ai/apollo-connector": ["@cinatra-ai/metric-usage-api"],
      },
    };
    expect(baselineGrowth(base, committed)).toEqual([]);
  });

  it("FAILS when a new entry is baselined into a PRESENT-but-EMPTY dimension (the {} bypass)", () => {
    // origin/main's baseline has `crossExtension: {}` — PRESENT (tracked), so a new
    // cross-extension entry must STILL be caught. The introducing-exemption is KEY-ABSENT
    // only; a `{}` dimension is not "introduced".
    const baseEmptyCross = { hostInternal: base.hostInternal, crossExtension: {} };
    const committed = {
      hostInternal: base.hostInternal,
      crossExtension: { "@cinatra-ai/x": ["@cinatra-ai/sneaky-sibling"] },
    };
    const grew = baselineGrowth(baseEmptyCross, committed);
    expect(grew.some((g) => g.includes("@cinatra-ai/sneaky-sibling"))).toBe(true);
  });

  it("STILL ratchets sdkOnly once it exists on base (may only shrink), and an existing dimension can't grow alongside an introduced one", () => {
    const baseWithSdk = {
      hostInternal: base.hostInternal,
      crossExtension: {},
      sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server"] },
    };
    // grow sdkOnly (now that it exists on base) AND grow hostInternal in the same PR.
    const committed = {
      hostInternal: { ...base.hostInternal, "@cinatra-ai/x": ["@/lib/sneaky"] },
      crossExtension: {},
      sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server", "@cinatra-ai/new-coupling"] },
    };
    const grew = baselineGrowth(baseWithSdk, committed);
    expect(grew.some((g) => g.includes("@cinatra-ai/new-coupling"))).toBe(true);
    expect(grew.some((g) => g.includes("@/lib/sneaky"))).toBe(true);
  });
});

describe("IMPORT_BAN_BASE fail-closed (the monotonic-guard bypass fix)", () => {
  it("exits 0 with no IMPORT_BAN_BASE set (the guard is simply not engaged)", () => {
    const r = runGate({ IMPORT_BAN_BASE: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[extension-import-ban] OK");
  });

  it("FAILS CLOSED (exit 1) when IMPORT_BAN_BASE is set but unresolvable", () => {
    // A set-but-unresolvable base must fail closed — never WARN-and-exit-0, which
    // would be a fail-open bypass (add coupling + regenerate the baseline, and if
    // base-ref resolution broke in CI it would pass).
    const r = runGate({ IMPORT_BAN_BASE: "definitely-not-a-real-ref-zzz-9f3a1" });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/did not resolve|failing closed/i);
  });

  it("FAILS CLOSED (exit 1) when IMPORT_BAN_BASE is flag-like (leading dash)", () => {
    const r = runGate({ IMPORT_BAN_BASE: "--upload-pack=evil" });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/flag-like/i);
  });
});

describe("currentCoupling (anthropic-connector un-exempt)", () => {
  // There is no whole-extension EXEMPT: anthropic-
  // connector's coupling is surfaced like every other extension's.
  it("NOW lists anthropic-connector's @/ imports (no whole-extension exemption)", () => {
    const inv = {
      extensions: [
        { name: "@cinatra-ai/anthropic-connector", hostInternalImports: ["@/lib/x"], crossExtensionImports: [] },
        { name: "@cinatra-ai/gmail-connector", hostInternalImports: ["@/lib/nango"], crossExtensionImports: [] },
      ],
    };
    const c = currentCoupling(inv);
    expect(c.hostInternal["@cinatra-ai/anthropic-connector"]).toEqual(["@/lib/x"]);
    expect(c.hostInternal["@cinatra-ai/gmail-connector"]).toEqual(["@/lib/nango"]);
  });

  it("NOW surfaces anthropic-connector's sdkOnly coupling like every other extension", () => {
    const inv = {
      extensions: [
        { name: "@cinatra-ai/anthropic-connector", hostInternalImports: [], crossExtensionImports: [], sdkOnlyViolations: ["@cinatra-ai/nango-connector"] },
        { name: "@cinatra-ai/email-connector", hostInternalImports: [], crossExtensionImports: [], sdkOnlyViolations: ["@cinatra-ai/mcp-server", "@cinatra-ai/mcp-client"] },
      ],
    };
    const c = currentCoupling(inv);
    expect(c.sdkOnly["@cinatra-ai/anthropic-connector"]).toEqual(["@cinatra-ai/nango-connector"]);
    expect(c.sdkOnly["@cinatra-ai/email-connector"]).toEqual(["@cinatra-ai/mcp-client", "@cinatra-ai/mcp-server"]);
  });
});

describe("diffCoupling — sdkOnly dimension (ratchet + strict flip)", () => {
  const baseline = {
    hostInternal: {},
    crossExtension: {},
    sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server", "@cinatra-ai/mcp-client"] },
  };

  it("DEFAULT (ratcheted): no violation when sdkOnly == baseline", () => {
    const { newViolations } = diffCoupling(baseline, baseline);
    expect(newViolations).toEqual([]);
  });

  it("DEFAULT: FAILS on a NEW non-SDK @cinatra-ai dep not in the baseline", () => {
    const current = {
      hostInternal: {},
      crossExtension: {},
      sdkOnly: {
        "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server", "@cinatra-ai/mcp-client"],
        "@cinatra-ai/apollo-connector": ["@cinatra-ai/metric-usage-api"],
      },
    };
    const { newViolations } = diffCoupling(baseline, current);
    expect(newViolations.some((v) => v.includes("apollo-connector") && v.includes("metric-usage-api"))).toBe(true);
    expect(newViolations.some((v) => v.includes("non-SDK @cinatra-ai dep"))).toBe(true);
  });

  it("DEFAULT: reports a decoupled baseline entry as stale (sdkOnly shrank)", () => {
    const current = { hostInternal: {}, crossExtension: {}, sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server"] } };
    const { newViolations, stale } = diffCoupling(baseline, current);
    expect(newViolations).toEqual([]);
    expect(stale.some((s) => s.includes("@cinatra-ai/mcp-client"))).toBe(true);
  });

  it("STRICT (--strict-sdk-only): zero-tolerance — EVERY current sdkOnly entry fails, baseline ignored", () => {
    const { newViolations } = diffCoupling(baseline, baseline, { strictSdkOnly: true });
    expect(newViolations).toHaveLength(2); // both baseline entries now violate
    expect(newViolations.every((v) => v.includes("non-SDK @cinatra-ai dep"))).toBe(true);
  });

  it("STRICT does NOT change the host/cross-extension ratchet (those stay no-new-rot)", () => {
    const base = {
      hostInternal: { "@cinatra-ai/gmail-connector": ["@/lib/nango"] },
      crossExtension: {},
      sdkOnly: {},
    };
    // identical host coupling + empty sdkOnly → strict still passes (no sdkOnly entries)
    const { newViolations } = diffCoupling(base, base, { strictSdkOnly: true });
    expect(newViolations).toEqual([]);
  });
});

describe("baselineGrowth — sdkOnly is part of the monotonic guard", () => {
  const base = {
    hostInternal: {},
    crossExtension: {},
    sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server"] },
  };
  it("allows a SHRUNK sdkOnly baseline", () => {
    const committed = { hostInternal: {}, crossExtension: {}, sdkOnly: {} };
    expect(baselineGrowth(base, committed)).toEqual([]);
  });
  it("FAILS when the committed baseline ADDED a new sdkOnly entry (the attack)", () => {
    const committed = {
      hostInternal: {},
      crossExtension: {},
      sdkOnly: { "@cinatra-ai/email-connector": ["@cinatra-ai/mcp-server", "@cinatra-ai/sneaky-new-dep"] },
    };
    const grew = baselineGrowth(base, committed);
    expect(grew.some((g) => g.includes("@cinatra-ai/sneaky-new-dep"))).toBe(true);
  });
});
