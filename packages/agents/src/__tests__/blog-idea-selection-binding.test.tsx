// @vitest-environment jsdom
/**
 * The blog-pipeline idea-selection binding
 * (`@cinatra-ai/blog-pipeline-agent:idea-selection`, kind
 * "blog-idea-selection").
 *
 * The chooser component is shipped by the pipeline pack itself; the host no
 * longer carries one (cinatra#3380). The KIND stays in the host table on the
 * schema floor, so a build without the pack's component degrades to the floor
 * and never blanks.
 *
 * Asserts:
 *   - the binding id resolves at priority 80 to the component the pinned pack
 *     ships (not to the host's floor), and classifies as a mid-run HITL gate;
 *   - the kind stays in the host vocabulary, like the other migrated kinds;
 *   - strict-id: the retired shared reviewer binding resolves to nothing.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";

import {
  continueAwaitsAPick,
  fieldRendererRegistry,
  type FieldRendererContext,
  type FieldRendererEntry,
  type FieldRendererProps,
} from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  knownFieldRendererKinds,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import {
  FIELD_RENDERER_PROPS_API_VERSION,
  hasFieldRendererComponent,
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import { RendererFloorReportContext, SchemaOnlyFloorRenderer } from "../schema-field-renderer";
import {
  classifyMidRunHitl,
  hasMidRunHitlBinding,
} from "../orchestrator-mid-run-hitl";

const CTX: FieldRendererContext = { connectedApps: [] };
const BINDING_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";
// The binding carries params, so registration wraps whichever component it
// picks; the wrapper's displayName names the component inside it. The pack's
// branch mounts the extension wrapper for this id, the floor branch would mount
// the host floor instead, so this name tells the two apart.
const PACK_RENDERER_NAME = `WithBindingParams(ExtensionFieldRenderer(${BINDING_ID}))`;
const rendererName = (renderer: unknown): string | undefined =>
  (renderer as ComponentType & { displayName?: string }).displayName;

describe("blog-pipeline idea-selection binding — resolution + mid-run classification", () => {
  beforeAll(() => {
    ensureDefaultFieldRenderersRegistered();
  });

  it("the dedicated binding id resolves at priority 80 to the component the pinned pipeline pack ships", () => {
    // The pinned pipeline pack declares its own component for this binding, so the
    // build map carries it and the binding mounts the pack's chooser; the host's
    // schema floor stays the kind's fallback for a build without the pack's component.
    expect(hasFieldRendererComponent(BINDING_ID)).toBe(true);
    const entry = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(80);
    expect(rendererName(entry!.renderer)).toBe(PACK_RENDERER_NAME);
  });

  it("the kind stays in the host vocabulary (its floor keeps a not-in-build binding from blanking)", () => {
    expect(knownFieldRendererKinds()).toContain("blog-idea-selection");
  });

  it("classifies as a mid-run HITL gate (parity with the retired :output-suffix classification)", () => {
    expect(hasMidRunHitlBinding(BINDING_ID)).toBe(true);
    expect(classifyMidRunHitl(BINDING_ID)).toBe(true);
  });

  it("strict-id: the dedicated id owns the chooser and the RETIRED shared binding resolves to nothing", () => {
    const dedicated = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(dedicated).toBeTruthy();
    expect(rendererName(dedicated!.renderer)).toBe(PACK_RENDERER_NAME);
    // cinatra#1796 teardown: the shared reviewer binding the chooser relocated
    // OFF is gone — its package is retired, its kind is out of the vocabulary
    // and its dispatcher is deleted. Reconstructed here from parts so this file
    // holds no live reference to the retired identity (the same technique the
    // retirement-identity gate uses on itself). Strict-id means the dedicated
    // chooser must NOT pick the orphaned id up.
    const RETIRED_SHARED_ID = ["@cinatra-ai/", "reviewer", "-agent:output"].join("");
    const orphaned = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": RETIRED_SHARED_ID },
      CTX as never,
    );
    expect(orphaned).toBeFalsy();
  });
});

describe("the idea step's Continue waits for a pick (cinatra#3035)", () => {
  beforeAll(() => {
    ensureDefaultFieldRenderersRegistered();
  });

  it("the pack-drawn binding carries the kind's hold, so its Continue waits with no pick", () => {
    const entry = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(entry!.holdsContinueUntilPicked).toBe(true);
    expect(continueAwaitsAPick(entry, {})).toBe(true);
  });

  it("continueAwaitsAPick holds only a held entry with no non-empty string pick", () => {
    const held = { holdsContinueUntilPicked: true } as FieldRendererEntry;
    expect(continueAwaitsAPick(undefined, {})).toBe(false);
    expect(continueAwaitsAPick({ holdsContinueUntilPicked: false } as FieldRendererEntry, {})).toBe(false);
    for (const pick of [undefined, "", 7, { id: "x" }]) expect(continueAwaitsAPick(held, { userResponse: pick })).toBe(true);
    const pick = JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-a" });
    expect(continueAwaitsAPick(held, { userResponse: pick })).toBe(false);
  });
});

describe("the floor commits no pick, so a floor-drawn idea step does not hold its Continue (cinatra#3035)", () => {
  const PICK = JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-a" });
  const resolveId = (id: string) =>
    fieldRendererRegistry.resolve("selectedIdeaJson", { "x-renderer": id }, CTX as never);

  beforeAll(() => {
    ensureDefaultFieldRenderersRegistered();
  });

  afterEach(() => {
    cleanup();
    __resetFieldRendererComponentMapForTests();
    vi.restoreAllMocks();
  });

  it("the real binding with its component holds until a userResponse pick and releases on one", () => {
    const entry = resolveId(BINDING_ID);
    expect(rendererName(entry!.renderer)).toBe(PACK_RENDERER_NAME);
    expect(continueAwaitsAPick(entry, {})).toBe(true);
    expect(continueAwaitsAPick(entry, { selectedIdeaJson: PICK })).toBe(true);
    expect(continueAwaitsAPick(entry, { selectedIdeaJson: PICK, userResponse: PICK })).toBe(false);
  });

  it("a binding of the kind with no component in the build draws the floor and does not hold", () => {
    const id = "@example/ideas:pick";
    expect(hasFieldRendererComponent(id)).toBe(false);
    registerFieldRendererBindings([{ id, kind: "blog-idea-selection", priority: 80, midRunHitl: true }]);
    const entry = resolveId(id);
    expect(entry!.renderer).toBe(SchemaOnlyFloorRenderer);
    expect(entry!.holdsContinueUntilPicked).toBe(false);
    // What the floor buffers for the object schema { selectedIdeaJson: string }: no userResponse.
    expect(continueAwaitsAPick(entry, {})).toBe(false);
    expect(continueAwaitsAPick(entry, { selectedIdeaJson: PICK })).toBe(false);
  });

  it("a binding whose component degrades tells the host that mounted it, and its entry keeps the kind's hold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = "@example/ideas:degrading-pick";
    __setFieldRendererComponentMapForTests({
      [id]: {
        resolution: "guardedOptional",
        packageName: "@example/ideas",
        propsApiVersion: FIELD_RENDERER_PROPS_API_VERSION,
        load: async () => {
          throw new Error("chunk unavailable");
        },
      },
    });
    registerFieldRendererBindings([{ id, kind: "blog-idea-selection", priority: 80, midRunHitl: true }]);
    const entry = resolveId(id);
    expect(rendererName(entry!.renderer)).toBe(`ExtensionFieldRenderer(${id})`);
    const props = {
      fieldName: "selectedIdeaJson",
      schema: { type: "string" },
      value: "",
      onChange: () => {},
      context: CTX,
    } as unknown as FieldRendererProps;
    const reports: boolean[] = [];
    const report = (floored: boolean) => {
      reports.push(floored);
    };
    const mounted = render(
      createElement(RendererFloorReportContext.Provider, { value: report }, createElement(entry!.renderer, props)),
    );
    // The load window: not floored, the component may still mount.
    expect(reports[0]).toBe(false);
    await waitFor(() => expect(reports.at(-1)).toBe(true));
    // One instance's floor is that instance's: the entry, shared by every instance of the id, keeps the hold.
    expect(entry!.holdsContinueUntilPicked).toBe(true);
    expect(continueAwaitsAPick(entry, { selectedIdeaJson: PICK })).toBe(true);
    // An unmounted instance stops lifting its host's hold.
    mounted.unmount();
    expect(reports.at(-1)).toBe(false);
  });

  it("each Continue caller lifts the hold only on the floor report of the renderer it mounts", () => {
    const src = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");
    const card = src("agent-hitl-screen-card.tsx");
    expect(card).toMatch(/<RendererFloorReportContext\.Provider value=\{setRendererFloored\}>\s*<AgentHitlScreenFields\b/);
    expect(card).toContain("awaitsPick={!rendererFloored && continueAwaitsAPick(resolveHitlGateEntry(runId, gate), activeBuffered)}");
    const panel = src("agentic-run-panel.tsx");
    expect(panel).toMatch(/<RendererFloorReportContext\.Provider value=\{setRendererFloored\}>\s*<RendererComponent\b/);
    expect(panel).toContain("(!rendererFloored && continueAwaitsAPick(hitlRendererEntry?.entry, bufferedHitlValue))");
    const stepper = src("orchestrator-stepper-panel.tsx");
    expect(stepper).toMatch(/<RendererFloorReportContext\.Provider value=\{setRendererFloored\}>\s*<RendererComponent\b/);
    expect(stepper).toContain("(!rendererFloored && continueAwaitsAPick(entry, bufferedHitlValue))");
    // No state is kept by binding id any more.
    expect(src("extension-field-renderer.tsx")).not.toMatch(/new Set<string>\(\)/);
  });
});
