// Skills-catalog explicit rebuild boot phase (cinatra#1364, lifecycle A4).
//
// The catalog read/rebuild split makes the rebuild an EXPLICIT lifecycle
// operation instead of a side effect of the first `readSkillsCatalog()` call.
// This phase runs it once at boot, AFTER extension activation and the
// required-extension materialize/projection phases (so the on-disk skill trees
// those phases produce are what the scanner merges), and records the
// completeness fence (`skills_catalog_rebuild_state`) that pure-snapshot
// consumers can consult. Until every call site migrates off the legacy
// read-triggers-rebuild path (S8, cinatra#1358), a failure here is self-healing
// — the next legacy read still rebuilds implicitly.
//
// Why `degraded`: a rebuild failure (e.g. transient GitHub sync/disk hiccup)
// must never abort boot — the process serves the persisted catalog, and the
// legacy path + the next lifecycle trigger retry the rebuild.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function skillsCatalogRebuildPhases(): BootPhase[] {
  return [
    {
      name: "skills-catalog-rebuild",
      policy: "degraded",
      run: async () => {
        const { rebuildSkillsCatalog } = await import(
          "@cinatra-ai/skills/skill-packages"
        );
        await rebuildSkillsCatalog({ reason: "boot" });
      },
    },
  ];
}
