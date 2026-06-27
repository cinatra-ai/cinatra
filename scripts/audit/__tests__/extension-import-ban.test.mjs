import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  diffCoupling,
  currentCoupling,
  pinnedEmptyViolations,
  baselineGrowth,
  staleAllowlistEntries,
  STRICT_SDK_ONLY_ALLOWLIST,
} from "../extension-import-ban.mjs";
import { buildInventory } from "../../extensions/inventory.mjs";
// The "live gate subprocess fixtures" below write a scratch `@/` edge into a
// connector's `src/` and run the gate over it. To avoid racing inventory.test.mjs
// (which scans the SHARED `extensions/` tree in the wholesale `pnpm test:root`
// run), each such write goes into a PRIVATE per-test clone of the tree and the
// gate is pointed at it via CINATRA_INVENTORY_EXT_ROOT — the shared tree is never
// mutated, so no concurrent reader can observe the transient fixture (cinatra#380).
import { makeIsolatedExtensionsTree } from "../../extensions/__tests__/isolated-extensions-tree.mjs";

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

function runGateArgs(args = [], extraEnv = {}) {
  return spawnSync("node", [GATE, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
}

// NOTE (cinatra#172): the gate's CHECK MODE is pinned empty — main() no longer
// consults the committed baseline for violation detection (see the PINNED EMPTY
// suites below). diffCoupling / baselineGrowth / staleAllowlistEntries stay
// exported with their full pre-flip semantics; the describes for them pin the
// pure-core behavior pinnedEmptyViolations is built on.

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

describe("PINNED EMPTY (cinatra#172 — the zero-floor flip)", () => {
  it("the committed baseline FILE is empty in EVERY dimension (a re-populated baseline is itself a failure)", () => {
    const doc = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/extension-import-ban.baseline.json"), "utf8"),
    );
    expect(doc.hostInternal).toEqual({});
    expect(doc.crossExtension).toEqual({});
    expect(doc.sdkOnly).toEqual({});
    expect(doc.note).toMatch(/PINNED EMPTY/);
    // tooling-shape compat field retained at its pinned value (mirrors the core
    // gate keeping classificationSummary at pinned zeros)
    expect(doc.classification).toBe("runtime-coupling");
  });

  it("the LIVE repo scans zero edges in every dimension (hostInternal 16 -> 0 across H1-H4; honestly empty, not vacuous)", async () => {
    // Clean-tree assertion over the SHARED tree. The scratch-fixture writers in
    // this file write into PRIVATE per-test clones (CINATRA_INVENTORY_EXT_ROOT),
    // never the shared tree, so this scan can never observe a transient `@/`
    // edge — no cross-file lock needed (cinatra#380).
    const inv = await buildInventory();
    expect(inv.extensions.length).toBeGreaterThan(0); // not vacuous — the extension tree is cloned back
    const c = currentCoupling(inv);
    expect(c.hostInternal).toEqual({});
    expect(c.crossExtension).toEqual({});
    expect(c.sdkOnly).toEqual({});
  });

  it("the committed repo state passes the gate, reporting the pinned zeros", () => {
    // Clean-tree gate run over the SHARED tree: the scratch fixtures live in
    // isolated clones, so no transient edge can leak into this expected-exit-0 run.
    const r = runGate({ IMPORT_BAN_BASE: "" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0 @\/ \+ 0 cross-extension \+ 0 non-SDK/);
    expect(r.stdout).toMatch(/PINNED EMPTY/);
  });

  it("pinnedEmptyViolations takes NO baseline parameter — no committed document can tolerate an edge (arity pin)", () => {
    // (current) — the allowlist is a defaulted second param; there is no
    // baseline anywhere in the signature, so 'baseline no longer consulted'
    // holds by construction.
    expect(pinnedEmptyViolations.length).toBe(1);
  });

  it("a synthetic hostInternal edge is a violation WITHOUT baseline consultation", () => {
    const v = pinnedEmptyViolations({
      hostInternal: { "@cinatra-ai/x-connector": ["@/lib/database"] },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("@/ import");
    expect(v[0]).toContain("@/lib/database");
  });

  it("a synthetic crossExtension edge is a violation WITHOUT baseline consultation", () => {
    const v = pinnedEmptyViolations({
      crossExtension: { "@cinatra-ai/x-connector": ["@cinatra-ai/y-connector"] },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("cross-extension import");
  });

  it("a synthetic sdkOnly edge is a violation — strict UNCONDITIONALLY (no flag involved at this level at all)", () => {
    const v = pinnedEmptyViolations({
      sdkOnly: { "@cinatra-ai/x-connector": ["@cinatra-ai/mcp-server"] },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("non-SDK @cinatra-ai dep");
  });

  it("the sdkOnly allowlist still works under the pin — exact-edge, sdkOnly-scoped ONLY (no carve-out path for the other dimensions)", () => {
    const allow = new Set([JSON.stringify(["@cinatra-ai/crm-connector", "@cinatra-ai/objects"])]);
    // allowlisted sdkOnly edge passes
    expect(
      pinnedEmptyViolations({ sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } }, allow),
    ).toEqual([]);
    // the SAME key as a hostInternal or crossExtension edge still fails
    expect(
      pinnedEmptyViolations({ hostInternal: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } }, allow),
    ).toHaveLength(1);
    expect(
      pinnedEmptyViolations({ crossExtension: { "@cinatra-ai/crm-connector": ["@cinatra-ai/objects"] } }, allow),
    ).toHaveLength(1);
    // wrong source / wrong target still fails (exact edge)
    expect(
      pinnedEmptyViolations({ sdkOnly: { "@cinatra-ai/rogue-connector": ["@cinatra-ai/objects"] } }, allow),
    ).toHaveLength(1);
    expect(
      pinnedEmptyViolations({ sdkOnly: { "@cinatra-ai/crm-connector": ["@cinatra-ai/mcp-server"] } }, allow),
    ).toHaveLength(1);
    // and the DEFAULT allowlist stays EMPTY (owner sign-off required to mint one)
    expect(STRICT_SDK_ONLY_ALLOWLIST.size).toBe(0);
  });
});

describe("PINNED EMPTY — live gate subprocess fixtures (scratch violation in an isolated tree clone)", () => {
  // The scratch edge is written into the gmail-connector's src under a PRIVATE
  // per-test clone of the extensions tree (relative path within that clone), and
  // the gate subprocess is pointed at the clone via CINATRA_INVENTORY_EXT_ROOT.
  // The shared committed `extensions/` tree is never mutated (cinatra#380).
  const FIXTURE_REL = join("cinatra-ai", "gmail-connector", "src", "__pinned-empty-flip-fixture__.ts");
  const REAL_FIXTURE_DIR = join(REPO_ROOT, "extensions/cinatra-ai/gmail-connector/src");
  const SCRATCH_MODULE = "@/lib/__pinned-empty-flip-scratch__";
  const BASELINE = join(REPO_ROOT, "scripts/audit/extension-import-ban.baseline.json");

  // Provision an isolated clone, write `fixtureContents` into the cloned
  // gmail-connector src, run `fn(extRoot)` with the clone available (the caller
  // runs the gate with CINATRA_INVENTORY_EXT_ROOT=extRoot), then clean up. The
  // shared tree must be cloned back (CI) for the clone to be non-vacuous.
  function withScratchEdge(fixtureContents, fn) {
    expect(
      existsSync(REAL_FIXTURE_DIR),
      "extensions tree must be cloned back (scripts/ci/sync-dev-extensions.mjs) before this suite",
    ).toBe(true);
    const { extRoot, writeFixture, cleanup } = makeIsolatedExtensionsTree();
    try {
      writeFixture(FIXTURE_REL, fixtureContents);
      return fn(extRoot);
    } finally {
      cleanup();
    }
  }

  it("check mode FAILS (exit 1) naming the edge — and NEITHER passing NOR omitting --strict-sdk-only/--strict can weaken it", () => {
    withScratchEdge(`import "${SCRATCH_MODULE}";\nexport {};\n`, (extRoot) => {
      for (const args of [[], ["--strict-sdk-only"], ["--strict"]]) {
        const r = runGateArgs(args, { IMPORT_BAN_BASE: "", CINATRA_INVENTORY_EXT_ROOT: extRoot });
        expect(r.status, JSON.stringify(args) + "\n" + r.stdout + r.stderr).toBe(1);
        expect(r.stderr).toContain(SCRATCH_MODULE);
        expect(r.stderr).toMatch(/PINNED EMPTY/);
      }
    });
  });

  it("check mode FAILS (exit 1) on a scratch CROSS-EXTENSION + sdkOnly edge through the full CLI path (both dimensions named)", () => {
    // One undeclared sibling-extension import registers in BOTH the
    // crossExtension dimension (undeclared cross-extension import) and the
    // sdkOnly dimension (non-SDK first-party package) — live CLI proof that
    // the pin covers all three dimensions, not just hostInternal.
    withScratchEdge('import "@cinatra-ai/crm-connector";\nexport {};\n', (extRoot) => {
      const r = runGateArgs([], { IMPORT_BAN_BASE: "", CINATRA_INVENTORY_EXT_ROOT: extRoot });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/cross-extension import: @cinatra-ai\/gmail-connector imports @cinatra-ai\/crm-connector/);
      expect(r.stderr).toMatch(/non-SDK @cinatra-ai dep: @cinatra-ai\/gmail-connector imports @cinatra-ai\/crm-connector/);
      expect(r.stderr).toMatch(/PINNED EMPTY/);
    });
  });

  it("--write-baseline REFUSES non-empty output (exit 1) and leaves the baseline file byte-unchanged", () => {
    const before = readFileSync(BASELINE, "utf8");
    withScratchEdge(`import "${SCRATCH_MODULE}";\nexport {};\n`, (extRoot) => {
      const r = runGateArgs(["--write-baseline"], { IMPORT_BAN_BASE: "", CINATRA_INVENTORY_EXT_ROOT: extRoot });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/refusing to write a NON-EMPTY baseline/);
      expect(r.stderr).toContain(SCRATCH_MODULE);
    });
    expect(readFileSync(BASELINE, "utf8")).toBe(before);
  });

  it("--write-baseline on the clean tree rewrites EXACTLY the committed pinned-empty document (idempotent)", () => {
    const before = readFileSync(BASELINE, "utf8");
    try {
      const r = runGateArgs(["--write-baseline"], { IMPORT_BAN_BASE: "" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(BASELINE, "utf8")).toBe(before);
    } finally {
      writeFileSync(BASELINE, before);
    }
  });

  it("a NON-EMPTY committed baseline is itself a failure (the re-population guard), even with a CLEAN tree", () => {
    const before = readFileSync(BASELINE, "utf8");
    try {
      const doc = JSON.parse(before);
      doc.hostInternal = { "@cinatra-ai/gmail-connector": ["@/lib/database"] };
      writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + "\n");
      const r = runGateArgs([], { IMPORT_BAN_BASE: "" });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/committed baseline is NON-EMPTY/);
      expect(r.stderr).toContain("@/lib/database");
    } finally {
      writeFileSync(BASELINE, before);
    }
  });
});
