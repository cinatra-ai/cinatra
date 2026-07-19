/**
 * The boot-time SYSTEM artifact-renderer registrar (epic #1620 M1 Slice B —
 * cinatra#1630, plan §5.1 / §5.3.4). Proves the "no boot registrar" dormancy gap
 * is closed: after reconciliation the four build-bundled bases
 * (image/pdf/audio/video-artifact) resolve to tier "extension" via the BUILD-MAP
 * fast path for EVERY org, and the generation-safe lifecycle holds (self-healing
 * reconcile; system extensions reject uninstall).
 *
 * Uses the REAL generated build map (the four bases) + the REAL arbitration
 * registry — the end-to-end resolution seam, not a synthesized leaf input.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import {
  systemArtifactRendererPackages,
  isSystemArtifactRendererPackage,
  systemRepresentationProviderSpecs,
  reconcileSystemRepresentationProviders,
} from "@/lib/artifacts/system-artifact-renderer-registrar";
import { invalidateArtifactRenderersForPackage } from "@/lib/extension-artifact-renderers-teardown";
import {
  resolveArtifactDispatchInputs,
  classifyLoadablePath,
  _resetFirstPartySeedForTests,
} from "@/app/artifacts/[id]/renderer-resolution";
import { pickArtifactRenderer } from "@/app/artifacts/[id]/renderer-dispatch";

const ORG = "org_system_reg";
const IMAGE = "@cinatra-ai/image-artifact";
const PDF = "@cinatra-ai/pdf-artifact";
const AUDIO = "@cinatra-ai/audio-artifact";
const VIDEO = "@cinatra-ai/video-artifact";

const floor: EffectiveIdentity = { kind: "no-primary" };

function dispatchFor(mime: string) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({
      orgId: ORG,
      baseType: "@cinatra-ai/artifact:object",
      identity: floor,
      mime,
    }),
  );
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

describe("system base set + specs are projected from the generated build map", () => {
  it("recognises the four build-bundled bases as system packages", () => {
    const pkgs = systemArtifactRendererPackages();
    expect(pkgs).toContain(IMAGE);
    expect(pkgs).toContain(PDF);
    expect(pkgs).toContain(AUDIO);
    expect(pkgs).toContain(VIDEO);
    expect(isSystemArtifactRendererPackage(IMAGE)).toBe(true);
    expect(isSystemArtifactRendererPackage("@vendor/marketplace-artifact")).toBe(false);
  });

  it("projects EXACT allowlisted-MIME specs (wildcards expanded, gated by the preview allowlist)", () => {
    const specs = systemRepresentationProviderSpecs();
    // image/pdf ship detail+preview; audio/video ship detail only — bound at the
    // EXACT allowlisted MIME, never the raw wildcard.
    expect(specs).toEqual(
      expect.arrayContaining([
        { packageName: IMAGE, pattern: "image/png", slot: "detail" },
        { packageName: IMAGE, pattern: "image/png", slot: "preview" },
        { packageName: PDF, pattern: "application/pdf", slot: "detail" },
        { packageName: PDF, pattern: "application/pdf", slot: "preview" },
        { packageName: AUDIO, pattern: "audio/mpeg", slot: "detail" },
        { packageName: VIDEO, pattern: "video/mp4", slot: "detail" },
      ]),
    );
    // NEVER the raw wildcard — a wildcard would claim MIMEs the preview route 415s.
    expect(specs).not.toContainEqual({ packageName: IMAGE, pattern: "image/*", slot: "detail" });
    // NEVER a non-allowlisted MIME (image/bmp / audio/midi / video/quicktime).
    expect(specs.some((s) => s.pattern === "image/bmp")).toBe(false);
    expect(specs.some((s) => s.pattern === "audio/midi")).toBe(false);
    expect(specs.some((s) => s.pattern === "video/quicktime")).toBe(false);
    // audio/video are detail-ONLY — never a preview provider.
    expect(specs.some((s) => s.packageName === AUDIO && s.slot === "preview")).toBe(false);
    expect(specs.some((s) => s.packageName === VIDEO && s.slot === "preview")).toBe(false);
  });
});

describe("the four MIME families dispatch to the build-map fast path after reconcile", () => {
  // Post-G2-cutover: each base is bound at the EXACT allowlisted MIME and there is
  // no host handler left to shadow it (pickHandler no longer selects these media
  // families), so an allowlisted row dispatches to the base. A NON-allowlisted
  // MIME (image/bmp etc.) is deliberately NOT bound → generic floor (asserted
  // in the never-blank case below + the G2 cutover suite).
  it.each([
    { mime: "application/pdf", pkg: PDF },
    { mime: "image/png", pkg: IMAGE },
    { mime: "audio/mpeg", pkg: AUDIO },
    { mime: "video/mp4", pkg: VIDEO },
  ])("$mime → representation extension via $pkg::detail (build-map)", ({ mime, pkg }) => {
    // resolveArtifactDispatchInputs reconciles the system bases for the org, so no
    // explicit registration is needed — this is the production path.
    const dispatch = dispatchFor(mime);
    expect(dispatch).toEqual({
      kind: "representation",
      packageName: pkg,
      generatedKey: `${pkg}::detail`,
      pattern: expect.any(String),
    });
    // The resolved key is the SSR build-map fast path (system base), never the
    // dynamic runtime path.
    expect(classifyLoadablePath(`${pkg}::detail`)).toBe("build-map");
  });

  it.each(["image/bmp", "audio/midi", "video/quicktime"])(
    "a NON-allowlisted media MIME (%s) is NOT claimed by a base → generic floor (preview route would 415)",
    (mime) => {
      expect(dispatchFor(mime)).toEqual({ kind: "fallback" });
    },
  );

  it("reconcile is self-healing — re-binds after a registry clear (reconcile missing bindings)", () => {
    expect(dispatchFor("application/pdf").kind).toBe("representation");
    // A hard registry clear (a torn-down epoch / a fresh worker).
    representationProviderRegistry._clearForTests(true);
    _resetFirstPartySeedForTests();
    // The very next resolve reconciles the missing bindings → extension again.
    expect(dispatchFor("application/pdf").kind).toBe("representation");
  });

  it("binds the full system set for a DIFFERENT org too (effective for every org)", () => {
    reconcileSystemRepresentationProviders("org_other");
    const snap = representationProviderRegistry._snapshotOrgProviders("org_other");
    const detailPkgs = snap.filter((d) => d.slot === "detail").map((d) => d.packageName);
    expect(detailPkgs).toEqual(expect.arrayContaining([IMAGE, PDF, AUDIO, VIDEO]));
  });
});

describe("system extensions reject uninstall (generation-conditional teardown)", () => {
  it("a capability teardown of a system base retires NOTHING (no-op)", () => {
    reconcileSystemRepresentationProviders(ORG);
    const before = representationProviderRegistry._snapshotOrgProviders(ORG).length;
    expect(before).toBeGreaterThan(0);

    const removed = invalidateArtifactRenderersForPackage(PDF);
    expect(removed).toEqual({
      removedSemanticTypes: [],
      removedRepresentationProviders: 0,
      removedRuntimeBindings: 0,
    });
    // The bindings survive — the four MIME families never dormant to the floor.
    expect(representationProviderRegistry._snapshotOrgProviders(ORG).length).toBe(before);
    expect(dispatchFor("application/pdf").kind).toBe("representation");
  });

  it("a NON-system package still retires normally (guard is package-scoped)", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: "@vendor/pdf-pro",
      pattern: "application/pdf",
      slot: "detail",
      generation: 1,
    });
    const removed = invalidateArtifactRenderersForPackage("@vendor/pdf-pro");
    expect(removed.removedRepresentationProviders).toBe(1);
  });
});
