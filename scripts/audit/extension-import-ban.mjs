#!/usr/bin/env node
// CI gate: the `@/` import-ban for extensions.
//
// A companion extension must reach privileged host capability ONLY through the
// `register(ctx)` ports and the per-concern `@cinatra-ai/host:*` services —
// never via a `@/lib/*`, `@/components/*`, `@/app/*` import, never via a static
// import of another extension package, and never via a non-SDK first-party
// package. (No whole-extension exemptions — anthropic-connector is decoupled to
// SDK-only like every other connector.)
//
// PINNED EMPTY (cinatra#172 — the zero-floor flip for the extension→host
// direction, on the core-extension-import-ban precedent): the decoupling sweep
// is COMPLETE. The hostInternal dimension was driven 16 → 12 → 8 → 4 → 0 across
// stages H1–H4 (ctx-port adoption, per-concern `@cinatra-ai/host:*` services
// consumed through connector deps slots, and test re-grounding);
// crossExtension and sdkOnly were already empty. From the flip onward:
//   - ANY current `hostInternal` or `crossExtension` edge fails CI immediately
//     (the committed baseline is no longer consulted for violation detection);
//   - the `sdkOnly` dimension is UNCONDITIONALLY zero-tolerance (the
//     `--strict-sdk-only` flag is retained as an accepted no-op for CLI
//     compatibility — neither passing it nor omitting it can weaken
//     enforcement); the documented STRICT_SDK_ONLY_ALLOWLIST carve-out
//     machinery survives unchanged (owner-ruled, currently EMPTY,
//     self-policing via the stale-carve-out hard failure);
//   - a committed baseline with ANY non-empty dimension is itself a hard
//     failure (the re-population guard);
//   - `--write-baseline` REFUSES to write non-empty output in every dimension;
//   - the IMPORT_BAN_BASE monotonic guard survives purely as a tamper check
//     (fail-closed on flag-like/unresolvable refs; growth trivially holds
//     against the pinned-empty document).
// Zero is the floor AND the ceiling — there is no data path (baseline,
// regenerate, flag) that can raise it. With this flip all FOUR coupling
// baselines are pinned empty (instance-coupling, core-import-ban,
// discovery-dispatcher-bypass, extension-import-ban) — both directions of the
// IoC rule are zero-floor. See scripts/audit/extension-coupling-gates.md.
//
// SCOPE: this gate covers the EXTENSION → `@/`/cross-extension/non-SDK
// direction. The HOST → extension direction is held at zero by the
// core-extension-instance-coupling-ban + core-extension-import-ban +
// discovery-dispatcher-bypass-ban pinned-empty gates.
//
// GRANULARITY: the unit is the (extension, host-module) edge, collapsed to
// distinct modules by scripts/extensions/inventory.mjs (which scans EVERY
// source file in each extension dir — `__tests__` included, `import type`
// included, dynamic/`require`/backtick forms included).
//
// CLASSIFICATION (shared taxonomy — scripts/audit/lib/
// extension-reference-classification.mjs, counts published in
// scripts/audit/extension-coupling-gates.md): all three dimensions here
// (`hostInternal`, `crossExtension`, `sdkOnly`) are EXTENSION-side import
// coupling and classify as `runtime-coupling` — none of them are facades/
// inventories/dev-lists (`mechanical`) and NOTHING on the extension side is
// permanently exempt (the strict exempt set — generated manifest + documented
// data-contract-ID allowlist — is host-side only).
//
// Usage:
//   node scripts/audit/extension-import-ban.mjs                  # check (exit 1 on ANY coupling)
//   node scripts/audit/extension-import-ban.mjs --write-baseline # rewrite the pinned-empty baseline (refuses non-empty)
//   node scripts/audit/extension-import-ban.mjs --strict         # accepted no-op (pre-flip CLI compat)
//   node scripts/audit/extension-import-ban.mjs --strict-sdk-only# accepted no-op (sdkOnly is ALWAYS strict now)
//   IMPORT_BAN_BASE=<ref> node ...                               # tamper check (fail-closed; baseline may never grow)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInventory } from "../extensions/inventory.mjs";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "extension-import-ban.baseline.json");

// No whole-extension EXEMPT: anthropic-connector is decoupled to SDK-only like
// every other connector (the "permanent in-tree exemption" was meant for the
// VENDORED `extensions/anthropics/skills` bundle, not the connector). The set is
// kept (empty) so the gate machinery is unchanged.
const EXEMPT = new Set([]);

