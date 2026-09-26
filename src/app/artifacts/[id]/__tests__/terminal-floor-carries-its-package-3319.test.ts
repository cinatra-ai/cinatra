/**
 * THE TERMINAL FLOOR CARRIES THE PACKAGE ITS TYPE NAMES (cinatra#3319).
 *
 * `specs/app-artifact-review.html` §V words the floor's diagnostic as three
 * segments — "a sanitized, telemetry-safe one-line diagnostic (package · slot ·
 * reason, never a raw error or manifest value)" — and its own example sentence
 * draws all three: `review target unavailable — package "@acme/support", slot
 * "detail", reason "requires-rebuild"`.
 *
 * The composer in `review-target-mount.tsx` is already written for three
 * segments and drops the first only when the VALUE it is handed is null. On the
 * terminal arm that value was null unconditionally, so the sentence lost its
 * package on BOTH surfaces — the artifact page's floor and the review target's
 * floor read the same resolver. The package is not a guess there: the resolution
 * receives the row's own `baseType`, and the host already owns the ONE
 * normalization that reduces any id form to the package a declaration is keyed
 * by (`artifactKindLabelPackageId`).
 *
 * WHAT THIS FILE DRIVES: the resolver's terminal arm, over the id forms that
 * normalization is written for, and the composer over the value it answers. The
 * `requires-rebuild` arm already carried a real package and is pinned here
 * unchanged, so the cut cannot move it.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { artifactKindLabelPackageId } from "@/lib/artifacts/artifact-kind-label";

import {
  _resetFirstPartySeedForTests,
  resolveArtifactDisplayMount,
} from "../renderer-resolution";
import { reviewTargetFloorDiagnostic } from "../review-target-mount";

const ORG = "org_3319_terminal_floor_package";
const NO_PRIMARY: EffectiveIdentity = { kind: "no-primary" };
/** A media type nothing in the tree claims, so the ladder reaches its terminal
 *  arm rather than a representation handler. */
const UNCLAIMED_MIME = "application/vnd.cinatra.nothing-claims-this";

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
});

function terminalFloorFor(baseType: string) {
  return resolveArtifactDisplayMount({
    orgId: ORG,
    baseType,
    identity: NO_PRIMARY,
    mime: UNCLAIMED_MIME,
    propsApiVersion: 2,
  });
}

/** The id forms the host's own normalization is written for, each with the
 *  package it reduces to — read off that function rather than transcribed, so
 *  this file and the cut cannot disagree about what the id yields. */
const ID_FORMS: { label: string; baseType: string }[] = [
  { label: "a scoped object-type id", baseType: "@acme/support:case" },
  { label: "a versioned id", baseType: "@cinatra-ai/email@1.2.0" },
  { label: "an unscoped id", baseType: "blog-idea" },
];

describe("the terminal floor names the package whose type found no display", () => {
  for (const { label, baseType } of ID_FORMS) {
    it(`carries the package for ${label} (${baseType})`, async () => {
      const expected = artifactKindLabelPackageId(baseType);
      expect(expected, "the normalization yields a package for this form").not.toBe("");

      const mount = await terminalFloorFor(baseType);

      expect(mount).toEqual({
        kind: "floor",
        slot: "detail",
        dispatch: "fallback",
        packageName: expected,
        reason: "no-display",
      });
    });
  }

  it("answers null for an id that yields no package at all", async () => {
    const baseType = "   ";
    expect(artifactKindLabelPackageId(baseType)).toBe("");

    const mount = await terminalFloorFor(baseType);

    expect(mount).toEqual({
      kind: "floor",
      slot: "detail",
      dispatch: "fallback",
      packageName: null,
      reason: "no-display",
    });
  });
});

describe("the composed sentence carries the package segment", () => {
  it("draws all three segments in the drawing's own shape", async () => {
    const mount = await terminalFloorFor("@acme/support:case");
    if (mount.kind !== "floor") throw new Error("the terminal arm answered no floor");

    expect(reviewTargetFloorDiagnostic(mount.packageName, mount.slot, mount.reason)).toBe(
      'review target unavailable — package "@acme/support", slot "detail", reason "no-display"',
    );
  });

  it("drops the segment only when there is genuinely no package", () => {
    // §V's artifact-level floor has no package to name, and the composer's own
    // two-segment sentence is the honest reading there — not a default the
    // terminal arm falls into.
    expect(reviewTargetFloorDiagnostic(null, "detail", "unknown-or-tombstoned")).toBe(
      'review target unavailable — slot "detail", reason "unknown-or-tombstoned"',
    );
  });
});

describe("the rebuild arm is not moved by the cut", () => {
  it("keeps the package the registry declared for it", async () => {
    const PKG = "@acme/support-artifact";
    const TYPE = `${PKG}:case`;
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: PKG });

    const mount = await resolveArtifactDisplayMount({
      orgId: ORG,
      baseType: TYPE,
      identity: { kind: "extension", extension: PKG },
      mime: UNCLAIMED_MIME,
      propsApiVersion: 2,
    });

    expect(mount).toMatchObject({
      kind: "floor",
      packageName: PKG,
      reason: "requires-rebuild",
    });
  });
});
