import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  deriveFacadePrimitiveOverrides,
  scanHostImportsInText,
  scanCrossExtImportsInText,
  isValidExtensionDependency,
  scanSdkOnlyImportsInText,
  sdkOnlyManifestDeps,
  isSdkOnlyViolation,
  basePackageOf,
  SDK_PACKAGES,
} from "../inventory.mjs";

// The import-ban gate's declared-cross-extension carve-out is only safe if a
// dependency must carry the FULL valid ExtensionDependency shape to count as
// "declared". A `{ packageName }`-only or otherwise-malformed row MUST be
// rejected — otherwise it could (a) hide a real cross-extension coupling from
// the gate, and (b) weaken closure (dependency-closure treats non-"required"
// requirement as optional).
describe("isValidExtensionDependency — full edge shape required (no packageName-only bypass)", () => {
  const VALID = {
    packageName: "@cinatra-ai/nango-connector",
    kind: "connector",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  };
  const nameToKind = new Map([["@cinatra-ai/nango-connector", "connector"]]);

  it("accepts a full, valid edge", () => {
    expect(isValidExtensionDependency(VALID, nameToKind)).toBe(true);
  });
  it("accepts kind absent (kind is optional)", () => {
    const { kind, ...noKind } = VALID;
    expect(isValidExtensionDependency(noKind, nameToKind)).toBe(true);
  });
  it("REJECTS a packageName-only row (a bypass to guard against)", () => {
    expect(isValidExtensionDependency({ packageName: "@cinatra-ai/nango-connector" }, nameToKind)).toBe(false);
  });
  it("rejects a missing/invalid edgeType", () => {
    expect(isValidExtensionDependency({ ...VALID, edgeType: undefined }, nameToKind)).toBe(false);
    expect(isValidExtensionDependency({ ...VALID, edgeType: "bogus" }, nameToKind)).toBe(false);
  });
  it("rejects a missing/invalid requirement", () => {
    expect(isValidExtensionDependency({ ...VALID, requirement: undefined }, nameToKind)).toBe(false);
    expect(isValidExtensionDependency({ ...VALID, requirement: "maybe" }, nameToKind)).toBe(false);
  });
  it("rejects an invalid versionConstraint", () => {
    expect(isValidExtensionDependency({ ...VALID, versionConstraint: undefined }, nameToKind)).toBe(false);
    expect(isValidExtensionDependency({ ...VALID, versionConstraint: { kind: "semver-range" } }, nameToKind)).toBe(false);
    expect(isValidExtensionDependency({ ...VALID, versionConstraint: { kind: "bogus", range: "*" } }, nameToKind)).toBe(false);
  });
  it("rejects an invalid kind, and a kind that does not match the target's actual kind", () => {
    expect(isValidExtensionDependency({ ...VALID, kind: "bogus" }, nameToKind)).toBe(false);
    expect(isValidExtensionDependency({ ...VALID, kind: "agent" }, nameToKind)).toBe(false); // target is a connector
  });
  it("rejects non-objects", () => {
    expect(isValidExtensionDependency(null)).toBe(false);
    expect(isValidExtensionDependency("@cinatra-ai/nango-connector")).toBe(false);
  });
});

