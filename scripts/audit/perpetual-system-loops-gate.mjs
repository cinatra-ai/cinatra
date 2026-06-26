#!/usr/bin/env node
/**
 * scripts/audit/perpetual-system-loops-gate.mjs
 *
 * Enforces the canonical "BullMQ perpetual system loops" pattern documented in
 * root AGENTS.md. The pattern has recurred in production four times before the
 * canonical fix existed:
 *   1. graphiti-projection-repair  → "~450-job queue storm" (anonymous successor)
 *   2. artifact-provider-cache-evict → ~70× warning burst (anonymous successor)
 *   3. audit-retention-enforce     → same antipattern, daily cadence
 *   4. litellm-pricing-sync        → stable-jobId HSETNX silent-drop
 * Each was migrated to the graphiti canonical pattern. This gate exists so a
 * fifth recurrence fails CI rather than landing.
 *
 * STRUCTURE (cinatra#304): the background-job handler table is now a name-keyed
 * REGISTRY in `src/lib/background-jobs-registry.ts`; the recurring
 * dup-guard → moveToDelayed → DelayedError sequence is factored into ONE shared
 * `runRecurringLoop` helper there; and the NAME constants + `*_LOOP_JOB_ID`
 * literals live in the leaf module `src/lib/background-jobs-names.ts`. The gate
 * reads all three files (instrumentation still owns the boot seeds).
 *
 * Invariants per boot-seeded loop (every `enqueueBackgroundJob(BACKGROUND_JOB_NAMES.X, ...)`
 * call in `src/instrumentation.node.ts`):
 *   - exported `<KEY>_LOOP_JOB_ID` constant in `background-jobs-names.ts`;
 *   - boot seed jobId references the constant (not a raw string literal);
 *   - boot seed sets overwriteIfStale: true, skipWorker: true,
 *     inheritActorContext: false;
 *   - the job-name string is in SYSTEM_JOBS in
 *     `packages/notifications/src/recipient-policy.ts`;
 *   - a registry entry `[BACKGROUND_JOB_NAMES.X]: { ... }` exists whose handler
 *     body WIRES the loop to its canonical id (references `<KEY>_LOOP_JOB_ID`,
 *     e.g. `loopJobId: <KEY>_LOOP_JOB_ID`);
 *   - the registry entry does NOT call
 *     `enqueueBackgroundJob(BACKGROUND_JOB_NAMES.<SAME>, ...)` (same-name
 *     enqueue ban — catches BOTH the anonymous and the stable-jobId
 *     antipatterns in one rule);
 *   - the shared `runRecurringLoop` helper (checked ONCE, globally) still
 *     contains the canonical sequence: the dup-guard
 *     `String(job.id ?? "") !== <loopJobId>`, a `job.moveToDelayed(` call, and
 *     `throw new DelayedError()`.
 *
 * Importable as a module (vitest tests live in `scripts/audit/__tests__/`); also
 * runnable as a CLI when invoked directly. Exit 0 on full pass; exit 1 with a
 * per-violation report otherwise; exit 2 on parse FATAL (file unreadable / shape
 * unexpected). Source paths overridable via env vars
 * `PERPETUAL_LOOPS_GATE_INSTRUMENTATION_FILE`,
 * `PERPETUAL_LOOPS_GATE_BACKGROUNDJOBS_FILE` (the names module),
 * `PERPETUAL_LOOPS_GATE_REGISTRY_FILE`,
 * `PERPETUAL_LOOPS_GATE_RECIPIENTPOLICY_FILE`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultFilePaths() {
  return {
    instrumentation:
      process.env.PERPETUAL_LOOPS_GATE_INSTRUMENTATION_FILE ||
      join(ROOT, "src/instrumentation.node.ts"),
    // The NAME constants + `*_LOOP_JOB_ID` literals live here (cinatra#304).
    // Kept under the historical `backgroundJobs` key so the env override and
    // the existing call sites stay stable.
    backgroundJobs:
      process.env.PERPETUAL_LOOPS_GATE_BACKGROUNDJOBS_FILE ||
      join(ROOT, "src/lib/background-jobs-names.ts"),
    // The name-keyed handler registry + the shared `runRecurringLoop` helper.
    registry:
      process.env.PERPETUAL_LOOPS_GATE_REGISTRY_FILE ||
      join(ROOT, "src/lib/background-jobs-registry.ts"),
    recipientPolicy:
      process.env.PERPETUAL_LOOPS_GATE_RECIPIENTPOLICY_FILE ||
      join(ROOT, "packages/notifications/src/recipient-policy.ts"),
  };
}

// ---------------------------------------------------------------------------
// parse helpers (each exported for direct unit testing)
// ---------------------------------------------------------------------------

export function parseSystemJobs(src) {
  const m = src.match(/const SYSTEM_JOBS = new Set<string>\(\[([\s\S]*?)\]\);/);
  if (!m) return null;
  return new Set(Array.from(m[1].matchAll(/"([^"]+)"/g), (mm) => mm[1]));
}

export function parseBackgroundJobNames(src) {
  // const BACKGROUND_JOB_NAMES = { KEY: "value", ... } as const | };
  const m = src.match(
    /BACKGROUND_JOB_NAMES\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?\s*;/,
  );
  if (!m) return null;
  const map = new Map();
  for (const e of m[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) {
    map.set(e[1], e[2]);
  }
  return map;
}

export function parseLoopIdConstants(src) {
  // export const <NAME>_LOOP_JOB_ID = "literal"; (whitespace-tolerant)
  const out = new Map();
  for (const e of src.matchAll(
    /export\s+const\s+(\w+_LOOP_JOB_ID)\s*=\s*"([^"]+)"\s*;/g,
  )) {
    out.set(e[1], e[2]);
  }
  return out;
}

export function parseBootSeeds(src) {
  // Find each enqueueBackgroundJob(BACKGROUND_JOB_NAMES.<NAME>, {data}, {options}, );
  // Strategy: locate the call header, then brace-walk to the 3rd argument's
  // object literal (the options block) and capture its inner text.
  const seeds = [];
  const callStartRe =
    /(?:await\s+)?enqueueBackgroundJob\s*\(\s*BACKGROUND_JOB_NAMES\.(\w+)\s*,/g;
  let m;
  while ((m = callStartRe.exec(src)) !== null) {
    const name = m[1];
    const line = src.slice(0, m.index).split("\n").length;
    let i = m.index + m[0].length;
    let depth = 0;
    // The header regex already consumed the first `,` (after BACKGROUND_JOB_NAMES.<NAME>),
    // so commaCount tracks top-level commas seen *from here forward*. The 3rd
    // arg's `{` opens when commaCount === 1 (one more comma seen — the one
    // separating the data `{}` from the options `{}`).
    let commaCount = 0;
    let optionsStart = -1;
    while (i < src.length && optionsStart === -1) {
      const ch = src[i];
      if (ch === "{") {
        depth++;
        if (depth === 1 && commaCount === 1) {
          optionsStart = i + 1;
          break;
        }
      } else if (ch === "}") {
        depth--;
      } else if (ch === "," && depth === 0) {
        commaCount++;
      }
      i++;
    }
    if (optionsStart === -1) {
      // Fail-closed: the call header matched but the 3rd-arg object literal
      // could not be located (unusual shape, partial source, exotic
      // formatting). Record a sentinel `options: null` entry so runGate
      // surfaces this as a violation instead of silently skipping the loop.
      seeds.push({ name, options: null, line });
      continue;
    }
    let optDepth = 1;
    let j = optionsStart;
    while (j < src.length && optDepth > 0) {
      const ch = src[j];
      if (ch === "{") optDepth++;
      else if (ch === "}") optDepth--;
      j++;
    }
    const options = src.slice(optionsStart, j - 1);
    seeds.push({ name, options, line });
  }
  return seeds;
}

/**
 * Find a name-keyed registry ENTRY `[BACKGROUND_JOB_NAMES.<KEY>]: {` and
 * brace-walk to its closing `}`. Replaces the old `case BACKGROUND_JOB_NAMES.X:`
 * switch-arm locator (cinatra#304 moved handlers from a switch into a registry
 * map). Kept under the name `parseHandlerCase` for call-site/test stability —
 * the *concept* (one handler body per job name) is unchanged.
 */
