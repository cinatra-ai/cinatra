import "server-only";

// ---------------------------------------------------------------------------
// THE AGENT'S TRUSTED CONTEXT SLOT MANIFEST (cinatra#2814, per-scope
// assignment S2).
//
// The Artifacts pane draws one group per slot the agent's manifest declares,
// and the context store refuses a row naming a slot the manifest does not
// declare. Both read the manifest HERE, from the same trust root the context
// routes read: the INSTALLED OAS on disk, resolved by the shared resolver from
// the canonical package name. Never a caller-supplied body.
//
// A slot id declared twice is ambiguous (the context routes refuse it as
// `slot_ambiguous`), so neither copy is offered and neither can be written.
// An unreadable manifest is an outage, not an empty manifest: the caller is
// told which, so the pane can say "could not be read" instead of the honest
// "declares no slots" empty state.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";

import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

export type TrustedContextSlots =
  | { ok: true; slots: AgentContextSlot[] }
  | { ok: false; reason: "manifest-missing" | "manifest-unreadable" };

export type TrustedContextSlotsDeps = {
  /** The installed OAS body for a package, `null` when none is installed. */
  readInstalledOas?: (packageName: string) => Promise<Record<string, unknown> | null>;
};

async function readInstalledOasDefault(packageName: string): Promise<Record<string, unknown> | null> {
  const { probeInstalledOasPathForRead } = await import("@cinatra-ai/agents/installed-oas-path");
  const probe = probeInstalledOasPathForRead(packageName);
  if (!probe.path) return null;
  return JSON.parse(await readFile(probe.path, "utf8")) as Record<string, unknown>;
}

/** Every slot the package's installed manifest declares exactly once. */
export async function readTrustedContextSlots(
  packageName: string,
  deps: TrustedContextSlotsDeps = {},
): Promise<TrustedContextSlots> {
  let oas: Record<string, unknown> | null;
  try {
    oas = await (deps.readInstalledOas ?? readInstalledOasDefault)(packageName);
  } catch {
    return { ok: false, reason: "manifest-unreadable" };
  }
  if (!oas) return { ok: false, reason: "manifest-missing" };
  const { readAgentContextSlotsFromOas } = await import(
    "@cinatra-ai/extensions/agent-context-slots-reader"
  );
  const declared = readAgentContextSlotsFromOas(oas);
  const counts = new Map<string, number>();
  for (const slot of declared) counts.set(slot.slotId, (counts.get(slot.slotId) ?? 0) + 1);
  return { ok: true, slots: declared.filter((slot) => counts.get(slot.slotId) === 1) };
}

/** The one slot with this id, or `null` (absent, ambiguous or unreadable). */
export async function readTrustedContextSlot(
  packageName: string,
  slotId: string,
  deps: TrustedContextSlotsDeps = {},
): Promise<AgentContextSlot | null> {
  const manifest = await readTrustedContextSlots(packageName, deps);
  if (!manifest.ok) return null;
  return manifest.slots.find((slot) => slot.slotId === slotId) ?? null;
}
