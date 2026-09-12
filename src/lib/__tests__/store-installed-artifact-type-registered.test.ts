/**
 * A SUPPLIED (UPLOADED) ARTIFACT PACK'S DECLARED TYPE REACHES THE ARTIFACTS
 * AREA'S OWN TYPE SOURCE (cinatra#3204 — the fix leg for the sixth proof
 * round's artifact defect).
 *
 * The round installed an artifact package through the upload road. Its claim
 * landed (an active dedicated claim, its settings address answered) and the
 * pack's payload was materialized into the unified extension store — and the
 * artifacts area still offered only the built-in types, filing an object made
 * through its upload control under the format base type instead.
 *
 * The cause is the WARM, not the pack. The area's meaning picker reads the
 * in-process object-type registry, and the warm its read path runs
 * (`ensureArtifactTypesRegistered`) bridges `<cwd>/extensions` — the git-native
 * authoring tree — and nothing else. A package installed at RUNTIME is
 * materialized into the unified content-addressed store instead, so its
 * declared type was registered only in a process that had itself performed the
 * install (or had run the boot phase since); in every other process the picker
 * offered the built-ins alone.
 *
 * The fix drives the store road's EXISTING owner from the area's warm —
 * `rescanArtifactBridgeFromStore`, which is fail-closed against the canonical
 * store. These tests assert BOTH halves of that: the live pack's declared type
 * is offered, and a pack whose canonical row is not live is still not offered,
 * so the warm can never resurrect a torn-down type.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Only the canonical-store gates are mocked, exactly as the rescan's own test
// mocks them: the fail-closed install-status behaviour is asserted without a DB.
const { writeAllowedMock, hasLiveRowMock } = vi.hoisted(() => ({
  writeAllowedMock: vi.fn(async (packageName: string): Promise<boolean> =>
    !packageName.includes("torn-down"),
  ),
  hasLiveRowMock: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
  hasLiveInstallRow: hasLiveRowMock,
}));
const { anchorMock } = vi.hoisted(() => ({
  anchorMock: vi.fn(
    async (): Promise<{ digest: string | null; kind?: string | null } | null> => null,
  ),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorResolver: async () => anchorMock,
}));

import { objectTypeRegistry } from "@cinatra-ai/objects";
import { EXTENSION_DATA_ROOT_ENV } from "@/lib/extension-data-root";

/** A well-formed store digest segment (64 hex chars) — the store's own shape. */
const DIGEST = "b3".repeat(32);
const LIVE_PACKAGE = "@acme/store-supplied-note-artifact";
const LIVE_TYPE = `${LIVE_PACKAGE}:note`;
const TORN_DOWN_PACKAGE = "@acme/store-torn-down-note-artifact";
const TORN_DOWN_TYPE = `${TORN_DOWN_PACKAGE}:note`;

let tmpRoot: string;
let priorDataRoot: string | undefined;

/** The manifest shape a supplied artifact pack carries: a declared,
 *  self-registered object type accepting a file MIME. */
function writeStorePackage(packageName: string, typeId: string): void {
  const slugDir = path.join(tmpRoot, "artifact", ...packageName.split("/"));
  const digestDir = path.join(slugDir, DIGEST);
  mkdirSync(digestDir, { recursive: true });
  writeFileSync(
    path.join(digestDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/plain"] } },
          objectTypes: [{ type: typeId, claim: "dedicated", schema: { type: "object" } }],
        },
      },
    }),
  );
}

beforeAll(async () => {
  tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "cinatra-store-artifact-")));
  writeStorePackage(LIVE_PACKAGE, LIVE_TYPE);
  writeStorePackage(TORN_DOWN_PACKAGE, TORN_DOWN_TYPE);

  priorDataRoot = process.env[EXTENSION_DATA_ROOT_ENV];
  process.env[EXTENSION_DATA_ROOT_ENV] = tmpRoot;

  // The area's read-path warm. Before this leg the module offered only the
  // SYNCHRONOUS warm (the authoring tree alone); resolving it that way keeps
  // this a BEHAVIOURAL comparison — on the previous head the assertions below
  // fail because the store-installed type is absent, not because a symbol is.
  const warm = await import("@/lib/artifacts/ensure-artifact-registry");
  if (typeof warm.ensureArtifactTypesRegisteredWithStore === "function") {
    await warm.ensureArtifactTypesRegisteredWithStore();
  } else {
    warm.ensureArtifactTypesRegistered();
  }
});

afterAll(() => {
  if (priorDataRoot === undefined) delete process.env[EXTENSION_DATA_ROOT_ENV];
  else process.env[EXTENSION_DATA_ROOT_ENV] = priorDataRoot;
  objectTypeRegistry.removeByPackage(LIVE_PACKAGE);
  objectTypeRegistry.removeByPackage(TORN_DOWN_PACKAGE);
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the artifacts area's warm sees a store-installed (supplied) artifact pack", () => {
  it("registers the live pack's declared type", () => {
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toContain(LIVE_TYPE);
  });

  it("carries the pack as the type's defining extension", () => {
    expect(objectTypeRegistry.getRegisteringPackage(LIVE_TYPE)).toBe(LIVE_PACKAGE);
  });

  it("offers the declared type on the area's installed-type source for the MIME it accepts", async () => {
    const { listInstalledMeaningTypesAcceptingMime } = await import(
      "@/lib/artifacts/installed-type-picker"
    );
    const offered = listInstalledMeaningTypesAcceptingMime("text/plain");
    expect(offered.map((o) => o.objectTypeId)).toContain(LIVE_TYPE);
  });

  it("still refuses a pack whose canonical row is not live (never resurrects a torn-down type)", async () => {
    const { listInstalledMeaningTypesAcceptingMime } = await import(
      "@/lib/artifacts/installed-type-picker"
    );
    const offered = listInstalledMeaningTypesAcceptingMime("text/plain");
    expect(offered.map((o) => o.objectTypeId)).not.toContain(TORN_DOWN_TYPE);
    expect(objectTypeRegistry.getRegisteringPackage(TORN_DOWN_TYPE)).toBeNull();
  });
});
