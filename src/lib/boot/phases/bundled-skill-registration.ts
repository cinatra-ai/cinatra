// Bundled colocated-skill registration boot phase (cinatra#2398).
//
// ALWAYS-ON, in dev AND prod — that is the entire point of the phase. The
// equivalent scan used to exist only on the dev path
// (`dev-boot.ts` -> `loadAllSkillPackagesAtBoot`, which early-returns unless
// `CINATRA_RUNTIME_MODE === "development"`), so on a production standalone
// build an image-bundled extension's co-located `skills/<slug>/SKILL.md` never
// reached `cinatra.skills` unless some lazy consumer self-healed it first. This
// phase makes registration a guaranteed boot fact instead of a race with the
// first read.
//
// ORDER: immediately BEFORE `skills-catalog-rebuild`, mirroring the dev scan's
// own scan-then-rebuild sequence — the rebuild then runs over a catalog that
// already contains the bundled rows and records its completeness fence over
// them. The registrar holds the catalog-rebuild lease for its own pass and
// RELEASES it before returning, so the rebuild phase that follows re-acquires
// it cleanly.
//
// Why `degraded`: a registration failure must never abort boot. The process
// serves whatever the catalog already holds, the lazy resolver still self-heals
// on demand exactly as it did before this phase existed, and the next boot
// re-runs an idempotent pass.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function bundledSkillRegistrationPhases(): BootPhase[] {
  return [
    {
      name: "bundled-skill-registration",
      policy: "degraded",
      run: async () => {
        const { registerBundledColocatedSkills } = await import(
          "@cinatra-ai/skills/bundled-skill-registration"
        );
        await registerBundledColocatedSkills();
      },
    },
  ];
}
