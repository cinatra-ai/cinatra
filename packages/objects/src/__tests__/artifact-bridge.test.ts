import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// register-artifact-extensions.ts is `import "server-only"` (fs + bridge);
// neutralise the RSC guard for the node test env (same pattern as the
// extensions package tests).
vi.mock("server-only", () => ({}));

import { z } from "zod";
import { ARTIFACT_UI_SDK_ABI_RANGE } from "@cinatra-ai/sdk-extensions/artifact-contract";
import type { EffectiveIdentity } from "../effective-identity";
import type { ObjectTypeDefinition, SemanticArtifactManifest } from "../types";
import { objectTypeRegistry, matcherManifestRegistry } from "../registry";
import { semanticRendererRegistry } from "../artifact-renderer-registry";
import { claimedTypeRegisteringPackage } from "../claims";
import {
  registerArtifactExtensions,
  registerParsedArtifactManifest,
} from "../integration/register-artifact-extensions";

// EXPLICIT-DECLARED-TYPES model (ratified manifest rule, entry 95, epic
// cinatra#1785): a pack declares the object types it owns in `objectTypes`, and
// the bridge registers EXACTLY those — surfaced in `listArtifacts()` under their
// exact objectTypeId. There is NO `${pkg}:artifact` umbrella and NO
// auto-derivation; the `mode` discriminator is gone. A NOVEL artifact type is
// discovered purely by dropping a `kind:"artifact"` extension dir that declares
// the type — zero core per-type branches.

