// cinatra#791 — V2 store layout helpers + IO primitives: the pure path grammar
// (kind/slug/digest, validate-and-reject slug sanitizer), the kind-segregated
// discovery walk (scoped + unscoped slugs; foreign/dot/tgz/current entries and
// kind/slug-contradicting manifests are skipped), and the atomic `current`
// mirror primitives.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXTENSION_STORE_KINDS,
  STORE_CURRENT_FILENAME,
  STORE_STAGING_DIRNAME,
  assertValidStorePackageName,
  currentFilePathV2,
  isExtensionStoreKind,
  isStoreDigestSegment,
  parseCurrentFileText,
  storeSlugDirV2,
  storeSlugSegments,
  storeDigestDirV2,
  storeTarballPathV2,
} from "@/lib/extension-package-store-core";
import {
  discoverStoreRecordsV2,
  promoteCurrent,
  readCurrentDigest,
} from "@/lib/extension-store-io";

const DIGEST_A = "a".repeat(128);
const DIGEST_B = "b".repeat(128);

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-store-io-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("pure layout grammar", () => {
  it("kind set matches the installed_extension DDL enum", () => {
    expect([...EXTENSION_STORE_KINDS].sort()).toEqual(
      ["agent", "artifact", "connector", "skill", "workflow"],
    );
    expect(isExtensionStoreKind("connector")).toBe(true);
    expect(isExtensionStoreKind("packages")).toBe(false);
    expect(isExtensionStoreKind(null)).toBe(false);
  });

  it("slug = the npm name verbatim as segments (@scope kept, validate-and-reject)", () => {
    expect(storeSlugSegments("@cinatra-ai/github-connector")).toEqual([
      "@cinatra-ai",
      "github-connector",
    ]);
    expect(storeSlugSegments("lodash")).toEqual(["lodash"]);
    for (const bad of [
      "",
      "UPPER",
      "@scope",
      "@scope/",
      "../evil",
      "@scope/../x",
      "a/b/c",
      ".dot",
      "@scope/.dot",
      "a".repeat(215),
      "name with space",
    ]) {
      expect(() => assertValidStorePackageName(bad), bad).toThrow(/invalid|store/);
    }
  });

  it("path builders compose <root>/<kind>/<slug>/<digest> (+ .tgz / current)", () => {
    const root = "/data/extensions";
    expect(storeSlugDirV2(root, "connector", "@cinatra-ai/x")).toBe(
      "/data/extensions/connector/@cinatra-ai/x",
    );
    expect(storeDigestDirV2(root, "workflow", "pkg", DIGEST_A)).toBe(
      `/data/extensions/workflow/pkg/${DIGEST_A}`,
    );
    expect(storeTarballPathV2(root, "workflow", "pkg", DIGEST_A)).toBe(
      `/data/extensions/workflow/pkg/${DIGEST_A}.tgz`,
    );
    expect(currentFilePathV2(root, "agent", "@s/n")).toBe(
      "/data/extensions/agent/@s/n/current",
    );
    expect(() => storeDigestDirV2(root, "agent", "pkg", "not-hex")).toThrow(/digest/);
  });

  it("digest segments are long lowercase hex only", () => {
    expect(isStoreDigestSegment(DIGEST_A)).toBe(true);
    expect(isStoreDigestSegment("a".repeat(64))).toBe(true);
    expect(isStoreDigestSegment("a".repeat(63))).toBe(false);
    expect(isStoreDigestSegment("Z".repeat(128))).toBe(false);
    expect(isStoreDigestSegment("current")).toBe(false);
  });

  it("parseCurrentFileText: trimmed digest or null (never a throw)", () => {
    expect(parseCurrentFileText(`${DIGEST_A}\n`)).toBe(DIGEST_A);
    expect(parseCurrentFileText("  garbage ")).toBeNull();
    expect(parseCurrentFileText("")).toBeNull();
  });
});

async function writeManifest(dir: string, pkg: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
}

function manifest(name: string, kind?: string): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    cinatra: { ...(kind ? { kind } : {}), serverEntry: "./register.mjs", sdkAbiRange: "^2" },
  };
}

