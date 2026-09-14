import "server-only";

// Extension → host/SDK compatibility — the install/update half of the contract.
//
// An extension declares the host/SDK ABI range it was built against in its
// manifest (`cinatra.sdkAbiRange`, see the frozen contract in
// `@cinatra-ai/sdk-extensions` manifest.ts). BOTH loaders already gate
// ACTIVATION on that declaration (`abiCompatible` in runtime-loader /
// static-bundle-loader) — but gating only at activation means an incompatible
// package can still INSTALL or UPDATE fine, finalize durable state (journal,
// grant, provenance, store dir), and then silently refuse to load at boot.
//
// This module gives the install + update paths the SAME verdict the loaders
// use, so a mismatch is refused BEFORE any durable state mutates, with an
// actionable error: which range the extension requires vs. which ABI this host
// provides. The verdict function is the SDK's own `isSdkAbiRangeSatisfied`
// (absent/"*" → unpinned/compatible; malformed or unsatisfied → fail closed),
// imported — never re-implemented — so the install gate can NEVER drift from
// the loaders' activation gate.
//
// Dependency direction stays extension → host/SDK (true IoC): the host only
// CONSUMES the SDK's frozen checker + ABI version constant and reads the
// MATERIALIZED package's own manifest. No extension package is imported.

import {
  isSdkAbiRangeSatisfied,
  SDK_EXTENSIONS_ABI_VERSION,
} from "@cinatra-ai/sdk-extensions";
import {
  readAgentContextSlotsFromOas,
  readParentSatisfiedContextSlotsStrictFromOas,
  type AgentContextSlot,
  type ParentSatisfiedContextSlot,
} from "@cinatra-ai/extensions/agent-context-slots-reader";

export type DeclaredHostCompat = {
  /** `cinatra.sdkAbiRange` from the package manifest, or null when undeclared. */
  sdkAbiRange: string | null;
};

/**
 * Read the declared host/SDK compatibility range from a MATERIALIZED package
 * dir (the SRI-verified bytes — the same trust basis the pipeline's
 * `readRequestedPorts` uses). A missing/unparseable package.json reads as
 * undeclared (the loaders treat the package as unpinned; install matches).
 */
export async function readDeclaredHostCompatFromStore(storeDir: string): Promise<DeclaredHostCompat> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return { sdkAbiRange: null };
  }
  let manifest: { cinatra?: { sdkAbiRange?: unknown } };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { sdkAbiRange: null };
  }
  const range = manifest.cinatra?.sdkAbiRange;
  return { sdkAbiRange: typeof range === "string" ? range : null };
}

/**
 * The loaders' ABI verdict, surfaced for the install/update gates: does this
 * host's frozen `@cinatra-ai/sdk-extensions` ABI satisfy the extension's
 * declared range? `compatible:true` for an undeclared/"*" range (unpinned);
 * fail closed (`compatible:false`) for a malformed range or a host outside the
 * declared bounds.
 */
export function evaluateHostSdkCompat(sdkAbiRange: string | null | undefined): {
  compatible: boolean;
  hostAbiVersion: string;
} {
  return {
    compatible: isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, sdkAbiRange),
    hostAbiVersion: SDK_EXTENSIONS_ABI_VERSION,
  };
}

/**
 * One actionable refusal message for every install/update surface (pipeline +
 * workflow saga), so the operator always learns: WHAT was refused, WHICH range
 * the extension requires, WHAT this host provides, and HOW to fix it.
 */
export function formatHostSdkCompatRefusal(input: {
  op: "install" | "update";
  packageName: string;
  version: string;
  sdkAbiRange: string | null;
}): string {
  const declared = input.sdkAbiRange === null ? "(undeclared)" : `"${input.sdkAbiRange}"`;
  return (
    `${input.op} of ${input.packageName}@${input.version} refused: the extension declares ` +
    `cinatra.sdkAbiRange ${declared} — the host/SDK ABI range it was built against — but this ` +
    `host provides @cinatra-ai/sdk-extensions ABI ${SDK_EXTENSIONS_ABI_VERSION}, which does not ` +
    `satisfy that range (a malformed range fails closed). Install a release of ` +
    `${input.packageName} whose sdkAbiRange admits ABI ${SDK_EXTENSIONS_ABI_VERSION}, or upgrade ` +
    `the host. Nothing was installed; the previously installed version (if any) is untouched.`
  );
}