function writeExt(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
): void {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(
    path.join(root, dir, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
}

describe("registerArtifactExtensions — descriptor bridge", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-bridge-"));
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });

  it("registers a NOVEL declared artifact type discovered purely from the extension dir", () => {
    writeExt(root, "fixture-thing-artifact", {
      name: "@cinatra-ai/fixture-thing-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          satisfies: ["@cinatra-ai/marketing-icp-artifact"],
          skills: { matchers: ["@cinatra-ai/fixture-matcher:skill"] },
          objectTypes: [
            {
              type: "@cinatra-ai/fixture-thing-artifact:thing",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });

    const count = registerArtifactExtensions(root);
    expect(count).toBe(1);

    const artifacts = objectTypeRegistry.listArtifacts();
    const entry = artifacts.find(
      (d) => d.type === "@cinatra-ai/fixture-thing-artifact:thing",
    );
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("@cinatra-ai/fixture-thing-artifact:thing");
    expect(entry?.isArtifact?.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(entry?.isArtifact?.satisfies).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
    ]);
    // The package-wide matcher/authoring surface is NOT inherited onto the type.
    expect(entry?.isArtifact?.skills).toBeUndefined();
    // …but it DOES land in the meaning-surface channel (cinatra#1891 A3), keyed
    // by package — the matcher runtime's candidate source and the presentation
    // host's threshold read exactly this record.
    const meaning = matcherManifestRegistry.get("@cinatra-ai/fixture-thing-artifact");
    expect(meaning).not.toBeNull();
    expect(meaning!.matcherSkillIds).toEqual(["@cinatra-ai/fixture-matcher:skill"]);
    expect(meaning!.fileMimeTypes).toEqual(["text/markdown"]);
    expect(meaning!.matcherConfidenceThreshold).toBe(0.7); // resolved default
    // NO derived umbrella is ever minted.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/fixture-thing-artifact:artifact"),
    ).toBeNull();
    // resolve() returns the declared type generically — no per-type branch anywhere.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/fixture-thing-artifact:thing"),
    ).not.toBeNull();
  });

  it("registers a manifest carrying the cross-kind dependencies + roles keys (cinatra#151 Stage 5)", () => {
    writeExt(root, "roled-artifact", {
      name: "@cinatra-ai/roled-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        roles: ["artifact-roled-summary"],
        dependencies: [],
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/roled-artifact:summary",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/roled-artifact:summary"),
    ).not.toBeNull();
  });

  it("registers a manifest carrying the cross-kind vendor key (cinatra#1570 installed-card byline)", () => {
    // `vendor` began connector-only but the `{Kind} by {Vendor}` byline reads
    // it kind-agnostically, so a first-party artifact declares it to render
    // "… by Cinatra". Admitted through ARTIFACT_ALLOWED_CINATRA_KEYS; the bridge
    // must NOT reject the manifest as extraneous.
    writeExt(root, "vendored-artifact", {
      name: "@cinatra-ai/vendored-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        displayName: "Vendored Artifact",
        vendor: { key: "cinatra-ai", name: "Cinatra" },
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/vendored-artifact:doc",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/vendored-artifact:doc"),
    ).not.toBeNull();
  });

  it("skips a kind:'artifact' package with an invalid/missing descriptor", () => {
    writeExt(root, "broken-artifact", {
      name: "@cinatra-ai/broken-artifact",
      version: "0.0.1",
      cinatra: { kind: "artifact", artifact: { artifactType: "legacy-substrate" } },
    });
    writeExt(root, "nodesc-artifact", {
      name: "@cinatra-ai/nodesc-artifact",
      version: "0.0.1",
      cinatra: { kind: "artifact" },
    });
    expect(registerArtifactExtensions(root)).toBe(0);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });

  it("still skips a manifest carrying a genuinely disallowed cinatra key", () => {
    writeExt(root, "drifted-artifact", {
      name: "@cinatra-ai/drifted-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        toolAccess: "all",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/drifted-artifact:thing",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(0);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });

  // Entry 95 / epic #1785: a type-less manifest mints NOTHING — umbrella
  // derivation is RETIRED. It hits the deprecation/no-op path (loud warn), NEVER
  // an umbrella. (A pure-representation renderer with no owned type binds via the
  // representation provider, not this object-type bridge.)
  it("registers NOTHING for a manifest that declares no objectTypes (no umbrella, deprecation path)", () => {
    writeExt(root, "typeless-artifact", {
      name: "@cinatra-ai/typeless-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: { accepts: { file: { mimeTypes: ["audio/mpeg"] } } },
      },
    });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let count: number;
    try {
      count = registerArtifactExtensions(root);
    } finally {
      console.warn = orig;
    }
    expect(count).toBe(0);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    // No derived umbrella minted.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/typeless-artifact:artifact"),
    ).toBeNull();
    expect(
      warns.some((w) => w.includes("declares no objectTypes") && w.includes("retired")),
    ).toBe(true);
  });

  it("ignores non-artifact dirs and is idempotent (replace-by-id)", () => {
    writeExt(root, "some-connector", {
      name: "@cinatra-ai/some-connector",
      version: "0.0.1",
      cinatra: { kind: "connector" },
    });
    writeExt(root, "real-artifact", {
      name: "@cinatra-ai/real-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/pdf"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/real-artifact:pdf",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    // second pass = idempotent replace, still exactly one artifact entry
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(1);
  });

  // cinatra#1425 AC-5 — MULTI-VENDOR registration. A THIRD-VENDOR
  // kind:"artifact" package under `<root>/<vendor>/*-artifact` registers
  // through the widened path exactly like a first-party one, keeping its
  // vendor scope in the declared type id. (The host fix: register-all-object-types
  // now passes the extensions ROOT, not the first-party vendor dir, so the
  // bridge's vendor-dir scan actually sees other vendors.)
  it("registers a THIRD-VENDOR kind:'artifact' fixture from its vendor dir, id keeps the vendor scope (AC-5)", () => {
    writeExt(root, path.join("acme-vendor", "competitor-teardown-artifact"), {
      name: "@acme-vendor/competitor-teardown-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            {
              type: "@acme-vendor/competitor-teardown-artifact:teardown",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    // A first-party sibling registers alongside — neither shadows the other.
    writeExt(root, path.join("cinatra-ai", "first-party-artifact"), {
      name: "@cinatra-ai/first-party-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/pdf"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/first-party-artifact:doc",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(2);
    const thirdVendor = objectTypeRegistry.resolve(
      "@acme-vendor/competitor-teardown-artifact:teardown",
    );
    expect(thirdVendor).not.toBeNull();
    expect(thirdVendor?.isArtifact?.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/first-party-artifact:doc"),
    ).not.toBeNull();
    // Provenance carries the third-vendor package name (teardown symmetry).
    expect(
      objectTypeRegistry.getTypesForPackage("@acme-vendor/competitor-teardown-artifact"),
    ).toEqual(["@acme-vendor/competitor-teardown-artifact:teardown"]);
  });
});

// ---------------------------------------------------------------------------
// LIVE-TREE anti-vacuity (cinatra#151 Stage 6): every kind:"artifact"
// extension PRESENT in this tree's materialized universe must register its
// self-owned declared object types through the bridge — a missing self-owned
// type means the allowlist or schema drifted from the real manifests. A pack
// that declares no owned types legitimately registers nothing (entry 95 / epic
// #1785: umbrella derivation is retired). When the extensions tree is absent
// entirely (bare package checkout) the suite skips loudly instead of asserting
// vacuously.
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, readFileSync } from "node:fs";

describe("registerArtifactExtensions — live extensions tree", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

  it("registers every present pack's self-owned declared object types (zero drift)", () => {
    if (!existsSync(EXT_ROOT)) {
      console.warn(
        "[artifact-bridge.test] extensions/ tree absent — live-tree registration pin skipped",
      );
      return;
    }
    // The self-owned declared types the bridge is REQUIRED to surface.
    const expectedTypes: string[] = [];
    for (const scope of readdirSync(EXT_ROOT, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      for (const dir of readdirSync(path.join(EXT_ROOT, scope.name), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const pkgPath = path.join(EXT_ROOT, scope.name, dir.name, "package.json");
        if (!existsSync(pkgPath)) continue;
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg?.cinatra?.kind !== "artifact" || typeof pkg.name !== "string") continue;
          const claims = pkg?.cinatra?.artifact?.objectTypes;
          if (!Array.isArray(claims)) continue;
          for (const claim of claims) {
            const type = claim?.type;
            if (typeof type === "string" && claimedTypeRegisteringPackage(type) === pkg.name) {
              expectedTypes.push(type);
            }
          }
        } catch {
          /* not a parseable package dir */
        }
      }
    }
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
    let threw: unknown = null;
    try {
      registerArtifactExtensions(EXT_ROOT);
    } catch (e) {
      threw = e;
    }
    expect(threw, String(threw)).toBeNull();
    const registered = new Set(objectTypeRegistry.listArtifacts().map((d) => d.type));
    for (const type of expectedTypes) {
      expect(registered.has(type), `${type} did not register`).toBe(true);
    }
    // No derived umbrella (`${pkg}:artifact`) is EVER minted for any present pack.
    for (const t of registered) {
      expect(t.endsWith(":artifact"), `umbrella-shaped id leaked: ${t}`).toBe(false);
    }
    // cinatra#1891 A3: the bundled matcher packs land REAL channel entries (the
    // candidate source the matcher runtime reads) — the marketing-strategy pack
    // that registers no object type is now discoverable.
    const channelPkgs = new Set(matcherManifestRegistry.list().map((e) => e.packageName));
    expect(channelPkgs.has("@cinatra-ai/marketing-strategy-artifact")).toBe(true);
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });
});

// cinatra#1429 — per-type JSON-Schema → Zod validator registration. The
// activation gate (objects_save / objects_update) resolves a declared type's
// validator from objectTypeRegistry. The bridge compiles each objectTypes type's
// inline JSON Schema into a real validator registered under the declared type id
// — resolvable, enforcing, AND surfaced in listArtifacts() (no umbrella).
describe("registerArtifactExtensions — per-type validators (cinatra#1429)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-type-validator-"));
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("compiles an objectTypes inline JSON Schema into an enforcing validator under the declared type id", () => {
    writeExt(root, "invoice-artifact", {
      name: "@cinatra-ai/invoice-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/json"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/invoice-artifact:invoice",
              claim: "dedicated",
              schema: {
                type: "object",
                required: ["amount"],
                properties: { amount: { type: "number" } },
                additionalProperties: true,
              },
            },
          ],
        },
      },
    });

    expect(registerArtifactExtensions(root)).toBe(1);

    const def = objectTypeRegistry.resolve("@cinatra-ai/invoice-artifact:invoice");
    expect(def).not.toBeNull();
    // The registered schema ENFORCES the declared shape (no longer permissive).
    expect(def!.schema.safeParse({ amount: 42 }).success).toBe(true);
    expect(def!.schema.safeParse({ amount: "not-a-number" }).success).toBe(false);
    expect(def!.schema.safeParse({}).success).toBe(false); // missing required 'amount'

    // The declared type IS surfaced as an artifact; NO umbrella is minted.
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(listed).toContain("@cinatra-ai/invoice-artifact:invoice");
    expect(listed).not.toContain("@cinatra-ai/invoice-artifact:artifact");

    // Teardown reaps the declared type via provenance.
    const removed = objectTypeRegistry.removeByPackage("@cinatra-ai/invoice-artifact");
    expect(removed).toContain("@cinatra-ai/invoice-artifact:invoice");
    expect(objectTypeRegistry.resolve("@cinatra-ai/invoice-artifact:invoice")).toBeNull();
  });
});

