// Core boot phases (engineering #302).
//
// The non-extension, non-loop startup side effects extracted verbatim from
// `instrumentation.node.ts`, each as a `BootPhase`. The bodies are byte-for-byte
// the same work the inline blocks did; the only change is that the ad-hoc
// try/catch is replaced by the phase POLICY (the runner records + applies it).
//
// Policy mapping (preserving the old per-block behavior exactly):
//   - dev-encryption-key / teardown-hook / activate-hook wiring : these never
//     threw before (they were unguarded or trivially safe). `retryable` so a
//     surprise failure is logged + swallowed rather than aborting boot.
//   - core-migrations : `fatal` — the prod/dev split lives INSIDE
//     runCoreMigrationsAtBoot (it rethrows only in prod for a real migration
//     failure). So this phase only throws when prod-abort was already the policy.
//   - cache-warmup / instance-identity / marketplace-attach : `retryable` —
//     each had its own try/catch that logged + continued ("retries on next boot").
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function coreBootPhases(): BootPhase[] {
  return [
    {
      name: "dev-encryption-key",
      policy: "retryable",
      run: async () => {
        // Dev-mode encryption key auto-gen. No-op in production.
        const { ensureDevEncryptionKey } = await import("@/lib/dev-encryption-key-bootstrap");
        ensureDevEncryptionKey();
      },
    },
    {
      name: "extension-teardown-hook-wiring",
      policy: "retryable",
      run: async () => {
        // Install the durable extension data-teardown hook at boot so a hard
        // uninstall/forceDelete via a UI Server Action (which does NOT load the
        // heavy @/lib/extensions handler graph) still finds the hook wired.
        await import("@/lib/extension-data-teardown-wiring");
      },
    },
    {
      name: "extension-activate-hook-wiring",
      policy: "retryable",
      run: async () => {
        // Install the hot-activate hook at boot so a connector install/update via
        // a UI Server Action hot-activates in-process (no restart) even in a
        // worker that never imported @/lib/extensions.
        await import("@/lib/extension-activate-hook-wiring");
      },
    },
    {
      name: "core-migrations",
      policy: "fatal",
      run: async () => {
        // Versioned core schema migrations (cinatra#116). The prod/dev fatality
        // split lives inside runCoreMigrationsAtBoot: prod rethrows a real
        // migration failure (aborting boot — this `fatal` phase), dev logs +
        // continues (returns -> `ok`). Unreachable/unconfigured DB -> skip.
        const { runCoreMigrationsAtBoot } = await import("@/lib/core-migrations");
        await runCoreMigrationsAtBoot();
      },
    },
    {
      name: "cache-warmup",
      policy: "retryable",
      run: async () => {
        // Pre-warm all version-based globalThis caches before the first
        // navigation. Also triggers ensurePostgresSchema() so the CREATE TABLE /
        // migration queries run once at startup, not during the first navigation.
        // Non-fatal — DB may not be configured yet (fresh install pre-wizard);
        // the first navigation will warm caches normally.
        const {
          readStartupDatasetFromDatabase,
          readSkillCatalogFromDatabase,
          readStartupOverridesFromDatabase,
        } = await import("@/lib/database");
        readStartupDatasetFromDatabase();
        readSkillCatalogFromDatabase();
        readStartupOverridesFromDatabase();
      },
    },
    {
      name: "instance-identity",
      policy: "retryable",
      run: async () => {
        // Backfill instanceId + instanceAttachSecret on the existing
        // instance_identity row. Idempotent; no-op for fresh installs pre-setup.
        // Awaited so downstream marketplace-attach hooks see the populated fields.
        // Non-fatal — instance-attach call sites retry on the next boot.
        const { ensureInstanceId } = await import("@/lib/instance-identity-store");
        await ensureInstanceId();
      },
    },
    {
      name: "marketplace-attach",
      policy: "retryable",
      run: async () => {
        // Marketplace consumer attach + vendor-state reconcile. Awaited so
        // downstream boot work that reads identity.consumerAttachment / vendorState
        // sees the post-reconcile values. Bails internally when the marketplace is
        // unreachable; never blocks boot — retries on the next boot.
        const { ensureMarketplaceAttachment } = await import("@/lib/marketplace-attach");
        await ensureMarketplaceAttachment();
      },
    },
  ];
}
