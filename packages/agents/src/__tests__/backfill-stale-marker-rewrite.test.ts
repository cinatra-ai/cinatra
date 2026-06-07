/**
 * Hermetic contract for `backfillPublishedMarkers` stale-marker rewrite
 * behavior + in-progress draft guard.
 *
 * Background: `.cinatra-published.json` markers are gated on `oasSha256`.
 * A missing-marker-only backfill leaves existing markers stale when a source
 * `oas.json` is hand-edited or updated outside the marker writer. In that
 * state, the wayflow loader silently refuses to mount the agent
 * (`hash_mismatch`), forcing operators to remove the marker manually.
 *
 * Backfill also rewrites stale / malformed markers without compromising the
 * in-progress draft contract (`.cinatra-in-progress.json`) that the
 * chat-authoring path relies on.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/backfill-stale-marker-rewrite.test.ts
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { backfillPublishedMarkers } from "../materialize-agent-package";

const PUBLISHED = ".cinatra-published.json";
const IN_PROGRESS = ".cinatra-in-progress.json";

/** Seed an agent dir at <root>/<vendor>/<slug>/cinatra/oas.json with given OAS body. */
function seedAgent(
  root: string,
  vendor: string,
  slug: string,
  oasBody: Record<string, unknown>,
  extras?: { packageJsonVersion?: string },
): { slugDir: string; oasPath: string; oasSha256: string } {
  const slugDir = path.join(root, vendor, slug);
  mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
  const oasPath = path.join(slugDir, "cinatra", "oas.json");
  const oasText = JSON.stringify(oasBody, null, 2);
  writeFileSync(oasPath, oasText, "utf-8");
  if (extras?.packageJsonVersion) {
    writeFileSync(
      path.join(slugDir, "package.json"),
      JSON.stringify(
        { name: `@${vendor}/${slug}`, version: extras.packageJsonVersion },
        null,
        2,
      ),
      "utf-8",
    );
  }
  const oasSha256 = createHash("sha256").update(oasText).digest("hex");
  return { slugDir, oasPath, oasSha256 };
}

function writeMarker(slugDir: string, marker: unknown): void {
  writeFileSync(
    path.join(slugDir, PUBLISHED),
    typeof marker === "string" ? marker : JSON.stringify(marker, null, 2),
    "utf-8",
  );
}

function readMarker(slugDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(slugDir, PUBLISHED), "utf-8"));
}

function sampleOas(packageName: string, packageVersion: string): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: `${packageName.replace(/[@/]/g, "-")}-flow`,
    name: packageName,
    description: "test agent",
    metadata: { cinatra: { type: "flow", packageName, packageVersion } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "s" },
    nodes: [{ $component_ref: "s" }, { $component_ref: "e" }],
    control_flow_connections: [],
    $referenced_components: {
      s: { component_type: "StartNode", id: "s" },
      e: { component_type: "EndNode", id: "e" },
    },
  };
}

