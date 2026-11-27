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

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The pure detectors (the searchParams-flash-driven banner heuristic) live in a
// shared module so the standalone connector scanner (scripts/audit/
// toast-banner-scan.mjs, run by the reusable toast-banner-gate workflow the
// S3–S12 connectors adopt) enforces the EXACT SAME rule as this core guard, with
// no per-repo copy — the single-source-of-truth shape the extension conformance
// gate uses. The unit fixtures below remain the RED/GREEN behaviour proof.
import {
  FLASH_OUTCOME_READ,
  ALERT_STATUS_BANNER,
  FLASH_COLORED_DIV,
  rendersTransientBanner,
  readsFlashOutcomeParam,
  isBannerFile,
  isExcludedFromScan,
} from "../../../scripts/audit/lib/toast-banner-detect.mjs";

import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  fixtureGit,
  makeFloorRepo,
} from "../../../scripts/audit/__tests__/floor-base-fixture.mjs";

// Re-exported for callers that want the raw detectors (kept from when they were
// defined inline here); the vitest fixtures exercise `isBannerFile` end-to-end.
export {
  FLASH_OUTCOME_READ,
  ALERT_STATUS_BANNER,
  FLASH_COLORED_DIV,
  rendersTransientBanner,
  readsFlashOutcomeParam,
  isBannerFile,
};

const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.join(REPO_ROOT, "src/lib/toast-banner-guard.baseline.json");

// Source roots that can host a transient banner. Everything else (node_modules,
// build output) is irrelevant and must never be walked.
const SCAN_ROOTS = ["src", "packages"] as const;

// ---------------------------------------------------------------------------
// Filesystem scan (deterministic; git-index-driven so gitignored node_modules
// trees are excluded by construction). The banner heuristic itself is imported
// from scripts/audit/lib/toast-banner-detect.mjs above (shared with the
// connector scanner); the unit fixtures at the bottom of this file remain the
// permanent RED/GREEN proof.
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
    // Never scan tests (fixtures) or the canonical island itself (shared
    // exclusion predicate, so core and the connector scanner never drift).
    .filter((p) => !isExcludedFromScan(p))
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

// ---------------------------------------------------------------------------
// The baseline may not grow against the base branch (cinatra#3832). The scanner
// (scripts/audit/toast-banner-scan.mjs) is only spawned here, never imported,
// and every spawn gets a test-owned environment (`runScan`), never the CI run's.
// ---------------------------------------------------------------------------

