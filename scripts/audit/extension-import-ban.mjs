#!/usr/bin/env node
// CI gate: the `@/` import-ban for extensions.
//
// A companion extension must reach privileged host capability ONLY through the
// `register(ctx)` ports — never via a `@/lib/*`, `@/components/*`, `@/app/*`
// import, and never via a static import of another extension package. (No
// whole-extension exemptions — anthropic-connector is decoupled to SDK-only like
// every other connector.)
//
// The actual decoupling is a large, incremental sweep across the connector
// fleet. This gate ships FIRST as a NO-NEW-ROT touch-ratchet (the repo's proven
// pattern — cf. the admin-route gates): a committed baseline records the CURRENT
// coupling, and CI fails only on coupling NOT in the baseline. As connectors are
// decoupled the baseline shrinks (regenerate with `--write-baseline`); when it
// reaches zero the ban is absolute.
//
// SCOPE (this gate is PARTIAL): it covers the EXTENSION → `@/`/cross-extension
// direction. The other half — "any direct extension import in cinatra core
// outside the generated/ manifests" — is the legitimate CURRENT host wiring
// (plugins-registry, register-transport-connectors, connector-setup-pages) that
// the manifest cutover replaces with the generated manifest, so it is deferred
// to that cutover's acceptance surface.
//
// GRANULARITY: the ratchet unit is the (extension, host-module) edge, not the
// import site. Decoupling removes a host module from an extension wholesale, so a
// second import of an already-baselined module is not NEW decoupling work; the
// monotonic base-comparison below still prevents the baselined SET from growing.
//
// IOC TIGHTENING: a THIRD ratcheted dimension — `sdkOnly` — records every
// NON-SDK first-party `@cinatra-ai/*` (and any sibling vendor-scope) CODE
// dependency, from package.json deps/peerDeps AND from source imports (runtime
// AND `import type`), collapsed to base packages. The canonical rule is that the
// ONLY permitted first-party code deps are the two SDK packages (`sdk-extensions`,
// `sdk-ui`); everything else is extraction-blocking coupling. By DEFAULT this
// dimension is ratcheted exactly like the other two (no-new-rot) so the current
// legitimate connector coupling does not break the build; the `--strict-sdk-only`
// flag makes it ZERO-TOLERANCE.
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
//   node scripts/audit/extension-import-ban.mjs                  # check (exit 1 on NEW coupling)
//   node scripts/audit/extension-import-ban.mjs --write-baseline # regenerate the baseline (shrink-only in CI)
//   node scripts/audit/extension-import-ban.mjs --strict         # also fail on stale baseline entries
//   node scripts/audit/extension-import-ban.mjs --strict-sdk-only# zero-tolerance for the sdkOnly dimension
//   IMPORT_BAN_BASE=<ref> node ...                               # also fail if the baseline GREW vs <ref>

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

// Documented EDGE-level carve-outs tolerated under `--strict-sdk-only` (and the
// ratchet) until a tracked follow-up removes them. Unlike EXEMPT (a whole
// extension), this exempts a SINGLE `extension -> module` sdkOnly edge. Each entry
// MUST carry an inline rationale + a follow-up reference. The allowlist is itself
// monotonic-shrink: remove an entry the moment its follow-up lands — never add a
// new one without owner sign-off. Keys are the same `JSON.stringify([ext, mod])`
// shape `flatten()` produces.
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

// Pure diff (no IO) — the testable core. `newViolations` = coupling present now
// but NOT in the baseline (fails CI); `stale` = baseline entries no longer
// present (decoupled — should be removed from the baseline).
//
// The `sdkOnly` dimension is ratcheted EXACTLY like the other two by default —
// only NEW entries fail. When `strictSdkOnly` is true (`--strict-sdk-only`), the
// sdkOnly dimension becomes ZERO-TOLERANCE: the baseline is ignored for it and
// EVERY current sdkOnly entry is a violation (the absolute SDK-only ban). The
// host/@-import + cross-extension ratchets are UNCHANGED in either mode.
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
    // below (an allowlist entry whose edge is gone is a hard failure). See
    // STRICT_SDK_ONLY_ALLOWLIST for the rationale + the follow-up that removes it.
    if (sdkOnlyAllowlist.has(k)) continue;
    if (strictSdkOnly || !baseSdk.has(k)) newViolations.push(show(k, "non-SDK @cinatra-ai dep"));
  }
  const stale = [];
  for (const k of baseHost) if (!curHost.has(k)) stale.push(show(k, "@/ import"));
  for (const k of baseXext) if (!curXext.has(k)) stale.push(show(k, "cross-extension import"));
  for (const k of baseSdk) if (!curSdk.has(k)) stale.push(show(k, "non-SDK @cinatra-ai dep"));
  return { newViolations, stale };
}

