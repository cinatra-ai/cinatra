// ---------------------------------------------------------------------------
// THE BLOG TYPES RESOLVE ON THE HOST — over the LIVE pinned extension tree and
// the REAL generated display map (lifecycle-c W9, cinatra#3033).
//
// The maintainer's reading of 24 September: a meaning-type artifact is drawn
// by the display of its CONTENT TYPE, not by a display of its own. So the blog
// idea, the blog post and the LinkedIn post draft register NO display at their
// pinned revisions — a text/markdown row of those types is drawn by the
// Markdown extension's display, a text/plain row by the host's text floor
// until the Text extension claims text/plain. Only the blog image keeps its own
// display (the featured-image fields and the link to its post).
//
// This suite is the host-side half of that reading: at the pinned revisions
// the blog image reaches its own display and the key it resolves to is in the
// generated build map — the single predicate every consuming surface asks
// (`key in GENERATED_ARTIFACT_RENDERERS`) — while the three text types reach
// no display of a blog pack in any slot.
//
// It runs the REAL bridge over the REAL `extensions/` tree at the committed
// pins, so a lock that moves any of the four packs off its pinned revision
// fails here.
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
  SEMANTIC_RENDERER_SLOTS,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

/**
 * The four blog packs, each with the type it defines or claims, the semantic
 * slots it registers and the build-map slots it ships at its own pin. The three
 * text packs ship none: their types draw through their content type's display.
 */
type BlogDisplay = {
  packageName: string;
  objectType: string;
  semanticSlots: readonly ("detail" | "listRow")[];
  mapSlots: readonly ("detail" | "preview" | "listRow")[];
  propsApiVersion: number | null;
};

const BLOG_DISPLAYS: readonly BlogDisplay[] = [
  {
    packageName: "@cinatra-ai/blog-idea-artifact",
    objectType: "@cinatra-ai/blog-idea-artifact:blog-idea",
    semanticSlots: [],
    mapSlots: [],
    propsApiVersion: null,
  },
  {
    packageName: "@cinatra-ai/blog-post-artifact",
    objectType: "@cinatra-ai/blog-post-artifact:post",
    semanticSlots: [],
    mapSlots: [],
    propsApiVersion: null,
  },
  {
    packageName: "@cinatra-ai/blog-image-artifact",
    objectType: "@cinatra-ai/blog-image-artifact:blog-image",
    semanticSlots: ["detail", "listRow"],
    mapSlots: ["detail", "preview", "listRow"],
    propsApiVersion: 2,
  },
  {
    packageName: "@cinatra-ai/linkedin-artifacts",
    objectType: "@cinatra-ai/linkedin:post-draft",
    semanticSlots: [],
    mapSlots: [],
    propsApiVersion: null,
  },
];

const BLOG_PACK_PREFIXES = BLOG_DISPLAYS.map((d) => `${d.packageName}::`);

beforeAll(() => {
  objectTypeRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
  registerArtifactExtensions(EXT_ROOT);
});

