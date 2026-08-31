/**
 * WAVE 2 OF `PLAN: Agents Lifecycle (D) - Review` (cinatra#3090 / epic #3087) -
 * the acceptance the seven mixed text-and-pdf kinds rest on:
 *
 *   "One shared pdf shell around that previewer - an SDK-leaf helper or a
 *   registry item - so seven extensions do not fork seven of them."
 *
 * EXACTLY ONE is a COUNT, and a count is what rots. A second module that mounts
 * a PDF of its own is how seven displays end up disagreeing about what a pdf
 * reading looks like, and it is invisible in review because each copy is
 * plausible on its own. So this test walks the host's own two source roots -
 * `src` and `packages`, the reach it names in a test of its own - and refuses a
 * second one, by every road a second one actually arrives on.
 *
 * WHAT IT CANNOT SEE, AND SAYS SO. The seven displays live in seven repositories
 * of their own, outside this tree; their consumption of this shell is proved in
 * those repositories and on the real surface. What IS provable here is the half
 * that lives here: that there is ONE shell, that an extension may depend on it
 * under a published specifier wired the same way for the compiler and for the
 * build, and that it renders no PDF of its own.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SHELL = "packages/sdk-ui/src/artifacts/pdf-detail-shell.tsx";

const SCANNED_ROOTS = ["src", "packages"] as const;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  "dist",
  "generated",
  "__tests__",
]);

function walk(absolute: string, acc: string[]): string[] {
  for (const entry of readdirSync(absolute)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const child = path.join(absolute, entry);
    if (statSync(child).isDirectory()) {
      walk(child, acc);
      continue;
    }
    if (child.endsWith(".tsx") || child.endsWith(".ts")) {
      acc.push(path.relative(REPO_ROOT, child));
    }
  }
  return acc;
}

const compiledModules = SCANNED_ROOTS.flatMap((root) =>
  walk(path.join(REPO_ROOT, root), []),
);

const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * A module that MOUNTS a PDF, as opposed to one that merely names the MIME.
 *
 * EVERY MOUNTING MECHANISM, not one spelling of one of them. A second viewer
 * does not announce itself as a copy of the first: it arrives as an `<object>`,
 * an `<iframe>` over a preview address, or a page renderer imported from a pdf
 * library. A detector that only knew the literal `<embed type="application/pdf">`
 * would wave all three through and still report "exactly one".
 */
function mountsAPdf(source: string): boolean {
  if (/<(embed|object)\b[\s\S]{0,400}?application\/pdf/.test(source)) return true;
  if (/application\/pdf[\s\S]{0,400}?<(embed|object)\b/.test(source)) return true;
  if (/<iframe\b[\s\S]{0,400}?(pdf|previewHref)/i.test(source)) return true;
  if (/from ["'][^"']*(react-pdf|pdfjs)/i.test(source)) return true;
  return false;
}

describe("wave 2 - exactly one pdf shell in the host source roots, and it is a leaf an extension may depend on", () => {
  it("finds ONE module in the host's own source roots that mounts a PDF", () => {
    const mounts = compiledModules.filter((relative) => mountsAPdf(read(relative)));
    expect(mounts).toEqual([SHELL]);
  });

  it("states the reach of that count, so nobody reads it as wider than it is", () => {
    // WHAT THE COUNT COVERS: the host's own two source roots. It does NOT cover
    // `extensions/`, which is not tracked here at all - each extension is its
    // own repository, pinned by commit, and synced into this tree before a run.
    // The pdf extension's shipped display lives there and is the very display
    // this shell is to take over; that cutover is proved in that repository, not
    // by this count. Naming the reach is the point: an unnamed reach is how a
    // guard that measures two directories gets read as measuring everything.
    expect(SCANNED_ROOTS).toEqual(["src", "packages"]);
    expect(SKIPPED_DIRECTORIES.has("__tests__")).toBe(true);
  });

  it("would SEE a second viewer that arrived by any other mounting road", () => {
    // The guard is only worth its name if it fails on the copies that actually
    // get written - none of which is a second `<embed type="application/pdf">`.
    expect(mountsAPdf('<object data={href} type="application/pdf" />')).toBe(true);
    expect(mountsAPdf('<embed type={PDF_MIME} src={href} />\nconst PDF_MIME = "application/pdf";')).toBe(true);
    expect(mountsAPdf("<iframe src={previewHref} />")).toBe(true);
    expect(mountsAPdf('import { Document } from "react-pdf";')).toBe(true);
    expect(mountsAPdf('import * as pdfjs from "pdfjs-dist";')).toBe(true);
    // And is not so eager that naming the media type counts as mounting one.
    expect(mountsAPdf('const mime = "application/pdf";')).toBe(false);
  });

  it("publishes the shell at a real subpath of its package", () => {
    const pkg = JSON.parse(read("packages/sdk-ui/package.json")) as {
      exports: Record<string, string>;
      files: string[];
    };
    expect(pkg.exports["./artifacts/pdf-detail-shell"]).toBe(
      "./src/artifacts/pdf-detail-shell.tsx",
    );
    // The package ships .tsx, so the shell is in the published files - a shell
    // an installed extension cannot resolve is not a shared shell.
    expect(pkg.files).toContain("src/**/*.tsx");
  });

  it("wires the SAME specifier for the compiler and for the build", () => {
    const specifier = "@cinatra-ai/sdk-ui/artifacts/pdf-detail-shell";
    const target = "./packages/sdk-ui/src/artifacts/pdf-detail-shell.tsx";

    // tsconfig.json carries comments, so the compiler map is asserted as the
    // exact line it must contain rather than through a JSON parse.
    expect(read("tsconfig.json")).toContain(`"${specifier}": ["${target}"],`);

    // The manifest is the SOURCE the compiler map is generated FROM, so the
    // shell is asserted there, not only in the generated file.
    const buildConfig = JSON.parse(read("config/build-config.manifest.json")) as {
      tsconfigPaths: Array<{ alias: string; target: string }>;
    };
    expect(
      buildConfig.tsconfigPaths.find((entry) => entry.alias === specifier)?.target,
    ).toBe(target);
  });

  it("keeps the shell a leaf - React and the package's own primitives, never a host import", () => {
    const source = read(SHELL);
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier === "react" || specifier.startsWith("../")).toBe(true);
    }
    // No host source, no framework router, no icon package: the three roads by
    // which a display stops being installable outside this repository.
    expect(source).not.toContain("@/lib/");
    expect(source).not.toContain("next/");
    expect(source).not.toContain("lucide-react");
  });
});

describe("wave 2 - the shell wraps the embedded previewer and renders no PDF itself", () => {
  it("is the browser's own view over the host-authorized preview address", () => {
    const source = read(SHELL);
    expect(source).toContain("src={view.previewHref}");
    expect(source).toContain('type="application/pdf"');
  });

  it("carries NO inline fallback viewer, which the plan took off this road", () => {
    const source = read(SHELL);
    for (const forbidden of [/react-pdf/i, /pdfjs/i, /pdfViewerEnabled/, /workerSrc/]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("never fetches: it reads the addresses it is handed and nothing else", () => {
    const source = read(SHELL);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/XMLHttpRequest/);
  });
});
