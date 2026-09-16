/**
 * cinatra#3032 (epic #3023, lifecycle-c W8) — acceptance item 5, "An
 * incompatible declaration is refused at install".
 *
 * Plan (C) item 0.29: "The declaration is static and checked at install against
 * the children's slots: the parent slot accepts every extension the child slot
 * accepts, its cardinality fits the child's bounds, the resolution mode matches,
 * a read-only child slot receives read-only references, and the child receives
 * the pinned revisions the parent's selection finalized; a conflict refuses the
 * install."
 *
 * Both halves are proved: the check itself, one conflict class at a time, and
 * the install pipeline actually refusing on it — pre-mutation, with the
 * materialized dir reclaimed, exactly as the host/SDK compatibility gate beside
 * it behaves.
 */
import { describe, expect, it } from "vitest";

import {
  checkParentSatisfiedContextSlots,
  readContextSlotComposition,
} from "@/lib/extension-host-compat";
import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";

const REGISTRY = "https://registry.cinatra.ai";
const PARENT = "@cinatra-ai/pipeline-agent";
const CHILD = "@cinatra-ai/idea-agent";

type SlotOverrides = Record<string, unknown>;

function slot(slotId: string, over: SlotOverrides = {}): Record<string, unknown> {
  return {
    slotId,
    acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
    ...over,
  };
}

/** A composed document: the composite agent, one embedded agent, one line. */
function composed(input: {
  parentSlot?: SlotOverrides;
  childSlot?: SlotOverrides;
  lines?: unknown;
}): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "pipeline-flow",
    nodes: [{ $component_ref: "idea-flow-node" }],
    start_node: { $component_ref: "start" },
    metadata: {
      cinatra: {
        packageName: PARENT,
        contextSlots: [slot("brandVoice", input.parentSlot ?? {})],
        parentSatisfiedContextSlots:
          input.lines ?? [
            { parentSlotId: "brandVoice", childPackage: CHILD, childSlotId: "ideaContext" },
          ],
      },
    },
    $referenced_components: {
      "idea-flow": {
        component_type: "Flow",
        id: "idea-flow",
        nodes: [{ $component_ref: "idea-work" }],
        start_node: { $component_ref: "idea-start" },
        metadata: {
          cinatra: {
            packageName: CHILD,
            contextSlots: [slot("ideaContext", input.childSlot ?? {})],
          },
        },
      },
    },
  };
}

function verdict(input: Parameters<typeof composed>[0]) {
  return checkParentSatisfiedContextSlots(readContextSlotComposition(composed(input)));
}

/**
 * A three-deep composition: the composite embeds a middle agent that is ITSELF
 * a composite and declares its own line onto a grandchild. The loader reads a
 * declaration off EVERY carrier and enforces it at mount, so the install gate
 * that exists to refuse it first has to look in the same places.
 */
const MIDDLE = "@cinatra-ai/section-agent";
const GRANDCHILD = "@cinatra-ai/research-agent";
function nested(middleLine: Record<string, unknown>, grandchildSlot: SlotOverrides = {}) {
  return {
    component_type: "Flow",
    id: "pipeline-flow",
    nodes: [{ $component_ref: "section-flow-node" }],
    start_node: { $component_ref: "start" },
    metadata: {
      cinatra: { packageName: PARENT, contextSlots: [slot("brandVoice")] },
    },
    $referenced_components: {
      "section-flow": {
        component_type: "Flow",
        id: "section-flow",
        nodes: [{ $component_ref: "research-flow-node" }],
        start_node: { $component_ref: "section-start" },
        metadata: {
          cinatra: {
            packageName: MIDDLE,
            contextSlots: [slot("sectionContext")],
            parentSatisfiedContextSlots: [middleLine],
          },
        },
        $referenced_components: {
          "research-flow": {
            component_type: "Flow",
            id: "research-flow",
            nodes: [{ $component_ref: "research-work" }],
            start_node: { $component_ref: "research-start" },
            metadata: {
              cinatra: {
                packageName: GRANDCHILD,
                contextSlots: [slot("researchContext", grandchildSlot)],
              },
            },
          },
        },
      },
    },
  };
}

