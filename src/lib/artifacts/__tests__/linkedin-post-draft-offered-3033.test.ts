/**
 * cinatra#3033 (CELL4, the picker) — app-artifacts §VI.1: "The picker admits
 * only installed, file-accepting types whose accepts include the detected
 * MIME". The LinkedIn post draft is installed and file-accepting, so the picker
 * owes it for a markdown upload and for a plain-text upload.
 *
 * The host is the type's single runtime registrar; the pinned
 * `@cinatra-ai/linkedin-artifacts` pack CLAIMS the id cross-namespace. The
 * host's registration must therefore carry the artifact descriptor (the same
 * two forms the pinned pack declares — read from disk, never re-typed), and the
 * picker must name the claiming pack as the extension a person asserts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { semanticRendererRegistry } from "@cinatra-ai/objects/artifact-renderer-registry";
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";
import {
  registerArtifactExtensionDir,
  registerParsedArtifactManifest,
} from "@cinatra-ai/objects/register-artifact-extensions";
import type { SemanticArtifactManifest } from "@cinatra-ai/objects";

/** Reconcile a pack away: a re-registration that declares nothing drops every
 *  bridge registration the pack held, its cross-namespace claims included. */
function reconcileAway(packageName: string): void {
  registerParsedArtifactManifest({} as SemanticArtifactManifest, packageName);
}

import {
  listInstalledMeaningTypesAcceptingMime,
  meaningExtensionFor,
} from "../installed-type-picker";

const LINKEDIN_PACK = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";
const MARKDOWN_BASE = "@cinatra-ai/markdown-artifact:artifact";
const TEXT_BASE = "@cinatra-ai/text-artifact:artifact";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");
const PINNED_DIRS = ["linkedin-artifacts", "markdown-artifact", "text-artifact"].map((d) =>
  path.join(EXT_ROOT, d),
);

function pinnedLinkedinAccepts(): string[] {
  const pkg = JSON.parse(
    readFileSync(path.join(EXT_ROOT, "linkedin-artifacts", "package.json"), "utf8"),
  ) as { cinatra: { artifact: { accepts: { file: { mimeTypes: string[] } } } } };
  return pkg.cinatra.artifact.accepts.file.mimeTypes;
}

function clearAll(): void {
  for (const pkg of [
    LINKEDIN_PACK,
    "@cinatra-ai/markdown-artifact",
    "@cinatra-ai/text-artifact",
  ]) {
    reconcileAway(pkg);
  }
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
}

describe("the LinkedIn post draft is offered by the installed-type picker (cinatra#3033)", () => {
  beforeEach(() => {
    clearAll();
    // The host registrations (the objects package's own registration entry),
    // then the pinned packs, in boot order.
    registerObjectsPackageObjectTypes();
    for (const dir of PINNED_DIRS) registerArtifactExtensionDir(dir);
  });
  afterEach(() => {
    clearAll();
  });

  it("lists the host-registered LinkedIn post draft as an artifact type", () => {
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(listed).toContain(LINKEDIN_TYPE);
  });

  it("states exactly the forms the pinned linkedin-artifacts pack declares (parity, read from disk)", () => {
    const def = objectTypeRegistry.listArtifacts().find((d) => d.type === LINKEDIN_TYPE);
    expect(def?.isArtifact?.accepts?.file?.mimeTypes).toEqual(pinnedLinkedinAccepts());
    // Representation forms only: the pack draws nothing of its own.
    expect(def?.isArtifact?.ui).toBeUndefined();
  });

  it("offers it for a text/markdown upload under the claiming extension", () => {
    const offered = listInstalledMeaningTypesAcceptingMime("text/markdown", {
      excludeTypeId: MARKDOWN_BASE,
    });
    expect(offered).toContainEqual(
      expect.objectContaining({ extension: LINKEDIN_PACK, objectTypeId: LINKEDIN_TYPE }),
    );
  });

  it("offers it for a text/plain upload under the claiming extension", () => {
    const offered = listInstalledMeaningTypesAcceptingMime("text/plain", {
      excludeTypeId: TEXT_BASE,
    });
    expect(offered).toContainEqual(
      expect.objectContaining({ extension: LINKEDIN_PACK, objectTypeId: LINKEDIN_TYPE }),
    );
  });
});

describe("meaningExtensionFor — the extension a meaning assertion names (cinatra#3033)", () => {
  it("names the registering package when there is one", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: "@acme/legal",
        crossNamespaceClaimants: ["@acme/other"],
      }),
    ).toBe("@acme/legal");
  });

  it("names the sole claimant of a host-registered type", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: null,
        crossNamespaceClaimants: [LINKEDIN_PACK],
      }),
    ).toBe(LINKEDIN_PACK);
  });

  it("answers null for two claimants — an ambiguity no picker resolves", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: null,
        crossNamespaceClaimants: ["@acme/a", "@acme/b"],
      }),
    ).toBeNull();
  });

  it("answers null for no registering package and no claimant", () => {
    expect(
      meaningExtensionFor({ registeringPackage: null, crossNamespaceClaimants: [] }),
    ).toBeNull();
  });
});
