// COMPILE-PROOF — the #2019 S4 builder-context widening of the external-MCP
// toolbox contract is ADDITIVE and identity-free.
//
// `ExtensionExternalMcpToolbox.buildTools` gained an OPTIONAL second parameter
// (`ExtensionToolboxBuildContext`). This file pins the two compatibility
// directions the widening promises and the exact shape of the context type:
//
//   1. BACKWARD (implementations): a toolbox written against the previous
//      one-parameter shape stays structurally assignable — no companion
//      extension recompiles or edits anything.
//   2. BACKWARD (call sites): a host call site that passes no context stays
//      type-valid — pre-widening hosts keep compiling, and a context-gated
//      toolbox MUST then fail closed (return `[]`).
//   3. EXACT SHAPE: the `surface` union and the context/pin key sets are
//      pinned exactly — adding, removing, or renaming a member reds this file
//      so the change is a conscious, reviewed one. The context deliberately
//      has NO identity-shaped members (per-instance authority derives
//      host-side from the ambient trusted actor stores, never from the SDK
//      context).
//
// Like the other contract compile-proofs here, this is a real `.ts` under
// `src` participating in the wholesale typecheck — the assignments below are
// genuine COMPILE proofs; the vitest assertions are a runtime smoke of the
// documented fail-closed consumption shape.
import { describe, expect, it } from "vitest";
import type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
  ExtensionToolboxBuildContext,
} from "../index";

// (1) A pre-widening, one-parameter toolbox implementation stays assignable.
const legacyToolbox: ExtensionExternalMcpToolbox = {
  buildTools: async (provider: string): Promise<ExtensionExternalMcpTool[]> => {
    void provider; // the one-parameter signature itself is the compile proof
    return [];
  },
};

// (2) A context-aware toolbox in the documented fail-closed gate shape:
// absent context ⇒ emit nothing (pre-widening hosts), and the context is a
// gate/narrowing input only.
const contextGatedToolbox: ExtensionExternalMcpToolbox = {
  buildTools: async (
    _provider: string,
    context?: ExtensionToolboxBuildContext,
  ): Promise<ExtensionExternalMcpTool[]> => {
    if (!context || context.surface !== "chat") {
      return [];
    }
    return [];
  },
};

// (3a) The surface union is EXACTLY these four values: a Record over the union
// fails to compile if a value is added (missing key) or removed/renamed
// (excess key).
const surfaceUnionPin: Record<ExtensionToolboxBuildContext["surface"], true> = {
  chat: true,
  agent_run: true,
  public_site_widget: true,
  session: true,
};

// (3b) The context carries EXACTLY { surface, connectorInstancePin } — no
// identity-shaped member can appear without redding this pin.
const contextKeyPin: Record<keyof ExtensionToolboxBuildContext, true> = {
  surface: true,
  connectorInstancePin: true,
};

// (3c) The pin is EXACTLY { connectorKey, instanceId }.
const pinKeyPin: Record<
  keyof NonNullable<ExtensionToolboxBuildContext["connectorInstancePin"]>,
  true
> = {
  connectorKey: true,
  instanceId: true,
};

// (3d) FULL exact-type equality probes (adopted from review): the Record pins
// above catch key drift but not in-place WIDENING — e.g. `surface` relaxing to
// `string`, or pin members turning optional, would slip through them. `Equal`
// resolves to `true` only when the two types are IDENTICAL (literal unions,
// optionality, and nested shapes included), so either assignment below stops
// compiling the moment the published type drifts from the pinned literal.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const contextShapeIsExact: Equal<
  ExtensionToolboxBuildContext,
  {
    surface: "chat" | "agent_run" | "public_site_widget" | "session";
    connectorInstancePin?: { connectorKey: string; instanceId: string };
  }
> = true;

const toolboxShapeIsExact: Equal<
  ExtensionExternalMcpToolbox,
  {
    buildTools: (
      provider: string,
      context?: ExtensionToolboxBuildContext,
    ) => Promise<ExtensionExternalMcpTool[]>;
  }
> = true;

describe("external-MCP toolbox build-context widening (#2019 S4)", () => {
  it("keeps one-parameter implementations and no-context call sites type-valid (compile proof) and the no-op signal intact", async () => {
    // Call-site backward compatibility: the pre-widening single-argument call
    // compiles against BOTH implementations and still resolves the no-op
    // signal.
    await expect(legacyToolbox.buildTools("anthropic")).resolves.toEqual([]);
    await expect(contextGatedToolbox.buildTools("anthropic")).resolves.toEqual([]);
  });

  it("supports the documented fail-closed consumption shape: absent context and non-chat surfaces emit nothing", async () => {
    await expect(
      contextGatedToolbox.buildTools("openai", { surface: "agent_run" }),
    ).resolves.toEqual([]);
    await expect(
      contextGatedToolbox.buildTools("openai", { surface: "public_site_widget" }),
    ).resolves.toEqual([]);
    await expect(
      contextGatedToolbox.buildTools("openai", { surface: "session" }),
    ).resolves.toEqual([]);
    // The pin is a pure narrowing filter — carrying it never widens the type
    // of the call or smuggles identity.
    await expect(
      contextGatedToolbox.buildTools("openai", {
        surface: "agent_run",
        connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
      }),
    ).resolves.toEqual([]);
  });

  it("pins the exact context shape (surface union + key sets)", () => {
    expect(Object.keys(surfaceUnionPin).sort()).toEqual([
      "agent_run",
      "chat",
      "public_site_widget",
      "session",
    ]);
    expect(Object.keys(contextKeyPin).sort()).toEqual([
      "connectorInstancePin",
      "surface",
    ]);
    expect(Object.keys(pinKeyPin).sort()).toEqual(["connectorKey", "instanceId"]);
  });

  it("pins the FULL exact type shapes (compile-level equality probes)", () => {
    expect(contextShapeIsExact).toBe(true);
    expect(toolboxShapeIsExact).toBe(true);
  });
});