// ===========================================================================
// The SECOND install/update compatibility gate this module carries: a composite
// agent's parent-satisfied context slots against the agents it embeds. It sits
// BESIDE the host/SDK gate above -- the same install seam, the same
// pre-mutation refusal shape -- rather than in a module of its own, because the
// locked routes' reachable first-party module graph is ratcheted
// (scripts/audit/route-graph-ratchet.mjs) and a new module on the install
// pipeline's edge grows every one of them.
// ===========================================================================

// ---------------------------------------------------------------------------
// PARENT-SATISFIED CONTEXT SLOTS, CHECKED AT INSTALL (plan (C) item 0.29,
// cinatra#3032, epic #3023 W8).
//
//   item 0.29: "The declaration is static and checked at install against the
//   children's slots: the parent slot accepts every extension the child slot
//   accepts, its cardinality fits the child's bounds, the resolution mode
//   matches, a read-only child slot receives read-only references, and the
//   child receives the pinned revisions the parent's selection finalized; a
//   conflict refuses the install."
//
// WHY AT INSTALL. The declaration removes the child's own pause: at run time
// the child no longer asks, it receives. A line that promises the child
// something the parent's slot cannot deliver — a kind of artefact the child
// accepts and the parent does not, more references than the child's bounds
// admit, a different resolution, or a writable reference into a read-only slot
// — would be discovered as a run that quietly worked on the wrong material.
// So it is a REFUSAL, before anything is installed, in the same seam and with
// the same inertness contract as the host/SDK compatibility gate the pipeline
// already runs: nothing durable has been written when it fires.
//
// WHAT IS NOT CHECKED HERE, and why. "the child receives the pinned revisions
// the parent's selection finalized" is not a field a manifest can get wrong:
// the value handed down IS the parent's finalized selection, threaded verbatim
// by the loader, and a finalized selection is pinned by construction — the
// selection is made through the context-selection road and finalized
// server-side. There is nothing static to disagree with, so this module states
// the fact rather than inventing a check for it; the threading itself is proved
// on the loader.
//
// PURE MODULE. No I/O, no registry, no database — it is fed an already-read
// composed document, so the install pipeline's own seam owns the reading.
// ---------------------------------------------------------------------------
/** One carrier of a slot declaration inside a composed document: the agent that
 *  owns the slots, named by its package. */
export type ContextSlotCarrier = {
  packageName: string | null;
  slots: AgentContextSlot[];
  /** The lines THIS carrier declares. Every carrier may declare them — the
   *  loader reads them off every declaration carrier, not only the root — so a
   *  nested composite's declaration is checked at install too. */
  lines?: ParentSatisfiedContextSlot[];
};

/** Everything the check needs, read off ONE composed document. */
export type ContextSlotComposition = {
  /** The composite agent's own package name, as the document declares it. */
  packageName: string | null;
  /** The composite agent's own slots. */
  parentSlots: AgentContextSlot[];
  /** The lines the composite agent declared. */
  lines: ParentSatisfiedContextSlot[];
  /** Every embedded agent's slots, by package name. */
  children: ContextSlotCarrier[];
  /** EVERY declaration carrier in the document, the composite agent itself
   *  first — the same set the loader walks. A nested composite declares lines
   *  of its own and the runtime enforces them, so the install gate checks each
   *  carrier's lines against the agents that carrier embeds. */
  carriers?: ContextSlotCarrier[];
  /** A declaration that is PRESENT and INVALID, per carrier. Distinct from an
   *  absent one: an unreadable declaration may never read as "nothing to
   *  check", or one stray key would turn a refusal into an install. */
  malformed?: string[];
};

function isFlowDefinition(node: Record<string, unknown>): boolean {
  // The same shape the loader's `_is_flow_definition` recognises.
  return (
    typeof node.id === "string" &&
    (typeof node.$referenced_components === "object" ||
      typeof node.start_node === "string" ||
      typeof node.start_node === "object" ||
      Array.isArray(node.nodes))
  );
}

function metadataCinatra(node: Record<string, unknown>): Record<string, unknown> | null {
  const meta = node.metadata;
  if (!meta || typeof meta !== "object") return null;
  const cin = (meta as { cinatra?: unknown }).cinatra;
  return cin && typeof cin === "object" ? (cin as Record<string, unknown>) : null;
}