describe("the install gate reads every carrier, and reads a present declaration strictly", () => {
  it("refuses a NESTED composite's incompatible line, not only the root's", () => {
    const bad = checkParentSatisfiedContextSlots(
      readContextSlotComposition(
        nested(
          {
            parentSlotId: "sectionContext",
            childPackage: GRANDCHILD,
            childSlotId: "researchContext",
          },
          { readableOnly: true },
        ),
      ),
    );
    expect(bad.compatible).toBe(false);
    expect(bad.compatible === false && bad.conflicts.join(" ")).toContain("read-only");
  });

  it("accepts a nested composite's compatible line", () => {
    const ok = checkParentSatisfiedContextSlots(
      readContextSlotComposition(
        nested({
          parentSlotId: "sectionContext",
          childPackage: GRANDCHILD,
          childSlotId: "researchContext",
        }),
      ),
    );
    expect(ok).toEqual({ compatible: true });
  });

  it("refuses a nested composite's line naming a slot that carrier does not declare", () => {
    const bad = checkParentSatisfiedContextSlots(
      readContextSlotComposition(
        nested({
          parentSlotId: "brandVoice", // the ROOT's slot, not this carrier's
          childPackage: GRANDCHILD,
          childSlotId: "researchContext",
        }),
      ),
    );
    expect(bad.compatible).toBe(false);
  });

  it("a PRESENT but malformed declaration is a refusal, never a silent 'nothing to check'", () => {
    // One stray key. The fail-quiet reader empties the WHOLE declaration, which
    // at this gate would read as "declares nothing" and INSTALL an otherwise
    // incompatible package, deferring the failure to the mount.
    const bad = verdict({
      childSlot: { readableOnly: true },
      lines: [
        {
          parentSlotId: "brandVoice",
          childPackage: CHILD,
          childSlotId: "ideaContext",
          note: "typo",
        },
      ],
    });
    expect(bad.compatible).toBe(false);
    expect(bad.compatible === false && bad.conflicts.join(" ")).toContain("malformed");
  });

  it("an ABSENT declaration is still compatible", () => {
    const c = readContextSlotComposition(composed({ lines: [] }));
    expect(checkParentSatisfiedContextSlots(c)).toEqual({ compatible: true });
    expect(c.malformed).toEqual([]);
  });
});

describe("readContextSlotComposition — the composed document's own declarations", () => {
  it("reads the composite agent's slots, its lines and every embedded agent's slots", () => {
    const c = readContextSlotComposition(composed({}));
    expect(c.packageName).toBe(PARENT);
    expect(c.parentSlots.map((s) => s.slotId)).toEqual(["brandVoice"]);
    expect(c.lines).toEqual([
      { parentSlotId: "brandVoice", childPackage: CHILD, childSlotId: "ideaContext" },
    ]);
    expect(c.children).toEqual([
      {
        packageName: CHILD,
        slots: [expect.objectContaining({ slotId: "ideaContext" })],
        lines: [],
      },
    ]);
    // EVERY carrier, the composite itself first — the same set the loader walks.
    expect(c.carriers?.map((x) => x.packageName)).toEqual([PARENT, CHILD]);
    expect(c.malformed).toEqual([]);
  });

  it("reads nothing from a document that is not one", () => {
    for (const bad of [null, undefined, 7, "flow", []]) {
      expect(readContextSlotComposition(bad)).toEqual({
        packageName: null,
        parentSlots: [],
        lines: [],
        children: [],
      });
    }
  });
});

