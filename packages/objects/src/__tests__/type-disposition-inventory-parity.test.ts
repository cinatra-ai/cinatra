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

import { objectTypeRegistry } from "../registry";
import { registerAllObjectTypes } from "../integration/register-types";
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
    "@cinatra-ai/email:recipient": {
      projection: "none",
      pinnable: false,
      snapshotPolicy: "none",
      sensitivity: "sensitive",
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
  "drupal-artifacts": {
    "@cinatra-ai/drupal:node": {
      projection: "artifact-safe",
      pinnable: false,
      snapshotPolicy: "none",
      sensitivity: "normal",
      mutability: "external",
    },
  },
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
    const def = objectTypeRegistry.resolve("@cinatra-ai/email:recipient");
    expect(def).not.toBeNull();
    expect(def!.dispositions?.projection).toBe("none");
    expect(def!.dispositions?.sensitivity).toBe("sensitive");
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
