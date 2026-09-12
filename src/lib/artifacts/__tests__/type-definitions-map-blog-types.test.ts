// ---------------------------------------------------------------------------
// THE CONSOLE TYPE MAP CARRIES ALL FOUR BLOG TYPES (lifecycle-c W9, cinatra#3033
// acceptance cell 1) — over the REAL host registrars and the REAL pinned
// extension tree.
//
// The sibling suite (blog-display-resolution) proves each of the four DISPLAYS
// resolves. This one proves the other half the console needs: that each of the
// four TYPES is an ARTIFACT type, because the Type definitions tab is built from
// `objectTypeRegistry.listArtifacts()` (src/lib/artifacts/type-definitions-inventory.ts)
// — a filter on the `isArtifact` DESCRIPTOR, never on the disposition.
//
// MEASURED at the branch head before this fix: three of the four were listed.
// `@cinatra-ai/linkedin:post-draft` resolved (the host is its single runtime
// registrar, register-types.ts, epic #1448 principle 5 — its pack CLAIMS the id
// cross-namespace and so registers a renderer, never the type) but carried
// `isArtifact: null`, so it was filtered out of the map and the console drew
// three blog types where four are owed. The disposition alone is not the
// admission signal — the same distinction `cms-content-snapshot` states in its
// own registration ("ARTIFACT BY DESCRIPTOR, not merely by disposition").
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";

import { deriveTypeDefinitionRows } from "@/lib/artifacts/type-definitions-inventory";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

/** The four blog types the console owes, with the display name the tab derives. */
const FOUR_BLOG_TYPES = [
  { typeId: "@cinatra-ai/blog-idea-artifact:blog-idea", displayName: "Blog idea" },
  { typeId: "@cinatra-ai/blog-image-artifact:blog-image", displayName: "Blog image" },
  { typeId: "@cinatra-ai/blog-post-artifact:post", displayName: "Post" },
  { typeId: "@cinatra-ai/linkedin:post-draft", displayName: "Post draft" },
] as const;

beforeAll(() => {
  objectTypeRegistry._clearForTests();
  // The EXACT pair of registrars the console warms through
  // `registerAllObjectTypes()`: the objects-package host built-ins FIRST (which
  // is where the LinkedIn post-draft type is registered), then the artifact
  // bridge over the pinned tree.
  registerObjectsPackageObjectTypes();
  registerArtifactExtensions(EXT_ROOT);
});

describe("the Type definitions tab lists all four blog types", () => {
  it("lists every one of the four as an artifact type", () => {
    const listed = new Set(objectTypeRegistry.listArtifacts().map((d) => d.type));
    for (const { typeId } of FOUR_BLOG_TYPES) {
      expect(listed.has(typeId), `${typeId} is absent from listArtifacts()`).toBe(true);
    }
  });

  it("draws a row for each, with the humanized local part as its name", () => {
    const rows = deriveTypeDefinitionRows({
      types: objectTypeRegistry.listArtifacts().map((def) => ({
        typeId: def.type,
        definer: objectTypeRegistry.definerOf(def.type),
      })),
      installed: [],
    });
    const byId = new Map(rows.map((r) => [r.typeId, r]));
    for (const { typeId, displayName } of FOUR_BLOG_TYPES) {
      expect(byId.get(typeId)?.displayName, typeId).toBe(displayName);
    }
  });

  it("keeps the LinkedIn post-draft a HOST registration — the claim never mints a second registrar", () => {
    // Epic #1448 principle 5: exactly one runtime registrar per type. The pack
    // claims the id cross-namespace; promoting it to an artifact must NOT hand
    // the type to the pack, or an uninstall of the pack would reap a host type.
    expect(objectTypeRegistry.definerOf("@cinatra-ai/linkedin:post-draft")).toBeNull();
  });

  it("states the same representation forms its claiming pack declares (drift pin)", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(EXT_ROOT, "cinatra-ai", "linkedin-artifacts", "package.json"),
        "utf8",
      ),
    ) as { cinatra?: { artifact?: { accepts?: unknown } } };
    const def = objectTypeRegistry.resolve("@cinatra-ai/linkedin:post-draft");
    expect(def?.isArtifact?.accepts).toEqual(manifest.cinatra?.artifact?.accepts);
  });
});
