/**
 * Deep-link guard for the RETIRED Environment "Connections" tab
 * (dev-only since cinatra#66, fully retired by cinatra#35).
 *
 * The Connections tab no longer renders in any mode (see
 * ../environment-tabs.ts) — a hardcoded link/push to the environment page
 * with the connections tab preselected lands users on the Mode-tab
 * fallback notice. The canonical, mode-independent destination for
 * "configure the connection service" CTAs is `/setup/secrets` (the
 * setup-wizard step that works in both runtime modes).
 *
 * This guard fails loudly if anyone re-introduces the literal retired-tab
 * URL in host or workspace-package source. `extensions/` is NOT scanned:
 * the companion extension repos are fixed in their own trees and clone
 * back here.
 */

import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

describe("retired Connections tab deep-link guard", () => {
  it("no host/package source hardcodes the retired ?tab=connections URL", () => {
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
        "Found hardcoded links to the retired Environment Connections tab — " +
          "point connection-service CTAs at /setup/secrets instead " +
          `(cinatra#66):\n${offenders}`,
      );
    }
    expect(offenders).toBe("");
  });

  it("no host/package source targets the RETIRED /setup/connections wizard path (cinatra#2502)", () => {
    // The step was renamed "Connections" → "Secrets" and its route moved with
    // the label. `next.config.ts` keeps a permanent 308 so bookmarks survive,
    // but that redirect is a compatibility floor, not a call site: a CTA that
    // rides it names the step by a word the wizard no longer shows and breaks
    // the day the redirect is retired.
    //
    // This guard exists because the rename MISSED one — the sdk-ui
    // "configure connection service" CTA lives under `packages/`, outside the
    // `src`-shaped sweep the rename was done with, and nothing caught it.
    // Matched as a STRING-LITERAL START — an opening quote of any of the three
    // kinds immediately followed by the path — so this scan finds routing
    // TARGETS (`router.push("…")`, `href='…'`, `` `…?tab=x` ``) rather than
    // prose: the redirect's own rationale is documented in comments on both
    // sides of the rename, and a bare-substring scan reports those as
    // offenders. Deliberately NOT anchored on a CLOSING quote, so a path
    // carrying a query string or hash is still caught. Split so this guard file
    // never matches itself, and extended past .ts/.tsx because a plain .js/.mjs
    // call site is just as much a call site.
    //
    // Run through execFileSync with an argv array rather than execSync with a
    // shell string: the pattern itself contains a single quote, which no amount
    // of shell quoting survives cleanly.
    const PATTERN = "[\"'`]/setup/" + "connections";
    let offenders = "";
    try {
      offenders = execFileSync(
        "grep",
        [
          "-RIlE",
          "--exclude-dir=node_modules",
          "--include=*.ts",
          "--include=*.tsx",
          "--include=*.js",
          "--include=*.jsx",
          "--include=*.mjs",
          "--include=*.cjs",
          PATTERN,
          "src",
          "packages",
        ],
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
    // The redirect's own declaration is the one legitimate mention, and it
    // lives in next.config.ts, which this scan does not cover.
    if (offenders) {
      throw new Error(
        "Found source routing at the RETIRED wizard path — the step is " +
          "Secrets, at /setup/secrets (cinatra#2502):\n" +
          offenders,
      );
    }
    expect(offenders).toBe("");
  });
});
