/**
 * One-shot removal guard for `src/lib/toast.ts`.
 *
 * The legacy `@/lib/toast` wrapper was deleted after all importers migrated
 * to `@/lib/cinatra-toast`. This test fails loudly if anyone re-introduces
 * an import from the old path — guarding against accidental reinstatement via
 * copy-paste, a stale snippet, or a merge that brings the legacy file back.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LEGACY_PATH = path.join(REPO_ROOT, "src/lib/toast.ts");

describe("legacy toast.ts removal guard", () => {
  it("src/lib/toast.ts is deleted", () => {
    expect(existsSync(LEGACY_PATH)).toBe(false);
  });

  it("no source file imports from the legacy toast path", () => {
    // Look for the legacy module path. The pattern is intentionally split so
    // this file itself does NOT match (otherwise the guard would always fail).
    const LEGACY = `from "@/lib/` + `toast"`;
    // Exit code 0 = matches found (bad). Exit code 1 = no matches (good).
    let offenders = "";
    try {
      offenders = execSync(
        `grep -RIl --include='*.ts' --include='*.tsx' '${LEGACY}' src packages extensions`,
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
    } catch (err: unknown) {
      // grep exit 1 = no match — that's the success case.
      const e = err as { status?: number; stderr?: Buffer | string };
      if (e.status === 1) {
        offenders = "";
      } else {
        throw err;
      }
    }

    if (offenders) {
      throw new Error(
        `Found imports from the deleted '@/lib/toast' module — migrate to '@/lib/cinatra-toast':\n${offenders}`,
      );
    }
    expect(offenders).toBe("");
  });
});