// Documented EDGE-level carve-outs tolerated under the (now unconditional)
// strict sdkOnly enforcement. Unlike EXEMPT (a whole extension), this exempts a
// SINGLE `extension -> module` sdkOnly edge. Each entry MUST carry an inline
// rationale + a follow-up reference and is added ONLY with owner sign-off. The
// allowlist is itself monotonic-shrink AND self-policing: remove an entry the
// moment its follow-up lands — a stale carve-out is a hard failure (see
// staleAllowlistEntries). Keys are the same `JSON.stringify([ext, mod])` shape
// `flatten()` produces. NOTE: the allowlist covers the sdkOnly dimension ONLY —
// there is no carve-out mechanism for `hostInternal` or `crossExtension` edges
// (those are pinned at zero unconditionally).
export const STRICT_SDK_ONLY_ALLOWLIST = new Set([
  // EMPTY (objects-ctx follow-up): the sole carve-out —
  // crm-connector → @cinatra-ai/objects — was CLOSED by routing the
  // object-type registry + sync-adapter registry + actor-scoped objects_save +
  // graphiti episode client through the SDK's host-injected
  // `requireObjectsProvider()` DI slot (packages/sdk-extensions/src/
  // objects-provider-contract.ts, bound at boot by src/lib/register-objects-provider.ts).
  // EVERY extension is now SDK-only-clean. Add a new edge-level carve-out ONLY
  // with owner sign-off + an inline rationale + a follow-up reference — the set is
  // monotonic-shrink + self-policing (see staleAllowlistEntries: a stale carve-out
  // is a hard failure).
]);

export function currentCoupling(inv) {
  const hostInternal = {};
  const crossExtension = {};
  const sdkOnly = {};
  for (const x of inv.extensions) {
    if (EXEMPT.has(x.name)) continue;
    if (x.hostInternalImports.length) hostInternal[x.name] = [...x.hostInternalImports].sort();
    // Only UNDECLARED cross-extension imports are coupling. A connector→connector
    // import declared in BOTH package.json (`workspace:*`) AND `cinatra.dependencies`
    // is valid architecture (the dependency closure installs/activates/uninstalls it),
    // not rot — `inventory.mjs` excludes those from `undeclaredCrossExtensionImports`.
    const undeclared = x.undeclaredCrossExtensionImports ?? x.crossExtensionImports;
    if (undeclared.length) crossExtension[x.name] = [...undeclared].sort();
    // IOC dimension: ALL non-SDK first-party `@cinatra-ai/*` + sibling
    // vendor-scope code coupling — source imports (runtime AND `import type`) AND
    // package.json deps/peerDeps — collapsed to base packages by `inventory.mjs`.
    // Unlike `crossExtension` above this does NOT honor a per-extension
    // declared-dependency carve-out: the canonical rule is that the ONLY permitted
    // first-party code deps are the SDK packages, so a declared
    // `@cinatra-ai/mcp-server` is still a violation. (There is no whole-extension
    // carve-out — anthropic-connector is SDK-only.)
    const sdk = x.sdkOnlyViolations ?? [];
    if (sdk.length) sdkOnly[x.name] = [...sdk].sort();
  }
  return { hostInternal, crossExtension, sdkOnly };
}

