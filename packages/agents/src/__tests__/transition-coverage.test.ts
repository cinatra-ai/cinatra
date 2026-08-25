/**
 * Static coverage check for run-status transition edges.
 *
 * Scans every .ts/.tsx file under packages/agent-builder/src/ (except
 * __tests__/ and store.ts itself), extracts every literal-argument call of
 * shape `transitionRunStatus(<any>, "FROM", "TO")`, and asserts every
 * extracted edge is present in `__LEGAL_TRANSITIONS__`.
 *
 * When there are no transitionRunStatus callers in production code, the
 * edges Set is empty and this test passes trivially. That's intentional:
 * the test is a safety net that activates as callers are introduced. Any
 * edge not in LEGAL_TRANSITIONS fails the test with a precise JSON diff
 * telling the dev exactly which edges to add.
 *
 * Dynamic-source callers (e.g. `transitionRunStatus(id, run.status as
 * AgentRunStatus, "stopped")`) cannot be resolved statically — the regex
 * deliberately matches only literal string arguments. Those sites are
 * covered instead by the exhaustive cancel/reject entries enumerated in
 * LEGAL_TRANSITIONS itself.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { __LEGAL_TRANSITIONS__ } from "../store";

/**
 * Recursively list all .ts/.tsx files under `dir`, skipping directories for
 * which `skip(absPath)` returns true.
 */
async function walkTsFiles(
  dir: string,
  skip: (absPath: string) => boolean,
  acc: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir)) {
    const abs = join(dir, entry);
    if (skip(abs)) continue;
    const st = await stat(abs);
    if (st.isDirectory()) {
      await walkTsFiles(abs, skip, acc);
    } else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
      acc.push(abs);
    }
  }
  return acc;
}

describe("transition-coverage", () => {
  it("every literal transitionRunStatus(from, to) call uses an edge in LEGAL_TRANSITIONS", async () => {
    // __dirname = packages/agent-builder/src/__tests__
    // srcDir    = packages/agent-builder/src
    const srcDir = join(__dirname, "..");
    const files = await walkTsFiles(
      srcDir,
      (p) => p.includes(`${"/"}__tests__${"/"}`) || p.endsWith(`${"/"}store.ts`),
    );

    // Match: transitionRunStatus(arg1, "FROM", "TO"[, ...])
    // Deliberately skips dynamic source-status calls (run.status as AgentRunStatus)
    // because those cannot be resolved statically — they are covered instead by
    // the exhaustive LEGAL_TRANSITIONS enumeration.
    const CALL_RE = /transitionRunStatus\s*\(\s*[^,]+,\s*["'`](\w+)["'`]\s*,\s*["'`](\w+)["'`]/g;

    const edges = new Set<string>();
    const perFileHits: Record<string, string[]> = {};
    for (const file of files) {
      const body = await readFile(file, "utf8");
      for (const match of body.matchAll(CALL_RE)) {
        const edge = `${match[1]}->${match[2]}`;
        edges.add(edge);
        (perFileHits[file] ??= []).push(edge);
      }
    }

    const missing = [...edges].filter((edge) => !__LEGAL_TRANSITIONS__.has(edge));

    // If the assertion fails, the diff below tells the executor EXACTLY which
    // edge needs to be added to LEGAL_TRANSITIONS in store.ts.
    expect(
      missing,
      `Edges used in code but missing from LEGAL_TRANSITIONS: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  // cinatra#1940 P1 (Decision 5): pending_trigger gains terminal outbound edges
  // (the bulk-stop conversion's extended status set is the concrete ->stopped
  // caller; ->failed is defensive parity with armed->failed).
  it("pending_trigger has both new terminal edges (->stopped, ->failed)", () => {
    expect(__LEGAL_TRANSITIONS__.has("pending_trigger->stopped")).toBe(true);
    expect(__LEGAL_TRANSITIONS__.has("pending_trigger->failed")).toBe(true);
  });

  it("pending_trigger's pre-existing lifecycle edges are unchanged (no inbound/semantics drift)", () => {
    for (const edge of [
      "pending_input->pending_trigger",
      "pending_trigger->pending_input",
      "pending_trigger->armed",
    ]) {
      expect(__LEGAL_TRANSITIONS__.has(edge)).toBe(true);
    }
    // pending_trigger is still never RUNNING — it is a waiting state, and the
    // dispatch below always goes through `queued` so the worker's own
    // queued->running CAS stays the single door into execution.
    expect(__LEGAL_TRANSITIONS__.has("pending_trigger->running")).toBe(false);
  });

  // cinatra#2523 (owner ruling 2026-08-09, remedy (c)). The setup -> trigger
  // hand-off gave `pending_trigger` its first PRODUCER (execution.ts ends a
  // finished setup there instead of running the agent before the user has
  // chosen when), and the trigger form's "Run right after setup" its first legal dispatch
  // edge. Until then `pending_trigger` was write-only in the table:
  // `pending_trigger->armed` had no reachable source state, and the immediate
  // branch faked a transition out of a terminal status and swallowed the
  // refusal.
  it("pending_trigger is both reachable from setup and dispatchable (cinatra#2523)", () => {
    expect(__LEGAL_TRANSITIONS__.has("queued->pending_trigger")).toBe(true);
    expect(__LEGAL_TRANSITIONS__.has("pending_trigger->queued")).toBe(true);
  });

  // The finality rule is untouched by that pair: no terminal status gains an
  // edge back into the lifecycle. This is the regression pin for the carve-out
  // cinatra#2523 removed rather than widened.
  it("no terminal status has ANY outbound edge except the documented failed->pending_input reset", () => {
    const terminalEdges = [...__LEGAL_TRANSITIONS__].filter((edge) =>
      ["completed", "failed", "stopped"].includes(edge.split("->")[0] as string),
    );
    expect(terminalEdges.sort()).toEqual(["failed->pending_input", "stopped->queued"]);
    for (const from of ["completed", "failed", "stopped"]) {
      expect(__LEGAL_TRANSITIONS__.has(`${from}->pending_trigger`)).toBe(false);
    }
    expect(__LEGAL_TRANSITIONS__.has("completed->queued")).toBe(false);
  });
});