describe("discoverStoreRecordsV2 — kind-segregated walk", () => {
  it("finds scoped + unscoped records across kinds; carries kind + declaredDigest", async () => {
    const root = path.join(workDir, "root-basic");
    await writeManifest(
      path.join(root, "connector", "@cinatra-ai", "x-connector", DIGEST_A),
      manifest("@cinatra-ai/x-connector", "connector"),
    );
    await writeManifest(
      path.join(root, "workflow", "plainpkg", DIGEST_B),
      manifest("plainpkg", "workflow"),
    );
    const records = await discoverStoreRecordsV2(root);
    expect(records).toHaveLength(2);
    const scoped = records.find((r) => r.packageName === "@cinatra-ai/x-connector");
    expect(scoped?.kind).toBe("connector");
    expect(scoped?.declaredDigest).toBe(DIGEST_A);
    expect(scoped?.storeDir).toBe(
      path.join(root, "connector", "@cinatra-ai", "x-connector", DIGEST_A),
    );
    const plain = records.find((r) => r.packageName === "plainpkg");
    expect(plain?.kind).toBe("workflow");
  });

  it("a missing root / empty kind dirs are a clean no-op", async () => {
    expect(await discoverStoreRecordsV2(path.join(workDir, "nope"))).toEqual([]);
    const root = path.join(workDir, "root-empty");
    await mkdir(path.join(root, "connector"), { recursive: true });
    expect(await discoverStoreRecordsV2(root)).toEqual([]);
  });

  it("skips current/tgz/dot entries, .staging, non-digest dirs, and non-kind dirs (legacy `packages/` invisible)", async () => {
    const root = path.join(workDir, "root-skips");
    const slugDir = path.join(root, "connector", "@s", "pkg");
    await writeManifest(path.join(slugDir, DIGEST_A), manifest("@s/pkg", "connector"));
    await writeFile(path.join(slugDir, STORE_CURRENT_FILENAME), `${DIGEST_A}\n`);
    await writeFile(path.join(slugDir, `${DIGEST_A}.tgz`), "tarball-bytes");
    await mkdir(path.join(slugDir, ".cinatra-quarantine"), { recursive: true });
    await mkdir(path.join(slugDir, "not-a-digest"), { recursive: true });
    // legacy flat store — NOT a kind dir → invisible by design (clean cutover).
    await writeManifest(path.join(root, "packages", "old@1.0.0", DIGEST_B), manifest("old"));
    // staging must never be scanned.
    await writeManifest(
      path.join(root, STORE_STAGING_DIRNAME, "materialize-x", "pkg"),
      manifest("@s/staged", "connector"),
    );
    const records = await discoverStoreRecordsV2(root);
    expect(records).toHaveLength(1);
    expect(records[0].packageName).toBe("@s/pkg");
  });

  it("REFUSES a record whose manifest kind contradicts the path kind", async () => {
    const root = path.join(workDir, "root-kindmismatch");
    await writeManifest(
      path.join(root, "connector", "@s", "wf"),
      manifest("@s/wf", "workflow"), // flat manifest — not a digest dir, ignored anyway
    );
    await writeManifest(
      path.join(root, "connector", "@s", "wf", DIGEST_A),
      manifest("@s/wf", "workflow"),
    );
    expect(await discoverStoreRecordsV2(root)).toEqual([]);
  });

  it("REFUSES a record whose manifest kind is present but UNKNOWN (fail closed)", async () => {
    const root = path.join(workDir, "root-unknownkind");
    await writeManifest(
      path.join(root, "connector", "@s", "gizmo", DIGEST_A),
      manifest("@s/gizmo", "gizmo"),
    );
    expect(await discoverStoreRecordsV2(root)).toEqual([]);
  });

  it("REFUSES a record whose manifest name slug contradicts the path slug", async () => {
    const root = path.join(workDir, "root-slugmismatch");
    await writeManifest(
      path.join(root, "connector", "@s", "claimed", DIGEST_A),
      manifest("@other/actual", "connector"),
    );
    expect(await discoverStoreRecordsV2(root)).toEqual([]);
  });

  it("accepts a manifest WITHOUT cinatra.kind (path kind wins; cross-check only when present)", async () => {
    const root = path.join(workDir, "root-nokind");
    await writeManifest(
      path.join(root, "artifact", "@s", "meta-only", DIGEST_A),
      manifest("@s/meta-only"),
    );
    const records = await discoverStoreRecordsV2(root);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("artifact");
  });
});

describe("promoteCurrent / readCurrentDigest — atomic mirror", () => {
  it("writes, re-points, and reads back the current digest", async () => {
    const root = path.join(workDir, "root-current");
    await promoteCurrent(root, "connector", "@s/pkg", DIGEST_A);
    expect(await readCurrentDigest(root, "connector", "@s/pkg")).toBe(DIGEST_A);
    await promoteCurrent(root, "connector", "@s/pkg", DIGEST_B);
    expect(await readCurrentDigest(root, "connector", "@s/pkg")).toBe(DIGEST_B);
    // no tmp residue left behind
    const entries = await readdir(path.join(root, "connector", "@s", "pkg"));
    expect(entries.filter((e) => e.startsWith(".current.tmp"))).toEqual([]);
  });

  it("refuses to promote a malformed digest", async () => {
    const root = path.join(workDir, "root-current-bad");
    await expect(promoteCurrent(root, "connector", "@s/pkg", "nope")).rejects.toThrow(/digest/);
  });

  it("readCurrentDigest is null on a missing or garbage file", async () => {
    const root = path.join(workDir, "root-current-null");
    expect(await readCurrentDigest(root, "agent", "@s/none")).toBeNull();
    await mkdir(path.join(root, "agent", "@s", "junk"), { recursive: true });
    await writeFile(path.join(root, "agent", "@s", "junk", STORE_CURRENT_FILENAME), "junk!!\n");
    expect(await readCurrentDigest(root, "agent", "@s/junk")).toBeNull();
  });
});

describe("discovery does not follow surprises", () => {
  it("a dangling symlink digest entry is skipped, not fatal", async () => {
    const root = path.join(workDir, "root-symlink");
    const slugDir = path.join(root, "connector", "plain");
    await writeManifest(path.join(slugDir, DIGEST_A), manifest("plain", "connector"));
    await symlink("/nonexistent-target", path.join(slugDir, DIGEST_B)).catch(() => undefined);
    const records = await discoverStoreRecordsV2(root);
    expect(records).toHaveLength(1);
  });
});
