import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// register-artifact-extensions.ts is `import "server-only"` (fs + bridge);
// neutralise the RSC guard for the node test env (same pattern as the
// extensions package tests).
vi.mock("server-only", () => ({}));

import { ARTIFACT_UI_SDK_ABI_RANGE } from "@cinatra-ai/sdk-extensions/artifact-contract";
import type { EffectiveIdentity } from "../effective-identity";
import type { SemanticArtifactManifest } from "../types";
import { objectTypeRegistry } from "../registry";
import { semanticRendererRegistry } from "../artifact-renderer-registry";
import {
  registerArtifactExtensions,
  registerParsedArtifactManifest,
  resolveArtifactManifestMode,
} from "../integration/register-artifact-extensions";

// Proves the pluggability guarantee: a brand-new artifact type (a NOVEL
// artifactType string that appears NOWHERE in core code) is discovered and
// surfaced via `listArtifacts()` purely by dropping a `kind:"artifact"`
// extension dir — zero core per-type branches.

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
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("registers a NOVEL artifact type discovered purely from the extension dir", () => {
    writeExt(root, "fixture-thing-artifact", {
      name: "@cinatra-ai/fixture-thing-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["text/markdown"] } },
          satisfies: ["@cinatra-ai/marketing-icp-artifact"],
          skills: { matchers: ["@cinatra-ai/fixture-matcher:skill"] },
        },
      },
    });

    const count = registerArtifactExtensions(root);
    expect(count).toBe(1);

    const artifacts = objectTypeRegistry.listArtifacts();
    const entry = artifacts.find(
      (d) => d.type === "@cinatra-ai/fixture-thing-artifact:artifact",
    );
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("@cinatra-ai/fixture-thing-artifact:artifact");
    expect(entry?.isArtifact?.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(entry?.isArtifact?.satisfies).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
    ]);
    // resolve() returns it generically — no per-type branch anywhere.
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/fixture-thing-artifact:artifact"),
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
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/roled-artifact:artifact"),
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
        },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(1);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/vendored-artifact:artifact"),
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
        artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(0);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
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
        artifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
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
  // vendor scope in the type id. (The host fix: register-all-object-types
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
        },
      },
    });
    // A first-party sibling registers alongside — neither shadows the other.
    writeExt(root, path.join("cinatra-ai", "first-party-artifact"), {
      name: "@cinatra-ai/first-party-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
      },
    });
    expect(registerArtifactExtensions(root)).toBe(2);
    const thirdVendor = objectTypeRegistry.resolve(
      "@acme-vendor/competitor-teardown-artifact:artifact",
    );
    expect(thirdVendor).not.toBeNull();
    expect(thirdVendor?.isArtifact?.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/first-party-artifact:artifact"),
    ).not.toBeNull();
    // Provenance carries the third-vendor package name (teardown symmetry).
    expect(
      objectTypeRegistry.getTypesForPackage("@acme-vendor/competitor-teardown-artifact"),
    ).toEqual(["@acme-vendor/competitor-teardown-artifact:artifact"]);
  });
});

// ---------------------------------------------------------------------------
// LIVE-TREE anti-vacuity (cinatra#151 Stage 6): every kind:"artifact"
// extension PRESENT in this tree's materialized universe must register
// through the bridge — a skip means the allowlist or schema drifted from
// the real manifests (exactly the silent class that left listArtifacts()
// empty before Stage 6). Presence-aware: in the required-only universe the
// only artifact extension is the floor type, which still keeps the
// assertion non-vacuous; when the extensions tree is absent entirely (bare
// package checkout) the suite skips loudly instead of asserting vacuously.
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, readFileSync } from "node:fs";

describe("registerArtifactExtensions — live extensions tree", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "extensions");

  it("registers EVERY present kind:'artifact' extension (zero skips)", () => {
    if (!existsSync(EXT_ROOT)) {
      console.warn(
        "[artifact-bridge.test] extensions/ tree absent — live-tree registration pin skipped",
      );
      return;
    }
    const expected: string[] = [];
    for (const scope of readdirSync(EXT_ROOT, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      for (const dir of readdirSync(path.join(EXT_ROOT, scope.name), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const pkgPath = path.join(EXT_ROOT, scope.name, dir.name, "package.json");
        if (!existsSync(pkgPath)) continue;
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg?.cinatra?.kind === "artifact" && typeof pkg.name === "string") {
            expected.push(pkg.name);
          }
        } catch {
          /* not a parseable package dir */
        }
      }
    }
    objectTypeRegistry._clearForTests();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let count: number;
    try {
      count = registerArtifactExtensions(EXT_ROOT);
    } finally {
      console.warn = orig;
    }
    const bridgeWarns = warns.filter((w) => w.includes("[artifacts:bridge]"));
    expect(bridgeWarns, bridgeWarns.join("\n")).toEqual([]);
    expect(count).toBe(expected.length);
    const registered = new Set(objectTypeRegistry.listArtifacts().map((d) => d.type));
    for (const name of expected) {
      expect(registered.has(`${name}:artifact`), `${name} did not register`).toBe(true);
    }
    objectTypeRegistry._clearForTests();
  });
});