// Self-policing carve-out check (runs in main() against the REAL current coupling).
// An allowlist entry whose edge is no longer present in current `sdkOnly` coupling
// is a stale carve-out that MUST be removed (its follow-up landed). This is a hard
// FAILURE so the allowlist is forced monotonic-shrink — AND so a later
// reintroduction of the same edge cannot silently ride a forgotten allowlist entry
// (the entry must be removed once the edge is gone, which then makes the
// reintroduction fail strict). Pure + exported for unit testing; kept OUT of
// diffCoupling so synthetic diffCoupling fixtures aren't gated on the default
// allowlist's real-repo edge.
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

// Monotonic-ratchet guard: the committed baseline must be a SUBSET of the
// base-branch baseline — it may only SHRINK. Without this, a PR could add a new
// `@/` import AND regenerate the baseline to include it, defeating the ratchet.
// Returns the entries the committed baseline ADDED vs base (empty = OK).
export function baselineGrowth(baseBaseline, committedBaseline) {
  // PER-DIMENSION monotonic guard. A dimension that is ABSENT on the base
  // baseline is being INTRODUCED by this PR (e.g. the first landing of the
  // `sdkOnly` dimension on a base whose baseline only had hostInternal/
  // crossExtension) — mirror the whole-file "baseline absent on base → the
  // introducing PR has no constraint" semantics PER DIMENSION, so adding a new
  // ratcheted dimension is not mis-read as baselining new coupling. Dimensions
  // that DO exist on base still ratchet (may only shrink), so this cannot be
  // used to sneak new coupling into an already-tracked dimension.
  const grown = [];
  for (const dim of ["hostInternal", "crossExtension", "sdkOnly"]) {
    // INTRODUCING = the dimension KEY is ABSENT on the base baseline (not merely
    // empty). A present-but-empty dimension (e.g. origin/main's `crossExtension: {}`)
    // is TRACKED and still ratchets — treating `{}` as "introduced" would let a PR
    // baseline a brand-new entry into an existing-but-empty dimension (a real
    // bypass). Only a dimension with NO key on base (e.g. `sdkOnly`'s first
    // landing) is exempt, mirroring the whole-file "absent on base" semantics.
    if (baseBaseline[dim] === undefined) continue;
    const baseSet = flatten(baseBaseline[dim]);
    for (const k of flatten(committedBaseline[dim] ?? {})) {
      if (!baseSet.has(k)) grown.push(show(k, "baseline-added"));
    }
  }
  return grown;
}

