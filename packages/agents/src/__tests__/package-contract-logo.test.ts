import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { cinatraAgentPackageMetadataSchema } from "../verdaccio/package-contract";

// cinatra#2469 — "every extension kind must be able to self-define
// `cinatra.logo`" (maintainer decision 2026-08-06).
//
// The agent kind reaches the registry through `publishAgentPackageFromGitDir`,
// which BUILDS A FRESH `cinatra` block rather than spreading the source one.
// That made the agent half of the decision false in a particularly quiet way:
// `walkPackageFiles` copies the package's `logo.svg` INTO the tarball while the
// synthesized package.json replaces the on-disk one, so the ASSET shipped and
// its manifest POINTER was erased — and installation projects the tarball
// through its own allowlisted file set, so the loss persisted past the registry
// rather than being repaired by the next install.
//
// The fix has FOUR parts, each with its own guard, because carrying the pointer
// without the file it names would only move the breakage one step later:
//   1. `carryManifestLogo` (verdaccio/client.ts) — the pointer survives the
//      publisher's fresh-cinatra-block rebuild. Covered below.
//   2. `assertDeclaredLogoShips` (verdaccio/client.ts) — the publish REFUSES a
//      declaration naming a file the tarball would not carry (a `dist/` asset
//      passes the generator's checks on the authoring tree yet never ships).
//      Covered below.
//   3. THIS schema — the pointer survives the parse (see the strip note below).
//   4. `_copyDeclaredLogo` (materialize-agent-package.ts) — the ASSET survives
//      installation. Covered in `materialize-agent-package.test.ts`.
//
// This schema is the THIRD of those four. It is a plain `z.object` — neither
// `.strict()` nor `.passthrough()` — so Zod's default STRIP behavior applies: an
// undeclared key parses WITHOUT ERROR and is silently removed from the parsed
// value. A test that only asserts "parsing does not throw" would therefore pass
// even with the field missing from the schema; every assertion below inspects
// the PARSED OUTPUT instead.

const validBase = {
  packageType: "agent" as const,
  manifestVersion: 1 as const,
  sourceTemplateId: "tpl-1",
  sourceVersionId: "ver-1",
  sourceVersionNumber: 1,
  type: "leaf" as const,
  riskLevel: "low" as const,
  hasApprovalGates: false,
  toolAccess: [],
  ownerOrgId: null,
};

describe("cinatraAgentPackageMetadataSchema — the self-declared logo (cinatra#2469)", () => {
  it("PRESERVES a declared logo through the parse (not merely 'does not throw')", () => {
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      logo: "./logo.svg",
    });
    expect(parsed.logo).toBe("./logo.svg");
  });

  it("proves the strip semantics that made the field necessary", () => {
    // An UNDECLARED key parses cleanly and vanishes — the exact mechanism that
    // erased `logo` before it was added to the schema.
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      notAField: "./logo.svg",
    }) as Record<string, unknown>;
    expect(parsed.notAField).toBeUndefined();
  });

  it("stays OPTIONAL — every already-published logo-less package still parses", () => {
    const parsed = cinatraAgentPackageMetadataSchema.parse(validBase);
    expect(parsed.logo).toBeUndefined();
  });

  it("rejects a non-string or empty logo (a path string is the only shape)", () => {
    for (const bad of [42, true, {}, [], ""]) {
      expect(() =>
        cinatraAgentPackageMetadataSchema.parse({ ...validBase, logo: bad }),
      ).toThrow();
    }
  });

  it("does NOT resolve or sanitize the path — that stays the generator's fail-closed job", () => {
    // The manifest layer carries the declaration as DATA (the same discipline
    // the artifact allowlist uses). `resolveDeclaredLogo` at generation owns
    // .svg-only, in-package containment, symlink escape, the size budget and the
    // sanitizer verdict, and is the ONLY producer of the inline data URI any
    // surface renders — so an unresolvable value here is a BUILD error there,
    // never a rendered one.
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      logo: "../../outside.svg",
    });
    expect(parsed.logo).toBe("../../outside.svg");
  });
});

