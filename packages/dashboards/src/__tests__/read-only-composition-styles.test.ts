import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Contract: every mount of the shared read-only composition loads the same two
 * stylesheets the dashboard home loads, in the same order (cinatra#4311).
 *
 * drizzle-cube draws its grid and its charts with `dc:`-prefixed utility
 * classes that only `drizzle-cube/client/styles.css` defines, and the Cinatra
 * `--dc-*` token mapping lives in `dashboard-theme.css`. The home has always
 * loaded both through `DashboardsClientShell`. A display that mounts the
 * composition outside that shell (the dashboard artifact's display on an
 * artifact page) loaded neither, so its portlets drew without their layout and
 * in drizzle-cube's own palette.
 *
 * The composition therefore loads both itself, and the theme lives beside it in
 * `@cinatra-ai/sdk-dashboard` (the SDK may not import `@cinatra-ai/dashboards`).
 * It loads drizzle-cube's stylesheet as the generated SCOPED copy
 * (`drizzle-cube-scoped.css`, pinned by drizzle-cube-scoped-styles.test.ts), so
 * the library rules the upstream file carries unscoped stay inside dashboard
 * regions. The home shell keeps loading the upstream defaults and then the
 * composition module, so there is ONE theme file and both mounts read it after
 * the defaults, which is the order the theme's overrides need.
 */

const REPO = join(__dirname, "..", "..", "..", "..");
const SDK_COMPONENTS = join(REPO, "packages", "sdk-dashboard", "src", "components");
const HOST_COMPONENTS = join(REPO, "packages", "dashboards", "src", "components");

/** The bare side-effect imports (`import "x";`) of a module, in source order. */
function sideEffectImports(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  return [...source.matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]);
}

describe("the read-only composition loads the dashboard stylesheets itself", () => {
  const composition = join(SDK_COMPONENTS, "read-only-composition.tsx");

  it("imports the scoped drizzle-cube defaults, then the Cinatra theme, in that order", () => {
    expect(sideEffectImports(composition)).toEqual([
      "./drizzle-cube-scoped.css",
      "./dashboard-theme.css",
    ]);
  });

  it("finds the scoped defaults and the theme beside it in the SDK package", () => {
    expect(existsSync(join(SDK_COMPONENTS, "drizzle-cube-scoped.css"))).toBe(true);
    expect(existsSync(join(SDK_COMPONENTS, "dashboard-theme.css"))).toBe(true);
  });
});

describe("the dashboard home reads the same theme, after the same defaults", () => {
  it("keeps exactly one dashboard-theme.css (no second copy in the host package)", () => {
    expect(existsSync(join(HOST_COMPONENTS, "dashboard-theme.css"))).toBe(false);
  });

  it("loads the drizzle-cube defaults, then the composition module that carries the theme", () => {
    expect(sideEffectImports(join(HOST_COMPONENTS, "dashboards-client-shell.tsx"))).toEqual([
      "drizzle-cube/client/styles.css",
      "@cinatra-ai/sdk-dashboard/components",
    ]);
  });
});