describe("backfillPublishedMarkers stale-marker rewrite", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(path.join(os.tmpdir(), "backfill-stale-marker-"));
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // BackfillResult shape — new `rewritten` counter.
  // -------------------------------------------------------------------------

  it("BackfillResult exposes a `rewritten` numeric counter alongside `written` / `skipped`", async () => {
    const result = await backfillPublishedMarkers(agentsRoot);
    expect(result).toMatchObject({
      scanned: 0,
      written: 0,
      rewritten: 0,
      skipped: 0,
      errors: [],
    });
  });

  // -------------------------------------------------------------------------
  // SKIP path: marker present + sha matches → no write.
  // -------------------------------------------------------------------------

  it("marker present + sha matches → skipped, marker untouched, rewritten=0", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "fresh-agent",
      sampleOas("@cinatra/fresh-agent", "0.1.0"),
    );
    const original = {
      packageName: "@cinatra/fresh-agent",
      packageVersion: "0.1.0",
      oasSha256,
      publishedAt: "2026-05-01T00:00:00.000Z",
    };
    writeMarker(slugDir, original);

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.rewritten).toBe(0);
    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    // Byte-for-byte preservation (no atomic-rename even when sha matches).
    expect(readMarker(slugDir)).toEqual(original);
  });

  // -------------------------------------------------------------------------
  // REWRITE path: stale sha → rewritten with fresh hash.
  // -------------------------------------------------------------------------

  it("marker present + sha mismatches oas.json → rewritten with new hash, rewritten=1, written=0", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "stale-agent",
      sampleOas("@cinatra/stale-agent", "0.1.1"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/stale-agent",
      packageVersion: "0.1.0",
      // Deliberately wrong hash (the old hash before someone hand-edited oas.json).
      oasSha256: "0".repeat(64),
      publishedAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.scanned).toBe(1);
    expect(result.rewritten).toBe(1);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    const refreshed = readMarker(slugDir);
    expect(refreshed.oasSha256).toBe(oasSha256);
    // Refreshed marker also picks up the new packageVersion via cascade.
    expect(refreshed.packageVersion).toBe("0.1.1");
    // packageName preserved from oas metadata.
    expect(refreshed.packageName).toBe("@cinatra/stale-agent");
  });

  // -------------------------------------------------------------------------
  // REWRITE path: malformed JSON / missing required fields.
  // -------------------------------------------------------------------------

  it("marker present but malformed JSON → treated as broken, rewritten", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "junk-marker",
      sampleOas("@cinatra/junk-marker", "0.2.0"),
    );
    writeMarker(slugDir, "{ this is not valid json");

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(readMarker(slugDir).oasSha256).toBe(oasSha256);
  });

  it("marker present but missing oasSha256 field → rewritten", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "schemaless",
      sampleOas("@cinatra/schemaless", "0.3.0"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/schemaless",
      packageVersion: "0.3.0",
      // oasSha256 omitted entirely
      publishedAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect(result.skipped).toBe(0);
    expect(readMarker(slugDir).oasSha256).toBe(oasSha256);
  });

  it("marker present + matching oasSha256 BUT missing publishedAt → rewritten (TS/Python schema parity)", async () => {
    // A marker that has the right sha but omits any of the 4 required keys
    // must not be classified `valid` by the TS side while the Python loader
    // treats it as `malformed` at runtime
    // (docker/wayflow/agent_loader.py:_check_marker_for), leaving the agent
    // gated. Aligning the TS `_readPublishedMarker` required-key set with the
    // loader's gate repairs that validation mismatch on the next boot.
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "schema-parity",
      sampleOas("@cinatra/schema-parity", "0.7.0"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/schema-parity",
      packageVersion: "0.7.0",
      oasSha256, // matches!
      // publishedAt omitted — Python loader will gate this as malformed.
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.written).toBe(0);
    const refreshed = readMarker(slugDir);
    expect(refreshed.publishedAt).toBeTypeOf("string");
    expect((refreshed.publishedAt as string).length).toBeGreaterThan(0);
    expect(refreshed.oasSha256).toBe(oasSha256);
  });

  it("marker present + matching oasSha256 BUT missing packageName → rewritten (TS/Python schema parity)", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "no-pkg-name",
      sampleOas("@cinatra/no-pkg-name", "0.8.0"),
    );
    writeMarker(slugDir, {
      // packageName omitted
      packageVersion: "0.8.0",
      oasSha256,
      publishedAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect(result.skipped).toBe(0);
    expect(readMarker(slugDir).packageName).toBe("@cinatra/no-pkg-name");
  });

  it("marker present + matching oasSha256 BUT empty-string packageVersion → rewritten (TS strictness)", async () => {
    // Edge case: present-but-empty-string. This is TS-only strictness — the
    // Python loader's required-key gate
    // (agent_loader.py:1821) accepts an empty `packageVersion`
    // because it only `isinstance`-checks the four keys, not their
    // lengths (except `oasSha256` later). TS rewrites it anyway to
    // upgrade the marker to canonical shape; the rewrite is
    // host-side only so Python's relaxed check isn't impacted.
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "empty-version",
      sampleOas("@cinatra/empty-version", "0.9.0"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/empty-version",
      packageVersion: "",
      oasSha256,
      publishedAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect((readMarker(slugDir).packageVersion as string).length).toBeGreaterThan(0);
  });

  it("marker present but oasSha256 is a non-string value → rewritten", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "wrong-type",
      sampleOas("@cinatra/wrong-type", "0.4.0"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/wrong-type",
      packageVersion: "0.4.0",
      oasSha256: 12345, // not a string
      publishedAt: "2026-05-01T00:00:00.000Z",
    });

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.rewritten).toBe(1);
    expect(readMarker(slugDir).oasSha256).toBe(oasSha256);
  });

  // -------------------------------------------------------------------------
  // WRITE path: marker missing → existing behavior preserved.
  // -------------------------------------------------------------------------

  it("marker missing → written, rewritten=0", async () => {
    const { slugDir, oasSha256 } = seedAgent(
      agentsRoot,
      "cinatra",
      "new-agent",
      sampleOas("@cinatra/new-agent", "0.5.0"),
    );

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.written).toBe(1);
    expect(result.rewritten).toBe(0);
    expect(readMarker(slugDir).oasSha256).toBe(oasSha256);
  });

  // -------------------------------------------------------------------------
  // IN-PROGRESS DRAFT GUARD.
  // -------------------------------------------------------------------------

  it("in-progress marker + stale published marker → SKIPPED, published marker untouched (no draft promotion)", async () => {
    const { slugDir } = seedAgent(
      agentsRoot,
      "cinatra",
      "draft-agent",
      sampleOas("@cinatra/draft-agent", "0.6.0"),
    );
    const staleMarker = {
      packageName: "@cinatra/draft-agent",
      packageVersion: "0.5.0",
      oasSha256: "1".repeat(64), // stale
      publishedAt: "2026-04-01T00:00:00.000Z",
    };
    writeMarker(slugDir, staleMarker);
    // Operator (or chat-authoring) wrote an in-progress marker → the
    // hash mismatch is intentional. Backfill must NOT touch this.
    writeFileSync(
      path.join(slugDir, IN_PROGRESS),
      JSON.stringify({ packageSlug: "draft-agent", lastEditAt: "2026-05-13T16:00:00.000Z" }, null, 2),
      "utf-8",
    );

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.skipped).toBe(1);
    expect(result.rewritten).toBe(0);
    expect(result.written).toBe(0);
    // Published marker must remain BYTE-IDENTICAL to its stale-state
    // pre-image — confirming the in-progress guard prevented the draft
    // promotion.
    expect(readMarker(slugDir)).toEqual(staleMarker);
  });

  it("in-progress marker + missing published marker → SKIPPED, no marker created", async () => {
    const { slugDir } = seedAgent(
      agentsRoot,
      "cinatra",
      "fresh-draft",
      sampleOas("@cinatra/fresh-draft", "0.0.1"),
    );
    writeFileSync(
      path.join(slugDir, IN_PROGRESS),
      JSON.stringify({ packageSlug: "fresh-draft" }, null, 2),
      "utf-8",
    );

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(result.rewritten).toBe(0);
    expect(existsSync(path.join(slugDir, PUBLISHED))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ERROR path: unparseable oas.json with existing marker → marker preserved.
  // -------------------------------------------------------------------------

  it("oas.json fails to parse + existing marker → error, marker preserved (don't blow away historical record)", async () => {
    const slugDir = path.join(agentsRoot, "cinatra", "junk-oas");
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), "{ bad json", "utf-8");
    const preservedMarker = {
      packageName: "@cinatra/junk-oas",
      packageVersion: "0.1.0",
      oasSha256: "a".repeat(64),
      publishedAt: "2026-04-01T00:00:00.000Z",
    };
    writeMarker(slugDir, preservedMarker);

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].reason).toContain("oas.json parse failed");
    expect(result.rewritten).toBe(0);
    expect(result.written).toBe(0);
    // Pre-existing marker must remain untouched.
    expect(readMarker(slugDir)).toEqual(preservedMarker);
  });

  // -------------------------------------------------------------------------
  // MULTI-AGENT mix: ensure counts add up across fresh + stale + matching + in-progress.
  // -------------------------------------------------------------------------

  it("mixed scenario across 4 slugs → counts sum correctly (1 written, 1 rewritten, 1 skipped, 1 in-progress-skipped)", async () => {
    // fresh (missing marker)
    seedAgent(agentsRoot, "cinatra", "fresh-mix", sampleOas("@cinatra/fresh-mix", "0.1.0"));

    // stale (mismatched sha)
    const stale = seedAgent(
      agentsRoot,
      "cinatra",
      "stale-mix",
      sampleOas("@cinatra/stale-mix", "0.2.0"),
    );
    writeMarker(stale.slugDir, {
      packageName: "@cinatra/stale-mix",
      packageVersion: "0.1.0",
      oasSha256: "0".repeat(64),
      publishedAt: "2026-04-01T00:00:00.000Z",
    });

    // unchanged (matching sha)
    const ok = seedAgent(
      agentsRoot,
      "cinatra",
      "ok-mix",
      sampleOas("@cinatra/ok-mix", "0.3.0"),
    );
    writeMarker(ok.slugDir, {
      packageName: "@cinatra/ok-mix",
      packageVersion: "0.3.0",
      oasSha256: ok.oasSha256,
      publishedAt: "2026-04-15T00:00:00.000Z",
    });

    // in-progress draft (stale sha, but protected)
    const draft = seedAgent(
      agentsRoot,
      "cinatra",
      "draft-mix",
      sampleOas("@cinatra/draft-mix", "0.4.0"),
    );
    writeMarker(draft.slugDir, {
      packageName: "@cinatra/draft-mix",
      packageVersion: "0.3.0",
      oasSha256: "0".repeat(64),
      publishedAt: "2026-04-01T00:00:00.000Z",
    });
    writeFileSync(
      path.join(draft.slugDir, IN_PROGRESS),
      JSON.stringify({ packageSlug: "draft-mix" }, null, 2),
      "utf-8",
    );

    const result = await backfillPublishedMarkers(agentsRoot);

    expect(result.scanned).toBe(4);
    expect(result.written).toBe(1); // fresh-mix
    expect(result.rewritten).toBe(1); // stale-mix
    expect(result.skipped).toBe(2); // ok-mix + draft-mix
    expect(result.errors).toEqual([]);
    // draft-mix marker still stale-sha because the in-progress guard fired.
    expect((readMarker(draft.slugDir).oasSha256 as string)).toBe("0".repeat(64));
  });

  // -------------------------------------------------------------------------
  // ATOMIC WRITE: temp file is cleaned up; no stray `.tmp-*` files left around.
  // -------------------------------------------------------------------------

  it("rewrite path leaves no stray .tmp-* sibling files in the slug dir", async () => {
    const { slugDir } = seedAgent(
      agentsRoot,
      "cinatra",
      "atomic-rewrite",
      sampleOas("@cinatra/atomic-rewrite", "0.1.0"),
    );
    writeMarker(slugDir, {
      packageName: "@cinatra/atomic-rewrite",
      packageVersion: "0.0.9",
      oasSha256: "0".repeat(64),
      publishedAt: "2026-04-01T00:00:00.000Z",
    });

    await backfillPublishedMarkers(agentsRoot);

    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(slugDir),
    );
    const strays = entries.filter((name) =>
      name.startsWith(`${PUBLISHED}.tmp-`),
    );
    expect(strays).toEqual([]);
  });
});