const TEST_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("buildInventory — declared vs undeclared cross-extension classification", () => {
  // Avoids a hardcoded "3 nango-declaring connectors" assertion, which rots
  // every time the decouple sweep removes a connector's cinatra.dependencies
  // entry. The DECLARERS are derived from the raw
  // package.json manifests on disk (the source of truth) — NOT from the
  // classifier output under test (declaredCrossExtensionDeps), so the test is
  // not circular: if a valid declaration were mis-dropped from `declared` and/or
  // mis-listed in `undeclared`, this fails.
  it("every manifest-declared cross-extension dep is classified declared, never undeclared", async () => {
    const inv = await buildInventory();
    const allNames = new Set(inv.extensions.map((e) => e.name));
    const nameToKind = new Map(inv.extensions.map((e) => [e.name, e.kind]));

    for (const ext of inv.extensions) {
      const pkg = JSON.parse(readFileSync(join(TEST_REPO_ROOT, ext.dir, "package.json"), "utf8"));
      const cinDeps = Array.isArray(pkg.cinatra?.dependencies) ? pkg.cinatra.dependencies : [];
      const npmDeps = pkg.dependencies ?? {};
      const workspaceDeps = new Set(
        Object.entries(npmDeps)
          .filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"))
          .map(([k]) => k),
      );
      // Source of truth (raw manifest): a dep is a DECLARED cross-extension dep
      // when it carries the FULL valid ExtensionDependency shape in
      // cinatra.dependencies AND is a workspace dep AND a known sibling
      // extension. Mirrors the gate's own "declared" rule, computed from disk
      // rather than read back from the classifier.
      const manifestDeclared = cinDeps
        .filter((d) => isValidExtensionDependency(d, nameToKind))
        .map((d) => d.packageName)
        .filter((p) => p !== ext.name && allNames.has(p) && workspaceDeps.has(p));

      // The classifier's declaredCrossExtensionDeps MUST equal the disk-derived
      // manifest declarations EXACTLY — never dropping a real declaration (which
      // would then be mis-flagged as undeclared coupling) nor inventing one. This
      // runs for ALL extensions, so it stays non-vacuous even when the set is
      // empty repo-wide: a classifier that spuriously emitted a declared dep would
      // fail here.
      expect(
        [...new Set(ext.declaredCrossExtensionDeps ?? [])].sort(),
        `${ext.name}: declaredCrossExtensionDeps must equal the on-disk manifest declarations`,
      ).toEqual([...new Set(manifestDeclared)].sort());
      for (const dep of manifestDeclared) {
        expect(
          ext.undeclaredCrossExtensionImports,
          `${ext.name}: declared dep ${dep} wrongly flagged undeclared`,
        ).not.toContain(dep);
      }
    }

    // Connector→SDK decouple: a "declared cross-extension dep" needs a
    // sibling in BOTH cinatra.dependencies AND a package.json workspace:* dep — but
    // the npm half is itself a sdkOnly violation now, so the sweep removed every
    // such npm dep (provider→facade registers through the SDK registry; siblings
    // remain in cinatra.dependencies only, as activation metadata). manifestDeclared
    // is therefore empty repo-wide today, so the obsolete `checked > 0` tripwire
    // (which only twenty-connector→crm-connector ever satisfied) is replaced by the
    // per-extension EQUALITY assertion above — the live, non-vacuous guard against
    // the classifier inventing or dropping a declaration.
  });
});

// The import-ban gate is only as good as the scanner that feeds it. These prove
// the scanner catches EVERY import form + every scope it claims to — a scanner
// regression to "only static `from` imports" (or "only @cinatra-ai") would let
// real coupling through the gate undetected. (Earlier tests fed the gate
// PRE-COMPUTED imports, so they couldn't catch a scanner regression.)
describe("scanHostImportsInText — catches every @/ import FORM", () => {
  it("catches from / bare-import / dynamic-import / require / backtick", () => {
    const text = [
      `import { a } from "@/lib/from-form";`,
      `import "@/lib/bare-form";`,
      `const c = await import("@/lib/dynamic-form");`,
      `const d = require("@/lib/require-form");`,
      "const e = import(`@/lib/backtick-form`);",
    ].join("\n");
    expect([...scanHostImportsInText(text)].sort()).toEqual([
      "@/lib/backtick-form",
      "@/lib/bare-form",
      "@/lib/dynamic-form",
      "@/lib/from-form",
      "@/lib/require-form",
    ]);
  });

  it("ignores @/ inside comments (strips before scanning) and never trips on https://", () => {
    const text = [
      `// import "@/lib/commented-line";`,
      `/* import "@/lib/commented-block"; */`,
      `const url = "https://example.com/@/not-an-import";`,
      `import { real } from "@/lib/real";`,
    ].join("\n");
    expect([...scanHostImportsInText(text)]).toEqual(["@/lib/real"]);
  });
});

describe("scanCrossExtImportsInText — every scope, not just @cinatra-ai", () => {
  const allNames = new Set([
    "@cinatra-ai/email-connector",
    "@example-vendor/blog-connector",
    "@cinatra-ai/gmail-connector",
  ]);
  it("catches an @example-vendor cross-extension import (regression: scope blind spot)", () => {
    const text = `import { x } from "@example-vendor/blog-connector";`;
    expect([...scanCrossExtImportsInText(text, "@cinatra-ai/gmail-connector", allNames)]).toEqual([
      "@example-vendor/blog-connector",
    ]);
  });
  it("catches dynamic + require forms across extensions", () => {
    const text = [
      `const a = await import("@cinatra-ai/email-connector");`,
      `const b = require("@example-vendor/blog-connector");`,
    ].join("\n");
    expect([...scanCrossExtImportsInText(text, "@cinatra-ai/gmail-connector", allNames)].sort()).toEqual([
      "@cinatra-ai/email-connector",
      "@example-vendor/blog-connector",
    ]);
  });
  it("excludes self-imports and non-extension scoped deps (radix/sdk)", () => {
    const text = [
      `import "@cinatra-ai/gmail-connector";`, // self
      `import { Dialog } from "@radix-ui/react-dialog";`, // not an extension
      `import { x } from "@cinatra-ai/sdk-extensions";`, // not in allNames
    ].join("\n");
    expect([...scanCrossExtImportsInText(text, "@cinatra-ai/gmail-connector", allNames)]).toEqual([]);
  });
});

