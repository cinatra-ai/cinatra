/**
 * Postgres sync-bridge inventory drift gate (#303).
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

  it("does NOT add new direct sync call sites in request-time stores (count never grows)", () => {
    // The committed JSON is the baseline. The live source tree must not ADD a
    // direct `runPostgresQueriesSync(` call beyond the committed per-file count.
    // Adding one (to an existing file, or a brand-new file) requires re-running
    // `pnpm sync:inventory` AND a reviewed classification update — which is the
    // intended friction for keeping the bridge an exceptional escape hatch.
    const committed = loadInventory();
    const committedByFile = new Map(committed.callers.map((c) => [c.file, c.calls]));

    const liveJson = execFileSync(
      process.execPath,
      [BUILDER, "--check"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // `--check` exits non-zero (throws) if the committed file is stale, which
    // already covers count growth. The assertion below is a belt-and-suspenders
    // restatement against the parsed committed baseline.
    expect(liveJson).toContain("up to date");

    const grew = committed.callers.filter((c) => {
      const baseline = committedByFile.get(c.file) ?? 0;
      return c.calls > baseline;
    });
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
