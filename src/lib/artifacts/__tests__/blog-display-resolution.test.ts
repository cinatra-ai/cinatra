// ---------------------------------------------------------------------------
// THE FOUR BLOG DISPLAYS RESOLVE ON THE HOST — over the LIVE pinned extension
// tree and the REAL generated display map (lifecycle-c W9, the re-pin half).
//
// The four blog extensions now ship their own displays. This suite is the
// host-side half of the acceptance: at the pinned revisions, each blog type
// reaches ITS OWN extension's display, and the key that display resolves to is
// present in the generated build map — which is the single predicate every
// consuming surface asks (the artifact page, the review card's read-only mount,
// the island inside a third-party application, and the run page's outputs list
// when it lands): `key in GENERATED_ARTIFACT_RENDERERS`.
//
// It runs the REAL bridge over the REAL `extensions/` tree at the committed
// pins, so a lock that moves any of the four back off its display fails here.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { claimedTypeRegisteringPackage } from "@cinatra-ai/objects/claims";
import {
  semanticRendererRegistry,
  generatedArtifactRendererKey,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

/** The four blog displays, each with the type it draws and the slots it ships. */
const BLOG_DISPLAYS = [
  {
    packageName: "@cinatra-ai/blog-idea-artifact",
    objectType: "@cinatra-ai/blog-idea-artifact:blog-idea",
    semanticSlots: ["detail"] as const,
    mapSlots: ["detail", "preview"] as const,
  },
  {
    packageName: "@cinatra-ai/blog-post-artifact",
    objectType: "@cinatra-ai/blog-post-artifact:post",
    semanticSlots: ["detail"] as const,
    mapSlots: ["detail", "preview"] as const,
  },
  {
    packageName: "@cinatra-ai/blog-image-artifact",
    objectType: "@cinatra-ai/blog-image-artifact:blog-image",
    semanticSlots: ["detail", "listRow"] as const,
    mapSlots: ["detail", "preview", "listRow"] as const,
  },
  {
    packageName: "@cinatra-ai/linkedin-artifacts",
    objectType: "@cinatra-ai/linkedin:post-draft",
    semanticSlots: ["detail"] as const,
    mapSlots: ["detail", "preview"] as const,
  },
] as const;

beforeAll(() => {
  objectTypeRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
  registerArtifactExtensions(EXT_ROOT);
});

describe("the four blog displays resolve at the pinned revisions", () => {
  it("has the companion extension tree on disk (the pins are what this suite reads)", () => {
    expect(existsSync(EXT_ROOT)).toBe(true);
    expect(semanticRendererRegistry._snapshot().length).toBeGreaterThan(0);
  });

  it.each(BLOG_DISPLAYS)(
    "$packageName registers its display for $objectType and the build map carries it",
    ({ packageName, objectType, semanticSlots, mapSlots }) => {
      for (const slot of semanticSlots) {
        const descriptor = semanticRendererRegistry.resolve(
          objectType,
          { kind: "extension", extension: packageName },
          slot,
        );
        expect(descriptor, `${packageName} ${slot}`).not.toBeNull();
        expect(descriptor?.packageName).toBe(packageName);
        expect(descriptor?.generatedKey).toBe(
          generatedArtifactRendererKey(packageName, slot),
        );
        expect(
          descriptor!.generatedKey in GENERATED_ARTIFACT_RENDERERS,
          descriptor!.generatedKey,
        ).toBe(true);
      }
      // The representation slots the semantic keyspace never carries
      // (`preview`) still have to be BUILT — the review card's read-only mount
      // and the island resolve them out of the same map.
      for (const slot of mapSlots) {
        const key = `${packageName}::${slot}`;
        expect(key in GENERATED_ARTIFACT_RENDERERS, key).toBe(true);
        const entry = GENERATED_ARTIFACT_RENDERERS[key];
        expect(entry.packageName).toBe(packageName);
        expect(entry.slot).toBe(slot);
        expect(entry.propsApiVersion).toBe(1);
        expect(entry.representations.length).toBeGreaterThan(0);
      }
    },
  );

  it("gives each blog type its OWN extension — no two extensions claim one blog display", () => {
    const snapshot = semanticRendererRegistry._snapshot();
    for (const { objectType, packageName } of BLOG_DISPLAYS) {
      const claimants = [
        ...new Set(
          snapshot.filter((d) => d.objectTypeId === objectType).map((d) => d.packageName),
        ),
      ];
      expect(claimants, objectType).toEqual([packageName]);
    }
    const packages = BLOG_DISPLAYS.map((d) => d.packageName);
    expect(new Set(packages).size).toBe(packages.length);
  });

  it("every blog display's build entry loads through a BARE package specifier, never a source path", () => {
    // Read the EMITTED map, not the loaded module: a guarded entry wraps its
    // import in the load guard, so the specifier the bundler resolves is only
    // visible in the generated source.
    const emitted = readFileSync(
      path.resolve(__dirname, "..", "..", "generated", "artifact-renderers.ts"),
      "utf8",
    );
    for (const { packageName, mapSlots } of BLOG_DISPLAYS) {
      for (const slot of mapSlots) {
        const line = emitted
          .split("\n")
          .find((l) => l.includes(`"${packageName}::${slot}"`));
        expect(line, `${packageName}::${slot}`).toBeDefined();
        const specifiers = [...line!.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
        expect(specifiers.length, line).toBeGreaterThan(0);
        for (const specifier of specifiers) {
          expect(specifier.startsWith(`${packageName}/`), specifier).toBe(true);
          expect(specifier.startsWith("."), specifier).toBe(false);
          expect(specifier.includes("extensions/"), specifier).toBe(false);
          expect(/\.(ts|tsx|js|jsx)$/.test(specifier), specifier).toBe(false);
        }
      }
    }
  });

  it("the LinkedIn post-draft type stays HOST-owned — its display is a cross-namespace renderer", () => {
    // `@cinatra-ai/linkedin:post-draft` is a host work-product type, so its
    // NAMESPACE owner is `@cinatra-ai/linkedin` and not the extension shipping
    // the display. The bridge therefore registers the LinkedIn display as a
    // cross-namespace renderer keyed by the shipping pack, which resolves for a
    // row whose presentation identity names that pack — the identity the
    // publish road already asserts. Pinned here so a later change that moves the
    // type's ownership is a visible decision, not a silently dead display.
    expect(claimedTypeRegisteringPackage("@cinatra-ai/linkedin:post-draft")).toBe(
      "@cinatra-ai/linkedin",
    );
    // The bridge registers only the types a pack OWNS by namespace, so the pack
    // shipping the display registers no type here — the host does, elsewhere.
    expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/linkedin:post-draft")).not.toBe(
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(
      semanticRendererRegistry.resolve(
        "@cinatra-ai/linkedin:post-draft",
        { kind: "extension", extension: "@cinatra-ai/linkedin" },
        "detail",
      ),
    ).toBeNull();
  });
  it("every one of the nine blog display entries LOADS to a callable default export", async () => {
    // Map membership is not resolution. The guarded loader swallows a missing
    // module and degrades to "absent", so a specifier that does not resolve at
    // runtime would leave the display silently blank instead of failing. This
    // leg executes each entry's own `load()` over the pinned tree and asserts
    // the module shape the renderer loader requires (a callable default).
    const keys = Object.keys(GENERATED_ARTIFACT_RENDERERS).filter(
      (key) =>
        key.startsWith("@cinatra-ai/blog-idea-artifact::") ||
        key.startsWith("@cinatra-ai/blog-image-artifact::") ||
        key.startsWith("@cinatra-ai/blog-post-artifact::") ||
        key.startsWith("@cinatra-ai/linkedin-artifacts::"),
    );
    expect(keys).toHaveLength(9);
    for (const key of keys) {
      const mod = (await GENERATED_ARTIFACT_RENDERERS[key].load()) as { default?: unknown };
      expect(typeof mod?.default, `${key} default export`).toBe("function");
    }
  });
});