/**
 * Read a composed agent document into the shape the check consumes.
 *
 * The composite agent IS the root Flow definition; the agents it embeds are the
 * nested Flow definitions the document carries, each naming its own package —
 * the same traversal the loader makes when it decides where to inject.
 */
export function readContextSlotComposition(oas: unknown): ContextSlotComposition {
  const empty: ContextSlotComposition = {
    packageName: null,
    parentSlots: [],
    lines: [],
    children: [],
  };
  if (!oas || typeof oas !== "object" || Array.isArray(oas)) return empty;
  const root = oas as Record<string, unknown>;
  const rootCin = metadataCinatra(root);
  const children: ContextSlotCarrier[] = [];
  const carriers: ContextSlotCarrier[] = [];
  const malformed: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record !== root && isFlowDefinition(record)) {
      const cin = metadataCinatra(record);
      const slots = readAgentContextSlotsFromOas(record);
      const pkg = cin?.packageName;
      const name = typeof pkg === "string" && pkg.length > 0 ? pkg : null;
      const read = readParentSatisfiedContextSlotsStrictFromOas(record);
      if (!read.ok) malformed.push(`${name ?? "an embedded agent"}: ${read.error}`);
      const lines = read.ok ? read.lines : [];
      if (slots.length > 0) children.push({ packageName: name, slots, lines });
      if (slots.length > 0 || lines.length > 0) {
        carriers.push({ packageName: name, slots, lines });
      }
    }
    for (const value of Object.values(record)) walk(value);
  };
  for (const value of Object.values(root)) walk(value);

  const ownPackage = rootCin?.packageName;
  const name = typeof ownPackage === "string" && ownPackage.length > 0 ? ownPackage : null;
  const rootSlots = readAgentContextSlotsFromOas(root);
  const rootRead = readParentSatisfiedContextSlotsStrictFromOas(root);
  if (!rootRead.ok) malformed.push(`${name ?? "this agent"}: ${rootRead.error}`);
  const rootLines = rootRead.ok ? rootRead.lines : [];
  return {
    packageName: name,
    parentSlots: rootSlots,
    lines: rootLines,
    children,
    carriers: [{ packageName: name, slots: rootSlots, lines: rootLines }, ...carriers],
    malformed,
  };
}

export type ContextSlotCompatVerdict =
  | { compatible: true }
  | { compatible: false; conflicts: string[] };

function describeLine(line: ParentSatisfiedContextSlot): string {
  return `"${line.parentSlotId}" -> ${line.childPackage} "${line.childSlotId}"`;
}

/** The bounds a slot admits, with the schema's own defaults made explicit. */
function bounds(slot: AgentContextSlot): { min: number; max: number } {
  return {
    min: typeof slot.minItems === "number" ? slot.minItems : 0,
    max: typeof slot.maxItems === "number" ? slot.maxItems : Number.POSITIVE_INFINITY,
  };
}

/**
 * Check every declared line against the children's own slots.
 *
 * A composition with no lines is compatible by definition — a child with no
 * line keeps its own pause, and a child with no slot receives nothing.
 */
export function checkParentSatisfiedContextSlots(
  composition: ContextSlotComposition,
): ContextSlotCompatVerdict {
  const conflicts: string[] = [...(composition.malformed ?? [])];

  // EVERY DECLARATION CARRIER, not only the root (the loader reads them off
  // every carrier and enforces them at mount, so the install gate that is
  // supposed to refuse them first must look in the same places). A composition
  // handed in without a carrier list is read as the single root carrier it
  // used to be.
  const carriers: ContextSlotCarrier[] =
    composition.carriers ??
    [
      {
        packageName: composition.packageName,
        slots: composition.parentSlots,
        lines: composition.lines,
      },
      ...composition.children,
    ];
  const declaring = carriers.filter((c) => (c.lines ?? []).length > 0);
  if (declaring.length === 0 && conflicts.length === 0) return { compatible: true };

  for (const carrier of declaring) {
    checkOneCarrier(carrier, carriers, composition, conflicts);
  }

  return conflicts.length === 0 ? { compatible: true } : { compatible: false, conflicts };
}

