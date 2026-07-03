// Artifact data-root stranded-bytes guard (cinatra#926, epic #922).
//
// The artifact byte root became configurable (env CINATRA_ARTIFACT_DATA_ROOT >
// DB metadata `artifact_data_root` > cwd-relative `data/artifacts`). A
// misconfigured root on a host that already HAS artifact rows would make every
// existing artifact 404 while looking like data loss. This phase warns LOUDLY
// when `artifact_blobs` rows exist but the resolved root has no `orgs/` dir —
// that is a mis-pointed root (config), not lost bytes.
//
// `retryable` + read-only: it never blocks or mutates anything; a DB hiccup
// logs and retries next boot. A fresh instance (no rows yet) is silent.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import { existsSync } from "node:fs";
import path from "node:path";

import type { BootPhase } from "@/lib/boot/boot-phase";

export function artifactDataRootGuardPhases(): BootPhase[] {
  return [
    {
      name: "artifact-data-root-guard",
      policy: "retryable",
      run: async () => {
        const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
        const { getPostgresConnectionString, postgresSchema } = await import(
          "@/lib/postgres-config"
        );
        const schema = postgresSchema.replaceAll('"', '""');
        const [res] = runPostgresQueriesSync({
          connectionString: getPostgresConnectionString(),
          queries: [
            { text: `SELECT 1 FROM "${schema}"."artifact_blobs" LIMIT 1`, values: [] },
          ],
        });
        const hasBlobRows = (res?.rows?.length ?? 0) > 0;
        if (!hasBlobRows) {
          return { skipped: "no artifact_blobs rows — nothing to strand" };
        }
        const {
          resolveArtifactDataRoot,
          ARTIFACT_DATA_ROOT_ENV,
          ARTIFACT_DATA_ROOT_METADATA_KEY,
        } = await import("@/lib/artifacts/artifact-data-root");
        const root = resolveArtifactDataRoot();
        if (existsSync(path.join(root, "orgs"))) return;
        console.warn(
          `[artifact-data-root-guard] artifact_blobs rows exist but the resolved ` +
            `artifact data root ${root} has no orgs/ directory. This usually means ` +
            `the root is MISCONFIGURED (env ${ARTIFACT_DATA_ROOT_ENV} or DB metadata ` +
            `key "${ARTIFACT_DATA_ROOT_METADATA_KEY}" pointing away from the volume ` +
            `that holds the bytes) — NOT data loss. Every existing artifact will ` +
            `fail to serve until the root points back at its bytes.`,
        );
      },
    },
  ];
}