// S7/M2 (cinatra#1631): the bridge registers EVERY declared semantic slot —
// `detail` AND the activated `listRow` — for each declared type (no umbrella);
// `preview` never enters the semantic keyspace.
describe("registerArtifactExtensions — semantic slot registration (S7 listRow)", () => {
  let root: string;

  const rowWinner: EffectiveIdentity = {
    kind: "extension",
    extension: "@cinatra-ai/rowful-artifact",
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-bridge-s7-"));
    objectTypeRegistry._clearForTests();
    semanticRendererRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
    semanticRendererRegistry._clearForTests();
  });

  it("registers detail + listRow renderers per declared slot for the declared type (preview stays representation-only)", () => {
    writeExt(root, "rowful-artifact", {
      name: "@cinatra-ai/rowful-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/json"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/rowful-artifact:row",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
          ui: {
            abiVersion: 1,
            sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
            renderers: {
              detail: { entry: "./src/detail.tsx", propsApiVersion: 1 },
              preview: { entry: "./src/preview.tsx", propsApiVersion: 1 },
              listRow: { entry: "./src/row.tsx", propsApiVersion: 1 },
            },
          },
        },
      },
    });

    expect(registerArtifactExtensions(root)).toBe(1);

    const declared = "@cinatra-ai/rowful-artifact:row";
    expect(semanticRendererRegistry.resolve(declared, rowWinner)).toMatchObject({
      slot: "detail",
      generatedKey: "@cinatra-ai/rowful-artifact::detail",
    });
    expect(semanticRendererRegistry.resolve(declared, rowWinner, "listRow")).toMatchObject({
      slot: "listRow",
      generatedKey: "@cinatra-ai/rowful-artifact::listRow",
    });
    // No umbrella exists → no umbrella renderer.
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/rowful-artifact:artifact", rowWinner),
    ).toBeNull();
    // `preview` is representation-only — never a semantic descriptor.
    const snapshot = semanticRendererRegistry._snapshot();
    expect(snapshot.every((d) => d.slot === "detail" || d.slot === "listRow")).toBe(true);
  });

  it("a detail-only manifest registers no listRow descriptor (glyph floors)", () => {
    writeExt(root, "detailonly-artifact", {
      name: "@cinatra-ai/detailonly-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/json"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/detailonly-artifact:thing",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
          ui: {
            abiVersion: 1,
            sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
            renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
          },
        },
      },
    });

    expect(registerArtifactExtensions(root)).toBe(1);
    const declared = "@cinatra-ai/detailonly-artifact:thing";
    const detailWinner: EffectiveIdentity = {
      kind: "extension",
      extension: "@cinatra-ai/detailonly-artifact",
    };
    expect(semanticRendererRegistry.resolve(declared, detailWinner)).not.toBeNull();
    expect(semanticRendererRegistry.resolve(declared, detailWinner, "listRow")).toBeNull();
  });

  it("a listRow-only manifest registers the row capability for the declared type", () => {
    writeExt(root, "rowonly-artifact", {
      name: "@cinatra-ai/rowonly-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/json"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/rowonly-artifact:thing",
              claim: "dedicated",
              schema: { type: "object" },
            },
          ],
          ui: {
            abiVersion: 1,
            sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
            renderers: { listRow: { entry: "./src/row.tsx", propsApiVersion: 1 } },
          },
        },
      },
    });

    expect(registerArtifactExtensions(root)).toBe(1);
    const w: EffectiveIdentity = {
      kind: "extension",
      extension: "@cinatra-ai/rowonly-artifact",
    };
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:thing", w, "listRow"),
    ).not.toBeNull();
    // No umbrella exists → no umbrella renderer.
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:artifact", w, "listRow"),
    ).toBeNull();
    expect(semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:thing", w)).toBeNull();
  });
});