describe("acceptance item 5 — an incompatible declaration is refused", () => {
  it("passes a declaration that fits the child in every respect", () => {
    expect(verdict({}).compatible).toBe(true);
  });

  it("passes a composition that declares no line at all", () => {
    expect(verdict({ lines: [] }).compatible).toBe(true);
  });

  it("refuses an extension the child accepts and the parent's slot does not", () => {
    const v = verdict({
      childSlot: {
        acceptedArtifactExtensions: [
          "@cinatra-ai/brand-voice-artifact",
          "@cinatra-ai/style-guide-artifact",
        ],
      },
    });
    expect(v.compatible).toBe(false);
    if (v.compatible) throw new Error("unreachable");
    expect(v.conflicts.join("\n")).toMatch(/@cinatra-ai\/style-guide-artifact/);
    expect(v.conflicts.join("\n")).toMatch(/hand down nothing for those/);
  });

  it("refuses a cardinality that does not fit the child's bounds", () => {
    const tooMany = verdict({ parentSlot: { maxItems: 9 }, childSlot: { maxItems: 3 } });
    expect(tooMany.compatible).toBe(false);
    if (tooMany.compatible) throw new Error("unreachable");
    expect(tooMany.conflicts.join("\n")).toMatch(/outside\s+the child's bounds/);

    const tooFew = verdict({ parentSlot: { minItems: 0 }, childSlot: { minItems: 1 } });
    expect(tooFew.compatible).toBe(false);

    // An unbounded parent slot cannot fit a child that bounds itself.
    const unbounded = verdict({ parentSlot: { maxItems: undefined }, childSlot: { maxItems: 3 } });
    expect(unbounded.compatible).toBe(false);
  });

  it("refuses a resolution mode that does not match", () => {
    const v = verdict({ parentSlot: { resolutionMode: "override" } });
    expect(v.compatible).toBe(false);
    if (v.compatible) throw new Error("unreachable");
    expect(v.conflicts.join("\n")).toMatch(/resolves "override" and the child expects "accumulate"/);
  });

  it("refuses a writable reference handed into a read-only child slot", () => {
    const v = verdict({ childSlot: { readableOnly: true } });
    expect(v.compatible).toBe(false);
    if (v.compatible) throw new Error("unreachable");
    expect(v.conflicts.join("\n")).toMatch(/read-only/);

    // A read-only parent into a read-only child is fine, and so is a read-only
    // parent into a child that does not ask for it.
    expect(
      verdict({ parentSlot: { readableOnly: true }, childSlot: { readableOnly: true } }).compatible,
    ).toBe(true);
    expect(verdict({ parentSlot: { readableOnly: true } }).compatible).toBe(true);
  });

  it("refuses a line that names a slot this agent does not declare", () => {
    const v = verdict({
      lines: [{ parentSlotId: "absent", childPackage: CHILD, childSlotId: "ideaContext" }],
    });
    expect(v.compatible).toBe(false);
    if (v.compatible) throw new Error("unreachable");
    expect(v.conflicts.join("\n")).toMatch(/declares no context slot "absent"/);
  });

  it("refuses a line that names an agent this one does not embed, or a slot it does not declare", () => {
    const noAgent = verdict({
      lines: [
        { parentSlotId: "brandVoice", childPackage: "@cinatra-ai/absent", childSlotId: "x" },
      ],
    });
    expect(noAgent.compatible).toBe(false);
    if (noAgent.compatible) throw new Error("unreachable");
    expect(noAgent.conflicts.join("\n")).toMatch(/embeds no agent/);

    const noSlot = verdict({
      lines: [{ parentSlotId: "brandVoice", childPackage: CHILD, childSlotId: "absent" }],
    });
    expect(noSlot.compatible).toBe(false);
    if (noSlot.compatible) throw new Error("unreachable");
    expect(noSlot.conflicts.join("\n")).toMatch(/declares no context slot "absent"/);
  });

  it("refuses two lines for one child slot — one line per child slot", () => {
    const line = {
      parentSlotId: "brandVoice",
      childPackage: CHILD,
      childSlotId: "ideaContext",
    };
    const v = verdict({ lines: [line, { ...line }] });
    expect(v.compatible).toBe(false);
    if (v.compatible) throw new Error("unreachable");
    expect(v.conflicts.join("\n")).toMatch(/declared twice/);
  });
});

describe("installExtensionFromRegistry — the context-slot gate refuses the install", () => {
  function gateDeps(oas: unknown, overrides: Partial<InstallPipelineDeps> = {}) {
    const calls = { begin: 0, requested: 0, approved: 0, provenance: 0, gc: [] as string[] };
    const deps: InstallPipelineDeps = {
      ...makeTestInstallPipelineDeps(),
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY }),
      materialize: async () => ({
        storeDir: "/store/pipeline/new-digest",
        digest: "new-digest",
        integrity: "sha512-abc",
        contentHash: "ch",
      }),
      readRequestedPorts: async () => [],
      readDeclaredCompat: async () => ({ sdkAbiRange: null }),
      readComposedAgentOas: async () => oas,
      recordProvenance: async () => {
        calls.provenance++;
      },
      recordRequestedGrant: async () => {
        calls.requested++;
      },
      approveGrant: async () => {
        calls.approved++;
      },
      beginInstallOp: async () => {
        calls.begin++;
      },
      advanceInstallOpPhase: async () => {},
      gcStoreDir: async (dir) => {
        calls.gc.push(dir);
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it("REFUSES a fresh install on an incompatible declaration — pre-mutation, actionable, GC'd", async () => {
    const { deps, calls } = gateDeps(
      composed({ parentSlot: { resolutionMode: "override" } }),
    );
    await expect(
      installExtensionFromRegistry({ packageName: PARENT, version: "1.0.0", orgId: null }, deps),
    ).rejects.toThrow(/install refused[^]*parent-satisfied context slots[^]*resolves "override"/);
    // Fully inert: NO journal begin, NO grant request/approve, NO provenance.
    expect(calls).toMatchObject({ begin: 0, requested: 0, approved: 0, provenance: 0 });
    expect(calls.gc).toEqual(["/store/pipeline/new-digest"]);
  });

  it("PASSES a compatible declaration, and a package that carries no document at all", async () => {
    for (const oas of [composed({}), null]) {
      const { deps, calls } = gateDeps(oas);
      const r = await installExtensionFromRegistry(
        { packageName: PARENT, version: "1.0.0", orgId: null },
        deps,
      );
      expect(r.installed).toBe(true);
      expect(calls.gc).toEqual([]);
    }
  });

  it("no readComposedAgentOas wired (legacy/unit deps) → no install-time slot gate", async () => {
    const { deps } = gateDeps(composed({ parentSlot: { resolutionMode: "override" } }));
    delete (deps as { readComposedAgentOas?: unknown }).readComposedAgentOas;
    const r = await installExtensionFromRegistry(
      { packageName: PARENT, version: "1.0.0", orgId: null },
      deps,
    );
    expect(r.installed).toBe(true);
  });
});
