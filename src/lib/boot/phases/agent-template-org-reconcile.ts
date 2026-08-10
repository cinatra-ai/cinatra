// Agent-template owning-org reconcile boot phase (cinatra#2619).
//
// MANDATORY and ALWAYS-ON (dev AND prod). The bundled-agent import runs before
// any organization exists on a fresh instance, so every seeded template lands
// with no owning org and `assertActorWithinAgentTemplateScope` denies every run
// with `unknown_scope`. Nothing backfilled those rows — the next boot logs
// "skipped — already up to date" and the first-run trigger that would COALESCE
// `org_id` can never fire, because the run is refused at creation.
//
// This phase is the heal that breaks the deadlock for EVERY already-damaged
// instance: it runs on the next boot, anchors the ownerless rows to the
// instance's single organization, and is a no-op forever after (its own writes
// stop matching its predicate). The reconcile primitive owns the safety rules —
// it never touches a template that already has an owner and never guesses an
// owner on a multi-org instance.
//
// ORDERING. After `core-boot` (the schema bootstrap has run, so the
// `owner_level IS NULL -> 'organization'` DDL backfill already stamped rows
// imported on the PREVIOUS boot) and after the extension/required-set phases
// that import agents on a prod boot, so this pass sees the rows those phases
// wrote. Placed next to the other agent self-heal passes.
//
// This phase is also where the org-bootstrap arm gets its implementation
// (`setOwnerlessAgentTemplateHealer`): `default-organization-bootstrap.ts` is
// reachable from every route, so it declares the slot and this module — reachable
// only from `instrumentation`, never from a route — fills it.
//
// `degraded`: a reconcile failure must never abort boot. The instance serves,
// the un-anchored agents stay refused exactly as they were, and the next boot
// retries an idempotent pass.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function agentTemplateOrgReconcilePhases(): BootPhase[] {
  return [
    {
      name: "agent-template-org-reconcile",
      policy: "degraded",
      run: async () => {
        const {
          reconcileAgentTemplateOrgOwnership,
          listInstanceOrganizationIds,
          describeReconcileResult,
        } = await import("@cinatra-ai/agents/reconcile-template-org-ownership");
        const { setOwnerlessAgentTemplateHealer } = await import(
          "@/lib/default-organization-bootstrap"
        );

        const pass = async (label: string) => {
          const r = await reconcileAgentTemplateOrgOwnership({
            listOrganizationIds: listInstanceOrganizationIds,
          });
          if (r.status === "healed") {
            console.log(`[agents/org-reconcile]${label} ${describeReconcileResult(r)}`);
          } else if (r.status === "skipped") {
            console.warn(
              `[agents/org-reconcile]${label} ${describeReconcileResult(r)} — ` +
                `those templates stay refused at run start (cinatra#2619)`,
            );
          }
          return r;
        };

        // Hand the org-bootstrap chokepoint its implementation. That module is
        // route-reachable and must not import this package itself (the
        // route-graph ratchet counts every edge), so the dependency is injected
        // from here — the boot side, which is not a route entry.
        setOwnerlessAgentTemplateHealer(async () => {
          await pass(" (org bootstrap)");
        });

        // Same inversion for the IMPORT side: `ensure-agent-package.ts` is also
        // route-reachable, so it declares a resolver slot rather than importing
        // the Better Auth store or the reconcile module. Registering it here is
        // what lets a seed written on an already-set-up instance be born with its
        // determinate anchor. Unregistered, the loader answers `null` and the row
        // is simply healed later — fail-closed either way.
        const { setAgentImportOwningOrgResolver } = await import(
          "@cinatra-ai/agents/ensure-agent-package"
        );
        setAgentImportOwningOrgResolver(async () => {
          const ids = await listInstanceOrganizationIds();
          return ids.length === 1 ? ids[0] : null;
        });

        const result = await pass("");

        // `pass` is silent on the overwhelmingly common healthy boot, and loud
        // whenever it either changed something or REFUSED to (a skipped
        // multi-org instance must not be a silent denial forever). Returning it
        // keeps the phase's own result available to any future assertion.
        void result;
      },
    },
  ];
}
