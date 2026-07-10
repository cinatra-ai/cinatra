/**
 * Toast-banner conformance guard — standing CI ratchet keeping every transient
 * notification on the canonical toast island (no new ad-hoc flash banners).
 *
 * WHAT THIS ENFORCES
 * ------------------
 * The toast epic converges all transient notifications onto one canonical layer:
 *   - imperative toasts → `cinatraToast` / `useNotify`
 *   - URL flash outcomes → the codes-only `<SearchParamToast>` island
 *     (packages/sdk-ui/src/search-param-toast.tsx)
 * The direct-`sonner`-import vector is already guarded by the ESLint
 * `no-restricted-imports` SONNER_BAN (eslint.config.mjs, run by the
 * ui-design-system-gate) and the legacy `@/lib/toast` removal guard
 * (toast-import-guard.test.ts). An import ban CANNOT catch a JSX banner, so this
 * guard closes the *second* regression vector: a searchParams-driven conditional
 * transient banner — a success/destructive `<Alert>` or a flash-palette
 * colored-`<div>` gated on a transient-outcome query param — being (re)introduced
 * in `src/` or `packages/` instead of a toast.
 *
 * MECHANISM (file-level heuristic + shrink-only baseline)
 * ------------------------------------------------------
 * A precise "flash banner" classifier is not statically decidable (the flash
 * value is often prop-drilled; a persistent `<Alert>` can sit on a page that
 * also reads searchParams). So the guard uses a deliberately conservative
 * file-level heuristic — a file that BOTH reads a transient-OUTCOME searchParam
 * AND renders a success/destructive `<Alert>` (or a flash-palette colored-div) —
 * and enumerates today's matches in a committed baseline that can only SHRINK:
 *   - A file that matches but is NOT in the baseline  → FAIL (new banner).
 *   - A baseline file that no longer matches          → FAIL (remove it; the
 *     ratchet only shrinks, so a migration PR that toasts a banner must also
 *     drop its baseline entry).
 * `pending-migration` entries are the transient banners the epic migrates to the
 * island (target: zero). `adjudicated-inline` entries are epic-sanctioned inline
 * surfaces (persistent state, already-canonical) the heuristic also flags —
 * permanent, each with a reason. The canonical island, `__tests__`, and
 * `*.test.tsx` are never scanned; comments are stripped before matching so a
 * mention inside a doc-comment never trips (or masks) the guard.
 *
 * KNOWN, ACCEPTED LIMITS (this is a mechanical guardrail, not a proof)
 * -------------------------------------------------------------------
 *   - Heuristic, so it can be EVADED by a determined author: a variant supplied
 *     through a non-literal variable (`variant={v}` where `v` is computed
 *     elsewhere), a banner extracted into a bespoke wrapper component, or a
 *     colored-div class assembled from variables. Inline-ternary variants,
 *     optional chaining, and `cn("bg-…")` literals ARE caught. The residual is
 *     accepted: the guard's job is to stop the *obvious* copy-paste regression,
 *     and any evasion still faces human/Codex review — it does not silently make
 *     an ad-hoc banner correct.
 *   - Granularity is per-FILE, not per-occurrence: a file already in the
 *     `pending-migration` baseline is not re-checked for ADDITIONAL banners.
 *     That is acceptable because those files are slated to reach zero banners
 *     (and leave the baseline) under the migration slice; a brand-new file gets
 *     no such tolerance.
 * (Concerns surfaced by the Codex convergence pass; the cheap-to-close ones —
 * comment stripping, optional chaining, inline-ternary variants — were folded
 * into the detector below.)
 *
 * WHY A VITEST SOURCE-SCANNER (not a new *-gate workflow)
 * ------------------------------------------------------
 * This file is picked up by the wholesale `pnpm test:root` step ("Root Vitest
 * suite — gate of record") inside the REQUIRED "Perpetual system loops
 * invariants" check, so the guard participates in required CI with no
 * .github/workflows edit — the same path-gated-into-an-existing-runner shape the
 * design-conformance specs use. Mirrors the fast, deterministic `git ls-files`
 * scan the sibling toast-import-guard uses (node_modules trees are gitignored
 * and thus never walked).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Shared lexical comment stripper used by the audit gates — removes comments
// while preserving string/JSX/template contents verbatim (so real
// `variant="destructive"` JSX survives, but a banner mentioned in a doc-comment
// does not trip the guard). Same import shape the sibling src/lib e2e tests use
// for a scripts/*.mjs helper.
import { stripComments } from "../../../scripts/audit/lib/strip-comments.mjs";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.join(REPO_ROOT, "src/lib/toast-banner-guard.baseline.json");

// Source roots that can host a transient banner. Everything else (node_modules,
// build output) is irrelevant and must never be walked.
const SCAN_ROOTS = ["src", "packages"] as const;

// ---------------------------------------------------------------------------
// Pure detectors (unit-tested below against inline fixtures — this is the
// permanent RED-behaviour proof; no real offender file is needed to prove the
// guard bites).
// ---------------------------------------------------------------------------

/**
 * Transient-OUTCOME query-param codes. Deliberately specific (a post-action
 * redirect flash), NOT generic tokens like `status`/`page` that route/pagination
 * code reads — this is what keeps the heuristic off persistent surfaces.
 */
