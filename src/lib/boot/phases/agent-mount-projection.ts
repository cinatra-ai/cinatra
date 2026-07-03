// Agent runtime-mount projection boot phase (cinatra#793).
//
// The agent RUNTIME MOUNT (`<CINATRA_EXTENSION_DATA_ROOT>/.agent-mount`) is a
// rebuildable PROJECTION of the unified content-addressed store: the install
// path writes it when an agent installs, and THIS phase self-heals it on boot —
// a fresh mount (new volume, mount wiped, or a crash between store finalize and
// mount materialize) is re-projected from the store so WayFlow + the host
// runtime readers never scan an empty/partial tree for agents whose canonical
// install is finalized.
//
// Selection is TRUST-GATED per package: only an installed (active|locked)
// agent-kind canonical row whose journal-confirmed finalized digest dir exists
// in the store is projected (`resolveFinalizedStorePayload` — the same
// journal-gated anchor selection the loaders use; the writable store alone
// never drives what lands on the mount). Idempotent: a package whose mount
// slug dir already exists is skipped (the install path owns refresh-on-update);
// per-package failures are non-fatal (`degraded` policy) — a broken package
// stays unprojected while the rest of the mount heals.
//
// Ordering (set by the orchestrator): AFTER required-extension-materialize
// (image-seed reconcile into the same mount) and BEFORE agent-marker-backfill
// (markers must cover the projected dirs before WayFlow reloads).
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function agentMountProjectionPhases(): BootPhase[] {
  return [
    {
      name: "agent-mount-projection",
      policy: "degraded",
      run: async () => {
        const { listInstalledExtensions } = await import(
          "@cinatra-ai/extensions/canonical-store"
        );
        let rows: Awaited<ReturnType<typeof listInstalledExtensions>>;
        try {
          rows = await listInstalledExtensions({});
        } catch (err) {
          return {
            skipped: `canonical store unreachable (${err instanceof Error ? err.message : String(err)})`,
          };
        }
        const agentRows = rows.filter(
          (r) =>
            r.kind === "agent" &&
            (r.status === "active" || r.status === "locked") &&
            r.source?.type === "verdaccio",
        );
        if (agentRows.length === 0) return { skipped: "no installed agent-kind rows" };

        const path = await import("node:path");
        const { existsSync } = await import("node:fs");
        const { mkdtemp, cp, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { resolveFinalizedStorePayload } = await import("@/lib/extension-store-payload");
        const { resolveAgentRuntimeMountDir } = await import(
          "@cinatra-ai/agents/agent-runtime-mount"
        );
        const { materializeAgentPackageToDisk, commitMaterialize, withInstallLock } =
          await import("@cinatra-ai/agents");
        const mountRoot = resolveAgentRuntimeMountDir();

        // One projection per package name (a package may have rows at several
        // org scopes; the mount tree is package-keyed).
        const packageNames = [...new Set(agentRows.map((r) => r.packageName))];
        let projected = 0;
        let present = 0;
        for (const packageName of packageNames) {
          try {
            // `@vendor/slug` → `<mount>/<vendor>/<slug>` (the materializer's
            // own naming rule; non-matching names are skipped by it anyway).
            const m = /^@([^/]+)\/(.+)$/.exec(packageName);
            if (!m) continue;
            const slugDir = path.join(mountRoot, m[1], m[2]);
            if (existsSync(slugDir)) {
              present += 1;
              continue;
            }
            const payload = await resolveFinalizedStorePayload({
              packageName,
              expectedKind: "agent",
            });
            if (!payload) continue; // no trusted finalized digest → nothing to project
            // Stage a COPY (the materializer MOVES its input; the store payload
            // must never be consumed destructively), then run the same
            // materialize→commit pair the install path uses, under the same
            // per-package install lock so a concurrent install never races.
            const staging = await mkdtemp(path.join(tmpdir(), "cinatra-agent-mount-projection-"));
            try {
              await cp(payload.storeDir, staging, { recursive: true });
              await withInstallLock(packageName, async () => {
                const result = await materializeAgentPackageToDisk({
                  extractedTempDir: staging,
                  packageName,
                  agentInstallDir: mountRoot,
                });
                if (result.materialized) {
                  await commitMaterialize(result);
                  projected += 1;
                } else {
                  console.warn(
                    `[agent-mount-projection] ${packageName}: not projected (${result.reason})`,
                  );
                }
              });
            } finally {
              await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            }
          } catch (err) {
            console.warn(
              `[agent-mount-projection] ${packageName}: projection failed (non-fatal):`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        if (projected > 0) {
          console.info(
            `[agent-mount-projection] mount ${mountRoot}: projected=${projected} ` +
              `already-present=${present} of ${packageNames.length} installed agent package(s)`,
          );
        }
        // No WayFlow reload here: the downstream agent-marker-backfill phase
        // writes markers for the (possibly new) dirs and reloads when it
        // repaired anything — a reload before markers would mount nothing.
      },
    },
  ];
}