// ---------------------------------------------------------------------------
// The PUBLISH half of the same fix.
// ---------------------------------------------------------------------------
import { carryManifestLogo, assertDeclaredLogoShips } from "../verdaccio/client";

describe("carryManifestLogo (publisher carry — cinatra#2469)", () => {
  it("carries a declared logo verbatim", () => {
    expect(carryManifestLogo({ cinatra: { kind: "agent", logo: "./logo.svg" } })).toBe("./logo.svg");
  });

  it("carries a nested package-relative path verbatim (no normalization)", () => {
    expect(carryManifestLogo({ cinatra: { logo: "./assets/brand/mark.svg" } })).toBe(
      "./assets/brand/mark.svg",
    );
  });

  it("absence stays absence — a logo-less agent publishes exactly as before", () => {
    // ABSENT is missing OR explicit null, byte-mirroring `resolveDeclaredLogo`
    // (which returns {dataUri:null, error:null} for exactly those two).
    expect(carryManifestLogo({ cinatra: { kind: "agent" } })).toBeUndefined();
    expect(carryManifestLogo({})).toBeUndefined();
    expect(carryManifestLogo({ cinatra: { logo: null } })).toBeUndefined();
    expect(carryManifestLogo({ cinatra: null })).toBeUndefined();
    expect(carryManifestLogo({ cinatra: "not-an-object" })).toBeUndefined();
    expect(carryManifestLogo({ cinatra: ["not-an-object"] })).toBeUndefined();
  });

  it("a PRESENT but malformed declaration REFUSES the publish — it is never laundered into undefined", () => {
    // codex round-6: silently returning `undefined` here publishes a manifest
    // indistinguishable from one that never declared a logo, so the generator
    // downstream has nothing left to fail loudly on — the silent degradation
    // #1482/#2467 exist to end, reintroduced at the publish seam. The message
    // mirrors the generator's wording for the same input.
    for (const bad of [42, true, {}, [], "", "   "]) {
      expect(() => carryManifestLogo({ cinatra: { logo: bad } }), String(bad)).toThrow(
        /cinatra\.logo must be a non-empty package-relative "\.svg" path/,
      );
    }
  });

  it("does NOT resolve or sanitize — the generator stays the fail-closed authority", () => {
    // An escaping path is carried as data; `resolveDeclaredLogo` turns it into a
    // BUILD ERROR at manifest generation. Silently rewriting it here would hide
    // the authoring mistake #1482/#2467 exist to surface.
    expect(carryManifestLogo({ cinatra: { logo: "../../etc/hostname.svg" } })).toBe(
      "../../etc/hostname.svg",
    );
  });

  it("round-trips through the package-contract schema (carry + parse, the full publish path)", () => {
    // The two halves are only useful TOGETHER: the carry puts `logo` on the
    // synthesized manifest, and the schema must not strip it back off.
    const carried = carryManifestLogo({ cinatra: { kind: "agent", logo: "./logo.svg" } });
    const parsed = cinatraAgentPackageMetadataSchema.parse({
      ...validBase,
      ...(carried !== undefined ? { logo: carried } : {}),
    });
    expect(parsed.logo).toBe("./logo.svg");
  });
});