// cinatra#1429 — per-claim JSON-Schema → Zod validator registration. The
// activation gate (objects_save / objects_update) resolves a claimed type's
// validator from objectTypeRegistry; before this it only found the permissive
// `${pkg}:artifact` umbrella, so enforcement was INERT. The bridge now compiles
// each objectTypes claim's inline JSON Schema into a real validator registered
// under the CLAIMED type id — resolvable + enforcing, but validation-only (NOT
// added to listArtifacts, which stays one-generic-type-per-package).
describe("registerArtifactExtensions — per-claim validators (cinatra#1429)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-claim-validator-"));
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("compiles an objectTypes inline JSON Schema into an enforcing validator under the claimed type id", () => {
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

    // Validation-only: the per-claim type is NOT surfaced as an artifact — the
    // serving/library surface stays one-generic-type-per-package.
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    expect(listed).toContain("@cinatra-ai/invoice-artifact:artifact"); // the umbrella
    expect(listed).not.toContain("@cinatra-ai/invoice-artifact:invoice");

    // Teardown reaps the per-claim validator via provenance (like the umbrella).
    const removed = objectTypeRegistry.removeByPackage("@cinatra-ai/invoice-artifact");
    expect(removed).toContain("@cinatra-ai/invoice-artifact:invoice");
    expect(objectTypeRegistry.resolve("@cinatra-ai/invoice-artifact:invoice")).toBeNull();
  });
});

// S7/M2 (cinatra#1631): the bridge registers EVERY declared semantic slot —
// `detail` AND the activated `listRow` — for the umbrella type and each claimed
// type; `preview` never enters the semantic keyspace.
describe("registerArtifactExtensions — semantic slot registration (S7 listRow)", () => {
  let root: string;

  const rowWinner: EffectiveIdentity = {
    kind: "extension",
    extension: "@cinatra-ai/rowful-artifact",
    basis: "binding",
    selectable: true,
    assertionId: "sa_row",
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

  it("registers detail + listRow renderers per declared slot (preview stays representation-only)", () => {
    writeExt(root, "rowful-artifact", {
      name: "@cinatra-ai/rowful-artifact",
      version: "0.0.1",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: ["application/json"] } },
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

    const umbrella = "@cinatra-ai/rowful-artifact:artifact";
    expect(semanticRendererRegistry.resolve(umbrella, rowWinner)).toMatchObject({
      slot: "detail",
      generatedKey: "@cinatra-ai/rowful-artifact::detail",
    });
    expect(semanticRendererRegistry.resolve(umbrella, rowWinner, "listRow")).toMatchObject({
      slot: "listRow",
      generatedKey: "@cinatra-ai/rowful-artifact::listRow",
    });
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
          ui: {
            abiVersion: 1,
            sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
            renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
          },
        },
      },
    });

    expect(registerArtifactExtensions(root)).toBe(1);
    const umbrella = "@cinatra-ai/detailonly-artifact:artifact";
    const detailWinner: EffectiveIdentity = {
      kind: "extension",
      extension: "@cinatra-ai/detailonly-artifact",
      basis: "binding",
      selectable: true,
      assertionId: "sa_d",
    };
    expect(semanticRendererRegistry.resolve(umbrella, detailWinner)).not.toBeNull();
    expect(semanticRendererRegistry.resolve(umbrella, detailWinner, "listRow")).toBeNull();
  });

  it("a listRow-only manifest registers the row capability for umbrella + claimed types", () => {
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
      basis: "binding",
      selectable: true,
      assertionId: "sa_r",
    };
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:artifact", w, "listRow"),
    ).not.toBeNull();
    expect(
      semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:thing", w, "listRow"),
    ).not.toBeNull();
    expect(semanticRendererRegistry.resolve("@cinatra-ai/rowonly-artifact:artifact", w)).toBeNull();
  });
});

