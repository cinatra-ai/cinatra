/**
 * S7/M2 — the activated `listRow` slot + the un-hard-coded library glyph
 * (cinatra#1631, epic #1620). Two proofs:
 *
 *   1. G2 CUTOVER MATRIX for the glyph arm (system: semantic-renderer): the
 *      un-hard-coding of the host-side per-extension-family glyph map is a
 *      legacy-arm deletion, so the replacement channel — the winner-bound
 *      semantic registry at slot `listRow` + the generated build map — is
 *      driven through EVERY matrix world-state before the map is gone.
 *   2. GLYPH RENDER floors: the extension glyph mounts ONLY for a built,
 *      winner-bound `listRow` claimant; every other state (no claimant, no
 *      listRow declaration, not in build, pre-render failure) renders the
 *      host's generic glyph for its tier; the file-vs-structured floor split
 *      stays host-side. Never blank.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import {
  evaluateArmCutover,
  type CutoverCaseId,
  type CutoverObservation,
} from "@cinatra-ai/objects/artifact-ui-cutover-matrix";

// vi.mock is hoisted above imports — the factory must not close over module
// locals. Execution counters live on globalThis so the factory and the tests
// see the same object.
type ExecCounts = { row: number; losing: number };
const EXEC_KEY = "__s7RowGlyphExecCounts" as const;
(globalThis as Record<string, unknown>)[EXEC_KEY] = { row: 0, losing: 0 };
function execCounts(): ExecCounts {
  return (globalThis as Record<string, unknown>)[EXEC_KEY] as ExecCounts;
}

vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/row-ext::listRow": {
      resolution: "guardedOptional",
      packageName: "@fixture/row-ext",
      slot: "listRow",
      representations: [],
      propsApiVersion: 1,
      load: async () => {
        ((globalThis as Record<string, unknown>).__s7RowGlyphExecCounts as { row: number }).row += 1;
        return {
          default: (props: { artifact: { objectType: string } }) => (
            <span data-fixture-glyph={props.artifact.objectType} />
          ),
        };
      },
    },
    "@fixture/losing-ext::listRow": {
      resolution: "guardedOptional",
      packageName: "@fixture/losing-ext",
      slot: "listRow",
      representations: [],
      propsApiVersion: 1,
      load: async () => {
        ((globalThis as Record<string, unknown>).__s7RowGlyphExecCounts as { losing: number }).losing += 1;
        return { default: () => <span data-fixture-glyph="losing" /> };
      },
    },
    "@fixture/bad-export::listRow": {
      resolution: "guardedOptional",
      packageName: "@fixture/bad-export",
      slot: "listRow",
      representations: [],
      propsApiVersion: 1,
      load: async () => ({ notDefault: true }),
    },
    "@fixture/abi-mismatch::listRow": {
      resolution: "guardedOptional",
      packageName: "@fixture/abi-mismatch",
      slot: "listRow",
      representations: [],
      propsApiVersion: 99,
      load: async () => ({ default: () => <span data-fixture-glyph="abi" /> }),
    },
  },
}));

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import { _resetArtifactRendererQuarantineForTests } from "@/lib/artifacts/artifact-renderer-loader";
import { _resetFirstPartySeedForTests, resolveSemanticListRowDispatch } from "@/app/artifacts/[id]/renderer-resolution";
import { LibraryRowGlyph } from "../library-row-glyph";

const TYPE = "@fixture/row-ext:artifact";

function winner(extension: string): EffectiveIdentity {
  return { kind: "extension", extension, basis: "binding", selectable: true, assertionId: "sa_1" };
}
const floorIdentity: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
const plainIdentity: EffectiveIdentity = { kind: "plain-object", selectable: false, assertionId: null };

function summaryOf(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "art_1",
    latestRepresentationRevisionId: null,
    objectType: TYPE,
    artifactType: "structured",
    title: "Fixture row",
    mime: "application/octet-stream",
    size: 0,
    originKind: "agent",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    eligibleExtensions: [],
    primaryExtension: "@fixture/row-ext",
    effectiveIdentity: winner("@fixture/row-ext"),
    sourceUrl: null,
    ...overrides,
  };
}

async function renderGlyph(summary: ArtifactSummary): Promise<string> {
  return renderToStaticMarkup(<>{await LibraryRowGlyph({ summary })}</>);
}

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
  _resetArtifactRendererQuarantineForTests();
  execCounts().row = 0;
  execCounts().losing = 0;
});

describe("G2 cutover matrix — the library-glyph arm (semantic-renderer @ listRow)", () => {
  it("the listRow arm is cutover-ready across every world-state", async () => {
    const observations = new Map<CutoverCaseId, CutoverObservation>();

    // Each case sets up its OWN world-state, drives the REAL glyph render, and
    // reports the observed outcome.
    const observe = async (caseId: CutoverCaseId): Promise<CutoverObservation> => {
      semanticRendererRegistry._clearForTests();
      _resetArtifactRendererQuarantineForTests();
      execCounts().row = 0;
      execCounts().losing = 0;

      switch (caseId) {
        case "provider-registered": {
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          const desc = semanticRendererRegistry.resolve(TYPE, winner("@fixture/row-ext"), "listRow");
          return { outcome: desc ? "extension" : "none" };
        }
        case "enabled-and-selected": {
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          const html = await renderGlyph(summaryOf());
          return { outcome: html.includes('data-glyph-source="extension"') ? "extension" : "generic-floor" };
        }
        case "selected-via-correct-registry": {
          // A REPRESENTATION-side package also present in the build must never
          // leak into the semantic glyph resolution: only the semantic winner's
          // module may execute.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          const html = await renderGlyph(summaryOf({ mime: "application/pdf" }));
          const viaSemantic = html.includes('data-glyph-source="extension"');
          return { outcome: viaSemantic && execCounts().losing === 0 ? "extension" : "cross-applied" };
        }
        case "precedence": {
          // Two claimants of the SAME type — the org winner's glyph renders;
          // the losing claimant's module NEVER executes.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/losing-ext", slot: "listRow" });
          const html = await renderGlyph(summaryOf());
          const winnerRendered = html.includes('data-glyph-source="extension"');
          return { outcome: winnerRendered && execCounts().losing === 0 ? "extension" : "cross-applied" };
        }
        case "disabled": {
          // The claim is present but NOT effective for the org (the winner is a
          // different/absent extension) — generic claimed glyph.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          const html = await renderGlyph(summaryOf({ effectiveIdentity: winner("@fixture/other-ext") }));
          return { outcome: html.includes('data-glyph-source="generic"') ? "generic-floor" : "extension" };
        }
        case "uninstalled": {
          // Teardown (archive/uninstall) retired the package's registrations.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          semanticRendererRegistry.removeByPackage("@fixture/row-ext");
          const html = await renderGlyph(summaryOf());
          return { outcome: html.includes('data-glyph-source="generic"') ? "generic-floor" : "extension" };
        }
        case "incompatible": {
          // Registered claimant ABSENT from this build → requires-rebuild at
          // the resolution; the glyph renders the generic claimed glyph.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/unbuilt-ext", slot: "listRow" });
          const resolved = resolveSemanticListRowDispatch(TYPE, winner("@fixture/unbuilt-ext"));
          const html = await renderGlyph(summaryOf({ effectiveIdentity: winner("@fixture/unbuilt-ext") }));
          const floored = html.includes('data-glyph-source="generic"');
          return {
            outcome: resolved && !resolved.built && floored ? "requires-rebuild" : "none",
          };
        }
        case "failing": {
          // Pre-render failure (invalid export) degrades silently to the
          // generic claimed glyph — never blank, never a crash.
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/bad-export", slot: "listRow" });
          const html = await renderGlyph(summaryOf({ effectiveIdentity: winner("@fixture/bad-export") }));
          return { outcome: html.includes('data-glyph-source="generic"') ? "generic-floor" : "none" };
        }
        case "floor-recovery": {
          // The host floor split stays: no claimant anywhere → generic tier.
          const html = await renderGlyph(summaryOf({ effectiveIdentity: plainIdentity }));
          return { outcome: html.includes('data-glyph-source="generic"') ? "generic-floor" : "none" };
        }
        case "single-module-executes": {
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
          semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/losing-ext", slot: "listRow" });
          const html = await renderGlyph(summaryOf());
          const ok = html.includes('data-glyph-source="extension"');
          return {
            outcome: ok ? "extension" : "none",
            modulesExecuted: execCounts().row + execCounts().losing,
          };
        }
        default: {
          const _exhaustive: never = caseId;
          return _exhaustive;
        }
      }
    };

    // evaluateArmCutover's observe is synchronous — pre-drive every case.
    for (const caseId of [
      "provider-registered",
      "enabled-and-selected",
      "selected-via-correct-registry",
      "precedence",
      "disabled",
      "uninstalled",
      "incompatible",
      "failing",
      "floor-recovery",
      "single-module-executes",
    ] as const) {
      observations.set(caseId, await observe(caseId));
    }

    const report = evaluateArmCutover({
      system: "semantic-renderer",
      arm: "library-glyph listRow",
      observe: (caseId) => observations.get(caseId)!,
    });
    expect(report.unmet).toEqual([]);
    expect(report.ready).toBe(true);
  });
});

describe("LibraryRowGlyph — extension glyph + host floors", () => {
  it("mounts the winner's built listRow renderer inside the claimed cell (props snapshot flows)", async () => {
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
    const html = await renderGlyph(summaryOf());
    expect(html).toContain('data-glyph-source="extension"');
    expect(html).toContain(`data-fixture-glyph="${TYPE}"`);
    expect(execCounts().row).toBe(1);
  });

  it("a GENERIC-typed library row reaches its winner's umbrella-registered listRow capability (the like-for-like replacement of the deleted family map)", async () => {
    // The bridge registers under the claimant's umbrella type; every live
    // library row is the generic artifact object type. The winner-umbrella
    // fallback connects the two — winner-bound (only `${winner}:artifact`).
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext", slot: "listRow" });
    const html = await renderGlyph(
      summaryOf({ objectType: "@cinatra-ai/artifact:object" }),
    );
    expect(html).toContain('data-glyph-source="extension"');
    expect(execCounts().row).toBe(1);
  });

  it("the umbrella fallback never reaches a LOSING claimant's registration (winner-binding)", async () => {
    // Only the losing claimant registered a listRow renderer; the row's winner
    // did not. Neither the type-keyed nor the umbrella-keyed lookup may reach
    // the loser's module — the glyph floors.
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/losing-ext", slot: "listRow" });
    semanticRendererRegistry.register({
      objectTypeId: "@fixture/losing-ext:artifact",
      packageName: "@fixture/losing-ext",
      slot: "listRow",
    });
    const html = await renderGlyph(
      summaryOf({ objectType: "@cinatra-ai/artifact:object" }),
    );
    expect(html).toContain('data-glyph-source="generic"');
    expect(execCounts().row).toBe(0);
    expect(execCounts().losing).toBe(0);
  });

  it("a claimant with ONLY a detail renderer floors the glyph (no listRow capability)", async () => {
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/row-ext" });
    const html = await renderGlyph(summaryOf());
    expect(html).toContain('data-glyph-source="generic"');
    expect(execCounts().row).toBe(0);
  });

  it("an ABI-mismatched listRow renderer degrades to the generic claimed glyph before render", async () => {
    semanticRendererRegistry.register({ objectTypeId: TYPE, packageName: "@fixture/abi-mismatch", slot: "listRow" });
    const html = await renderGlyph(summaryOf({ effectiveIdentity: winner("@fixture/abi-mismatch") }));
    expect(html).toContain('data-glyph-source="generic"');
    expect(html).not.toContain("data-fixture-glyph");
  });

  it("the host file-vs-structured floor split stays: file mime tier", async () => {
    const html = await renderGlyph(
      summaryOf({ effectiveIdentity: floorIdentity, mime: "application/pdf" }),
    );
    expect(html).toContain('data-glyph-source="generic"');
    expect(html).toContain("text-warning");
  });

  it("the host file-vs-structured floor split stays: structured tier", async () => {
    const html = await renderGlyph(summaryOf({ effectiveIdentity: plainIdentity }));
    expect(html).toContain('data-glyph-source="generic"');
    expect(html).toContain("text-muted-foreground");
  });

  it("a claimed row keeps the claimed tint even when the glyph floors (identity styling is host-side)", async () => {
    const html = await renderGlyph(summaryOf());
    expect(html).toContain("text-primary");
    expect(html).toContain('data-glyph-source="generic"');
  });
});
