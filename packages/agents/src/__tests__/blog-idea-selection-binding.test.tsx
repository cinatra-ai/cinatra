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
import { describe, it, expect, beforeAll } from "vitest";
import type { ComponentType } from "react";

import {
  fieldRendererRegistry,
  type FieldRendererContext,
} from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  knownFieldRendererKinds,
} from "../register-default-renderers";
import { hasFieldRendererComponent } from "../field-renderer-components";
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
