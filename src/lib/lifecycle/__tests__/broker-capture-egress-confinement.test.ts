import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// #2576 AC-2, as a STRUCTURAL negative: "no broker-surface path can reach
// /content bytes or renderer bundles".
//
// A behavioural test can only prove that the paths it thought to try are shut.
// These assertions are over the SOURCE of the routes themselves, so a future
// edit that opens a broker branch on a session byte route, or that teaches the
// a broker path to address a renderer bundle, fails here rather than shipping.
//
// The surfaces and what each must be:
//
//   /api/artifacts/…/content   — COOKIE SESSION ONLY. It streams arbitrary
//   /api/artifacts/…/preview     artifact bytes for whatever the actor may see,
//                                which is exactly the reach a broker principal
//                                must not have. Neither route may learn to
//                                accept a widget/broker credential.
//   (The capture egress, its serving ladder and its sealed capability left
//   with cinatra#3862 leg 8.)
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const CONTENT_ROUTE = "src/app/api/artifacts/[artifactId]/versions/[versionId]/content/route.ts";
const PREVIEW_ROUTE = "src/app/api/artifacts/[artifactId]/versions/[versionId]/preview/route.ts";

/** Every module that can turn a broker credential into a principal. A session
 * byte route importing ANY of these would be growing a broker branch. */
const BROKER_AUTH_MODULES = [
  "widget-user-auth",
  "widget-token-broker",
  "widget-stream-auth",
  "widget-capture-principal",
];

describe("broker-surface confinement (cinatra#2576 AC-2)", () => {
  it.each([
    ["content", CONTENT_ROUTE],
    ["preview", PREVIEW_ROUTE],
  ])("the %s byte route stays COOKIE-SESSION ONLY", (_label, rel) => {
    const src = source(rel);
    // It authenticates through the session, and only through the session.
    expect(src).toContain("getAuthSession");
    expect(src).toContain("requireActorContext");
    for (const brokerModule of BROKER_AUTH_MODULES) {
      expect(src).not.toContain(brokerModule);
    }
    // No bearer/authorization reading of any kind.
    expect(src).not.toMatch(/["']authorization["']/i);
    expect(src).not.toContain("X-Cinatra-Widget-User-Token");
    expect(src).not.toContain("cwu_");
  });

  it("BOTH session byte routes refuse cross-origin consumption (CORP hygiene)", () => {
    for (const rel of [CONTENT_ROUTE, PREVIEW_ROUTE]) {
      expect(source(rel)).toContain('"Cross-Origin-Resource-Policy": "same-origin"');
    }
  });

  it("the capture route and the broker minter's module are gone", () => {
    for (const rel of ["src/app/api/lifecycle-views/capture/route.ts", "src/lib/lifecycle/widget-capture-egress.ts"]) {
      expect(existsSync(path.join(ROOT, rel)), rel).toBe(false);
    }
  });
});
