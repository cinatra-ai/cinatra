/**
 * Deep-link guard for the dev-only Environment "Connections" tab (cinatra#66).
 *
 * The Connections tab only renders in development mode (see
 * ../environment-tabs.ts), so a hardcoded link/push to the environment page
 * with the connections tab preselected mis-lands production users on the
 * Mode tab. The canonical, mode-independent destination for "configure
 * the connection service" CTAs is `/setup/connections` (the setup-wizard
 * step that works in both runtime modes).
 *
 * This guard fails loudly if anyone re-introduces the literal dev-only-tab
 * URL in host or workspace-package source (the page itself builds its
 * dev-mode redirectTo from CONNECTIONS_TAB_VALUE via a template literal, so
 * it does not match). `extensions/` is NOT scanned: the companion extension
 * repos are fixed in their own trees and clone back here.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

describe("dev-only Connections tab deep-link guard", () => {
  it("no host/package source hardcodes the dev-only ?tab=connections URL", () => {
    // Split so this guard file itself never matches.
    const LITERAL = "configuration/environment?tab=" + "connections";
    // Exit code 0 = matches found (bad). Exit code 1 = no matches (good).
    let offenders = "";
    try {
      offenders = execSync(
        `grep -RIl --exclude-dir=node_modules --include='*.ts' --include='*.tsx' -F '${LITERAL}' src packages`,
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 1) {
        offenders = "";
      } else {
        throw err;
      }
    }

    if (offenders) {
      throw new Error(
        "Found hardcoded links to the dev-only Environment Connections tab — " +
          "point connection-service CTAs at /setup/connections instead " +
          `(cinatra#66):\n${offenders}`,
      );
    }
    expect(offenders).toBe("");
  });
});