// Structural invariants only — no hardcoded counts, so this survives the
// extraction sweeps (extensions leaving the tree changes counts but not these
// invariants).
describe("inventory generator", () => {
  it("produces a coherent, acyclic, fully-kinded inventory", async () => {
    const inv = await buildInventory();

    // every extension has a known kind
    const KINDS = new Set(["agent", "connector", "artifact", "skill", "workflow"]);
    for (const x of inv.extensions) {
      expect(KINDS.has(x.kind), `${x.name} has kind ${x.kind}`).toBe(true);
    }

    // No in-tree exemptions: anthropic-connector is un-exempt — extractable like
    // every other connector. Every extension is an extract target.
    expect(inv.summary.inTreeExempt).toEqual([]);
    expect(inv.summary.extractTarget).toBe(inv.summary.totalExtensions - inv.summary.inTreeExempt.length);

    // dependency graph is acyclic (extraction order must be a valid topo sort)
    expect(inv.extractionOrder.cyclicOrUnresolved).toEqual([]);
    expect(inv.extractionOrder.order.length).toBe(inv.extensions.length);

    // every graph edge points at a real, inventoried extension
    const names = new Set(inv.extensions.map((x) => x.name));
    for (const e of inv.dependencyGraph) {
      expect(names.has(e.from)).toBe(true);
      expect(names.has(e.to)).toBe(true);
      expect(e.sources.length).toBeGreaterThan(0);
    }

    // EVERY cross-extension static import must produce a confident graph edge
    // (else extraction order can place a dependency after its dependent).
    const edgeKeys = new Set(inv.dependencyGraph.map((e) => `${e.from}::${e.to}`));
    const orderIdx = new Map(inv.extractionOrder.order.map((n, i) => [n, i]));
    for (const x of inv.extensions) {
      for (const dep of x.crossExtensionImports) {
        expect(edgeKeys.has(`${x.name}::${dep}`), `${x.name} -> ${dep} has a graph edge`).toBe(true);
        // dependency extracted before dependent
        expect(orderIdx.get(dep)).toBeLessThan(orderIdx.get(x.name));
      }
    }

    // the empirical host-import surface is non-empty (drives the ABI port set)
    expect(inv.summary.distinctHostInternalImports.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SDK-only coupling detection (the tightened import-ban dimension). The
// canonical rule: an extension's ONLY permitted first-party `@cinatra-ai/*`
// CODE deps are the SDK packages (sdk-extensions, sdk-ui); every other
// @cinatra-ai/* or sibling-scope (@example-vendor/*) code dep — via a runtime
// import, an `import type`, OR a package.json dep/peerDep — is a violation.
// ---------------------------------------------------------------------------
const SELF = "@cinatra-ai/some-connector";

describe("scanSdkOnlyImportsInText (source-import detection)", () => {
  it("(a) flags a RUNTIME import of a non-SDK @cinatra-ai package", () => {
    const hits = scanSdkOnlyImportsInText(
      `import { registerMcpModule } from "@cinatra-ai/mcp-server";`,
      SELF,
    );
    expect([...hits]).toEqual(["@cinatra-ai/mcp-server"]);
  });

  it("(b) flags an `import type` of a non-SDK @cinatra-ai package", () => {
    const hits = scanSdkOnlyImportsInText(
      `import type { SemanticArtifactManifest } from "@cinatra-ai/objects";`,
      SELF,
    );
    expect([...hits]).toEqual(["@cinatra-ai/objects"]);
  });

  it("(d) flags a non-@cinatra-ai sibling-extension scope (@example-vendor/*)", () => {
    const hits = scanSdkOnlyImportsInText(
      `import { blogFacade } from "@example-vendor/blog-connector";`,
      SELF,
      new Set(["@cinatra-ai", "@example-vendor"]),
    );
    expect([...hits]).toEqual(["@example-vendor/blog-connector"]);
  });

  it("(e) does NOT flag the SDK packages (sdk-extensions, sdk-ui) — value OR type", () => {
    expect([...scanSdkOnlyImportsInText(`import type { Ctx } from "@cinatra-ai/sdk-extensions";`, SELF)]).toEqual([]);
    expect([...scanSdkOnlyImportsInText(`import { register } from "@cinatra-ai/sdk-extensions";`, SELF)]).toEqual([]);
    // a portable SDK SUBPATH (e.g. sdk-ui/marketplace) is allowed too — it
    // collapses to the allowed base package.
    expect([...scanSdkOnlyImportsInText(`import { MarketplaceCard } from "@cinatra-ai/sdk-ui/marketplace";`, SELF)]).toEqual([]);
  });

  it("collapses a non-SDK SUBPATH import to its base package (the ratchet unit)", () => {
    const hits = scanSdkOnlyImportsInText(
      `import { creds } from "@cinatra-ai/mcp-server/credentials";\n` +
        `import { handlers } from "@cinatra-ai/objects/mcp-handlers";`,
      SELF,
    );
    expect([...hits].sort()).toEqual(["@cinatra-ai/mcp-server", "@cinatra-ai/objects"]);
  });

  it("ignores third-party scoped deps (radix, openai, …) and self-imports", () => {
    expect([...scanSdkOnlyImportsInText(`import { z } from "zod";\nimport * as R from "@radix-ui/react-dialog";`, SELF)]).toEqual([]);
    expect([...scanSdkOnlyImportsInText(`import { x } from "${SELF}/facade";`, SELF)]).toEqual([]);
  });

  it("does not count a non-SDK import that lives only in a comment (stripComments)", () => {
    // mirrors the resend-connector false-positive guard
    expect([...scanSdkOnlyImportsInText(`// historical: import { x } from "@cinatra-ai/mcp-server"\nconst a = 1;`, SELF)]).toEqual([]);
  });
});

describe("sdkOnlyManifestDeps (package.json detection)", () => {
  it("(c) flags a non-SDK @cinatra-ai entry in dependencies", () => {
    const hits = sdkOnlyManifestDeps(
      { dependencies: { "@cinatra-ai/mcp-server": "workspace:*", "@cinatra-ai/sdk-extensions": "workspace:*", zod: "^4" } },
      SELF,
    );
    expect([...hits].sort()).toEqual(["@cinatra-ai/mcp-server"]);
  });

  it("(c) flags a non-SDK @cinatra-ai entry in peerDependencies", () => {
    const hits = sdkOnlyManifestDeps(
      { peerDependencies: { "@cinatra-ai/nango-connector": "*" } },
      SELF,
    );
    expect([...hits]).toEqual(["@cinatra-ai/nango-connector"]);
  });

  it("(d) flags a sibling-scope (@example-vendor/*) dep in deps/peerDeps", () => {
    const hits = sdkOnlyManifestDeps(
      { dependencies: { "@example-vendor/blog-connector": "workspace:*" } },
      SELF,
      new Set(["@cinatra-ai", "@example-vendor"]),
    );
    expect([...hits]).toEqual(["@example-vendor/blog-connector"]);
  });

  it("(e) does NOT flag SDK packages and ignores third-party deps + self", () => {
    const hits = sdkOnlyManifestDeps(
      {
        dependencies: {
          "@cinatra-ai/sdk-extensions": "workspace:*",
          "@cinatra-ai/sdk-ui": "workspace:*",
          "@radix-ui/react-dialog": "^1",
          [SELF]: "workspace:*",
        },
      },
      SELF,
    );
    expect([...hits]).toEqual([]);
  });
});

describe("isSdkOnlyViolation / basePackageOf (predicate edges)", () => {
  it("the two SDK packages are the only allowed first-party code deps", () => {
    expect([...SDK_PACKAGES].sort()).toEqual(["@cinatra-ai/sdk-extensions", "@cinatra-ai/sdk-ui"]);
    expect(isSdkOnlyViolation("@cinatra-ai/sdk-extensions")).toBe(false);
    expect(isSdkOnlyViolation("@cinatra-ai/sdk-ui")).toBe(false);
    expect(isSdkOnlyViolation("@cinatra-ai/sdk-ui/marketplace")).toBe(false);
  });
  it("non-SDK first-party + sibling scope violate; third-party + relative do not", () => {
    expect(isSdkOnlyViolation("@cinatra-ai/mcp-server")).toBe(true);
    // a sibling extension scope: injected (the default scope set is derived from
    // the on-disk extensions/ dirs, which a unit test must not depend on).
    expect(isSdkOnlyViolation("@example-vendor/blog-connector", new Set(["@cinatra-ai", "@example-vendor"]))).toBe(true);
    expect(isSdkOnlyViolation("@radix-ui/react-dialog")).toBe(false);
    expect(isSdkOnlyViolation("zod")).toBe(false);
    expect(isSdkOnlyViolation("./relative")).toBe(false);
  });
  it("basePackageOf collapses subpaths and rejects relative/bare specifiers", () => {
    expect(basePackageOf("@cinatra-ai/mcp-server/credentials")).toBe("@cinatra-ai/mcp-server");
    expect(basePackageOf("@scope/pkg")).toBe("@scope/pkg");
    expect(basePackageOf("pkg/sub")).toBe("pkg");
    expect(basePackageOf("./x")).toBeNull();
    expect(basePackageOf("@scope")).toBeNull();
  });
});

describe("buildInventory — sdkOnlyViolations per extension (live, real repo)", () => {
  it("records ZERO non-SDK first-party coupling (every extension is SDK-only-clean) and (f) NEVER lets SDK packages in", async () => {
    const inv = await buildInventory();
    // The connector decouple is complete: every extension imports ONLY the SDK
    // packages now, so no extension carries non-SDK first-party coupling. (The
    // detector's positive/negative behavior is proven non-vacuously by the
    // isSdkOnlyViolation unit tests above; this live-repo test asserts the achieved
    // end-state + that the live inventory shape never mis-flags an SDK package.)
    const anyViolations = inv.extensions.some((x) => (x.sdkOnlyViolations ?? []).length > 0);
    expect(anyViolations).toBe(false);
    // no extension's sdkOnlyViolations ever includes an SDK package
    for (const x of inv.extensions) {
      for (const v of x.sdkOnlyViolations ?? []) {
        expect(SDK_PACKAGES.has(v), `${x.name} flagged SDK pkg ${v}`).toBe(false);
      }
    }
  });
});

// Facade-primitive overrides are DERIVED from extension manifests
// (cinatra.facadePrimitives — cinatra#151 Stage 4). The hand-written
// connectors-catalog overrides.mjs map is retired; this derivation is the
// single source for the inventory's primitive->connector candidate mapping.
describe("deriveFacadePrimitiveOverrides — manifest-driven, deterministic", () => {
  const writeFixture = (dir, name, cinatra) => {
    const pkgDir = join(dir, name.split("/")[1] ?? name);
    mkdirSync(pkgDir, { recursive: true });
    const pkgPath = join(pkgDir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name, cinatra }, null, 2));
    return { scope: "cinatra-ai", slug: name, dir: pkgDir, pkgPath };
  };

  it("maps each declared facade primitive to the declaring package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "inv-facade-"));
    const entries = [
      writeFixture(tmp, "@cinatra-ai/gmail-connector", { facadePrimitives: ["email_send"] }),
      writeFixture(tmp, "@cinatra-ai/apollo-connector", {}),
    ];
    expect(deriveFacadePrimitiveOverrides(entries)).toEqual({
      email_send: "@cinatra-ai/gmail-connector",
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ignores malformed declarations (non-array, non-string, empty) and unreadable manifests", () => {
    const tmp = mkdtempSync(join(tmpdir(), "inv-facade-"));
    const entries = [
      writeFixture(tmp, "@cinatra-ai/a-connector", { facadePrimitives: "email_send" }),
      writeFixture(tmp, "@cinatra-ai/b-connector", { facadePrimitives: [42, "", "ok_prim"] }),
      { scope: "cinatra-ai", slug: "missing", dir: tmp, pkgPath: join(tmp, "nope/package.json") },
    ];
    expect(deriveFacadePrimitiveOverrides(entries)).toEqual({
      ok_prim: "@cinatra-ai/b-connector",
    });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("collision: lexicographically-first package wins regardless of scan order (deterministic)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "inv-facade-"));
    const a = writeFixture(tmp, "@cinatra-ai/aaa-connector", { facadePrimitives: ["email_send"] });
    const b = writeFixture(tmp, "@cinatra-ai/zzz-connector", { facadePrimitives: ["email_send"] });
    expect(deriveFacadePrimitiveOverrides([a, b])).toEqual({
      email_send: "@cinatra-ai/aaa-connector",
    });
    expect(deriveFacadePrimitiveOverrides([b, a])).toEqual({
      email_send: "@cinatra-ai/aaa-connector",
    });
    rmSync(tmp, { recursive: true, force: true });
  });
});
