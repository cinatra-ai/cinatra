// Bundled artifact claim heal boot phase (cinatra#4158).
//
// ALWAYS-ON, in dev AND prod. An artifact package that ships inside the image
// gets its platform `installed_extension` row from the static-bundle seeder
// (static-bundle-lifecycle.ts), but that seeder writes no
// `artifact_type_claims` row. The boot's claim-activation backstop (the
// `artifact-bridge-store-rescan` phase) only re-fires for packages found in the
// runtime store, and the repair that does seed the claims for an on-disk
// package (`healArtifactInstallRecordAndClaims`, cinatra#2536) ran only from
// the development scan. So on a production-mode instance an image-bundled
// artifact package read as installed while every run that wrote its artifact
// failed with "no active artifact-safe claim".
//
// This phase runs that SAME repair for every image-bundled artifact package
// whose canonical row is already live. It never creates an install row (a
// package without a live row is skipped, so a deployment's installed set is
// never widened, and an archived package is never brought back), and the claim
// half is the idempotent, diff-first backstop: a package whose claims already
// match is a no-op, so a second boot creates no duplicate claim and changes no
// existing claim. Runtime-store packages are not in the image's bundled
// records, so this phase never reads them; the store backstop keeps them.
//
// `retryable`, like the store backstop: a heal failure is logged and never
// aborts boot; the next boot re-runs the same idempotent pass.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import path from "node:path";
import { existsSync } from "node:fs";

import type { BootPhase } from "@/lib/boot/boot-phase";

const SKIPPED_BY_KILL_SWITCH = (envKey: string) => ({ skipped: `disabled via ${envKey}` });

/**
 * The on-disk package dir of an image-bundled package: the record's own source
 * dir (the tree the object-type bridge reads), else the package as the server
 * resolves it. `null` when neither holds a `package.json`.
 */
function resolveBundledPackageDir(rec: { packageName: string; sourceDir?: string | null }): string | null {
  const root = process.cwd();
  const candidates = [
    ...(rec.sourceDir ? [path.resolve(root, rec.sourceDir)] : []),
    path.join(root, "node_modules", rec.packageName),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

export function bundledArtifactClaimHealPhases(): BootPhase[] {
  return [
    {
      name: "bundled-artifact-claim-heal",
      policy: "retryable",
      run: async () => {
        if ((process.env.CINATRA_DISABLE_INSTALL_RECORD_HEAL ?? "").trim() === "true") {
          return SKIPPED_BY_KILL_SWITCH("CINATRA_DISABLE_INSTALL_RECORD_HEAL");
        }
        const { STATIC_EXTENSION_RECORDS } = await import("@/lib/generated/extensions.server");
        const { probeInstallRecord, healArtifactInstallRecordAndClaims } = await import(
          "@/lib/extension-install-anchor"
        );
        const tally = { converged: 0, notApplicable: 0, unhealed: 0, notLive: 0 };
        for (const rec of STATIC_EXTENSION_RECORDS) {
          if (rec.kind !== "artifact") continue;
          // Only a package whose row is ALREADY live: this phase seeds claims,
          // it never decides that a package is installed.
          const probe = await probeInstallRecord(rec.packageName, {}, { expectKind: "artifact" });
          if (probe.state !== "live") {
            tally.notLive += 1;
            continue;
          }
          const packageDir = resolveBundledPackageDir(rec);
          if (!packageDir) {
            tally.unhealed += 1;
            console.warn(
              `[boot] bundled artifact claim heal: ${rec.packageName} is install-active but no package.json ` +
                `was found on disk, so its artifact type claims cannot be seeded (cinatra#4158).`,
            );
            continue;
          }
          const outcome = await healArtifactInstallRecordAndClaims({
            packageName: rec.packageName,
            packageDir,
            version: rec.version ?? undefined,
          });
          if (outcome.claims === "converged") tally.converged += 1;
          else if (outcome.claims === "not-applicable") tally.notApplicable += 1;
          else {
            tally.unhealed += 1;
            console.warn(
              `[boot] bundled artifact claim heal: ${rec.packageName} is install-active but has NO active ` +
                `artifact type claim — ${outcome.detail ?? outcome.claims}. Runs that write its artifact ` +
                `will fail until the claim activates (cinatra#4158).`,
            );
          }
        }
        if (tally.converged || tally.unhealed || tally.notApplicable) {
          console.info(
            `[boot] bundled artifact claim heal: converged=${tally.converged} ` +
              `not-applicable=${tally.notApplicable} unhealed=${tally.unhealed} not-live=${tally.notLive}`,
          );
        }
      },
    },
  ];
}
