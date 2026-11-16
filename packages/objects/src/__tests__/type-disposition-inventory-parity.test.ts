// Type-driven disposition INVENTORY PARITY gate (epic #1785).
//
// The retirement makes the in-process registry the single disposition authority,
// relocating every disposition that used to live on a DB `objectTypes` pack
// claim onto its defining registration. This gate pins that relocation COMPLETE:
// every host-registered type that a dev-extension pack claims with a disposition
// must resolve, from the registry, to the SAME payload the pack manifest
// declares. A missed relocation would silently flip a type's projection — most
// dangerously @cinatra-ai/email:recipient (sensitive addresses) from 'none' to
// the artifact-safe default, leaking it into the derived index — so this parity
// is a MERGE GATE (codex convergence, 2026-07-19).
//
// Self-contained: the EXPECTED inventory below is the source of truth captured
// from the pack manifests. When the dev-extension manifests are present (synced
// in CI), an additional cross-check asserts they still match — catching a future
// manifest-side drift.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isDispositionGovernedType,
  matcherManifestRegistry,
  objectTypeRegistry,
  resolveTypeProjectionDisposition,
} from "../registry";
import { semanticRendererRegistry } from "../artifact-renderer-registry";
import { registerAllObjectTypes } from "../integration/register-types";
import { registerParsedArtifactManifest } from "../integration/register-artifact-extensions";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import type { TypeDispositions } from "../types";

// React-free renderer slots — keep the registration pure TS (same harness as
// register-types-generic.test.ts).
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./generic-renderers", () => ({
  GenericObjectListRow: vi.fn(),
  GenericObjectCard: vi.fn(),
  GenericObjectDetail: vi.fn(),
}));

// The complete relocated inventory — every host type a dev pack claims with a
// disposition, keyed by the claiming pack manifest. Captured from the manifests
// under extensions/cinatra-ai/*/package.json @15c23ad.
const INVENTORY: Record<string, Record<string, TypeDispositions>> = {
  "email-artifacts": {
    "@cinatra-ai/email:body": {
      projection: "artifact-safe",
      pinnable: true,
      snapshotPolicy: "content",
      sensitivity: "normal",
      mutability: "draftable",
    },
    "@cinatra-ai/email:sent-email": {
      projection: "artifact-safe",
      pinnable: false,
      snapshotPolicy: "metadata",
      sensitivity: "normal",
      mutability: "record",
    },
    "@cinatra-ai/email:received-reply": {
      projection: "artifact-safe",
      pinnable: false,
      snapshotPolicy: "metadata",
      sensitivity: "normal",
      mutability: "record",
    },
  },
  "linkedin-artifacts": {
    "@cinatra-ai/linkedin:post-draft": {
      projection: "artifact-safe",
      pinnable: true,
      snapshotPolicy: "content",
      sensitivity: "normal",
      mutability: "draftable",
    },
  },
  // drupal-artifacts is not here: the pack declares its pointer type in its own
  // namespace (cinatra#4366), so the HOST registers no Drupal type. Its own case
  // below reads the materialized pack.
};

// The Drupal pointer, owned by its pack (cinatra#4366). The pack renamed its
// claim from the host-registered `@cinatra-ai/drupal:node` to a type in its own
// namespace, which the artifact bridge registers from the claim under the pack.
const DRUPAL_PACK_DIR = "drupal-artifacts";
const DRUPAL_POINTER_TYPE = "@cinatra-ai/drupal-artifacts:node-pointer";
const DRUPAL_RETIRED_HOST_TYPE = "@cinatra-ai/drupal:node";
// The retired id's tombstone: the same flags as before the move, projection
// artifact-safe included, so its stored rows stay in the artifact library.
const DRUPAL_RETIRED_DISPOSITIONS: TypeDispositions = {
  projection: "artifact-safe",
  pinnable: false,
  snapshotPolicy: "none",
  sensitivity: "normal",
  mutability: "external",
};
const DRUPAL_POINTER_DISPOSITIONS: TypeDispositions = {
  projection: "artifact-safe",
  pinnable: false,
  snapshotPolicy: "none",
  sensitivity: "normal",
  mutability: "external",
};