export function parseHandlerCase(src, jobNameKey) {
  // Match `[BACKGROUND_JOB_NAMES.<KEY>]: {` (registry entry) OR the legacy
  // `case BACKGROUND_JOB_NAMES.<KEY>: {` (switch arm) so the parser tolerates
  // either shape. The registry form is the current structure.
  const startRe = new RegExp(
    `(?:case\\s+)?\\[?\\s*BACKGROUND_JOB_NAMES\\.${jobNameKey}\\s*\\]?\\s*:\\s*\\{`,
  );
  const sm = startRe.exec(src);
  if (!sm) return null;
  const line = src.slice(0, sm.index).split("\n").length;
  let i = sm.index + sm[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const body = src.slice(sm.index + sm[0].length, i - 1);
  return { body, line };
}

/**
 * Locate the shared `runRecurringLoop` helper in the registry source and
 * return its body (brace-walked). Returns null if the helper is absent. The
 * canonical dup-guard + moveToDelayed + DelayedError sequence is asserted ONCE
 * against this body in runGate (cinatra#304 factored the 7 hand-rolled copies
 * into this single helper).
 */
export function parseSharedLoopHelper(src) {
  const startRe = /function\s+runRecurringLoop\s*\([\s\S]*?\)\s*(?::[^\{]*)?\{/;
  const sm = startRe.exec(src);
  if (!sm) return null;
  let i = sm.index + sm[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return { body: src.slice(sm.index + sm[0].length, i - 1) };
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/**
 * Run the gate against in-memory source strings.
 *
 * `sources` shape: { instrumentation, backgroundJobs (names module), registry,
 * recipientPolicy }. The legacy 3-key shape (no `registry`) is tolerated by
 * falling back to reading the registry-shaped invariants from `backgroundJobs`
 * — this lets a single combined fixture string exercise every rule.
 *
 * Returns { violations: string[], bootSeedNames: string[] }.
 * Throws on parse-fatal (missing SYSTEM_JOBS or BACKGROUND_JOB_NAMES blocks).
 */
export function runGate(sources) {
  const namesSrc = sources.backgroundJobs;
  // Tolerate a combined fixture: when no separate `registry` source is given,
  // the registry-shaped invariants are read from the same string.
  const registrySrc = sources.registry ?? sources.backgroundJobs;

  const systemJobs = parseSystemJobs(sources.recipientPolicy);
  const jobNames = parseBackgroundJobNames(namesSrc);
  const loopConsts = parseLoopIdConstants(namesSrc);
  const bootSeeds = parseBootSeeds(sources.instrumentation);
  const sharedHelper = parseSharedLoopHelper(registrySrc);

  if (!systemJobs) {
    throw new Error(
      "could not parse SYSTEM_JOBS in recipient-policy.ts (expected `const SYSTEM_JOBS = new Set<string>([ ... ]);`)",
    );
  }
  if (!jobNames) {
    throw new Error(
      "could not parse BACKGROUND_JOB_NAMES in background-jobs-names.ts (expected `BACKGROUND_JOB_NAMES = { ... } [as const];`)",
    );
  }

  const violations = [];

  // The shared recurring-loop helper carries the canonical sequence ONCE for
  // every loop. Assert it exists and is on-pattern before the per-loop checks
  // (a broken helper would silently break every loop at runtime).
  if (bootSeeds.length > 0) {
    if (!sharedHelper) {
      violations.push(
        "shared `runRecurringLoop` helper not found in background-jobs-registry.ts — the canonical dup-guard/moveToDelayed/DelayedError sequence must live in one shared helper",
      );
    } else {
      const hb = sharedHelper.body;
      const helperHasDupGuard = /String\(\s*job\.id\s*\?\?\s*""\s*\)\s*!==/.test(hb);
      const helperHasMoveToDelayed = /\bjob\.moveToDelayed\s*\(/.test(hb);
      const helperHasDelayedError = /throw\s+new\s+DelayedError\s*\(/.test(hb);
      if (!helperHasDupGuard) {
        violations.push(
          'shared `runRecurringLoop` helper missing the dup-guard `String(job.id ?? "") !== <loopJobId>`',
        );
      }
      if (!helperHasMoveToDelayed) {
        violations.push(
          "shared `runRecurringLoop` helper missing the `job.moveToDelayed(...)` call",
        );
      }
      if (!helperHasDelayedError) {
        violations.push(
          "shared `runRecurringLoop` helper missing `throw new DelayedError()`",
        );
      }
    }
  }

  for (const seed of bootSeeds) {
    const jobNameStr = jobNames.get(seed.name);
    if (!jobNameStr) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — BACKGROUND_JOB_NAMES.${seed.name} not found in background-jobs-names.ts`,
      );
      continue;
    }
    const constName = `${seed.name}_LOOP_JOB_ID`;
    const constLiteral = loopConsts.get(constName);

    if (seed.options === null) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — boot seed options block could not be parsed (unexpected call shape — fail-closed)`,
      );
      continue;
    }

    const opt = seed.options;
    const jobIdMatch = opt.match(/jobId\s*:\s*([^,\n}]+?)\s*[,\n}]/);
    const jobIdRaw = jobIdMatch ? jobIdMatch[1].trim() : null;
    const usesConstant = jobIdRaw === constName;
    const hasOverwriteIfStale = /overwriteIfStale\s*:\s*true/.test(opt);
    const hasSkipWorker = /skipWorker\s*:\s*true/.test(opt);
    const hasInheritActorContext = /inheritActorContext\s*:\s*false/.test(opt);

    if (!constLiteral) {
      violations.push(
        `${seed.name} — missing exported \`${constName}\` in background-jobs-names.ts`,
      );
    }
    if (!usesConstant) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — boot seed jobId must be the exported \`${constName}\` constant (got ${jobIdRaw ?? "<missing>"})`,
      );
    }
    if (!hasOverwriteIfStale) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — boot seed missing \`overwriteIfStale: true\``,
      );
    }
    if (!hasSkipWorker) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — boot seed missing \`skipWorker: true\``,
      );
    }
    if (!hasInheritActorContext) {
      violations.push(
        `${seed.name} (instrumentation.node.ts:${seed.line}) — boot seed missing \`inheritActorContext: false\``,
      );
    }
    if (!systemJobs.has(jobNameStr)) {
      violations.push(
        `${seed.name} — job name "${jobNameStr}" missing from SYSTEM_JOBS in recipient-policy.ts`,
      );
    }

    const handler = parseHandlerCase(registrySrc, seed.name);
    if (!handler) {
      violations.push(
        `${seed.name} — no \`[BACKGROUND_JOB_NAMES.${seed.name}]:\` registry entry found in background-jobs-registry.ts`,
      );
      continue;
    }
    const body = handler.body;
    // The registry entry must WIRE the loop to its canonical id by referencing
    // the `<KEY>_LOOP_JOB_ID` constant (typically `loopJobId: <KEY>_LOOP_JOB_ID`
    // passed to the shared helper). This is the per-loop binding the dup-guard
    // depends on; the dup-guard/moveToDelayed/DelayedError sequence itself is
    // asserted once on the shared helper above.
    const wiresLoopIdRe = new RegExp(`\\b${constName}\\b`);
    const hasLoopIdWiring = wiresLoopIdRe.test(body);
    const sameNameEnqueueRe = new RegExp(
      `enqueueBackgroundJob\\s*\\(\\s*BACKGROUND_JOB_NAMES\\.${seed.name}\\b`,
    );
    const hasSameNameEnqueue = sameNameEnqueueRe.test(body);

    if (!hasLoopIdWiring) {
      violations.push(
        `${seed.name} (background-jobs-registry.ts:${handler.line}) — registry entry must wire the loop to its canonical id by referencing \`${constName}\` (e.g. \`loopJobId: ${constName}\`)`,
      );
    }
    if (hasSameNameEnqueue) {
      violations.push(
        `${seed.name} (background-jobs-registry.ts:${handler.line}) — registry entry calls \`enqueueBackgroundJob(BACKGROUND_JOB_NAMES.${seed.name}, ...)\` (forbidden self-reschedule shape — use the shared runRecurringLoop helper instead)`,
      );
    }
  }

  return {
    violations,
    bootSeedNames: bootSeeds.map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// CLI entry (only when invoked directly, not when imported by tests)
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const paths = defaultFilePaths();
  let sources;
  try {
    sources = {
      instrumentation: readFileSync(paths.instrumentation, "utf8"),
      backgroundJobs: readFileSync(paths.backgroundJobs, "utf8"),
      registry: readFileSync(paths.registry, "utf8"),
      recipientPolicy: readFileSync(paths.recipientPolicy, "utf8"),
    };
  } catch (err) {
    console.error(
      `[perpetual-system-loops-gate] FATAL: could not read source: ${err.message}`,
    );
    process.exit(2);
  }

  let result;
  try {
    result = runGate(sources);
  } catch (err) {
    console.error(`[perpetual-system-loops-gate] FATAL: ${err.message}`);
    process.exit(2);
  }

  if (result.violations.length > 0) {
    console.error(
      `✗ perpetual-system-loops-gate: ${result.violations.length} violation(s) across ${result.bootSeedNames.length} boot-seeded loop(s):\n`,
    );
    for (const v of result.violations) console.error(`  - ${v}`);
    console.error(
      `\nSee AGENTS.md "BullMQ perpetual system loops" for the canonical pattern.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ perpetual-system-loops-gate: 0 violations across ${result.bootSeedNames.length} boot-seeded loop(s) (${result.bootSeedNames.join(", ")})`,
  );
}