// entry 95 / epic #1785 — the EXPLICIT-DECLARED-TYPES registration substrate. A
// pack mints NO generic `${pkg}:artifact` umbrella; each declared objectTypes
// type it OWNS is registered as its own first-class artifact type, surfaced
// under its exact objectTypeId with NO package-wide matcher/authoring
// inheritance. Exercised through the exported registration seam
// `registerParsedArtifactManifest`.
describe("registerParsedArtifactManifest — explicit declared types (entry 95, cinatra#1785)", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });

  // cinatra#1891 A3 — the CORE fix at the registration seam: a MATCHER-ONLY pack
  // (declares matchers + accepts.file, NO objectTypes) mints no object type
  // (returns false) yet lands its meaning surface in the channel. Pre-fix this
  // pack was invisible to the matcher runtime — the silent-no-op root cause.
  it("a matcher-only (no objectTypes) manifest registers a channel entry even though it mints no type", () => {
    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        skills: { matchers: ["@cinatra-ai/marketing-strategy-artifact:marketing-strategy-matcher"] },
        matcherConfidenceThreshold: 0.7,
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/marketing-strategy-artifact",
    );
    // No object type minted (the no-objectTypes deprecation path).
    expect(registered).toBe(false);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    // …but the meaning surface IS in the channel — the matcher runtime can now
    // discover it.
    const meaning = matcherManifestRegistry.get("@cinatra-ai/marketing-strategy-artifact");
    expect(meaning).not.toBeNull();
    expect(meaning!.matcherSkillIds).toEqual([
      "@cinatra-ai/marketing-strategy-artifact:marketing-strategy-matcher",
    ]);
    expect(meaning!.matcherConfidenceThreshold).toBe(0.7);
    expect(meaning!.fileMimeTypes).toEqual(["text/markdown"]);
  });

  it("mints NO umbrella and registers each declared type as its own surfaced artifact type", () => {
    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        // Package-wide matcher/authoring surface that MUST NOT be inherited.
        skills: { matchers: ["@cinatra-ai/pkg-matcher:skill"] },
        matcherConfidenceThreshold: 0.9,
        templates: [
          { id: "t", form: "file", mimeType: "text/markdown", path: "./t.md" },
        ],
        objectTypes: [
          {
            type: "@cinatra-ai/linkedin-artifacts:post-draft",
            claim: "dedicated",
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
              additionalProperties: true,
            },
          },
          {
            type: "@cinatra-ai/linkedin-artifacts:org-post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(registered).toBe(true);

    // AC: zero catch-all — the generic umbrella is NEVER minted.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:artifact"),
    ).toBeNull();
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(listed).not.toContain("@cinatra-ai/linkedin-artifacts:artifact");

    // AC: each declared type IS surfaced as an artifact under its exact objectTypeId.
    expect(listed).toContain("@cinatra-ai/linkedin-artifacts:post-draft");
    expect(listed).toContain("@cinatra-ai/linkedin-artifacts:org-post-draft");
    expect(listed).toHaveLength(2);

    // The per-type validator ENFORCES its inline schema (activation gate is live).
    const postDraft = objectTypeRegistry.resolve(
      "@cinatra-ai/linkedin-artifacts:post-draft",
    );
    expect(postDraft!.schema.safeParse({ text: "hi" }).success).toBe(true);
    expect(postDraft!.schema.safeParse({ text: 5 }).success).toBe(false);
    expect(postDraft!.schema.safeParse({}).success).toBe(false); // required 'text'

    // AC: NO package-wide matcher/authoring inheritance — the per-type descriptor
    // carries representation forms but NOT the package skills / threshold /
    // templates / nested types.
    expect(postDraft!.isArtifact).toBeDefined();
    expect(postDraft!.isArtifact!.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(postDraft!.isArtifact!.skills).toBeUndefined();
    expect(postDraft!.isArtifact!.matcherConfidenceThreshold).toBeUndefined();
    expect(postDraft!.isArtifact!.templates).toBeUndefined();
    expect(postDraft!.isArtifact!.objectTypes).toBeUndefined();

    // The package-wide matcher surface stripped off the TYPE lives in the
    // channel instead (cinatra#1891 A3) — a declared-type pack is in BOTH the
    // object-type registry AND the meaning-surface channel.
    const meaning = matcherManifestRegistry.get("@cinatra-ai/linkedin-artifacts");
    expect(meaning).not.toBeNull();
    expect(meaning!.matcherSkillIds).toEqual(["@cinatra-ai/pkg-matcher:skill"]);
    expect(meaning!.matcherConfidenceThreshold).toBe(0.9);

    // Provenance reaps every declared type on teardown.
    const removed = objectTypeRegistry.removeByPackage(
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(removed).toContain("@cinatra-ai/linkedin-artifacts:post-draft");
    expect(removed).toContain("@cinatra-ai/linkedin-artifacts:org-post-draft");
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:post-draft"),
    ).toBeNull();
  });

  it("resolves the declared type by its EXACT objectTypeId (discriminator substrate)", () => {
    registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/x-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/x-artifacts",
    );
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/x-artifacts:post-draft"),
    ).not.toBeNull();
    // A DIFFERENT id in the same package does not resolve — exact-id resolution,
    // never a package-coarse umbrella match.
    expect(objectTypeRegistry.resolve("@cinatra-ai/x-artifacts:other")).toBeNull();
    expect(objectTypeRegistry.resolve("@cinatra-ai/x-artifacts:artifact")).toBeNull();
  });

  it("registers per-type semantic renderers (never an umbrella renderer)", () => {
    semanticRendererRegistry._clearForTests();
    registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/x-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
        ui: {
          abiVersion: 1,
          sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
          renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
        },
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/x-artifacts",
    );
    const winner: EffectiveIdentity = {
      kind: "extension",
      extension: "@cinatra-ai/x-artifacts",
    };
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/x-artifacts:post-draft", winner),
    ).not.toBeNull();
    // No umbrella type exists, so no umbrella renderer was registered.
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/x-artifacts:artifact", winner),
    ).toBeNull();
    semanticRendererRegistry._clearForTests();
  });

  it("surfaces only self-namespaced types; skips cross-namespace claims (WITH or WITHOUT a schema)", () => {
    // Ownership is by namespace, never by inline schema (epic #1448/#1424: exactly
    // one runtime registrar per type; the claimant schema is activation evidence,
    // not a second registrar). A pack must never shadow another package's
    // registrant — that would let this pack's removeByPackage delete the real
    // owner's type via the replace-by-id registry.
    const ok = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        objectTypes: [
          // self-owned → registered as an artifact.
          {
            type: "@cinatra-ai/x-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
          // cross-namespace, NO inline schema → the owner registers it; skip.
          { type: "@cinatra-ai/other-pkg:thing", claim: "dedicated" },
          // cross-namespace WITH an inline schema → schema is activation evidence,
          // NOT ownership; still the owner's to register; skip (never shadow).
          {
            type: "@cinatra-ai/another-pkg:widget",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/x-artifacts",
    );
    expect(ok).toBe(true);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/x-artifacts:post-draft"),
    ).not.toBeNull();
    expect(objectTypeRegistry.resolve("@cinatra-ai/other-pkg:thing")).toBeNull();
    expect(objectTypeRegistry.resolve("@cinatra-ai/another-pkg:widget")).toBeNull();
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toEqual([
      "@cinatra-ai/x-artifacts:post-draft",
    ]);
  });

  it("reconciles a declared-type-set change: a dropped type is removed, no umbrella ever appears", () => {
    // First register the package declaring TWO owned types.
    registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/linkedin-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
          {
            type: "@cinatra-ai/linkedin-artifacts:org-post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type).sort()).toEqual([
      "@cinatra-ai/linkedin-artifacts:org-post-draft",
      "@cinatra-ai/linkedin-artifacts:post-draft",
    ]);

    // Re-register the SAME package now declaring only ONE type. The dropped id
    // must be reconciled away; no `${pkg}:artifact` umbrella ever appears.
    registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/linkedin-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:artifact"),
    ).toBeNull();
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:org-post-draft"),
    ).toBeNull();
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toEqual([
      "@cinatra-ai/linkedin-artifacts:post-draft",
    ]);
  });

  // entry 95 / epic #1785 — a type-less manifest hits the DEPRECATION path: it
  // mints NO type and NEVER an umbrella. This is the "legacy manifest, if any
  // pack is still blocked" resolution outcome.
  it("mints NO umbrella for a type-less manifest — deprecation path, never a catch-all", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let ok: boolean;
    try {
      ok = registerParsedArtifactManifest(
        { accepts: { file: { mimeTypes: ["text/markdown"] } } } as SemanticArtifactManifest,
        "@cinatra-ai/classic-artifact",
      );
    } finally {
      console.warn = orig;
    }
    expect(ok).toBe(false);
    expect(objectTypeRegistry.resolve("@cinatra-ai/classic-artifact:artifact")).toBeNull();
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    expect(
      warns.some((w) => w.includes("declares no objectTypes") && w.includes("retired")),
    ).toBe(true);
  });

  // PERMANENT namespace tombstones (cinatra#1789, epic #1785): the registration
  // seam rejects a package under a retired dynamic namespace.
  it("rejects a package under a retired dynamic namespace — nothing registers", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let ok: boolean;
    try {
      ok = registerParsedArtifactManifest(
        {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          objectTypes: [
            { type: "@dynamic/types:thing", claim: "dedicated", schema: { type: "object" } },
          ],
        } as SemanticArtifactManifest,
        "@dynamic/types",
      );
    } finally {
      console.warn = orig;
    }
    expect(ok).toBe(false);
    expect(objectTypeRegistry.resolve("@dynamic/types:artifact")).toBeNull();
    expect(objectTypeRegistry.resolve("@dynamic/types:thing")).toBeNull();
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    expect(warns.some((w) => w.includes("permanently-retired dynamic namespace"))).toBe(true);
  });

  it("skips a cross-namespace tombstoned claim (owner-owned) — no umbrella, nothing self-owned registers", () => {
    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@dynamic/types:invoice", // a tombstoned CROSS-namespace claim
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/normal-artifact",
    );
    // No self-owned type → nothing registered, and NO umbrella is minted.
    expect(registered).toBe(false);
    expect(objectTypeRegistry.resolve("@cinatra-ai/normal-artifact:artifact")).toBeNull();
    expect(objectTypeRegistry.resolve("@dynamic/types:invoice")).toBeNull();
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CROSS-NAMESPACE clobber prevention (epic #1785). An artifact pack that CLAIMS
// a type another registrar OWNS (a cross-namespace `objectTypes` claim) must NOT
// re-register a def over it — that silently clobbered the owner's rich
// definition and, with the registry conflict guard, would now throw at boot.
// Empirics: the email-artifacts pack over the host `@cinatra-ai/email:body`
// (content + identityKey) / `@cinatra-ai/email:sent-email` (idempotencyKey
// identity), and the default-artifact floor over the host generic
// `@cinatra-ai/objects:object` (cinatraAgentRunId identityKey).
// ---------------------------------------------------------------------------

function hostEmailBodyDef(): ObjectTypeDefinition<unknown> {
  return {
    type: "@cinatra-ai/email:body",
    category: "content",
    schema: z.object({ runId: z.string().optional(), contactId: z.string().optional() }),
    lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
    renderers: { listRow: null, card: null, detail: null },
    identityKey: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const runId = typeof d.runId === "string" && d.runId.length > 0 ? d.runId : null;
      if (!runId) return null;
      const contactId =
        typeof d.contactId === "string" && d.contactId.length > 0 ? d.contactId : null;
      return contactId ? `${runId}:${contactId}` : runId;
    },
  } as unknown as ObjectTypeDefinition<unknown>;
}

function hostSentEmailDef(): ObjectTypeDefinition<unknown> {
  return {
    type: "@cinatra-ai/email:sent-email",
    category: "report",
    schema: z.object({ idempotencyKey: z.string().min(1) }),
    lifecycle: { sources: ["agent", "import"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    identityKey: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const k = typeof d.idempotencyKey === "string" ? d.idempotencyKey : null;
      return k && k.length > 0 ? k : null;
    },
  } as unknown as ObjectTypeDefinition<unknown>;
}

function hostGenericObjectDef(): ObjectTypeDefinition<unknown> {
  return {
    type: "@cinatra-ai/objects:object",
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
    renderers: { listRow: null, card: null, detail: null },
    identityKey: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const runId = d.cinatraAgentRunId;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
  } as unknown as ObjectTypeDefinition<unknown>;
}

// Host member LinkedIn post-draft def (register-types.ts registerLinkedinObjectTypes,
// cinatra#1457/#1808) — draftable content, member-constrained destination, dedup on
// (runId, destinationId) so distinct drafts in one run never merge.
function hostLinkedinPostDraftDef(): ObjectTypeDefinition<unknown> {
  return {
    type: "@cinatra-ai/linkedin:post-draft",
    category: "content",
    schema: z.object({
      content: z.string().optional(),
      destination: z
        .object({
          accountId: z.string().optional(),
          destinationType: z.literal("member").optional(),
          destinationId: z.string().optional(),
        })
        .optional(),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
      mediaAssetRefs: z.array(z.string()).optional(),
      runId: z.string().optional(),
      campaignId: z.string().optional(),
    }),
    lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
    renderers: { listRow: null, card: null, detail: null },
    identityKey: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const runId = typeof d.runId === "string" && d.runId.length > 0 ? d.runId : null;
      const dest =
        d.destination && typeof d.destination === "object"
          ? (d.destination as Record<string, unknown>)
          : {};
      const destinationId =
        typeof dest.destinationId === "string" && dest.destinationId.length > 0
          ? dest.destinationId
          : null;
      return runId && destinationId ? `${runId}:${destinationId}` : null;
    },
  } as unknown as ObjectTypeDefinition<unknown>;
}

// Host Drupal external node-pointer def (register-types.ts registerDrupalObjectTypes,
// cinatra#1465) — an `external` connector-owned POINTER to a Drupal node (canonical
// content lives in Drupal). category content; dedup on (instance, node) =
// connectorRef.connectorId + connectorRef.externalId so a re-sync of the same node
// updates that pointer row in place, and a row missing either id keeps its random
// identity rather than collapsing distinct pointers.
function hostDrupalNodeDef(): ObjectTypeDefinition<unknown> {
  return {
    type: "@cinatra-ai/drupal:node",
    category: "content",
    schema: z
      .object({
        artifactType: z.literal("connector-ref"),
        originKind: z.literal("external_link"),
        mime: z.string().min(1),
        title: z.string().optional(),
        excerpt: z.string().optional(),
        connectorRef: z
          .object({
            url: z.string().min(1),
            connectorId: z.string().min(1),
            externalId: z.string().min(1),
            state: z.enum(["linked", "stale", "dangling"]),
          })
          .strict(),
      })
      .passthrough(),
    // Written by connector sync only (agent/import); the `external` claim narrows
    // post-create mutableBy to [] — reference state moves via connector verification.
    lifecycle: { sources: ["agent", "import"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    identityKey: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const ref =
        d.connectorRef && typeof d.connectorRef === "object"
          ? (d.connectorRef as Record<string, unknown>)
          : {};
      const connectorId =
        typeof ref.connectorId === "string" && ref.connectorId.length > 0
          ? ref.connectorId
          : null;
      const externalId =
        typeof ref.externalId === "string" && ref.externalId.length > 0
          ? ref.externalId
          : null;
      return connectorId && externalId ? `${connectorId}:${externalId}` : null;
    },
  } as unknown as ObjectTypeDefinition<unknown>;
}

describe("registerParsedArtifactManifest — cross-namespace claims never clobber the owner (epic #1785)", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
  });

  it("a pack claiming host email:body / :sent-email leaves both host definitions intact and registers only its self-owned type", () => {
    // Host registers the rich definitions first (register-types.ts boot order).
    objectTypeRegistry.register(hostEmailBodyDef());
    objectTypeRegistry.register(hostSentEmailDef());

    // The email-artifacts pack CLAIMS those cross-namespace ids (with the SAME
    // shape the fs manifest carries) PLUS a self-owned type.
    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/email:body",
            claim: "dedicated",
            schema: { type: "object", additionalProperties: true },
          },
          {
            type: "@cinatra-ai/email:sent-email",
            claim: "dedicated",
            schema: { type: "object", additionalProperties: true },
          },
          {
            // A SELF-owned type — this one MUST register.
            type: "@cinatra-ai/email-artifacts:local-thing",
            claim: "dedicated",
            schema: {
              type: "object",
              required: ["k"],
              properties: { k: { type: "string" } },
              additionalProperties: true,
            },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/email-artifacts",
    );
    // The self-owned type registered; NO umbrella was minted.
    expect(registered).toBe(true);
    expect(objectTypeRegistry.resolve("@cinatra-ai/email-artifacts:artifact")).toBeNull();

    // email:body — host content/identityKey definition PRESERVED (not clobbered
    // to report/no-identityKey).
    const body = objectTypeRegistry.resolve("@cinatra-ai/email:body");
    expect(body).not.toBeNull();
    expect(body!.category).toBe("content");
    expect(typeof body!.identityKey).toBe("function");
    expect(body!.identityKey!({ runId: "r1", contactId: "c9" })).toBe("r1:c9");
    // Still host-owned (no bridge provenance attached to it).
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/email-artifacts")).not.toContain(
      "@cinatra-ai/email:body",
    );

    // email:sent-email — host idempotencyKey identity PRESERVED.
    const sent = objectTypeRegistry.resolve("@cinatra-ai/email:sent-email");
    expect(sent).not.toBeNull();
    expect(sent!.identityKey!({ idempotencyKey: "idem-42" })).toBe("idem-42");

    // The SELF-owned type DID register its enforcing validator under the pack.
    const local = objectTypeRegistry.resolve("@cinatra-ai/email-artifacts:local-thing");
    expect(local).not.toBeNull();
    expect(local!.schema.safeParse({ k: "ok" }).success).toBe(true);
    expect(local!.schema.safeParse({}).success).toBe(false);
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/email-artifacts")).toEqual(
      expect.arrayContaining(["@cinatra-ai/email-artifacts:local-thing"]),
    );
  });

  it("the linkedin-artifacts pack claiming host linkedin:post-draft [draftable] leaves the host definition intact (and mints no umbrella) (cinatra#1457)", () => {
    // Host registers the rich draftable member post-draft first (boot order).
    objectTypeRegistry.register(hostLinkedinPostDraftDef());

    // The linkedin-artifacts pack (fc751149) CLAIMS the cross-namespace host id
    // (dedicated, draftable) — the pack manifest carries the disposition/mutability
    // class + arbitration, NEVER a second runtime registrar (epic #1448 principle 5).
    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["text/markdown", "text/plain"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/linkedin:post-draft",
            claim: "dedicated",
            dispositions: {
              projection: "artifact-safe",
              pinnable: true,
              snapshotPolicy: "content",
              sensitivity: "normal",
              mutability: "draftable",
            },
            schema: { type: "object", additionalProperties: true },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/linkedin-artifacts",
    );
    // The ONLY declared claim is cross-namespace (registrant @cinatra-ai/linkedin,
    // not the claiming pack) → nothing self-owned registers, and umbrella/derived
    // minting is retired (entry 95, epic #1785) → NO `${pkg}:artifact` umbrella.
    expect(registered).toBe(false);
    expect(objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:artifact")).toBeNull();

    // linkedin:post-draft — host draftable member definition PRESERVED (the pack
    // never registers a cross-namespace type, so the host def is untouched).
    const draft = objectTypeRegistry.resolve("@cinatra-ai/linkedin:post-draft");
    expect(draft).not.toBeNull();
    expect(draft!.category).toBe("content");
    expect(typeof draft!.identityKey).toBe("function");
    // Dedup on (runId, destinationId); never collapse onto runId alone.
    expect(
      draft!.identityKey!({ runId: "r1", destination: { destinationId: "d9" } }),
    ).toBe("r1:d9");
    expect(draft!.identityKey!({ runId: "r1" })).toBeNull();
    // Still host-owned — no bridge provenance attaches the claimed id to the pack.
    expect(
      objectTypeRegistry.getTypesForPackage("@cinatra-ai/linkedin-artifacts"),
    ).not.toContain("@cinatra-ai/linkedin:post-draft");
  });

  it("the drupal-artifacts pack claiming host drupal:node [external] leaves the host definition intact (and mints no umbrella) (cinatra#1465)", () => {
    // Host registers the rich external node-pointer def first (boot order).
    objectTypeRegistry.register(hostDrupalNodeDef());

    // The drupal-artifacts pack (8bd7bf36) CLAIMS the cross-namespace host id
    // (dedicated, external) — the pack manifest carries the disposition/mutability
    // class + arbitration, NEVER a second runtime registrar (epic #1448 principle 5).
    // `external` ⇒ pinnable:false + snapshotPolicy:none (you pin the immutable
    // snapshot record, never the live pointer).
    const registered = registerParsedArtifactManifest(
      {
        accepts: { connectorRef: { resolvedMimeTypes: ["text/html"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/drupal:node",
            claim: "dedicated",
            dispositions: {
              projection: "artifact-safe",
              pinnable: false,
              snapshotPolicy: "none",
              sensitivity: "normal",
              mutability: "external",
            },
            schema: { type: "object", additionalProperties: true },
          },
        ],
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/drupal-artifacts",
    );
    // The ONLY declared claim is cross-namespace (registrant @cinatra-ai/drupal,
    // not the claiming pack) → nothing self-owned registers, and umbrella/derived
    // minting is retired (entry 95, epic #1785) → NO `${pkg}:artifact` umbrella.
    expect(registered).toBe(false);
    expect(objectTypeRegistry.resolve("@cinatra-ai/drupal-artifacts:artifact")).toBeNull();

    // drupal:node — host external pointer definition PRESERVED (the pack never
    // registers a cross-namespace type, so the host def is untouched).
    const node = objectTypeRegistry.resolve("@cinatra-ai/drupal:node");
    expect(node).not.toBeNull();
    expect(node!.category).toBe("content");
    expect(typeof node!.identityKey).toBe("function");
    // Dedup on (instance, node) = connectorId:externalId; never collapse onto one id.
    expect(
      node!.identityKey!({ connectorRef: { connectorId: "drupal-1", externalId: "42" } }),
    ).toBe("drupal-1:42");
    expect(node!.identityKey!({ connectorRef: { connectorId: "drupal-1" } })).toBeNull();
    // Still host-owned — no bridge provenance attaches the claimed id to the pack.
    expect(
      objectTypeRegistry.getTypesForPackage("@cinatra-ai/drupal-artifacts"),
    ).not.toContain("@cinatra-ai/drupal:node");
  });

  it("the default-artifact floor claim over the host generic object type does not clobber its identityKey (and mints no umbrella)", () => {
    objectTypeRegistry.register(hostGenericObjectDef());

    const registered = registerParsedArtifactManifest(
      {
        accepts: { file: { mimeTypes: ["*/*"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/objects:object", // the cross-namespace floor claim
            claim: "default",
            schema: { type: "object" },
          },
        ],
      } as SemanticArtifactManifest,
      "@cinatra-ai/default-artifact",
    );
    // The only claim is cross-namespace → nothing self-owned registers, no umbrella.
    expect(registered).toBe(false);
    expect(objectTypeRegistry.resolve("@cinatra-ai/default-artifact:artifact")).toBeNull();

    const generic = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    expect(generic).not.toBeNull();
    // The host generic dedup identity (cinatraAgentRunId) survives.
    expect(generic!.identityKey!({ cinatraAgentRunId: "run-7" })).toBe("run-7");
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/default-artifact")).not.toContain(
      "@cinatra-ai/objects:object",
    );
  });
});