// cinatra#1452 (epic #1448) — CLAIM-ONLY manifest mode + the exact objectTypeId
// registry substrate. A claim-only pack mints NO generic `${pkg}:artifact`
// umbrella; each objectTypes claim is registered as its own first-class artifact
// type, surfaced under its exact objectTypeId with NO package-wide
// matcher/authoring inheritance. Exercised through the exported mode-dispatch
// seam `registerParsedArtifactManifest` because the `mode` manifest FIELD (its
// schema/type/kind-gate) is owned by the sibling substrate lanes (#1449 / #1453)
// and cannot yet flow through the fs/parse fixture path.
describe("registerParsedArtifactManifest — claim-only manifest mode (cinatra#1452)", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
  });

  it("mints NO umbrella and registers each claim as its own surfaced artifact type", () => {
    const registered = registerParsedArtifactManifest(
      {
        // `mode` is the ratified claim-only discriminator; its schema/type lands
        // in #1449/#1453, so cast until the manifest type carries it.
        mode: "claim-only",
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

    // AC: each claim IS surfaced as an artifact under its exact objectTypeId.
    expect(listed).toContain("@cinatra-ai/linkedin-artifacts:post-draft");
    expect(listed).toContain("@cinatra-ai/linkedin-artifacts:org-post-draft");
    expect(listed).toHaveLength(2);

    // The per-claim type ENFORCES its inline schema (activation gate is live).
    const postDraft = objectTypeRegistry.resolve(
      "@cinatra-ai/linkedin-artifacts:post-draft",
    );
    expect(postDraft!.schema.safeParse({ text: "hi" }).success).toBe(true);
    expect(postDraft!.schema.safeParse({ text: 5 }).success).toBe(false);
    expect(postDraft!.schema.safeParse({}).success).toBe(false); // required 'text'

    // AC: NO package-wide matcher/authoring inheritance — the per-claim descriptor
    // carries representation forms but NOT the package skills / threshold /
    // templates / nested claims.
    expect(postDraft!.isArtifact).toBeDefined();
    expect(postDraft!.isArtifact!.accepts.file?.mimeTypes).toEqual(["text/markdown"]);
    expect(postDraft!.isArtifact!.skills).toBeUndefined();
    expect(postDraft!.isArtifact!.matcherConfidenceThreshold).toBeUndefined();
    expect(postDraft!.isArtifact!.templates).toBeUndefined();
    expect(postDraft!.isArtifact!.objectTypes).toBeUndefined();

    // Provenance reaps every claim-only type on teardown (like the umbrella).
    const removed = objectTypeRegistry.removeByPackage(
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(removed).toContain("@cinatra-ai/linkedin-artifacts:post-draft");
    expect(removed).toContain("@cinatra-ai/linkedin-artifacts:org-post-draft");
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:post-draft"),
    ).toBeNull();
  });

  it("resolves the claim-only type by its EXACT objectTypeId (discriminator substrate)", () => {
    registerParsedArtifactManifest(
      {
        mode: "claim-only",
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

  it("registers per-claim semantic renderers (never an umbrella renderer)", () => {
    semanticRendererRegistry._clearForTests();
    registerParsedArtifactManifest(
      {
        mode: "claim-only",
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
      basis: "binding",
      selectable: true,
      assertionId: "sa_x",
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

  it("surfaces only self-namespaced claims; skips cross-namespace claims (WITH or WITHOUT a schema)", () => {
    // Ownership is by namespace, never by inline schema (epic #1448/#1424: exactly
    // one runtime registrar per type; the claimant schema is activation evidence,
    // not a second registrar). A claim-only pack must never shadow another
    // package's registrant — that would let this pack's removeByPackage delete the
    // real owner's type via the replace-by-id registry.
    const ok = registerParsedArtifactManifest(
      {
        mode: "claim-only",
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

  it("reconciles a mode change: hybrid -> claim-only drops the stale umbrella catch-all", () => {
    // First register the package as HYBRID (umbrella minted + validator claim).
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
    ).not.toBeNull();

    // Re-register the SAME package as CLAIM-ONLY (its manifest changed mode). The
    // forbidden `${pkg}:artifact` umbrella must not survive the transition.
    registerParsedArtifactManifest(
      {
        mode: "claim-only",
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          {
            type: "@cinatra-ai/linkedin-artifacts:post-draft",
            claim: "dedicated",
            schema: { type: "object" },
          },
        ],
      } as unknown as SemanticArtifactManifest,
      "@cinatra-ai/linkedin-artifacts",
    );
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/linkedin-artifacts:artifact"),
    ).toBeNull();
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toEqual([
      "@cinatra-ai/linkedin-artifacts:post-draft",
    ]);
  });

  it("skips a claim-only manifest that ships no objectTypes claims", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let ok: boolean;
    try {
      ok = registerParsedArtifactManifest(
        {
          mode: "claim-only",
          accepts: { file: { mimeTypes: ["text/markdown"] } },
        } as unknown as SemanticArtifactManifest,
        "@cinatra-ai/empty-artifacts",
      );
    } finally {
      console.warn = orig;
    }
    expect(ok).toBe(false);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    expect(
      warns.some((w) => w.includes("claim-only mode but ships no objectTypes")),
    ).toBe(true);
  });

  // PARITY (AC: descriptor-only / hybrid extensions unaffected). With no explicit
  // `mode` — the state of EVERY manifest today, since the parser strips an unknown
  // field — the umbrella is still minted, byte-for-byte today's behavior.
  it("descriptor-only (no mode, no claims) still mints the umbrella", () => {
    expect(resolveArtifactManifestMode({
      accepts: { file: { mimeTypes: ["text/markdown"] } },
    } as SemanticArtifactManifest)).toBe("descriptor-only");
    expect(
      registerParsedArtifactManifest(
        { accepts: { file: { mimeTypes: ["text/markdown"] } } } as SemanticArtifactManifest,
        "@cinatra-ai/classic-artifact",
      ),
    ).toBe(true);
    expect(
      objectTypeRegistry.resolve("@cinatra-ai/classic-artifact:artifact"),
    ).not.toBeNull();
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toContain(
      "@cinatra-ai/classic-artifact:artifact",
    );
  });

  it("hybrid (no mode, WITH claims) mints the umbrella + a validator-only claim type", () => {
    expect(
      resolveArtifactManifestMode({
        accepts: { file: { mimeTypes: ["application/json"] } },
        objectTypes: [
          { type: "@cinatra-ai/hybrid-artifact:thing", claim: "dedicated" },
        ],
      } as SemanticArtifactManifest),
    ).toBe("hybrid");
    expect(
      registerParsedArtifactManifest(
        {
          accepts: { file: { mimeTypes: ["application/json"] } },
          objectTypes: [
            {
              type: "@cinatra-ai/hybrid-artifact:thing",
              claim: "dedicated",
              schema: {
                type: "object",
                required: ["k"],
                properties: { k: { type: "string" } },
              },
            },
          ],
        } as SemanticArtifactManifest,
        "@cinatra-ai/hybrid-artifact",
      ),
    ).toBe(true);
    const listed = objectTypeRegistry.listArtifacts().map((d) => d.type);
    // umbrella surfaced; the claim is validator-ONLY (resolvable, NOT surfaced).
    expect(listed).toContain("@cinatra-ai/hybrid-artifact:artifact");
    expect(listed).not.toContain("@cinatra-ai/hybrid-artifact:thing");
    const claim = objectTypeRegistry.resolve("@cinatra-ai/hybrid-artifact:thing");
    expect(claim).not.toBeNull();
    expect(claim!.schema.safeParse({}).success).toBe(false); // enforces required 'k'
  });

  // PERMANENT namespace tombstones (cinatra#1789, epic #1785): the registration
  // seam rejects a package under a retired dynamic namespace (its derived
  // umbrella id is tombstoned) and drops a cross-namespace tombstoned claim.
  it("rejects a package under a retired dynamic namespace (tombstoned umbrella) — nothing registers", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    let ok: boolean;
    try {
      ok = registerParsedArtifactManifest(
        { accepts: { file: { mimeTypes: ["text/markdown"] } } } as SemanticArtifactManifest,
        "@dynamic/types",
      );
    } finally {
      console.warn = orig;
    }
    expect(ok).toBe(false);
    expect(objectTypeRegistry.resolve("@dynamic/types:artifact")).toBeNull();
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
    expect(warns.some((w) => w.includes("permanently-retired dynamic namespace"))).toBe(true);
  });

  it("drops a cross-namespace tombstoned claim validator in a hybrid manifest (umbrella still mints)", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    try {
      expect(
        registerParsedArtifactManifest(
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
        ),
      ).toBe(true);
    } finally {
      console.warn = orig;
    }
    // The package's own umbrella still registers...
    expect(objectTypeRegistry.resolve("@cinatra-ai/normal-artifact:artifact")).not.toBeNull();
    // ...but the tombstoned claim validator never did.
    expect(objectTypeRegistry.resolve("@dynamic/types:invoice")).toBeNull();
    expect(warns.some((w) => w.includes("permanently-retired dynamic namespace"))).toBe(true);
  });
});
