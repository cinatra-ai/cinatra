/**
 * The Anthropic skill sync map must be a PER-PROCESS singleton, not a
 * per-module-instance one (cinatra#2094 finding F7).
 *
 * WHY THIS TEST EXISTS — the defect it pins, stated as the failure it produced:
 * the map used to live in a plain module-level `let`. Next.js gives each bundler
 * compilation (instrumentation / route / RSC) its OWN module cache, so the
 * table-backed map installed by the `anthropic-skill-sync-map` BOOT phase (the
 * instrumentation compilation) was invisible to `/chat` and `/api/llm-bridge`
 * (route compilations), which each held a fresh
 * `UnsyncedAnthropicSkillMap`. Every Anthropic skill delivery therefore resolved
 * `null` and threw `AnthropicSkillNotSyncedError` — INCLUDING for skills that
 * held non-stale `cinatra.anthropic_skill_sync` rows, which is exactly the
 * symptom the S7 acceptance recorded (all 5 required ids named as unsynced while
 * 2 of them measurably resolved in SQL). Measured in-process on the live failing
 * turn as `resolver=UnsyncedAnthropicSkillMap`.
 *
 * `vi.resetModules()` + a fresh dynamic import reproduces the second
 * compilation's fresh module cache inside one process: the module state is
 * re-initialized, but the process is the same — which is precisely the Next.js
 * situation. Before the fix the second instance answered with its own default;
 * after it, the installed map survives because the holder is keyed on
 * `globalThis` under a namespaced `Symbol.for(...)`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import {
  setAnthropicSkillSyncMap,
  resetAnthropicSkillSyncMap,
  getAnthropicSkillSyncMap,
  type AnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "../tools/anthropic-skill-sync-map";

const MODULE_PATH = "../tools/anthropic-skill-sync-map";

/** A stand-in for the table-backed map the boot phase installs. */
class FakeTableBackedSyncMap implements AnthropicSkillSyncMap {
  async resolve(catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null> {
    return { skillId: "skill_boot", version: "1", catalogSkillId };
  }
}

afterEach(() => {
  resetAnthropicSkillSyncMap();
  vi.resetModules();
});

describe("Anthropic skill sync map — cross-compilation (per-process) holder", () => {
  it("a FRESH module instance in the SAME process still resolves the installed map", async () => {
    // Compilation 1 (stands in for the instrumentation/boot compilation).
    setAnthropicSkillSyncMap(new FakeTableBackedSyncMap());
    expect(getAnthropicSkillSyncMap().constructor.name).toBe("FakeTableBackedSyncMap");

    // Compilation 2 (stands in for the /chat route compilation): a brand new
    // module instance, same process, no re-registration.
    vi.resetModules();
    const fresh = await import(MODULE_PATH);
    const resolver = fresh.getAnthropicSkillSyncMap();

    // THE REGRESSION: this used to be `UnsyncedAnthropicSkillMap`.
    expect(resolver.constructor.name).toBe("FakeTableBackedSyncMap");
    await expect(resolver.resolve("@cinatra-ai/chat:chat-assistant-core")).resolves.toEqual({
      skillId: "skill_boot",
      version: "1",
      catalogSkillId: "@cinatra-ai/chat:chat-assistant-core",
    });
  });

  it("the fail-loud default still applies when NOTHING was ever installed", async () => {
    resetAnthropicSkillSyncMap();
    // The reset installs the default explicitly; a never-touched process gets it
    // from the lazy fallback in `getAnthropicSkillSyncMap`.
    expect(getAnthropicSkillSyncMap().constructor.name).toBe("UnsyncedAnthropicSkillMap");
    await expect(getAnthropicSkillSyncMap().resolve("@x/y:z")).resolves.toBeNull();
  });

  it("a reset in one module instance is observed by another (one shared holder)", async () => {
    setAnthropicSkillSyncMap(new FakeTableBackedSyncMap());
    vi.resetModules();
    const fresh = await import(MODULE_PATH);
    fresh.resetAnthropicSkillSyncMap();
    // Observed through the ORIGINAL instance — proves there is exactly one
    // holder, so a test's `afterEach` reset cannot leak state into a sibling.
    expect(getAnthropicSkillSyncMap().constructor.name).toBe("UnsyncedAnthropicSkillMap");
  });
});
