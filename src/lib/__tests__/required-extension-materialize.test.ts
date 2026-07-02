// Unit tests for the required-extension OAS materializer (cinatra-ai/ops#436).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REQUIRED_OAS_SEED_DIR,
  materializeRequiredExtensions,
} from "@/lib/required-extension-materialize";

const SEED_MARKER_FILENAME = ".cinatra-required-seed.json";
const SEED_MANIFEST_FILENAME = "manifest.json";

let root: string;
let seedDir: string;
let installDir: string;

function writeSeedSlug(vendor: string, slug: string, oas: object) {
  const slugDir = path.join(seedDir, vendor, slug);
  mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
  writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify(oas) + "\n");
  writeFileSync(path.join(slugDir, "package.json"), JSON.stringify({ name: `@${vendor}/${slug}`, version: "1.0.0" }) + "\n");
  writeFileSync(
    path.join(slugDir, SEED_MARKER_FILENAME),
    JSON.stringify({ vendor, slug, kind: "required-oas-seed" }) + "\n",
  );
}

function writeManifest(slugs: Array<{ vendor: string; slug: string }>) {
  writeFileSync(
    path.join(seedDir, SEED_MANIFEST_FILENAME),
    JSON.stringify({ kind: "required-oas-seed-manifest", slugs }) + "\n",
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ops436-"));
  seedDir = path.join(root, "seed");
  installDir = path.join(root, "install");
  mkdirSync(seedDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("materializeRequiredExtensions", () => {
  it("materializes required agent OAS trees from the seed into an empty install dir", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { title: "planner" } });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);

    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    expect(result.materialized).toEqual(["cinatra-ai/planner-agent"]);
    expect(result.changed).toBe(true);
    const liveOas = path.join(installDir, "cinatra-ai", "planner-agent", "cinatra", "oas.json");
    expect(existsSync(liveOas)).toBe(true);
    expect(JSON.parse(readFileSync(liveOas, "utf8")).info.title).toBe("planner");
    // package.json + ownership marker rode along.
    expect(existsSync(path.join(installDir, "cinatra-ai", "planner-agent", "package.json"))).toBe(true);
    expect(existsSync(path.join(installDir, "cinatra-ai", "planner-agent", SEED_MARKER_FILENAME))).toBe(true);
  });

  it("is idempotent: an unchanged OAS is left untouched (no churn)", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0" });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    const second = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(second.materialized).toEqual([]);
    expect(second.unchanged).toEqual(["cinatra-ai/planner-agent"]);
    expect(second.changed).toBe(false);
  });

  it("refreshes a slug whose OAS bytes changed (deploy tag bump)", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { version: "old" } });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    // New tag ships new OAS bytes.
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { version: "new" } });
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    expect(result.materialized).toEqual(["cinatra-ai/planner-agent"]);
    const liveOas = path.join(installDir, "cinatra-ai", "planner-agent", "cinatra", "oas.json");
    expect(JSON.parse(readFileSync(liveOas, "utf8")).info.version).toBe("new");
  });

  it("prunes a seed-owned slug dropped from the new seed", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0" });
    writeSeedSlug("cinatra-ai", "media-transcript-agent", { openapi: "3.1.0" });
    writeManifest([
      { vendor: "cinatra-ai", slug: "planner-agent" },
      { vendor: "cinatra-ai", slug: "media-transcript-agent" },
    ]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(existsSync(path.join(installDir, "cinatra-ai", "media-transcript-agent"))).toBe(true);

    // New tag drops media-transcript-agent from the required set.
    rmSync(path.join(seedDir, "cinatra-ai", "media-transcript-agent"), { recursive: true, force: true });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    expect(result.pruned).toEqual(["cinatra-ai/media-transcript-agent"]);
    expect(existsSync(path.join(installDir, "cinatra-ai", "media-transcript-agent"))).toBe(false);
    expect(existsSync(path.join(installDir, "cinatra-ai", "planner-agent"))).toBe(true);
  });

  it("does NOT mistake a real slug containing '.tmp-' for a staging leftover (prefix-collision guard)", () => {
    // A pathological-but-valid required slug whose name contains the old
    // collision substring must round-trip materialize → idempotent, never swept.
    writeSeedSlug("cinatra-ai", "weird.tmp-agent", { openapi: "3.1.0" });
    writeManifest([{ vendor: "cinatra-ai", slug: "weird.tmp-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(existsSync(path.join(installDir, "cinatra-ai", "weird.tmp-agent", "cinatra", "oas.json"))).toBe(true);
    const second = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(second.unchanged).toEqual(["cinatra-ai/weird.tmp-agent"]);
    expect(existsSync(path.join(installDir, "cinatra-ai", "weird.tmp-agent"))).toBe(true);
  });

  it("NEVER prunes a coexisting non-seed-owned (user/operator) dir", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0" });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    // A user-installed agent dir WITHOUT the ownership marker.
    const userSlug = path.join(installDir, "acme", "user-agent");
    mkdirSync(path.join(userSlug, "cinatra"), { recursive: true });
    writeFileSync(path.join(userSlug, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }));

    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(result.pruned).toEqual([]);
    expect(existsSync(userSlug)).toBe(true);
  });

  it("fails closed in prod when the seed manifest is missing", () => {
    // seedDir exists but has no manifest.
    expect(() =>
      materializeRequiredExtensions({ installDir, seedDir, failClosed: true }),
    ).toThrow(/seed missing or unreadable/);
  });

  it("is a benign no-op (non-prod) when the seed manifest is missing", () => {
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: false });
    expect(result.changed).toBe(false);
    expect(result.note).toMatch(/seed absent/);
  });

  it("refuses to materialize into the durable user-install store", () => {
    writeManifest([]);
    expect(() =>
      materializeRequiredExtensions({
        installDir: "/data/extensions/packages",
        seedDir,
        failClosed: true,
      }),
    ).toThrow(/user-install store/);
    expect(() =>
      materializeRequiredExtensions({
        installDir: "/data/extensions/packages/sub",
        seedDir,
        failClosed: true,
      }),
    ).toThrow(/user-install store/);
  });

  it("an empty (zero-slug) seed manifest is a valid no-op, not a failure", () => {
    writeManifest([]);
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(result.materialized).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("exports a default seed dir matching the Dockerfile COPY destination", () => {
    expect(DEFAULT_REQUIRED_OAS_SEED_DIR).toBe("/app/.cinatra-required-oas-seed");
  });

  it("stays idempotent after a runtime .cinatra-published.json marker is written (no re-materialize churn)", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0" });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    // The agent-marker-backfill writes this runtime marker into the LIVE dir
    // (it is NOT part of the seed surface).
    writeFileSync(
      path.join(installDir, "cinatra-ai", "planner-agent", ".cinatra-published.json"),
      JSON.stringify({ packageName: "@cinatra-ai/planner-agent", oasSha256: "deadbeef" }) + "\n",
    );

    const second = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(second.materialized).toEqual([]);
    expect(second.unchanged).toEqual(["cinatra-ai/planner-agent"]);
    expect(second.changed).toBe(false);
    // The runtime marker survived (we never touched the unchanged dir).
    expect(
      existsSync(path.join(installDir, "cinatra-ai", "planner-agent", ".cinatra-published.json")),
    ).toBe(true);
  });

  it("re-materializes when the new seed REMOVES a file (stale live-only file is dropped)", () => {
    const slugDir = path.join(seedDir, "cinatra-ai", "planner-agent");
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }) + "\n");
    mkdirSync(path.join(slugDir, "skills"), { recursive: true });
    writeFileSync(path.join(slugDir, "skills", "foo.md"), "# foo\n");
    writeFileSync(path.join(slugDir, SEED_MARKER_FILENAME), JSON.stringify({ vendor: "cinatra-ai", slug: "planner-agent" }) + "\n");
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(existsSync(path.join(installDir, "cinatra-ai", "planner-agent", "skills", "foo.md"))).toBe(true);

    // New seed drops skills/foo.md (OAS unchanged).
    rmSync(path.join(slugDir, "skills", "foo.md"));
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(result.materialized).toEqual(["cinatra-ai/planner-agent"]);
    expect(existsSync(path.join(installDir, "cinatra-ai", "planner-agent", "skills", "foo.md"))).toBe(false);
  });

  it("refreshes a slug when ONLY package.json/skills change (same OAS) — whole-tree idempotence", () => {
    const slugDir = path.join(seedDir, "cinatra-ai", "planner-agent");
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }) + "\n");
    writeFileSync(path.join(slugDir, "package.json"), JSON.stringify({ version: "1.0.0" }) + "\n");
    writeFileSync(path.join(slugDir, SEED_MARKER_FILENAME), JSON.stringify({ vendor: "cinatra-ai", slug: "planner-agent" }) + "\n");
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    // Bump ONLY package.json (OAS unchanged).
    writeFileSync(path.join(slugDir, "package.json"), JSON.stringify({ version: "2.0.0" }) + "\n");
    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(result.materialized).toEqual(["cinatra-ai/planner-agent"]);
    const livePkg = JSON.parse(
      readFileSync(path.join(installDir, "cinatra-ai", "planner-agent", "package.json"), "utf8"),
    );
    expect(livePkg.version).toBe("2.0.0");
  });

  it("rejects a path-traversal slug entry in the manifest (fail-closed)", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0" });
    writeFileSync(
      path.join(seedDir, SEED_MANIFEST_FILENAME),
      JSON.stringify({ kind: "x", slugs: [{ vendor: "..", slug: "etc" }] }) + "\n",
    );
    expect(() =>
      materializeRequiredExtensions({ installDir, seedDir, failClosed: true }),
    ).toThrow(/invalid slug entry/);
  });

  it("leaves the required slug present across a refresh (atomic swap; never absent)", () => {
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { v: 1 } });
    writeManifest([{ vendor: "cinatra-ai", slug: "planner-agent" }]);
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    const live = path.join(installDir, "cinatra-ai", "planner-agent", "cinatra", "oas.json");
    expect(existsSync(live)).toBe(true);
    // Refresh; the dir must still exist (and have the new bytes).
    writeSeedSlug("cinatra-ai", "planner-agent", { openapi: "3.1.0", info: { v: 2 } });
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(existsSync(live)).toBe(true);
    expect(JSON.parse(readFileSync(live, "utf8")).info.v).toBe(2);
    // No leftover temp/backup siblings.
    const vendorDir = path.join(installDir, "cinatra-ai");
    const leftovers = readdirSync(vendorDir).filter(
      (n) => n.includes(".tmp-") || n.includes(".bak-"),
    );
    expect(leftovers).toEqual([]);
  });
});