function stable(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// Flatten {ext: [modules]} → Set of JSON keys (no fragile string separators).
function flatten(map) {
  const out = new Set();
  for (const ext of Object.keys(map)) {
    for (const mod of map[ext]) out.add(JSON.stringify([ext, mod]));
  }
  return out;
}

function show(jsonKey, label) {
  const pair = JSON.parse(jsonKey);
  return label + ": " + pair[0] + " imports " + pair[1];
}

// Pure diff (no IO) — retained EXPORTED for unit tests and tooling. Since the
// pinned-empty flip (cinatra#172) main() no longer consults the committed
// baseline for violation detection — check mode is pinnedEmptyViolations()
// below. diffCoupling keeps its full pre-flip semantics (ratchet diff +
// strictSdkOnly flip) so the historical behavior stays pinned by tests.
export function diffCoupling(
  baseline,
  current,
  { strictSdkOnly = false, sdkOnlyAllowlist = STRICT_SDK_ONLY_ALLOWLIST } = {},
) {
  const baseHost = flatten(baseline.hostInternal ?? {});
  const baseXext = flatten(baseline.crossExtension ?? {});
  const baseSdk = flatten(baseline.sdkOnly ?? {});
  const curHost = flatten(current.hostInternal ?? {});
  const curXext = flatten(current.crossExtension ?? {});
  const curSdk = flatten(current.sdkOnly ?? {});
  const newViolations = [];
  for (const k of curHost) if (!baseHost.has(k)) newViolations.push(show(k, "@/ import"));
  for (const k of curXext) if (!baseXext.has(k)) newViolations.push(show(k, "cross-extension import"));
  for (const k of curSdk) {
    // Documented carve-out edges never fail AS A VIOLATION — under strict OR the
    // ratchet. They are still subject to the self-policing stale-carve-out check
    // (an allowlist entry whose edge is gone is a hard failure). See
    // STRICT_SDK_ONLY_ALLOWLIST for the policy.
    if (sdkOnlyAllowlist.has(k)) continue;
    if (strictSdkOnly || !baseSdk.has(k)) newViolations.push(show(k, "non-SDK @cinatra-ai dep"));
  }
  const stale = [];
  for (const k of baseHost) if (!curHost.has(k)) stale.push(show(k, "@/ import"));
  for (const k of baseXext) if (!curXext.has(k)) stale.push(show(k, "cross-extension import"));
  for (const k of baseSdk) if (!curSdk.has(k)) stale.push(show(k, "non-SDK @cinatra-ai dep"));
  return { newViolations, stale };
}

// PINNED-EMPTY check core (cinatra#172): EVERY current edge in EVERY dimension
// is a violation — there is NO baseline parameter, so no committed document can
// tolerate an edge. The ONLY tolerated set is the owner-ruled, self-policing
// STRICT_SDK_ONLY_ALLOWLIST, which covers the sdkOnly dimension exclusively
// (an allowlisted [ext, module] key appearing as a hostInternal or
// crossExtension edge still fails — dimension-scoped, exact-edge). Implemented
// as a diff against a LITERAL empty baseline with the strict-sdkOnly flip
// engaged, so the pinned semantics reuse the same exhaustively-tested core.
export function pinnedEmptyViolations(current, sdkOnlyAllowlist = STRICT_SDK_ONLY_ALLOWLIST) {
  return diffCoupling(
    { hostInternal: {}, crossExtension: {}, sdkOnly: {} },
    current,
    { strictSdkOnly: true, sdkOnlyAllowlist },
  ).newViolations;
}

// Self-policing carve-out check (runs in main() against the REAL current coupling).
// An allowlist entry whose edge is no longer present in current `sdkOnly` coupling
// is a stale carve-out that MUST be removed (its follow-up landed). This is a hard
// FAILURE so the allowlist is forced monotonic-shrink — AND so a later
// reintroduction of the same edge cannot silently ride a forgotten allowlist entry
// (the entry must be removed once the edge is gone, which then makes the
// reintroduction fail). Pure + exported for unit testing; kept OUT of
// diffCoupling/pinnedEmptyViolations so synthetic fixtures aren't gated on the
// default allowlist's real-repo edge.
export function staleAllowlistEntries(current, allowlist = STRICT_SDK_ONLY_ALLOWLIST) {
  const curSdk = flatten(current.sdkOnly ?? {});
  const out = [];
  for (const k of allowlist) {
    if (!curSdk.has(k)) {
      out.push(show(k, "STALE carve-out — coupling gone, remove from STRICT_SDK_ONLY_ALLOWLIST"));
    }
  }
  return out;
}

// Monotonic guard over the COMMITTED DOCUMENT — retained as a pure tamper
// check since the pinned-empty flip: the committed baseline must be a subset of
// the base-branch baseline (trivially true while both stay `{}`). The committed-
// baseline-must-be-EMPTY pin in main() is the primary guard; this catches a
// tampered base-side document too. Pure + exported for unit testing.
export function baselineGrowth(baseBaseline, committedBaseline) {
  // PER-DIMENSION monotonic guard. A dimension that is ABSENT on the base
  // baseline is being INTRODUCED by this PR — mirror the whole-file "baseline
  // absent on base → the introducing PR has no constraint" semantics PER
  // DIMENSION. Dimensions that DO exist on base still ratchet (may only
  // shrink). NOTE (post-flip): a present-but-empty dimension (`{}` — the pinned
  // state) is TRACKED, so ANY entry committed into it is growth; combined with
  // the empty-baseline pin in main() there is no data path that can raise the
  // floor.
  const grown = [];
  for (const dim of ["hostInternal", "crossExtension", "sdkOnly"]) {
    if (baseBaseline[dim] === undefined) continue;
    const baseSet = flatten(baseBaseline[dim]);
    for (const k of flatten(committedBaseline[dim] ?? {})) {
      if (!baseSet.has(k)) grown.push(show(k, "baseline-added"));
    }
  }
  return grown;
}

const PINNED_NOTE =
  "Extension import-ban baseline — PINNED EMPTY by the zero-floor flip (cinatra#172, on the " +
  "core-extension-import-ban precedent). The hostInternal dimension was driven 16 -> 0 across " +
  "stages H1-H4 (ctx ports, per-concern @cinatra-ai/host:* services consumed via connector deps " +
  "slots, test re-grounding); crossExtension and sdkOnly were already empty. ANY current edge in " +
  "ANY dimension fails CI immediately (the baseline is no longer consulted for violation " +
  "detection); a non-empty committed baseline is itself a failure and --write-baseline refuses to " +
  "produce one; the sdkOnly dimension is unconditionally zero-tolerance (--strict-sdk-only is an " +
  "accepted no-op) with the owner-ruled STRICT_SDK_ONLY_ALLOWLIST (EMPTY, self-policing) as the " +
  "only carve-out mechanism. IMPORT_BAN_BASE survives as a fail-closed tamper check. Under the " +
  "shared extension-reference taxonomy (scripts/audit/lib/extension-reference-classification.mjs + " +
  "scripts/audit/extension-coupling-gates.md) every dimension classifies as runtime-coupling; the " +
  "classification field is retained at its pinned value for tooling-shape compatibility.";

async function main() {
  const args = process.argv.slice(2);
  // Fail-closed: the extension source must be cloned back before
  // this gate runs, or it scans an empty tree and passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "extension-import-ban");
  const inv = await buildInventory();
  const current = currentCoupling(inv);
  const violations = pinnedEmptyViolations(current);

  if (args.includes("--write-baseline")) {
    // PINNED EMPTY (cinatra#172): there is nothing left to tolerate. Refuse to
    // write a baseline while ANY dimension has a (non-allowlisted) edge —
    // remove the coupling instead (route through register(ctx) ports /
    // per-concern @cinatra-ai/host:* services via the connector's deps slot),
    // never re-baseline.
    if (violations.length) {
      console.error(
        "[extension-import-ban] FAIL — refusing to write a NON-EMPTY baseline (the floor is pinned " +
          "at zero; route through register(ctx) host ports / per-concern @cinatra-ai/host:* services " +
          "via the connector's deps slot instead of re-baselining):",
      );
      for (const v of violations.sort()) console.error("  + " + v);
      process.exit(1);
    }
    const doc = {
      note: PINNED_NOTE,
      classification: "runtime-coupling",
      hostInternal: {},
      crossExtension: {},
      sdkOnly: {},
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    console.log("[extension-import-ban] baseline written (pinned empty).");
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[extension-import-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  // PINNED-EMPTY pin: the committed baseline must be EMPTY in EVERY dimension —
  // a re-populated baseline file is a bypass attempt regardless of the tree's
  // state (the floor is pinned at zero since the cinatra#172 flip).
  const committedEntries = [];
  for (const dim of ["hostInternal", "crossExtension", "sdkOnly"]) {
    for (const k of flatten(baseline[dim] ?? {})) committedEntries.push(show(k, dim));
  }
  if (committedEntries.length) {
    console.error(
      "[extension-import-ban] FAIL — committed baseline is NON-EMPTY (" +
        committedEntries.length +
        " entr" +
        (committedEntries.length === 1 ? "y" : "ies") +
        "); the floor is pinned at zero since the zero-floor flip (cinatra#172):",
    );
    for (const e of committedEntries.sort()) console.error("  + " + e);
    process.exit(1);
  }

  // IMPORT_BAN_BASE — retained purely as a fail-closed TAMPER CHECK since the
  // flip (the committed baseline is already pinned empty above; this also
  // rejects a tampered/unusable base-ref configuration). CI sets it to the PR
  // base ref; the committed baseline must be a subset of the base-branch
  // baseline. Absent on base (the introducing PR) → no constraint.
  const baseRef = process.env.IMPORT_BAN_BASE;
  if (baseRef && baseRef.startsWith("-")) {
    // FAIL CLOSED. A leading-dash ref would be parsed by `git show`/`rev-parse`
    // as an option, AND it means the tamper check can't run. IMPORT_BAN_BASE is
    // only ever SET in CI, where it MUST be a real ref; a flag-like value is a
    // misconfig, never a reason to silently drop the guard.
    console.error(
      `[extension-import-ban] FAIL — IMPORT_BAN_BASE="${baseRef}" begins with "-" (flag-like); ` +
        `refusing to feed a flag-like value to git. Fix the CI base-ref configuration.`,
    );
    process.exit(1);
  } else if (baseRef) {
    // IMPORT_BAN_BASE is set, so the tamper check MUST run. Distinguish:
    //  - ref does NOT resolve (CI misconfig / shallow checkout that didn't fetch
    //    it) → FAIL CLOSED (exit 1). Silently disabling the guard here would be
    //    fail-open; a set-but-unusable base ref is a build error.
    //  - ref resolves but the baseline FILE is absent at that ref → a legitimate
    //    introducing PR (the baseline is new) → no constraint.
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[extension-import-ban] FAIL — IMPORT_BAN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). The baseline tamper check cannot run; ` +
          `failing closed. Ensure the base ref is fetched (e.g. fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/extension-import-ban.baseline.json`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(
          "[extension-import-ban] FAIL — the committed baseline GREW vs " +
            baseRef +
            " (the floor is pinned at zero — no regenerate can raise it):",
        );
        for (const g of grew) console.error("  + " + g);
        process.exit(1);
      }
    }
  }

  // Self-policing: fail if a documented carve-out's edge is no longer coupled — the
  // allowlist entry must be removed (its follow-up landed), else a later
  // reintroduction of the same edge would silently ride the forgotten entry.
  const staleCarveOuts = staleAllowlistEntries(current);
  if (staleCarveOuts.length) {
    console.error(
      "[extension-import-ban] FAIL — STALE sdkOnly carve-out(s): an allowlisted edge is no longer\n" +
        "coupled in the codebase, so its STRICT_SDK_ONLY_ALLOWLIST entry MUST be removed (its\n" +
        "follow-up has landed). Leaving it behind would let a later reintroduction of the same\n" +
        "edge silently pass:",
    );
    for (const v of staleCarveOuts) console.error("  + " + v);
    process.exit(1);
  }

  // PINNED EMPTY: any current edge in any dimension fails immediately (zero is
  // the floor and the ceiling — there is no tolerated set left to diff against;
  // `--strict-sdk-only` / `--strict` are accepted no-ops and cannot weaken or
  // change this).
  if (violations.length) {
    console.error(
      "[extension-import-ban] FAIL — extension coupling is not allowed (PINNED EMPTY since the " +
        "zero-floor flip, cinatra#172):",
    );
    for (const v of violations.sort()) console.error("  + " + v);
    console.error(
      "\nAn extension may import ONLY `@cinatra-ai/sdk-extensions` + `@cinatra-ai/sdk-ui` as\n" +
        "first-party code deps; everything else (host `@/`, cross-extension, or any other\n" +
        "first-party / sibling-vendor package) must go through `register(ctx)` host ports or a\n" +
        "per-concern `@cinatra-ai/host:*` service resolved via the connector's deps slot (see\n" +
        "scripts/audit/extension-coupling-gates.md, end-state record). There is NO re-baselining\n" +
        "path: `--write-baseline` refuses non-empty output, a non-empty committed baseline is\n" +
        "itself a failure, and the only carve-out mechanism (sdkOnly STRICT_SDK_ONLY_ALLOWLIST)\n" +
        "requires an owner ruling.",
    );
    process.exit(1);
  }

  console.log(
    "[extension-import-ban] OK — 0 @/ + 0 cross-extension + 0 non-SDK @cinatra-ai (baseline PINNED " +
      "EMPTY since the zero-floor flip, cinatra#172; sdkOnly unconditionally strict, " +
      "STRICT_SDK_ONLY_ALLOWLIST EMPTY; no whole-extension exemptions). All FOUR coupling " +
      "baselines are pinned empty — see scripts/audit/extension-coupling-gates.md.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
