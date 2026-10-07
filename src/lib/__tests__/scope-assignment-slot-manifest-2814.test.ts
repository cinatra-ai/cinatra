/**
 * THE ARTIFACTS PANE READS THE AGENT'S TRUSTED SLOT MANIFEST (cinatra#2814,
 * per-scope assignment S2): "lists the agent's declared context slots from its
 * trusted OAS manifest ... honest empty state when the manifest declares no
 * slots".
 *
 * The manifest is the installed OAS, never a caller body. A slot id declared
 * twice is ambiguous and offered by neither copy; a missing or unreadable
 * manifest is reported as such, never as "declares nothing".
 */
import { describe, expect, it } from "vitest";

import {
  readTrustedContextSlot,
  readTrustedContextSlots,
} from "@/lib/scope-assignment/context-slot-manifest.server";

const slot = (slotId: string) => ({
  slotId,
  acceptedArtifactExtensions: ["@cinatra-ai/brand-kit-artifact"],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
  maxItems: 2,
});

/** An installed OAS body declaring these slots where the reader reads them. */
const oas = (...slots: unknown[]) => ({ metadata: { cinatra: { contextSlots: slots } } });

describe("readTrustedContextSlots", () => {
  it("returns the declared slots", async () => {
    const result = await readTrustedContextSlots("@acme/writer", {
      readInstalledOas: async () => oas(slot("brand-voice"), slot("reference-posts")),
    });
    expect(result.ok && result.slots.map((s) => s.slotId)).toEqual(["brand-voice", "reference-posts"]);
  });

  it("returns no slots for a manifest that declares none", async () => {
    expect(await readTrustedContextSlots("@acme/writer", { readInstalledOas: async () => ({}) })).toEqual({
      ok: true,
      slots: [],
    });
  });

  it("offers neither copy of a slot id declared twice", async () => {
    const result = await readTrustedContextSlots("@acme/writer", {
      readInstalledOas: async () => oas(slot("brand-voice"), slot("brand-voice"), slot("posts")),
    });
    expect(result.ok && result.slots.map((s) => s.slotId)).toEqual(["posts"]);
    expect(
      await readTrustedContextSlot("@acme/writer", "brand-voice", {
        readInstalledOas: async () => oas(slot("brand-voice"), slot("brand-voice")),
      }),
    ).toBeNull();
  });

  it("tells a missing manifest and an unreadable one apart from an empty one", async () => {
    expect(await readTrustedContextSlots("@acme/writer", { readInstalledOas: async () => null })).toEqual({
      ok: false,
      reason: "manifest-missing",
    });
    expect(
      await readTrustedContextSlots("@acme/writer", {
        readInstalledOas: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    ).toEqual({ ok: false, reason: "manifest-unreadable" });
  });
});
