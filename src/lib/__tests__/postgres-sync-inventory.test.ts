/**
 * Postgres sync-bridge inventory ratchet guard (#303).
 *
 * The synchronous Postgres bridge (`runPostgresQueriesSync`) is an exceptional
 * sync-leaf escape hatch, not the default request-time store path. This gate
 * keeps the machine-generated scan
 * (`docs/architecture/postgres-sync-inventory.json`) and the hand-authored
 * classification (`src/lib/postgres-sync-inventory.ts`) in lockstep, and — most
 * importantly — RATCHETS the number of direct sync call sites so a NEW direct
 * caller (in an existing file OR a brand-new file) cannot land without an
 * explicit, reviewed classification + baseline bump.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SYNC_CALLER_CLASSIFICATIONS } from "../postgres-sync-inventory";

const REPO_ROOT = resolve(__dirname, "../../..");
const INVENTORY_PATH = resolve(REPO_ROOT, "docs/architecture/postgres-sync-inventory.json");
const BUILDER = resolve(REPO_ROOT, "scripts/build-postgres-sync-inventory.mjs");

type Inventory = {
  generatedBy: string;
  totalCallSites: number;
  callers: { file: string; calls: number }[];
};

function loadInventory(): Inventory {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

describe("postgres sync-bridge inventory", () => {
  it("every scanned caller has a classification", () => {
    const inv = loadInventory();
    const missing = inv.callers
      .map((c) => c.file)
      .filter((f) => !SYNC_CALLER_CLASSIFICATIONS[f]);
    if (missing.length > 0) {
      throw new Error(
        `Missing classification for ${missing.length} sync-bridge caller(s) in ` +
          `src/lib/postgres-sync-inventory.ts:\n` +
          missing.map((f) => `  - ${f}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  it("every classification maps to a scanned caller (no stale entries)", () => {
    const inv = loadInventory();
    const scanned = new Set(inv.callers.map((c) => c.file));
    const stale = Object.keys(SYNC_CALLER_CLASSIFICATIONS).filter((f) => !scanned.has(f));
    if (stale.length > 0) {
      throw new Error(
        `Stale classification entries (no direct sync call site remains) in ` +
          `src/lib/postgres-sync-inventory.ts:\n` +
          stale.map((f) => `  - ${f}`).join("\n"),
      );
    }
    expect(stale).toEqual([]);
  });

  it("every classification has a non-empty justification", () => {
    const empty = Object.entries(SYNC_CALLER_CLASSIFICATIONS)
      .filter(([, c]) => !c.justification || c.justification.trim().length < 20)
      .map(([f]) => f);
    expect(empty).toEqual([]);
  });

  it("does NOT add new direct sync call sites in request-time stores (count never grows vs the committed baseline)", () => {
    // The COMMITTED JSON is the baseline. We scan the LIVE source tree fresh
    // (via `--print`, which never reads or writes the committed file) and assert
    // no file's direct-call count EXCEEDS its committed baseline, and no NEW
    // caller file appears. A new call site (in an existing OR brand-new file)
    // therefore fails this test until the committed baseline is consciously
    // re-generated AND the classification is updated — the intended friction for
    // keeping the bridge an exceptional escape hatch.
    //
    // NOTE: this compares LIVE-vs-COMMITTED, not committed-vs-itself, so the
    // ratchet has real teeth even when someone regenerates the JSON locally
    // (the committed baseline only moves with a reviewed commit).
    const committed = loadInventory();
    const baselineByFile = new Map(committed.callers.map((c) => [c.file, c.calls]));

    const liveJson = execFileSync(process.execPath, [BUILDER, "--print"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const live = JSON.parse(liveJson) as Inventory;

    const grew = live.callers
      .filter((c) => c.calls > (baselineByFile.get(c.file) ?? 0))
      .map((c) => `${c.file}: ${baselineByFile.get(c.file) ?? 0} -> ${c.calls}`);
    if (grew.length > 0) {
      throw new Error(
        "New direct runPostgresQueriesSync call site(s) beyond the committed baseline " +
          "(docs/architecture/postgres-sync-inventory.json):\n" +
          grew.map((g) => `  - ${g}`).join("\n") +
          "\nIf intentional, run `pnpm sync:inventory`, update the classification in " +
          "src/lib/postgres-sync-inventory.ts, and commit both.",
      );
    }
    expect(grew).toEqual([]);
  });

  it("the generated inventory is up to date with the source tree (--check)", () => {
    // Throws (non-zero exit) when stale; the thrown error surfaces the builder's
    // remediation message.
    const out = execFileSync(process.execPath, [BUILDER, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("up to date");
  });
});
