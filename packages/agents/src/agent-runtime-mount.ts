// Agent runtime-mount + dev-source path helpers (cinatra#793).
//
// These two resolvers REPLACE the deleted `agent-install-path.ts`
// (`CINATRA_AGENT_INSTALL_DIR` env + `agent_install_path` DB metadata), whose
// single knob conflated two different trees:
//
//  1. RUNTIME MOUNT — `resolveAgentRuntimeMountDir()` =
//     `<CINATRA_EXTENSION_DATA_ROOT>/.agent-mount`. The deploy-owned directory
//     WayFlow mounts `:/agents:ro` and every RUNTIME reader (llm-bridge,
//     agents-store scan, schema/field-binding resolution, marker backfill,
//     required-extension materialize, rollback cleanup) resolves. It is a
//     PROJECTION/CACHE populated FROM the unified content-addressed store
//     (`<root>/agent/<slug>/<digest>/`) by the install path + the boot
//     projection phase — rebuildable, never the durable source of truth. The
//     dot-dir name keeps it INVISIBLE to the store's kind-dir discovery walk
//     (discovery skips `.`-prefixed entries), so the mount can live inside the
//     one configured extension data root without becoming a phantom kind.
//     There is deliberately NO env/metadata knob of its own: the extension
//     data root (env > DB metadata > default) already carries the deploy
//     determinism (ops#436) — a second knob could split the mount off the
//     store it is projected from.
//
//  2. DEV SOURCE ROOT — `resolveDevExtensionSourceRoot()` = `<cwd>/extensions`.
//     The git-native AUTHORING tree (agent_source_* / workflow_source_* /
//     artifact_source_* / skill_source_* MCP pipelines, dev-boot scans,
//     authoring compile/review flows, the shared-component authoring
//     registry). Unchanged semantics from the historical dev default.

import path from "node:path";
import { resolveExtensionDataRoot } from "@/lib/extension-data-root";

/** Dot-dir under the extension data root holding the projected agent runtime
 *  tree (`<mount>/<vendor>/<slug>/…`). Dot-prefixed = invisible to the store's
 *  kind-dir discovery (same convention as `.staging`). */
export const AGENT_RUNTIME_MOUNT_DIRNAME = ".agent-mount";

/** The agent RUNTIME mount root — deploy-owned; WayFlow mounts this dir and
 *  every runtime reader of installed agents scans it. Projected FROM the
 *  unified store; rebuildable on any boot (agent-mount-projection phase). */
export function resolveAgentRuntimeMountDir(): string {
  return path.join(resolveExtensionDataRoot(), AGENT_RUNTIME_MOUNT_DIRNAME);
}

/** The git-native dev/authoring extension source tree (`<cwd>/extensions`). */
export function resolveDevExtensionSourceRoot(): string {
  return path.join(process.cwd(), "extensions");
}
