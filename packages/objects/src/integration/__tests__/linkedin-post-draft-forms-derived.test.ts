/**
 * cinatra#3251 — THE LINKEDIN POST-DRAFT'S REPRESENTATION FORMS ARE THE
 * CLAIMING PACK'S, DERIVED, NEVER A HOST-SIDE COPY.
 *
 * Acceptance 1: `register-types.ts` no longer hand-states this type's
 * representation forms as a literal; the registrar reads them from the claiming
 * pack's declared manifest through the same parse the bridge already performs
 * elsewhere (`parseSemanticArtifactManifest`).
 *
 * Acceptance 4: the pair the registrar lands is pinned AGAINST THE PACK'S OWN
 * MANIFEST, read fresh at test time from the pinned tree — never against a
 * second hand-copy written here — so a future pack-side edit cannot silently
 * diverge from the host registration.
 *
 * The host stays this type's single runtime registrar (epic #1448 principle 5);
 * what changes is where the record's CONTENT comes from. The first case proves
 * the derivation by moving the pack's declaration and watching the registration
 * follow it, which no literal can do; the last proves the fail-closed half — a
 * host that cannot read the claiming pack's declaration does not invent one.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

import { objectTypeRegistry } from "../../registry";
import { parseSemanticArtifactManifest } from "../../semantic-manifest";
import { registerAllObjectTypes } from "../register-types";

const POST_DRAFT = "@cinatra-ai/linkedin:post-draft";
const CLAIMANT_SLUG = "linkedin-artifacts";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const PINNED_EXTENSIONS_ROOT = path.join(REPO_ROOT, "extensions");
const PINNED_CLAIMANT_MANIFEST = path.join(
  PINNED_EXTENSIONS_ROOT,
  "cinatra-ai",
  CLAIMANT_SLUG,
  "package.json",
);

const tempRoots: string[] = [];

/** The pack's OWN declared representation forms, parsed the way the bridge
 *  parses them — never a literal restated in this file. */
function declaredFormsOf(manifestPath: string): unknown {
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    cinatra?: { artifact?: unknown };
  };
  const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
  expect(parsed.ok, manifestPath).toBe(true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.manifest.accepts;
}

/**
 * A throwaway extensions root holding ONE claiming pack: the pinned pack's own
 * manifest with its declared file mime types replaced. Everything else about
 * the manifest is the pack's, so the fixture cannot drift into a shape the real
 * parse would reject.
 */
function fixtureRootWithDeclaredMimes(mimeTypes: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-3251-"));
  tempRoots.push(root);
  const dir = path.join(root, "cinatra-ai", CLAIMANT_SLUG);
  mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(readFileSync(PINNED_CLAIMANT_MANIFEST, "utf8")) as {
    cinatra: { artifact: { accepts: { file: { mimeTypes: string[] } } } };
  };
  pkg.cinatra.artifact.accepts.file.mimeTypes = mimeTypes;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return root;
}

/** An extensions root with no packs at all — the reduced universe. */
function emptyFixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-3251-empty-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "cinatra-ai"), { recursive: true });
  return root;
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
});

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("the post-draft's representation forms are DERIVED from the claiming pack", () => {
  it("follows the pack's declaration when the pack declares a different pair", () => {
    const root = fixtureRootWithDeclaredMimes(["text/markdown", "text/plain", "text/html"]);
    registerAllObjectTypes({ extensionsRoot: root });

    const def = objectTypeRegistry.resolve(POST_DRAFT);
    expect(def, POST_DRAFT).not.toBeNull();
    expect(def!.isArtifact?.accepts).toEqual(
      declaredFormsOf(path.join(root, "cinatra-ai", CLAIMANT_SLUG, "package.json")),
    );
  });

  it("registers NO representation forms it could not read (fail-closed, never invented)", () => {
    registerAllObjectTypes({ extensionsRoot: emptyFixtureRoot() });

    const def = objectTypeRegistry.resolve(POST_DRAFT);
    // The runtime RECORD stays — the host is this type's single registrar — but
    // its artifact descriptor is the pack's to state, and with no claiming pack
    // on disk there is nothing to state it from.
    expect(def, POST_DRAFT).not.toBeNull();
    expect(def!.isArtifact).toBeUndefined();
  });
});

describe("the registrar-derived pair is pinned against the pack's own manifest", () => {
  it("matches the pinned tree's claiming pack, read fresh, with no second copy here", () => {
    registerAllObjectTypes({ extensionsRoot: PINNED_EXTENSIONS_ROOT });

    const def = objectTypeRegistry.resolve(POST_DRAFT);
    expect(def, POST_DRAFT).not.toBeNull();
    expect(def!.isArtifact?.accepts).toEqual(declaredFormsOf(PINNED_CLAIMANT_MANIFEST));
  });
});
