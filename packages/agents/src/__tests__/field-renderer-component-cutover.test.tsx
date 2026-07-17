// @vitest-environment jsdom
/**
 * Field-renderer per-binding G2 cutover — RENDER / DOM half (cinatra#1625, epic
 * #1620 S8 — M3 spine). The never-blank/never-crash proof (#1625 AC4) under real
 * render: the mapped binding renders its extension component; a degraded module
 * and a render-time throw both fall back to the SchemaFieldRenderer FLOOR.
 *
 * ENVIRONMENT NOTE: like every other packages/agents render test that mounts a
 * renderer from the register-default-renderers graph (e.g.
 * context-selector-renderer.test.tsx), this suite requires the FULL extension
 * tree — mounting pulls the connector registry (src/lib/generated/
 * extensions.server.ts) which references the connector packages. It runs green
 * in CI; it cannot run in a partial dev worktree that lacks the connector
 * packages. The pure resolution + degrade taxonomy (no render) is proved
 * separately in field-renderer-component-resolution.test.ts, which runs in both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

import {
  fieldRendererRegistry,
  type FieldRendererProps,
} from "../field-renderer-registry";
import { registerFieldRendererBindings } from "../register-default-renderers";
import {
  __setFieldRendererComponentMapForTests,
  __resetFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import type { GeneratedFieldRendererComponentEntry } from "@/lib/generated/field-renderer-components";

const BINDING_ID = "@cinatra-ai/email-drafting-agent:email-drafts-review";
const BINDING_KIND = "email-drafts-review";
const PKG = "@cinatra-ai/email-drafting-agent";
const FLOOR_TITLE = "FieldTitleForFloor";

function Entry(
  load: GeneratedFieldRendererComponentEntry["load"],
): GeneratedFieldRendererComponentEntry {
  return { resolution: "guardedOptional", packageName: PKG, propsApiVersion: 1, load };
}

function FixtureExtensionRenderer(_props: FieldRendererProps) {
  return <div>EXTENSION_OK</div>;
}

function ThrowingRenderer(_props: FieldRendererProps): never {
  throw new Error("boom in extension renderer");
}

function props(): FieldRendererProps {
  return {
    fieldName: "myField",
    schema: { "x-renderer": BINDING_ID, type: "string", title: FLOOR_TITLE },
    value: "",
    onChange: () => {},
    context: { connectedApps: [] },
  } as FieldRendererProps;
}

function mountResolved() {
  registerFieldRendererBindings([
    { id: BINDING_ID, kind: BINDING_KIND, priority: 80 },
  ]);
  const resolved = fieldRendererRegistry.resolve("myField", props().schema, {
    connectedApps: [],
  });
  const Renderer = resolved!.renderer;
  return render(<Renderer {...props()} />);
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
});

afterEach(() => {
  cleanup();
  __resetFieldRendererComponentMapForTests();
  vi.restoreAllMocks();
});

describe("extension field-renderer wrapper — render cutover (never blank/crash)", () => {
  it("renders the extension component for its binding id", async () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: FixtureExtensionRenderer })),
    });
    mountResolved();
    expect(await screen.findByText("EXTENSION_OK")).toBeTruthy();
  });

  it("falls back to the SchemaFieldRenderer floor when the module is degraded", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => {
        throw new Error("chunk unavailable");
      }),
    });
    mountResolved();
    await waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('reason "load-failed"'),
      ),
    );
    expect(screen.queryByText("EXTENSION_OK")).toBeNull();
    expect(screen.getByText(FLOOR_TITLE)).toBeTruthy(); // floor rendered, never blank
  });

  it("contains a render-time throw to the floor (never crashes the panel)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: ThrowingRenderer })),
    });
    mountResolved();
    await waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("extension renderer threw during render"),
        expect.anything(),
      ),
    );
    expect(screen.queryByText("EXTENSION_OK")).toBeNull();
    expect(screen.getByText(FLOOR_TITLE)).toBeTruthy(); // floor rendered, never crashed
  });
});