async function main() {
  const args = process.argv.slice(2);
  // Fail-closed: the extension source must be cloned back before
  // this gate runs, or it scans an empty tree and passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "extension-import-ban");
  const inv = await buildInventory();
  const current = currentCoupling(inv);

  if (args.includes("--write-baseline")) {
    const doc = {
      note:
        "Extension import-ban no-new-rot baseline. `hostInternal`/`crossExtension` = CURRENT @/ or cross-extension coupling tolerated until the decoupling sweep removes it. `sdkOnly` = CURRENT non-SDK first-party/sibling-vendor code coupling (deps + source imports incl. `import type`) tolerated until the connector sweep migrates each onto `ctx`; the canonical rule is SDK-packages-only. Under the shared extension-reference taxonomy (scripts/audit/lib/extension-reference-classification.mjs + scripts/audit/extension-coupling-gates.md) ALL entries in every dimension classify as runtime-coupling; nothing extension-side is mechanical or permanently exempt. Regenerate with `node scripts/audit/extension-import-ban.mjs --write-baseline` (every dimension should only ever SHRINK). The `--strict-sdk-only` flip makes `sdkOnly` zero-tolerance. anthropic-connector is un-exempt and scanned like every other connector.",
      classification: "runtime-coupling",
      hostInternal: current.hostInternal,
      crossExtension: current.crossExtension,
      sdkOnly: current.sdkOnly,
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    console.log("[extension-import-ban] baseline written.");
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[extension-import-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  // Monotonic-ratchet guard (closes the "regenerate baseline to pass" bypass).
  // CI sets IMPORT_BAN_BASE to the PR base ref; the committed baseline must be a
  // subset of the base-branch baseline. Absent on base (the introducing PR) →
  // no constraint.
  const baseRef = process.env.IMPORT_BAN_BASE;
  if (baseRef && baseRef.startsWith("-")) {
    // FAIL CLOSED. A leading-dash ref would be parsed by `git show`/`rev-parse`
    // as an option, AND it means the monotonic baseline-growth guard can't run.
    // IMPORT_BAN_BASE is only ever SET in CI, where it MUST be a real ref; a
    // flag-like value is a misconfig, never a reason to silently drop the guard
    // (that was a fail-OPEN bypass: add coupling + regenerate the baseline → pass).
    console.error(
      `[extension-import-ban] FAIL — IMPORT_BAN_BASE="${baseRef}" begins with "-" (flag-like); ` +
        `refusing to feed a flag-like value to git. Fix the CI base-ref configuration.`,
    );
    process.exit(1);
  } else if (baseRef) {
    // IMPORT_BAN_BASE is set, so the monotonic guard MUST run. Distinguish:
    //  - ref does NOT resolve (CI misconfig / shallow checkout that didn't fetch
    //    it) → FAIL CLOSED (exit 1). Silently disabling the guard here was a
    //    fail-OPEN bypass; a set-but-unusable base ref is a build error.
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
          `(shallow checkout / misconfig?). The monotonic baseline-growth guard cannot run; ` +
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
            " (coupling baselines may only shrink; you cannot baseline new coupling):",
        );
        for (const g of grew) console.error("  + " + g);
        process.exit(1);
      }
    }
  }

  // --strict-sdk-only: treat the sdkOnly dimension as zero-tolerance (NO
  // per-extension allowlist accumulation). Default runs keep it ratcheted
  // alongside the host/cross-extension dimensions.
  const strictSdkOnly = args.includes("--strict-sdk-only");
  const { newViolations, stale } = diffCoupling(baseline, current, { strictSdkOnly });
  const baseCount = flatten(baseline.hostInternal ?? {}).size;
  const baseXextCount = flatten(baseline.crossExtension ?? {}).size;
  const baseSdkCount = flatten(baseline.sdkOnly ?? {}).size;

  // Self-policing: fail if a documented carve-out's edge is no longer coupled — the
  // allowlist entry must be removed (its follow-up landed), else a later
  // reintroduction of the same edge would silently ride the forgotten entry.
  const staleCarveOuts = staleAllowlistEntries(current);
  if (staleCarveOuts.length) {
    console.error(
      "[extension-import-ban] FAIL — STALE sdkOnly carve-out(s): an allowlisted edge is no longer\n" +
        "coupled in the codebase, so its STRICT_SDK_ONLY_ALLOWLIST entry MUST be removed (the\n" +
        "objects-ctx / decoupling follow-up has landed). Leaving it behind would let a later\n" +
        "reintroduction of the same edge silently pass --strict-sdk-only:",
    );
    for (const v of staleCarveOuts) console.error("  + " + v);
    process.exit(1);
  }

  if (newViolations.length) {
    console.error(
      strictSdkOnly
        ? "[extension-import-ban] FAIL — extension coupling not allowed (--strict-sdk-only: SDK packages only):"
        : "[extension-import-ban] FAIL — NEW extension coupling not in the baseline:",
    );
    for (const v of newViolations) console.error("  + " + v);
    console.error(
      "\nAn extension may import ONLY `@cinatra-ai/sdk-extensions` + `@cinatra-ai/sdk-ui` as\n" +
        "first-party code deps; everything else (host `@/`, cross-extension, or any other\n" +
        "first-party / sibling-vendor package) must go through `register(ctx)` host ports.\n" +
        "If this is a legitimate temporary step during the decoupling sweep, regenerate\n" +
        "the baseline with `node scripts/audit/extension-import-ban.mjs --write-baseline` (baselines\n" +
        "only shrink). NOTE: --strict-sdk-only refuses to tolerate ANY sdkOnly entry (the zero-tolerance flip).",
    );
    process.exit(1);
  }

  if (stale.length) {
    const strict = args.includes("--strict");
    const header =
      "[extension-import-ban] " +
      (strict ? "FAIL" : "NOTE") +
      " — " +
      stale.length +
      " baseline entr" +
      (stale.length === 1 ? "y is" : "ies are") +
      " stale (decoupled — remove via --write-baseline):";
    const body = stale.map((s) => "  - " + s).join("\n");
    if (strict) {
      console.error(header + "\n" + body);
      process.exit(1);
    }
    console.log(header + "\n" + body);
  }

  console.log(
    "[extension-import-ban] OK — no NEW coupling" +
      (strictSdkOnly ? " (--strict-sdk-only: SDK-only ENFORCED)" : "") +
      ". Baseline: " +
      baseCount +
      " @/ + " +
      baseXextCount +
      " cross-extension + " +
      baseSdkCount +
      " non-SDK @cinatra-ai (all runtime-coupling class; no whole-extension exemptions). sdkOnly is now FLIPPED to --strict-sdk-only " +
      "(zero-tolerance) in CI; the STRICT_SDK_ONLY_ALLOWLIST is EMPTY (the objects-ctx " +
      "follow-up closed the last carve-out). Drive @/ + cross-extension to 0 next.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
