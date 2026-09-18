/**
 * THE DECLARED-MODULE LOAD ROAD IS ANCHOR-BOUND (cinatra#3525, convergence).
 *
 * The host imports nothing out of the writable package store that the TRUSTED
 * canonical install row does not name: the boot loader binds the row's kind and
 * its digest to the store record before it activates a serverEntry, and the
 * road that runs a caller's DECLARED module is held to the same two bindings.
 * Reading name and version off the store itself would accept any retained
 * digest directory that self-reports the same version — including one
 * activation refuses.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-module-loader-anchor-binding.test.ts
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PACK = "@fixture-scope/fixture-tool-pack";
const PINNED = "1.2.3";
const ORG = "org-fixture";
const LIVE_DIGEST = "aaaaaaaaaaaa";
const RETAINED_DIGEST = "bbbbbbbbbbbb";

type StoreRecord = {
  packageName: string;
  kind: string;
  storeDir: string;
  declaredDigest?: string;
};

const storeRecords: StoreRecord[] = [];
const anchors: { version: string | null; digest: string | null; kind: string | null }[] = [];
const anchorResolverCalls: (string | null)[] = [];

vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => "/unused-by-this-test",
}));

vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: async () => storeRecords,
  realStoreFs: {
    readFile: async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8"),
  },
}));

vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorsResolver: async (orgId: string | null) => {
    anchorResolverCalls.push(orgId);
    return async () => anchors;
  },
}));

/**
 * The fixture tool module's source — a CONSTANT, never built from a value.
 *
 * Constructing the module text by interpolating the digest into it made the
 * written file's CODE depend on a value, which is the shape the scanner names
 * (js/bad-code-sanitization). The fixture needs no such interpolation: the
 * store layout this file builds below is
 * `<dataRoot>/agent/fixture-tool-pack/<digest>/cinatra/tools/fixture-tool.mjs`,
 * so the digest is the fourth path segment from the end of the module's OWN
 * url and the module reads it out of its own location instead.
 *
 * Every arm of this suite passes `load` its own `importModule` stub, so this
 * body is never executed by the tests — the file exists only so the loader has
 * a real module to resolve and refuse or admit.
 */
const FIXTURE_TOOL_MODULE_SOURCE = `import path from "node:path";
import { fileURLToPath } from "node:url";

export function extensionTool() {
  const segments = path.dirname(fileURLToPath(import.meta.url)).split(path.sep);
  return { digest: segments[segments.length - 3] };
}
`;

/** Two digest dirs of the SAME package at the SAME version, as a store that has
 *  retained an older install beside the live one actually looks. */
async function twoDigestStore() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "cinatra-3525-store-"));
  // The RETAINED digest is discovered FIRST, so a resolver that trusts the
  // store's own package.json hands back exactly the wrong directory.
  for (const digest of [RETAINED_DIGEST, LIVE_DIGEST]) {
    const dir = path.join(dataRoot, "agent", "fixture-tool-pack", digest, "cinatra", "tools");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dataRoot, "agent", "fixture-tool-pack", digest, "package.json"),
      JSON.stringify({ name: PACK, version: PINNED }),
    );
    await writeFile(path.join(dir, "fixture-tool.mjs"), FIXTURE_TOOL_MODULE_SOURCE);
    storeRecords.push({
      packageName: PACK,
      kind: "agent",
      declaredDigest: digest,
      storeDir: path.join(dataRoot, "agent", "fixture-tool-pack", digest),
    });
  }
  return dataRoot;
}

async function load(importModule?: (absPath: string) => Promise<unknown>) {
  const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
  return loadDeclaredToolModule(
    {
      packageName: PACK,
      packageVersion: PINNED,
      orgId: ORG,
      toolName: "fixture_tool",
      modulePath: "./cinatra/tools/fixture-tool.mjs",
    },
    importModule ? { importModule } : {},
  );
}

beforeEach(async () => {
  storeRecords.length = 0;
  anchors.length = 0;
  anchorResolverCalls.length = 0;
  await twoDigestStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the declared-module load road binds the trusted install anchor", () => {
  it("loads out of the digest directory the anchor names, never a retained sibling", async () => {
    anchors.push({ version: PINNED, digest: LIVE_DIGEST, kind: "agent" });
    const seen: string[] = [];
    await load(async (absPath) => {
      seen.push(absPath);
      return { extensionTool: () => ({ ok: true }) };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(path.join(LIVE_DIGEST, "cinatra", "tools", "fixture-tool.mjs"));
    expect(seen[0]).not.toContain(RETAINED_DIGEST);
    // The anchor is read in the RUN'S OWN organisation, never platform-wide.
    expect(anchorResolverCalls).toEqual([ORG]);
  });

  it("refuses when the anchor names a digest that is not the one on disk", async () => {
    anchors.push({ version: PINNED, digest: "cccccccccccc", kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses when the canonical row's kind contradicts the store path's kind", async () => {
    anchors.push({ version: PINNED, digest: LIVE_DIGEST, kind: "artifact" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses when no trusted row carries the version the run is bound to", async () => {
    anchors.push({ version: "9.9.9", digest: LIVE_DIGEST, kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });

  it("refuses a digest-unbound legacy anchor while the store is ambiguous", async () => {
    anchors.push({ version: PINNED, digest: null, kind: "agent" });
    await expect(load(async () => ({ extensionTool: () => ({}) }))).rejects.toThrow(
      /not materialized at the pinned version/,
    );
  });
});
