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
});