/** One carrier's lines against the agents that carrier embeds. */
function checkOneCarrier(
  carrier: ContextSlotCarrier,
  carriers: readonly ContextSlotCarrier[],
  composition: ContextSlotComposition,
  conflicts: string[],
): void {
  const parentBySlot = new Map(carrier.slots.map((s) => [s.slotId, s]));
  const childrenByPackage = new Map<string, AgentContextSlot[]>();
  const embedded =
    composition.carriers === undefined
      ? composition.children
      : carriers.filter((c) => c !== carrier);
  for (const child of embedded) {
    if (child.packageName === null) continue;
    const existing = childrenByPackage.get(child.packageName) ?? [];
    childrenByPackage.set(child.packageName, [...existing, ...child.slots]);
  }

  // ONE LINE PER CHILD SLOT (item 0.29). Two lines for one child slot are two
  // answers to "which pick does this child receive".
  const seen = new Set<string>();
  for (const line of carrier.lines ?? []) {
    const key = `${line.childPackage} ${line.childSlotId}`;
    if (seen.has(key)) {
      conflicts.push(
        `${describeLine(line)}: declared twice — one line per child slot, or the child ` +
          "receives two answers to one question",
      );
      continue;
    }
    seen.add(key);

    const parent = parentBySlot.get(line.parentSlotId);
    if (!parent) {
      conflicts.push(
        `${describeLine(line)}: this agent declares no context slot "${line.parentSlotId}" ` +
          "— a slot cannot satisfy a child with a pick it never makes",
      );
      continue;
    }
    const childSlots = childrenByPackage.get(line.childPackage);
    if (!childSlots) {
      conflicts.push(
        `${describeLine(line)}: this agent embeds no agent "${line.childPackage}" that ` +
          "declares context slots",
      );
      continue;
    }
    const child = childSlots.find((s) => s.slotId === line.childSlotId);
    if (!child) {
      conflicts.push(
        `${describeLine(line)}: ${line.childPackage} declares no context slot ` +
          `"${line.childSlotId}"`,
      );
      continue;
    }

    // "the parent slot accepts every extension the child slot accepts"
    const parentAccepts = new Set(parent.acceptedArtifactExtensions);
    const unaccepted = child.acceptedArtifactExtensions.filter((e) => !parentAccepts.has(e));
    if (unaccepted.length > 0) {
      conflicts.push(
        `${describeLine(line)}: the child accepts [${unaccepted.join(", ")}], which this ` +
          `agent's slot does not (it accepts [${parent.acceptedArtifactExtensions.join(", ")}]) ` +
          "— it could hand down nothing for those",
      );
    }

    // "its cardinality fits the child's bounds"
    const p = bounds(parent);
    const c = bounds(child);
    if (p.min < c.min || p.max > c.max) {
      const show = (n: number) => (Number.isFinite(n) ? String(n) : "unbounded");
      conflicts.push(
        `${describeLine(line)}: this agent's slot selects ${show(p.min)}..${show(p.max)} ` +
          `references and the child admits ${show(c.min)}..${show(c.max)} — a pick outside ` +
          "the child's bounds could be handed down",
      );
    }

    // "the resolution mode matches"
    if (parent.resolutionMode !== child.resolutionMode) {
      conflicts.push(
        `${describeLine(line)}: this agent's slot resolves "${parent.resolutionMode}" and the ` +
          `child expects "${child.resolutionMode}" — the child would read a differently ` +
          "ordered set from the one it was written for",
      );
    }

    // "a read-only child slot receives read-only references"
    if (child.readableOnly === true && parent.readableOnly !== true) {
      conflicts.push(
        `${describeLine(line)}: the child's slot is read-only and this agent's slot is not ` +
          "— a writable reference may not be handed into a read-only slot",
      );
    }
  }
}

/**
 * The refusal sentence an install/update throws with — the same shape and the
 * same actionability as the host/SDK compatibility refusal beside it.
 */
export function formatContextSlotCompatRefusal(input: {
  op: "install" | "update";
  packageName: string;
  version: string;
  conflicts: string[];
}): string {
  const lines = input.conflicts.map((c) => `  - ${c}`).join("\n");
  return (
    `[install-pipeline] ${input.packageName}@${input.version}: ${input.op} refused — its ` +
    "declared parent-satisfied context slots do not fit the agents it embeds " +
    `(cinatra#3032, plan (C) item 0.29). ${input.conflicts.length} conflict(s):\n${lines}`
  );
}