const OUTCOME =
  "(?:saved|ok|error|errors|deleted|added|removed|invalid|invalidUrl|logsCleared|reconnected|disconnected)";

/**
 * A read of a transient-outcome value FROM searchParams. Covers (incl. optional
 * chaining `?.`):
 *   - `searchParams.get("saved")` / `searchParams?.get("saved")`
 *   - `resolvedSearchParams.ok` / `searchParams.error` / `params.error` /
 *     `sp.deleted` (the resolved-searchParams object is conventionally named
 *     one of these; the OUTCOME token set makes a route-`params` collision
 *     effectively impossible — route params are path segments, never `ok`/`error`)
 *   - `pick(sp.error)` / `pickSearchParam(resolvedSearchParams.ok)`
 */
export const FLASH_OUTCOME_READ = new RegExp(
  "(?:" +
    `searchParams\\??\\.get\\(\\s*["']${OUTCOME}["']` +
    "|" +
    `(?:resolvedSearchParams|searchParams|params|sp)\\??\\.${OUTCOME}\\b` +
    "|" +
    `pick\\w*\\(\\s*\\w+\\??\\.${OUTCOME}\\b` +
    ")",
  "i",
);

/**
 * A status-carrying `<Alert>` — the transient-banner variants. Matches both a
 * string-literal variant (`variant="destructive"`) and an inline-expression
 * variant that names the code (`variant={x ? "destructive" : "default"}`). A
 * plain `<Alert>` / `variant="default"` (persistent/informational) does NOT
 * match. A variant supplied through an opaque variable is a known residual (see
 * the header's accepted-limits note).
 */