describe("assertDeclaredLogoShips (publish refuses a dangling pointer — cinatra#2469)", () => {
  const PKG = "@cinatra/test-agent";
  const ROOT = path.resolve("/tmp/fixture-agent-root");
  // `walkPackageFiles` relPaths: POSIX, package-relative, NO leading "./".
  const SHIPPED = ["package.json", "cinatra/oas.json", "logo.svg", "assets/brand/mark.svg"];

  const check = (logo: string | undefined, relPaths: readonly string[] = SHIPPED) =>
    assertDeclaredLogoShips({ logo, packageRoot: ROOT, relPaths, packageName: PKG });

  it("passes when the declaration names a file that ships", () => {
    expect(() => check("./logo.svg")).not.toThrow();
    expect(() => check("logo.svg")).not.toThrow();
    expect(() => check("./assets/brand/mark.svg")).not.toThrow();
  });

  it("passes trivially when nothing is declared", () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() => check(undefined, [])).not.toThrow();
  });

  it("THROWS on a generated-dir asset that the tarball would silently omit", () => {
    // The exact case codex round-2 found: `walkPackageFiles` excludes dist/,
    // build/, out/ and node_modules/, so this declaration passes the generator's
    // containment + `.svg` + sanitizer checks on the AUTHORING tree and is still
    // absent from the published package.
    for (const bad of ["./dist/brand.svg", "./build/brand.svg", "./out/brand.svg"]) {
      expect(() => check(bad), bad).toThrow(
        /does not resolve to a file that ships in the published package/,
      );
    }
  });

  it("names the offending path AND the fix in the error (an author can act on it)", () => {
    let message = "";
    try {
      check("./dist/brand.svg");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(PKG);
    expect(message).toContain("./dist/brand.svg");
    expect(message).toContain("Move the asset into a published path");
  });

  it("REFUSES rather than silently dropping — a dropped logo is indistinguishable from an undeclared one", () => {
    // The whole point of #1482/#2467: declared-but-unresolvable must be LOUD.
    expect(() => check("./nope.svg")).toThrow();
  });

  // -------------------------------------------------------------------------
  // PATH SEMANTICS (codex round-3 BLOCKER).
  //
  // An earlier version compared a REWRITTEN string (trim + `\`→`/`) while the
  // manifest published the string VERBATIM, so the check could certify one file
  // and publish a pointer to another. The check now RESOLVES the declaration
  // against the package root, exactly as `resolveDeclaredLogo` (generation) and
  // `_copyDeclaredLogo` (materialization) later will.
  // -------------------------------------------------------------------------
  it("accepts every form the GENERATOR resolves to a shipped file", () => {
    for (const ok of ["././logo.svg", "assets/../logo.svg", "./assets/brand/../brand/mark.svg"]) {
      expect(() => check(ok), ok).not.toThrow();
    }
  });

  it("REFUSES the forms the generator does NOT resolve, rather than string-normalizing them into a pass", () => {
    // A whitespace-padded path is resolved RAW by `resolveDeclaredLogo` and does
    // NOT resolve (pinned in generate-extension-manifest.test.mjs) — so it must
    // not be trimmed into a pass here, or publish would certify `logo.svg` while
    // shipping a pointer that resolves to nothing.
    expect(() => check("  ./logo.svg  ")).toThrow();
    // Backslashes are ordinary filename characters on POSIX, not separators.
    expect(() => check("assets\\brand\\mark.svg")).toThrow();
  });

  it("applies the SAME trimmed-.svg rule as the generator and the materializer (codex round-5)", () => {
    // A shipped `logo.png` used to pass PUBLISH while the generator rejects it
    // and the materializer skips it — publishing a manifest in a state its own
    // consumers cannot build. The publisher was the loose link; it no longer is.
    expect(() => check("./logo.png", [...SHIPPED, "logo.png"])).toThrow(
      /is not a "\.svg" path/,
    );
    // …and the trimmed form is accepted, matching the generator exactly: the
    // suffix is tested on the TRIMMED value while the path resolves RAW, so a
    // file literally named `logo.svg ` is a valid declaration.
    expect(() => check("./logo.svg ", [...SHIPPED, "logo.svg "])).not.toThrow();
  });

  it("REFUSES a declaration that escapes the package, even if the basename ships", () => {
    // `../logo.svg` must not be silently re-anchored onto the shipped
    // top-level `logo.svg` — it points outside the package and the generator
    // rejects it outright.
    expect(() => check("../logo.svg")).toThrow();
    expect(() => check("/etc/hostname.svg")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wiring guard (codex round-2 SHOULD-FIX).
//
// The helpers above are pure and fully unit-covered, but `publishAgentPackageFromGitDir`
// does live registry I/O, so no in-lane test EXECUTES the assembly that uses
// them — deleting the `logo` spread from `distManifest`, or the
// `assertDeclaredLogoShips` call, would leave every assertion above green.
//
// This closes that gap the way the repo already guards un-executable seams
// (the `in-admin-cms-egress-guard` / connectors design-contract precedent): a
// source-text assertion over the publisher itself.
// ---------------------------------------------------------------------------
describe("publishAgentPackageFromGitDir wiring (cinatra#2469 source-text guard)", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "verdaccio", "client.ts"),
    "utf8",
  );

  it("carries the logo INTO the rebuilt distManifest cinatra block", () => {
    expect(source).toContain("const logo = carryManifestLogo(gitPkgJson)");
    // The conditional spread is what actually puts it on the published manifest.
    expect(source).toContain("...(logo !== undefined ? { logo } : {})");
  });

  it("guards the DECLARATIVE (artifact|skill) publisher too — #2469 is cross-kind", () => {
    // `publishExtensionPackageFromDir` spreads `incomingCinatra` VERBATIM, so it
    // never DROPPED the logo — but it also never proved the asset ships, leaving
    // artifacts and skills able to publish a dangling `./dist/brand.svg`
    // (codex round-6). It must run the same two-step the agent publisher does.
    expect(source).toMatch(/logo:\s*carryManifestLogo\(\{\s*cinatra:\s*incomingCinatra\s*\}\)/);
    expect(source).toMatch(/packageRoot:\s*input\.packageDir/);
    expect(source).toMatch(
      /relPaths:\s*publishableFiles\.filter\(extShipsInTarball\)\.map\(\(f\) => f\.relPath\)/,
    );
    expect(source).toMatch(/if \(!extShipsInTarball\(file\)\) continue;/);
    // COVERAGE, not a call count (codex round-7): counting calls catches a new
    // GUARDED publisher and misses a new UNGUARDED one — precisely backwards.
    // Instead: enumerate every tarball-building publisher in this module and
    // assert each one's BODY contains the assertion.
    const publishers = [...source.matchAll(/export async function (publish\w*(?:FromDir|FromGitDir))\b/g)].map(
      (m) => m[1],
    );
    // Guard the guard: if the naming convention changes this must not silently
    // enumerate nothing and pass.
    expect(publishers).toEqual(
      expect.arrayContaining(["publishAgentPackageFromGitDir", "publishExtensionPackageFromDir"]),
    );
    for (const name of publishers) {
      const start = source.indexOf(`export async function ${name}`);
      const next = source.indexOf("\nexport ", start + 1);
      const body = source.slice(start, next === -1 ? source.length : next);
      expect(body, `${name} must assert its declared logo ships`).toContain(
        "assertDeclaredLogoShips({",
      );
    }
  });

  it("asserts the declared logo ships, against the walker's own file set", () => {
    expect(source).toMatch(/assertDeclaredLogoShips\(\{/);
    expect(source).toMatch(/packageRoot:\s*input\.agentDir/);
    // The asserted set must be the FILTERED copy set, not the raw walk (codex
    // round-4): the copy loop additionally drops the synthesized
    // package.json/agent.json and every isEnvBlocked file, so asserting against
    // the unfiltered walk would certify a file the tarball does not contain.
    expect(source).toMatch(
      /relPaths:\s*publishableFiles\.filter\(shipsInTarball\)\.map\(\(f\) => f\.relPath\)/,
    );
    // ONE definition of the predicate, consumed by BOTH the assertion and the
    // copy loop, so the two cannot drift apart.
    expect(source).toMatch(/const shipsInTarball = /);
    expect(source).toMatch(/if \(!shipsInTarball\(file\)\) continue;/);
  });
});