describe("the blog types resolve at the pinned revisions", () => {
  it("has the companion extension tree on disk (the pins are what this suite reads)", () => {
    expect(existsSync(EXT_ROOT)).toBe(true);
    expect(semanticRendererRegistry._snapshot().length).toBeGreaterThan(0);
  });

  it.each(BLOG_DISPLAYS)(
    "$packageName registers exactly its pinned slots for $objectType and the build map carries exactly those",
    ({ packageName, objectType, semanticSlots, mapSlots, propsApiVersion }) => {
      const identity = { kind: "extension" as const, extension: packageName };
      for (const slot of SEMANTIC_RENDERER_SLOTS) {
        const descriptor = semanticRendererRegistry.resolve(objectType, identity, slot);
        if (!semanticSlots.includes(slot)) {
          // No semantic display of this pack for its type in this slot.
          expect(descriptor, `${packageName} ${slot}`).toBeNull();
          continue;
        }
        expect(descriptor, `${packageName} ${slot}`).not.toBeNull();
        expect(descriptor?.packageName).toBe(packageName);
        expect(descriptor?.generatedKey).toBe(generatedArtifactRendererKey(packageName, slot));
        expect(
          descriptor!.generatedKey in GENERATED_ARTIFACT_RENDERERS,
          descriptor!.generatedKey,
        ).toBe(true);
      }
      // The build map carries exactly the pinned slots of this pack — the
      // representation slots the semantic keyspace never carries (`preview`)
      // included, and nothing for a pack that ships no display.
      const keys = Object.keys(GENERATED_ARTIFACT_RENDERERS)
        .filter((key) => key.startsWith(`${packageName}::`))
        .sort();
      expect(keys).toEqual(mapSlots.map((slot) => `${packageName}::${slot}`).sort());
      for (const slot of mapSlots) {
        const key = `${packageName}::${slot}`;
        const entry = GENERATED_ARTIFACT_RENDERERS[key];
        expect(entry.packageName).toBe(packageName);
        expect(entry.slot).toBe(slot);
        expect(entry.propsApiVersion, key).toBe(propsApiVersion);
        expect(entry.representations.length).toBeGreaterThan(0);
      }
    },
  );

  it("gives the blog image its OWN extension and leaves the three text types unclaimed", () => {
    const snapshot = semanticRendererRegistry._snapshot();
    for (const { objectType, packageName, semanticSlots } of BLOG_DISPLAYS) {
      const claimants = [
        ...new Set(
          snapshot.filter((d) => d.objectTypeId === objectType).map((d) => d.packageName),
        ),
      ];
      // A pack that ships no display of its own claims nothing here — the
      // type draws through its content type's display.
      expect(claimants, objectType).toEqual(semanticSlots.length > 0 ? [packageName] : []);
      if (semanticSlots.length === 0) {
        expect(semanticRendererRegistry.listByPackage(packageName), packageName).toEqual([]);
      }
    }
    const packages = BLOG_DISPLAYS.map((d) => d.packageName);
    expect(new Set(packages).size).toBe(packages.length);
  });

  it("the text/markdown representation reaches the Markdown extension's required display in the build map", () => {
    // With no display of a blog pack for the three text types, a text/markdown
    // row of those types is drawn by the representation's display: the ONE
    // detail entry of the build map that draws text/markdown is the Markdown
    // extension's, and it is REQUIRED (always built).
    const markdownDetail = Object.entries(GENERATED_ARTIFACT_RENDERERS)
      .filter(
        ([, entry]) => entry.slot === "detail" && entry.representations.includes("text/markdown"),
      )
      .map(([key]) => key);
    expect(markdownDetail).toEqual(["@cinatra-ai/markdown-artifact::detail"]);
    expect(GENERATED_ARTIFACT_RENDERERS["@cinatra-ai/markdown-artifact::detail"].resolution).toBe(
      "required",
    );
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

  it("the LinkedIn post-draft type stays HOST-owned — and no display is registered for it", () => {
    // `@cinatra-ai/linkedin:post-draft` is a host work-product type, so its
    // NAMESPACE owner is `@cinatra-ai/linkedin` and not the extension that
    // claims it. The bridge registers only the types a pack OWNS by namespace,
    // so the LinkedIn pack registers no type here — the host does, elsewhere.
    // Pinned here so a later change that moves the type's ownership is a
    // visible decision.
    expect(claimedTypeRegisteringPackage("@cinatra-ai/linkedin:post-draft")).toBe(
      "@cinatra-ai/linkedin",
    );
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

  it("every one of the three blog display entries LOADS to a callable default export", async () => {
    // Map membership is not resolution. The guarded loader swallows a missing
    // module and degrades to "absent", so a specifier that does not resolve at
    // runtime would leave the display silently blank instead of failing. This
    // leg executes each entry's own `load()` over the pinned tree and asserts
    // the module shape the renderer loader requires (a callable default).
    const keys = Object.keys(GENERATED_ARTIFACT_RENDERERS).filter((key) =>
      BLOG_PACK_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      const mod = (await GENERATED_ARTIFACT_RENDERERS[key].load()) as { default?: unknown };
      expect(typeof mod?.default, `${key} default export`).toBe("function");
    }
  });
});
