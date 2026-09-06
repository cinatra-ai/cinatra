import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// THE ADOPTION IS WIRED, NOT MERELY AVAILABLE.
//
// The plan, §3.4 wave 3: "The CMS picture pair's broker minter — built today,
// with no caller — is wired here, so the pair loads inside a third-party
// application as well." And §6.7: "wave 3 is the displays' adoption of them, not
// their construction."
//
// An enabler with no caller is the exact state this wave exists to end, so the
// bar this file holds is a COUNTED one: each of the two minters must have a real
// caller in the product tree, and the island reader must reach both. A future
// edit that quietly un-wires either one fails here rather than at a blank panel
// inside somebody else's website.

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(abs, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (entry.includes(".test.")) continue;
      out.push(abs);
    }
  }
  return out;
}

const PRODUCT_FILES = walk(path.join(ROOT, "src"));

function callersOf(symbol: string): string[] {
  const needle = new RegExp(`\\b${symbol}\\s*\\(`);
  return PRODUCT_FILES.filter((abs) => {
    const src = readFileSync(abs, "utf8");
    if (!needle.test(src)) return false;
    // The module that DEFINES the symbol is not a caller of it.
    return !new RegExp(`export (async )?function ${symbol}\\b`).test(src);
  }).map((abs) => path.relative(ROOT, abs));
}

describe("wave 3 — the byte capability finally has a caller", () => {
  it("mints island byte capabilities from the product tree, not only from a test", () => {
    const callers = callersOf("mintReviewIslandByteCapability");
    expect(callers.length).toBeGreaterThan(0);
  });

  it("routes the island reader's media bytes through the minter this wave adds", () => {
    const prepare = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-target-prepare.ts"),
      "utf8",
    );
    expect(prepare).toContain("byteMinter");
    // The snapshot must carry a byte REFERENCE, not a second copy of the
    // session address: the field the new props version added.
    expect(prepare).toMatch(/bytes:\s*\{|bytes,/);
  });

  it("hands the island road down from the surface loader to the preparation ports", () => {
    const ports = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-gate-ports.ts"),
      "utf8",
    );
    expect(ports).toContain("roads");
    const island = readFileSync(
      path.join(ROOT, "src/app/lifecycle/review-island/page.tsx"),
      "utf8",
    );
    expect(island).toContain("islandReviewSurfaceRoads");
  });
});

describe("wave 3 — the CMS picture pair's broker minter is wired", () => {
  it("has a caller in the product tree", () => {
    const callers = callersOf("buildBrokerCapturePair");
    expect(callers.length).toBeGreaterThan(0);
  });

  it("is reached from the review surface loader, so the pair loads in a third-party app", () => {
    const roads = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-surface-roads.ts"),
      "utf8",
    );
    expect(roads).toContain("buildBrokerCapturePair");
  });
});

describe("wave 3 — the three browser fetchers are handed their content", () => {
  it("the review card's props builder reaches the content channel instead of naming it unwired", () => {
    const roads = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-surface-roads.ts"),
      "utf8",
    );
    expect(roads).toContain("buildArtifactContentProjection");
  });

  it("the content channel's own host ports exist and are the only reader of the pinned bytes", () => {
    const ports = readFileSync(
      path.join(ROOT, "src/lib/artifacts/artifact-content-channel-ports.ts"),
      "utf8",
    );
    expect(ports).toContain("readPinnedSubstance");
    // The port reads bytes ON THE SERVER and hands back a CAPPED string; it must
    // never hand back a buffer, which is how a byte would reach a snapshot.
    expect(ports).not.toMatch(/return\s*\{\s*class:\s*"text",\s*text:\s*buf\b/);
  });
});

describe("wave 3 — the island road never falls back to a cookie-only address", () => {
  it("the island page supplies a principal for the byte road it paints under", () => {
    const island = readFileSync(
      path.join(ROOT, "src/app/lifecycle/review-island/page.tsx"),
      "utf8",
    );
    expect(island).toContain("islandReviewSurfaceRoads");
  });

  it("the island credential resolver hands its caller the live principal it proved", () => {
    const serving = readFileSync(
      path.join(ROOT, "src/lib/lifecycle/review-island-serving.ts"),
      "utf8",
    );
    expect(serving).toMatch(/principal/);
  });
});
