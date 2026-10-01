// The two new media displays' registration in this application (cinatra#3091,
// W3 of #3087).
//
// Wave 3 gives the host half of the byte road its display half: eleven display
// packages move to their merged heads, and two of them — the screenshot kind
// and the slide-deck kind — ship a `ui.renderers` block for the FIRST time.
// Each package lives in its own repository and carries its own suites; what
// THIS repository owes is the registration that makes the display real here —
// a commit pin at the merged head, the generated renderer-map entry behind the
// optional-import guard, and the host-maintained alias the map resolves the
// display through. Without them the renderer is invisible to the host: the
// package installs, but every artifact of the kind falls back to the generic
// display.
//
// Both displays draw a single `detail` slot at props API version 2 — the
// version this wave's host half introduces (the byte reference), not the
// version 1 shape the already-registered displays were built on. That is the
// load-bearing difference from the earlier waves' registrations, and the cases
// below pin it: a display that silently regressed to version 1 props would
// still resolve, and would still draw, but would not read a byte reference.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const PROPS_API_VERSION = 2;

type LockEntry = { packageName: string; repo: string; resolvedSha: string };

type MediaDisplay = {
  readonly packageName: string;
  readonly repoSlug: string;
  readonly shortName: string;
  readonly forms: readonly string[];
};

// The two packages whose display half is new in this wave. The nine other
// re-pinned packages already carried renderers, so their registration is
// already pinned by the roster suites; only these two are new here.
const NEW_DISPLAYS: readonly MediaDisplay[] = [
  {
    packageName: "@cinatra-ai/screenshot-artifact",
    repoSlug: "cinatra-ai/screenshot-artifact",
    shortName: "screenshot-artifact",
    forms: ["image/png", "image/jpeg", "image/webp"],
  },
  {
    packageName: "@cinatra-ai/slide-deck-artifact",
    repoSlug: "cinatra-ai/slide-deck-artifact",
    shortName: "slide-deck-artifact",
    forms: ["application/pdf"],
  },
] as const;

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), "utf8"));
}

function readText(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function hostManifest(): Record<string, unknown> {
  return readJson("package.json").cinatra as Record<string, unknown>;
}

function devLockEntries(): LockEntry[] {
  return readJson("cinatra-dev-extensions.lock.json").packages as LockEntry[];
}

function requiredLockEntries(): LockEntry[] {
  return readJson("cinatra-required-extensions.lock.json").packages as LockEntry[];
}

function installedManifest(display: MediaDisplay): Record<string, unknown> {
  return readJson(`extensions/cinatra-ai/${display.shortName}/package.json`);
}

describe.each(NEW_DISPLAYS)("$packageName is registered as a display (#3091)", (display) => {
  it("is declared as a development extension on its own repository and pinned at a commit", () => {
    const devExtensions = hostManifest().devExtensions as Record<string, string>;
    expect(devExtensions[display.packageName]).toBe(`https://github.com/${display.repoSlug}.git`);

    const pinned = devLockEntries().filter((p) => p.packageName === display.packageName);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].repo).toBe(display.repoSlug);
    expect(pinned[0].resolvedSha).toMatch(/^[0-9a-f]{40}$/);

    // Partitioned locks, no overlap: a package pinned in the development lock
    // is never also in the prod bootable lock.
    expect(requiredLockEntries().map((p) => p.packageName)).not.toContain(display.packageName);
  });

  it("draws one detail slot over its own forms at props API version 2", () => {
    const manifest = installedManifest(display);
    const artifact = (manifest.cinatra as Record<string, unknown>).artifact as Record<string, unknown>;

    // The pin must be at a head that actually SHIPS the display. Before this
    // wave's re-pin the installed package carried no `ui` block at all, so the
    // generated map had nothing to emit.
    const ui = artifact.ui as Record<string, unknown> | null | undefined;
    expect(ui, `${display.packageName} ships no ui block — is the pin at the merged head?`).toBeTruthy();
    expect((ui as Record<string, unknown>).abiVersion).toBe(1);

    const renderers = (ui as Record<string, unknown>).renderers as Record<
      string,
      { entry: string; propsApiVersion: number; representations: string[] }
    >;
    expect(Object.keys(renderers)).toEqual(["detail"]);

    const detail = renderers.detail;
    expect(detail.propsApiVersion).toBe(PROPS_API_VERSION);
    expect(detail.representations).toEqual([...display.forms]);

    // The packaging rule: the display is reached through the package's own
    // `exports` key, never through a path into the package's source tree.
    const exportsMap = manifest.exports as Record<string, unknown>;
    const exportsKey = detail.entry.replace(/\.(tsx|ts|jsx|js)$/, "");
    expect(Object.keys(exportsMap)).toContain(exportsKey);
  });

  it("carries the detail slot in the generated renderer map, behind the optional-import guard", () => {
    const generated = readText("src/lib/generated/artifact-renderers.ts");
    const specifier = `${display.packageName}/src/renderers/detail`;

    expect(generated).toContain(`"${display.packageName}::detail"`);
    // Both packages are outside the shipped set, so the renderer import must
    // go through the guard that degrades to the generic display when the
    // package is not present.
    expect(generated).toContain(`guardedExtensionImport("${specifier}"`);
    // The map records the props version the host hands this display; a
    // regression to version 1 here would be a silent contract break.
    expect(generated).toContain(
      `"packageName":"${display.packageName}","slot":"detail","representations":${JSON.stringify(display.forms)},"propsApiVersion":${PROPS_API_VERSION}`,
    );
  });

  it("resolves the renderer specifier through a host-maintained alias", () => {
    // The build manifest is the source; the committed tsconfig is rendered
    // from it, and is read as text because it carries comments.
    const specifier = `${display.packageName}/src/renderers/detail`;
    const target = `./extensions/cinatra-ai/${display.shortName}/src/renderers/detail.tsx`;

    const buildAliases = readJson("config/build-config.manifest.json").tsconfigPaths as Array<{
      alias: string;
      target: string;
    }>;
    expect(buildAliases.find((a) => a.alias === specifier)?.target).toBe(target);
    expect(readText("tsconfig.json")).toContain(JSON.stringify(specifier));
  });
});

describe("the wave's eleven display packages travel together (#3091)", () => {
  // The host half and the display half must ship in ONE commit: a host that
  // reads a byte reference against displays pinned before the byte road would
  // draw nothing. Each of the eleven is pinned in exactly one of the two
  // locks, and every pin is an immutable commit sha.
  const ELEVEN = [
    "@cinatra-ai/image-artifact",
    "@cinatra-ai/video-artifact",
    "@cinatra-ai/audio-artifact",
    "@cinatra-ai/pdf-artifact",
    "@cinatra-ai/document-artifact",
    "@cinatra-ai/zip-artifact",
    "@cinatra-ai/json-artifact",
    "@cinatra-ai/cms-snapshot-artifact",
    "@cinatra-ai/text-artifact",
    "@cinatra-ai/screenshot-artifact",
    "@cinatra-ai/slide-deck-artifact",
  ] as const;

  it.each(ELEVEN)("%s is pinned exactly once, at a commit sha", (packageName) => {
    const inDev = devLockEntries().filter((p) => p.packageName === packageName);
    const inRequired = requiredLockEntries().filter((p) => p.packageName === packageName);
    expect(inDev.length + inRequired.length).toBe(1);
    expect([...inDev, ...inRequired][0].resolvedSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