describe("toast-banner-scan - the baseline may not grow against the base", () => {
  const SCAN = path.join(REPO_ROOT, "scripts/audit/toast-banner-scan.mjs");
  const FLOOR = "src/lib/toast-banner-guard.baseline.json";
  const entry = (file: string) => ({ file, class: "pending-migration", reason: "a fixture entry" });
  const list = (...files: string[]) => ({ entries: files.map(entry) });
  const cleanups: Array<() => void> = [];
  afterAll(() => cleanups.forEach((c) => c()));

  // Every variable the script or the shared guard reads is named here: nothing
  // else of the outer environment reaches the spawned script.
  const OWNED = ["GITHUB_EVENT_NAME", "GITHUB_BASE_REF", "TOAST_BANNER_BASE", "FLOOR_BASE_FETCH", "GITHUB_HEAD_REF", "GITHUB_REF_NAME"];
  // Next's ambient `NodeJS.ProcessEnv` requires NODE_ENV, which the test-owned
  // environment deliberately omits, so the one assertion lives here.
  function scanEnv(run: Record<string, string>): NodeJS.ProcessEnv {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    for (const k of OWNED) delete env[k];
    return { ...env, ...run } as NodeJS.ProcessEnv;
  }
  function runScan(root: string, run: Record<string, string>) {
    const r = spawnSync(
      process.execPath,
      [SCAN, "--package", root, "--baseline", path.join(root, FLOOR), "--scan-root", "src"],
      { cwd: root, encoding: "utf8", env: scanEnv(run) },
    );
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }
  function fixture(base: unknown, head: unknown) {
    const f = makeFloorRepo({ base: { [FLOOR]: base }, head: { [FLOOR]: head } });
    cleanups.push(f.cleanup);
    return f.root as string;
  }

  it("an added entry FAILS on a pull request, naming the file", () => {
    const r = runScan(fixture(list("src/a.tsx"), list("src/a.tsx", "src/new.tsx")), PULL_REQUEST_RUN);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/GREW against/);
    expect(r.out).toContain("entries file src/new.tsx");
  });

  it("an added entry FAILS on a merge group with a pinned base", () => {
    const root = fixture(list("src/a.tsx"), list("src/a.tsx", "src/new.tsx"));
    const pinned = fixtureGit(root, ["rev-parse", "HEAD~1"]).trim();
    const r = runScan(root, { GITHUB_EVENT_NAME: "merge_group", TOAST_BANNER_BASE: pinned });
    expect(r.status).toBe(1);
    expect(r.out).toContain("entries file src/new.tsx");
  });

  it("a removal passes", () => {
    const some = runScan(fixture(list("src/a.tsx", "src/b.tsx"), list("src/a.tsx")), PULL_REQUEST_RUN);
    expect(some.out).toMatch(/does not grow against/);
    const all = runScan(fixture(list("src/a.tsx"), list()), PULL_REQUEST_RUN);
    expect(all.status, all.out).toBe(0);
    expect(all.out).toMatch(/does not grow against/);
  });

  it("a null or absent entries list is the empty list, on both sides", () => {
    for (const form of [{}, { entries: null }]) {
      expect(runScan(fixture(list("src/a.tsx"), form), PULL_REQUEST_RUN).out).toMatch(/does not grow against/);
      const base = runScan(fixture(form, list("src/a.tsx")), PULL_REQUEST_RUN);
      expect(base.status).toBe(1);
      expect(base.out).toContain("entries file src/a.tsx");
    }
  });

  it("a wrong shape FAILS on the head naming the field, and on the base", () => {
    const cases: Array<[unknown, string]> = [
      [{ entries: "src/a.tsx" }, "entries is not a list"],
      [{ entries: { a: 1 } }, "entries is not a list"],
      [{ entries: [{ class: "pending-migration" }] }, "entries[0].file is not a string"],
      [{ entries: [entry("src/a.tsx"), 5] }, "entries[1].file is not a string"],
    ];
    for (const [bad, field] of cases) {
      const head = runScan(fixture(list("src/a.tsx"), bad), PULL_REQUEST_RUN);
      expect(head.status, field).toBe(1);
      expect(head.out).toMatch(/not a readable baseline/);
      expect(head.out, `head: ${field}`).toContain(field);
      const base = runScan(fixture(bad, list("src/a.tsx")), PULL_REQUEST_RUN);
      expect(base.status, field).toBe(1);
      expect(base.out).toMatch(/not a readable floor/);
      expect(base.out, `base: ${field}`).toContain(field);
    }
  });

  it("an unparsable head, an unparsable base and an unreadable base fail closed", () => {
    for (const text of ["not json", "[]", "null", "5"]) {
      const head = runScan(fixture(list("src/a.tsx"), text), PULL_REQUEST_RUN);
      expect(head.status, `head ${text}`).toBe(1);
      expect(head.out).toMatch(/not a readable baseline/);
      const base = runScan(fixture(text, list("src/a.tsx")), PULL_REQUEST_RUN);
      expect(base.status, `base ${text}`).toBe(1);
      expect(base.out).toMatch(/not a readable floor/);
    }
    const r = runScan(fixture(list("src/a.tsx"), list("src/a.tsx")), UNREADABLE_BASE_RUN);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });

  it("a run that is no pull request says so and passes the comparison", () => {
    const r = runScan(fixture(list(), list()), NO_PULL_REQUEST_RUN);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/not compared with a base on this run/);
  });

  it("an unchanged head passes against a pinned base that holds an entry live main has since removed", () => {
    // The event's base SHA holds src/old.tsx; live origin/main has moved on without it.
    const root = fixture(list("src/old.tsx"), list("src/old.tsx"));
    const headSha = fixtureGit(root, ["rev-parse", "HEAD"]).trim();
    const pinned = fixtureGit(root, ["rev-parse", "HEAD~1"]).trim();
    fixtureGit(root, ["checkout", "-q", "--detach", pinned]);
    writeFileSync(path.join(root, FLOOR), JSON.stringify(list(), null, 2) + "\n");
    fixtureGit(root, ["commit", "-q", "-a", "--allow-empty", "-m", "live main moved on"]);
    fixtureGit(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixtureGit(root, ["checkout", "-q", "--detach", headSha]);
    expect(runScan(root, { ...PULL_REQUEST_RUN, TOAST_BANNER_BASE: pinned }).out).toMatch(/does not grow against/);
    expect(runScan(root, { GITHUB_EVENT_NAME: "merge_group", TOAST_BANNER_BASE: pinned }).out).toMatch(/does not grow against/);
    // Without the event's base the live tip is read: the unchanged entry looks like growth.
    const live = runScan(root, PULL_REQUEST_RUN);
    expect(live.status).toBe(1);
    expect(live.out).toMatch(/GREW against/);
  });

  it("a merge group with no base named fails closed instead of passing as no-base", () => {
    const r = runScan(fixture(list(), list("src/new.tsx")), { GITHUB_EVENT_NAME: "merge_group" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/merge group's but TOAST_BANNER_BASE is empty/);
  });

  it("a run with no baseline file has nothing to compare and passes the comparison", () => {
    const root = fixture(list(), list());
    fixtureGit(root, ["rm", "-q", "-f", FLOOR]);
    expect(runScan(root, PULL_REQUEST_RUN).out).toMatch(/no baseline file, so no entry can be added/);
  });

  // A baseline FILE the base commit does not hold is the empty list on the base;
  // an unreadable base (an unknown commit) is not.
  function addedFileFixture(head: unknown) {
    const f = makeFloorRepo({ base: { "README.md": "base\n" }, head: { [FLOOR]: head } });
    cleanups.push(f.cleanup);
    return f.root as string;
  }

  it("the base lacks the file and the head adds it with no entries: passes", () => {
    const r = runScan(addedFileFixture(list()), PULL_REQUEST_RUN);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/holds no src\/lib\/toast-banner-guard\.baseline\.json: an empty list/);
    expect(r.out).toMatch(/does not grow against/);
    // `{}` is an empty list for the comparison (the scan's own check still wants `entries`).
    expect(runScan(addedFileFixture({}), PULL_REQUEST_RUN).out).toMatch(/does not grow against/);
  });

  it("the base lacks the file and the head adds one entry: fails naming it, on a pull request and a merge group", () => {
    const root = addedFileFixture(list("src/new.tsx", "src/other.tsx"));
    const pr = runScan(root, PULL_REQUEST_RUN);
    expect(pr.status).toBe(1);
    expect(pr.out).toMatch(/GREW against/);
    expect(pr.out).toContain("entries file src/new.tsx");
    expect(pr.out).toContain("entries file src/other.tsx");
    const pinned = fixtureGit(root, ["rev-parse", "HEAD~1"]).trim();
    const group = runScan(root, { GITHUB_EVENT_NAME: "merge_group", TOAST_BANNER_BASE: pinned });
    expect(group.status).toBe(1);
    expect(group.out).toContain("entries file src/new.tsx");
  });

  it("the base lacks the file and the head file is wrongly shaped: still fails closed on the head", () => {
    const r = runScan(addedFileFixture({ entries: "src/a.tsx" }), PULL_REQUEST_RUN);
    expect(r.status).toBe(1);
    expect(r.out).toContain("entries is not a list");
  });

  it("the base holds the file and the head deleted it: passes", () => {
    const root = fixture(list("src/a.tsx"), list("src/a.tsx"));
    fixtureGit(root, ["rm", "-q", "-f", FLOOR]);
    fixtureGit(root, ["commit", "-q", "-m", "delete the baseline"]);
    const r = runScan(root, PULL_REQUEST_RUN);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/no baseline file, so no entry can be added/);
  });

  it("the base commit is unknown: fails closed, with the head file added or present", () => {
    const unknown = "0".repeat(40);
    for (const root of [addedFileFixture(list()), fixture(list("src/a.tsx"), list("src/a.tsx"))]) {
      const r = runScan(root, { GITHUB_EVENT_NAME: "pull_request", TOAST_BANNER_BASE: unknown });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/cannot be compared with the base/);
      expect(r.out).toMatch(/did not resolve/);
    }
  });

  it("the reusable workflow step sets TOAST_BANNER_BASE from the merge group's or the pull request's base SHA", () => {
    const lines = readFileSync(path.join(REPO_ROOT, ".github/workflows/toast-banner-gate-reusable.yml"), "utf8").split("\n");
    const at = lines.findIndex((l) => l === "      - name: Run the toast-banner conformance gate");
    expect(at, "the step is missing").toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > at && /^ {6}(- |#)/.test(l));
    const step = lines.slice(at, end === -1 ? undefined : end).join("\n");
    expect(step).toContain(
      "        env:\n          TOAST_BANNER_BASE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}\n",
    );
    expect(step).toContain('node "$SCAN"');
  });
});