export const ALERT_STATUS_BANNER =
  /<Alert\b[^>]*\bvariant\s*=\s*(?:["'](?:success|destructive)["']|\{[^}>]*\b(?:success|destructive)\b)/;

/** A raw colored-`<div>` banner in the flash palette (bg-/border- status
 * colors). `text-`-only destructive copy (in-dialog inline errors) does NOT
 * match — only a filled/bordered banner surface. `className={cn("bg-…")}` and
 * template-literal class strings are caught; a class built from a variable is
 * a known residual. */
export const FLASH_COLORED_DIV =
  /<div\b[^>]*className=[^>]*(?:bg-destructive|bg-red-|bg-amber-|bg-yellow-|bg-emerald-|bg-green-|border-destructive)\b/;

/** True when the file renders a transient banner primitive. */
export function rendersTransientBanner(strippedText: string): boolean {
  return ALERT_STATUS_BANNER.test(strippedText) || FLASH_COLORED_DIV.test(strippedText);
}

/** True when the file reads a transient-outcome searchParam. */
export function readsFlashOutcomeParam(strippedText: string): boolean {
  return FLASH_OUTCOME_READ.test(strippedText);
}

/**
 * The guard's file-level match: a searchParams-flash-driven transient banner.
 * Comments are stripped first so a doc-comment mention neither trips nor masks
 * the guard. A file both reads a transient-outcome param AND renders a status
 * banner.
 */
export function isBannerFile(text: string): boolean {
  const stripped = stripComments(text);
  return readsFlashOutcomeParam(stripped) && rendersTransientBanner(stripped);
}

// ---------------------------------------------------------------------------
// Filesystem scan (deterministic; git-index-driven so gitignored node_modules
// trees are excluded by construction).
// ---------------------------------------------------------------------------

/** This guard file, repo-relative — always excluded (it holds the fixtures). */
const GUARD_REL = path.relative(REPO_ROOT, __filename);

function listSourceFiles(): string[] {
  const globs = SCAN_ROOTS.map((root) => `${root}/**/*.tsx`);
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    // Never scan tests (fixtures), or the canonical island itself.
    .filter((p) => !/(^|\/)__tests__\//.test(p))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => !/(^|\/)search-param-toast\.tsx$/.test(p))
    .filter((p) => p !== GUARD_REL);
}

/** Repo-relative paths that currently match the banner heuristic, sorted. */
function scanBannerFiles(): string[] {
  return listSourceFiles()
    .filter((rel) => isBannerFile(readFileSync(path.join(REPO_ROOT, rel), "utf8")))
    .sort();
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const VALID_CLASSES = new Set(["pending-migration", "adjudicated-inline"]);

interface BaselineEntry {
  file: string;
  class: string;
  reason: string;
}

function loadBaseline(): { entries: BaselineEntry[] } {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

const CANONICAL_HINT =
  "Route this transient notification through the canonical toast layer instead of an ad-hoc banner: " +
  "imperative feedback → `cinatraToast` / `useNotify`; a URL flash outcome → the codes-only " +
  "`<SearchParamToast>` island (packages/sdk-ui/src/search-param-toast.tsx). " +
  "See src/lib/toast-banner-guard.baseline.json for the adjudicated inline exemptions.";

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("toast-banner conformance guard", () => {
  it("baseline is well-formed (unique, sorted, typed, reasoned)", () => {
    const baseline = loadBaseline();
    expect(Array.isArray(baseline.entries)).toBe(true);
    const files = baseline.entries.map((e) => e.file);
    // Unique
    expect(new Set(files).size).toBe(files.length);
    // Sorted (stable diffs)
    expect(files).toEqual([...files].sort());
    for (const e of baseline.entries) {
      expect(typeof e.file, `entry.file must be a string: ${JSON.stringify(e)}`).toBe("string");
      expect(VALID_CLASSES.has(e.class), `entry.class must be one of ${[...VALID_CLASSES].join("/")}: ${e.file}`).toBe(true);
      expect(typeof e.reason === "string" && e.reason.trim().length > 0, `entry.reason must be non-empty: ${e.file}`).toBe(true);
    }
  });

  it("no NEW searchParams-driven banner outside the baseline; no STALE baseline entry (the ratchet only shrinks)", () => {
    const start = performance.now();
    const matches = scanBannerFiles();
    const elapsedMs = performance.now() - start;

    const baselineFiles = new Set(loadBaseline().entries.map((e) => e.file));

    const introduced = matches.filter((f) => !baselineFiles.has(f));
    const stale = [...baselineFiles].filter((f) => !matches.includes(f)).sort();

    if (introduced.length > 0) {
      throw new Error(
        `Found ${introduced.length} NEW searchParams-driven transient banner(s) not on the canonical toast layer:\n` +
          introduced.map((f) => `  - ${f}`).join("\n") +
          `\n\n${CANONICAL_HINT}`,
      );
    }
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} toast-banner baseline entr${stale.length === 1 ? "y" : "ies"} no longer match — the ratchet only shrinks. ` +
          `Remove the migrated file(s) from src/lib/toast-banner-guard.baseline.json:\n` +
          stale.map((f) => `  - ${f}`).join("\n"),
      );
    }

    expect(introduced).toEqual([]);
    expect(stale).toEqual([]);

    // Deterministic scan budget (sibling toast-import-guard rationale): a
    // regression that reintroduces a node_modules-style walk becomes a loud,
    // named failure instead of an intermittent 30s-timeout flake.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// Detector unit tests — the permanent proof that the guard BITES on a
// reintroduced banner and IGNORES the sanctioned inline surfaces (AC6, without
// committing a real offender fixture file to the tree).
// ---------------------------------------------------------------------------

describe("toast-banner detector", () => {
  const flashRead = `const saved = pickSearchParam(resolvedSearchParams.saved);`;
  const successAlert = `{saved ? (<Alert variant="success"><AlertDescription>Saved.</AlertDescription></Alert>) : null}`;
  const destructiveAlert = `<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>`;
  const coloredDiv = `<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">Heads up</div>`;

  it("FLAGS a flash-outcome read gated onto a success <Alert> (the reintroduced-banner case)", () => {
    expect(isBannerFile(`${flashRead}\n${successAlert}`)).toBe(true);
  });

  it("FLAGS a destructive <Alert> on a page reading ?error", () => {
    const src = `const sp = await searchParams;\nconst error = sp.error;\n${destructiveAlert}`;
    expect(isBannerFile(src)).toBe(true);
  });

  it("FLAGS a flash-palette colored-div gated on a flash param", () => {
    const src = `const ok = searchParams.get("ok");\n{ok ? ${coloredDiv} : null}`;
    expect(isBannerFile(src)).toBe(true);
  });

  it("FLAGS an optional-chained flash read (searchParams?.get) with a status banner", () => {
    const src = `const saved = searchParams?.get("saved");\n${successAlert}`;
    expect(isBannerFile(src)).toBe(true);
  });

  it("FLAGS an inline-ternary dynamic <Alert> variant gated on a flash param", () => {
    const src = `const error = sp.error;\n<Alert variant={error ? "destructive" : "default"}><AlertDescription>{error}</AlertDescription></Alert>`;
    expect(isBannerFile(src)).toBe(true);
  });

  it("FLAGS a cn()-composed colored-div class gated on a flash param", () => {
    const src = `const error = searchParams.get("error");\n{error ? <div className={cn("rounded p-2", "bg-destructive/10")}>{error}</div> : null}`;
    expect(isBannerFile(src)).toBe(true);
  });

  it("IGNORES a status <Alert> with NO searchParams flash read (a persistent inline surface)", () => {
    const src = `const rebuild = await checkRebuild();\n{rebuild ? <Alert variant="destructive"><AlertTitle>Requires rebuild</AlertTitle></Alert> : null}`;
    expect(isBannerFile(src)).toBe(false);
  });

  it("IGNORES a flash read with NO status banner (already routed to a toast/island)", () => {
    const src = `const error = pickSearchParam(resolvedSearchParams.error); // suppresses auto-advance; surfaced by <SearchParamToast>`;
    expect(isBannerFile(src)).toBe(false);
  });

  it("IGNORES a plain/informational <Alert> (variant=default) even with a flash read", () => {
    const src = `const saved = searchParams.get("saved");\n<Alert variant="default"><AlertTitle>The Connections tab moved</AlertTitle></Alert>`;
    expect(isBannerFile(src)).toBe(false);
  });

  it("IGNORES an in-dialog text-destructive inline error (not a filled/bordered banner)", () => {
    const src = `const error = sp.error;\n{error ? <p className="text-sm text-destructive">{error}</p> : null}`;
    expect(isBannerFile(src)).toBe(false);
  });

  it("does NOT match a generic non-outcome searchParam (e.g. pagination) with a persistent Alert", () => {
    const src = `const page = searchParams.get("page");\n<Alert variant="destructive"><AlertTitle>Prerequisite missing</AlertTitle></Alert>`;
    expect(isBannerFile(src)).toBe(false);
  });

  it("IGNORES a banner + flash-read that appear ONLY inside comments (comments are stripped)", () => {
    const src = `// legacy: <Alert variant="destructive"> gated on searchParams.get("error")\nexport const x = 1;`;
    expect(isBannerFile(src)).toBe(false);
  });
});