const ALL_ENTRIES = Object.values(INVENTORY).flatMap((pack) => Object.entries(pack));

beforeAll(() => {
  registerAllObjectTypes();
});

describe("type-driven disposition inventory parity (epic #1785 merge gate)", () => {
  it.each(ALL_ENTRIES)(
    "%s resolves from the registry to its relocated pack disposition",
    (type, expected) => {
      const def = objectTypeRegistry.resolve(type);
      expect(def, `${type} must be host-registered`).not.toBeNull();
      expect(def!.dispositions).toEqual(expected);
    },
  );

  it("SECURITY: @cinatra-ai/email:recipient stays projection:'none' + sensitivity:'sensitive'", () => {
    // cinatra#3089: the host no longer registers the recipient type; the email
    // pack's own claim governs it (cinatra#3970). The pinned claim of the
    // materialized pack is registered through the claim-governed road and the
    // resolved definition is read. An absent pack fails this case, never skips it.
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const manifestPath = `${root}extensions/cinatra-ai/email-artifacts/package.json`;
    expect(existsSync(manifestPath), `the materialized email pack must be present at ${manifestPath}`).toBe(true);
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      cinatra?: { artifact?: unknown };
    };
    const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
    expect(parsed.ok, "the email pack's artifact manifest must parse").toBe(true);
    if (!parsed.ok) return;
    try {
      registerParsedArtifactManifest(parsed.manifest, pkg.name);
      const def = objectTypeRegistry.resolve("@cinatra-ai/email:recipient");
      expect(def).not.toBeNull();
      expect(objectTypeRegistry.definerOf("@cinatra-ai/email:recipient")).toBe(pkg.name);
      expect(def!.dispositions?.projection).toBe("none");
      expect(def!.dispositions?.sensitivity).toBe("sensitive");
      expect(def!.identityKey?.({ runId: "run-1", contactKey: "contact:c1" })).toBe("run-1:contact:c1");
    } finally {
      objectTypeRegistry.removeByPackage(pkg.name);
      semanticRendererRegistry.removeByPackage(pkg.name);
      matcherManifestRegistry.removeByPackage(pkg.name);
    }
  });

  it("the host keeps the retired Drupal id as a read-only tombstone whose stored rows stay listed", () => {
    // registerAllObjectTypes ran in beforeAll; no pack is registered here.
    // Stored rows of the retired id must stay governed: resolvable, still
    // admitted to the artifact library as before the move (governed and
    // artifact-safe: the predicate of artifactObjectTypeIds() in
    // src/lib/artifacts/artifact-service.ts), and marked retired so no write
    // reaches them.
    const def = objectTypeRegistry.resolve(DRUPAL_RETIRED_HOST_TYPE);
    expect(def, "the retired id must stay resolvable").not.toBeNull();
    expect(objectTypeRegistry.definerOf(DRUPAL_RETIRED_HOST_TYPE)).toBeNull();
    expect(objectTypeRegistry.isRetired(DRUPAL_RETIRED_HOST_TYPE)).toBe(true);
    expect(isDispositionGovernedType(DRUPAL_RETIRED_HOST_TYPE)).toBe(true);
    expect(resolveTypeProjectionDisposition(DRUPAL_RETIRED_HOST_TYPE)).toBe("artifact-safe");
    expect(def!.dispositions).toEqual(DRUPAL_RETIRED_DISPOSITIONS);
    // The former contract stays on the tombstone: content category, the
    // agent/import sources and the old pointer schema.
    expect(def!.category).toBe("content");
    expect(def!.lifecycle).toEqual({ sources: ["agent", "import"], mutableBy: ["agent"] });
    expect(def!.isArtifact).toBeUndefined();
    expect(
      def!.schema.safeParse({
        artifactType: "connector-ref",
        originKind: "external_link",
        mime: "text/html",
        connectorRef: {
          url: "https://cms.example.test/node/42",
          connectorId: "drupal-1",
          externalId: "42",
          state: "linked",
        },
      }).success,
    ).toBe(true);
    // No other host type is retired.
    const retired = objectTypeRegistry.list().filter((d) => objectTypeRegistry.isRetired(d.type));
    expect(retired.map((d) => d.type)).toEqual([DRUPAL_RETIRED_HOST_TYPE]);
  });

  it("the drupal-artifacts pack OWNS its pointer type with the external disposition", () => {
    // The pinned pack is materialized in CI; an absent pack fails this case,
    // never skips it (the same rule as the email recipient case above).
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const manifestPath = `${root}extensions/cinatra-ai/${DRUPAL_PACK_DIR}/package.json`;
    expect(existsSync(manifestPath), `the materialized Drupal pack must be present at ${manifestPath}`).toBe(true);
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      cinatra?: { artifact?: { objectTypes?: Array<{ type: string; dispositions?: TypeDispositions }> } };
    };
    const claims = pkg.cinatra?.artifact?.objectTypes ?? [];
    expect(claims.map((c) => c.type)).toEqual([DRUPAL_POINTER_TYPE]);
    expect(claims[0]!.dispositions).toEqual(DRUPAL_POINTER_DISPOSITIONS);
    const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
    expect(parsed.ok, "the Drupal pack's artifact manifest must parse").toBe(true);
    if (!parsed.ok) return;
    try {
      expect(registerParsedArtifactManifest(parsed.manifest, pkg.name)).toBe(true);
      const def = objectTypeRegistry.resolve(DRUPAL_POINTER_TYPE);
      expect(def).not.toBeNull();
      expect(objectTypeRegistry.definerOf(DRUPAL_POINTER_TYPE)).toBe(pkg.name);
      expect(def!.dispositions).toEqual(DRUPAL_POINTER_DISPOSITIONS);
      // The bridge's contract for a pack's own type, pinned because it differs
      // from the retired host definition: category report (was content), the
      // agent/user/import sources with an agent/user baseline (was agent/import
      // and agent), and no identity key (was connectorId:externalId).
      expect(def!.category).toBe("report");
      expect(def!.lifecycle).toEqual({
        sources: ["agent", "user", "import"],
        mutableBy: ["agent", "user"],
      });
      expect(def!.identityKey).toBeUndefined();
      expect(objectTypeRegistry.isRetired(DRUPAL_POINTER_TYPE)).toBe(false);
      // The pack does not touch the retired id: it stays the host tombstone.
      expect(objectTypeRegistry.definerOf(DRUPAL_RETIRED_HOST_TYPE)).toBeNull();
      expect(objectTypeRegistry.isRetired(DRUPAL_RETIRED_HOST_TYPE)).toBe(true);
      expect(resolveTypeProjectionDisposition(DRUPAL_RETIRED_HOST_TYPE)).toBe("artifact-safe");
    } finally {
      objectTypeRegistry.removeByPackage(pkg.name);
      semanticRendererRegistry.removeByPackage(pkg.name);
      matcherManifestRegistry.removeByPackage(pkg.name);
    }
  });

  it("cross-checks the dev-extension manifests when present (catches manifest-side drift)", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    let checked = 0;
    for (const [pack, types] of Object.entries(INVENTORY)) {
      const manifestPath = `${root}extensions/cinatra-ai/${pack}/package.json`;
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        cinatra?: { artifact?: { objectTypes?: Array<{ type: string; dispositions?: TypeDispositions }> } };
      };
      const claims = manifest.cinatra?.artifact?.objectTypes ?? [];
      for (const [type, expected] of Object.entries(types)) {
        const claim = claims.find((c) => c.type === type);
        expect(claim, `${pack} manifest must still claim ${type}`).toBeDefined();
        expect(claim!.dispositions, `${type} manifest disposition drifted from the relocated registry payload`).toEqual(
          expected,
        );
        checked++;
      }
    }
    // Informational: 0 when the synced extensions are absent (local self-contained run).
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
