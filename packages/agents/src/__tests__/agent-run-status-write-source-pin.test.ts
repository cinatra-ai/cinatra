/**
 * cinatra#1940 P1 (Decision 4) — source pin: no THIRD status-write commit.
 *
 * The bulk-stop bypass (a direct, unguarded `db.update(agentRuns).set({status})`
 * outside the kernel guard, CAS, and legality table) is killed. This lockstep
 * scan (same static-scan style as the write-registry writeSites ratchet) asserts
 * that every INLINE `agentRuns` status `.set({...status...})` in packages/agents
 * lives ONLY in the sanctioned, org-write-GUARDED and REGISTERED transition
 * modules — so a new unguarded status writer (the exact bulkStop mistake) fails
 * CI the moment it is introduced.
 *
 * Allowlisted (each writes status inside `guardedRunWrite` and has a
 * write-registry row):
 *   - run-transition.ts               — the canonical CAS + delegated meta writer
 *   - run-terminal-derivation-outbox.ts — the terminal-success outbox delegate
 *   - resume-run-from-setup-approval.ts — the HITL setup-resume CAS (#1939 wave-2 §7.1)
 *
 * NOTE the design text named only run-transition.ts; resume-run-from-setup-approval.ts
 * is a pre-existing guarded/registered inline status CAS (verified against the
 * write-registry), so it is allowlisted here — the invariant the pin enforces is
 * "no UNGUARDED status bypass", which the bulk-stop conversion restores.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(__dirname, "..");

// Guarded + registered transition-machinery modules permitted to write status.
const ALLOWLIST = new Set<string>([
  "run-transition.ts",
  "run-terminal-derivation-outbox.ts",
  "resume-run-from-setup-approval.ts",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

/** Strip block comments so a comment mentioning the killed pattern (e.g. the
 *  bulkStop doc) can never trip the scan. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Files containing an INLINE `agentRuns` status write: an `.update(agentRuns)`
 * whose chained `.set({...})` (everything up to the terminating `.where(`)
 * assigns the `status` column. Robust to nested object literals (a ternary
 * `{ ... } : {}` before `status:`) that a naive `[^}]*` would miss.
 */
function filesWithInlineAgentRunsStatusSet(): Set<string> {
  const hits = new Set<string>();
  for (const file of walk(SRC_DIR)) {
    const src = stripBlockComments(readFileSync(file, "utf-8"));
    const UPDATE = /\.update\(\s*agentRuns\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = UPDATE.exec(src)) !== null) {
      const start = m.index + m[0].length;
      const whereIdx = src.indexOf(".where(", start);
      const end = whereIdx === -1 ? Math.min(src.length, start + 600) : Math.min(whereIdx, start + 600);
      const slice = src.slice(start, end);
      // The set-chain between `.update(agentRuns)` and `.where(` assigns status.
      if (slice.includes(".set(") && /\bstatus\b\s*[:,]/.test(slice)) {
        hits.add(file.slice(SRC_DIR.length + 1));
      }
    }
  }
  return hits;
}

describe("agent-run status-write source pin (#1940 P1 Decision 4)", () => {
  const matched = filesWithInlineAgentRunsStatusSet();

  it("every inline agentRuns status write lives in a guarded/registered transition module", () => {
    const offenders = [...matched].filter((f) => !ALLOWLIST.has(f));
    expect(
      offenders,
      `Unguarded agentRuns status write(s) outside the transition machinery: ${JSON.stringify(
        offenders,
      )} — route status changes through transitionRunStatus (cinatra#1940 P1).`,
    ).toEqual([]);
  });

  it("is non-vacuous: the canonical CAS writer IS detected", () => {
    expect(matched.has("run-transition.ts")).toBe(true);
  });

  it("the killed bulkStop bypass is gone: store.ts no longer writes status inline", () => {
    expect(matched.has("store.ts")).toBe(false);
  });
});
