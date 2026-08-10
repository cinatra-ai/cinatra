import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// #2576 AC-2, as a STRUCTURAL negative: "no broker-surface path can reach
// /content bytes or renderer bundles".
//
// A behavioural test can only prove that the paths it thought to try are shut.
// These assertions are over the SOURCE of the routes themselves, so a future
// edit that opens a broker branch on a session byte route, or that teaches the
// capture egress to address a renderer bundle, fails here rather than shipping.
//
// The three surfaces and what each must be:
//
//   /api/artifacts/…/content   — COOKIE SESSION ONLY. It streams arbitrary
//   /api/artifacts/…/preview     artifact bytes for whatever the actor may see,
//                                which is exactly the reach a broker principal
//                                must not have. Neither route may learn to
//                                accept a widget/broker credential.
//   /api/artifact-renderer-assets — the digest-pinned JS bundle route. Nothing
//                                on the broker capture path may name it, and
//                                the capture route cannot serve JS at all (it
//                                admits one MIME).
//   /api/lifecycle-views/capture — the ONE broker-reachable byte path, confined
//                                to pinned capture PNGs by the gate binding.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/**
 * The module's CODE, with comments stripped.
 *
 * These files carry long prose headers that necessarily NAME the paths they
 * must not reach ("there is no reachable path from here to /content bytes"),
 * so a raw substring test would fail on the very sentence that states the
 * property. The assertions below are about what the code can construct.
 */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const CONTENT_ROUTE = "src/app/api/artifacts/[artifactId]/versions/[versionId]/content/route.ts";
const PREVIEW_ROUTE = "src/app/api/artifacts/[artifactId]/versions/[versionId]/preview/route.ts";
const CAPTURE_ROUTE = "src/app/api/lifecycle-views/capture/route.ts";
const EGRESS_MODULE = "src/lib/lifecycle/widget-capture-egress.ts";
const SERVING_MODULE = "src/lib/lifecycle/capture-capability-serving.ts";

/** Every module that can turn a broker credential into a principal. A session
 * byte route importing ANY of these would be growing a broker branch. */
const BROKER_AUTH_MODULES = [
  "widget-user-auth",
  "widget-token-broker",
  "widget-stream-auth",
  "capture-capability",
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

  it("nothing on the broker capture path names a renderer bundle or the session byte routes", () => {
    for (const rel of [CAPTURE_ROUTE, EGRESS_MODULE, SERVING_MODULE]) {
      const src = code(rel);
      expect(src, rel).not.toContain("artifact-renderer-assets");
      expect(src, rel).not.toContain("runtime-renderer-registry");
      expect(src, rel).not.toContain("renderer-asset-serving");
      // The one thing the capture route legitimately needs from the artifact
      // lane is the blob RESOLVER, reached only after the gate has vouched for
      // the capture. It never composes an artifact byte-route URL of any kind.
      expect(src, rel).not.toContain("/versions/");
      expect(src, rel).not.toContain("/content");
      expect(src, rel).not.toContain("/preview");
    }
  });

  it("the capture egress admits exactly ONE MIME, so a JS bundle can never egress", () => {
    const src = source(SERVING_MODULE);
    expect(src).toContain('CAPTURE_SERVE_MIME = "image/png"');
    // The comparison is an equality against that one constant — not a list, not
    // a prefix test, not a top-level-type check.
    expect(src).toContain("serve.mime !== CAPTURE_SERVE_MIME");
    expect(src).not.toContain("startsWith(\"image/\")");
  });

  it("the capture route reads NO identifier from the request except the sealed capability", () => {
    const src = code(CAPTURE_ROUTE);
    // One query parameter, and it is the capability. No path params at all —
    // the file lives at a static route segment, so there is no id in the URL
    // for a caller to vary.
    expect(src).toContain("url.searchParams.get(CAPTURE_CAPABILITY_QUERY_PARAM)");
    expect(src).not.toContain("params");
    expect(src.match(/searchParams\.get\(/g) ?? []).toHaveLength(1);
  });

  it("the capture route's answers carry a no-execution CSP on every path", () => {
    const src = code(CAPTURE_ROUTE);
    expect(src).toContain("default-src 'none'; sandbox");
    // ONE header object — declared once, spread into the refusal and into the
    // served response — so a header can never be present on one answer shape
    // and absent on the other.
    expect(src.match(/CAPTURE_RESPONSE_HEADERS/g) ?? []).toHaveLength(3);
  });
});
