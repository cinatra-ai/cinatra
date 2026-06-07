import "server-only";

// Disk-dir cleanup plus post-rollback WayFlow reload for the extension-install
// compensation block.
//
// extension-handler.ts's installAndRegisterSkills calls
// installAgentPackageWithDependencies (which materializes to disk + reloads
// WayFlow) then registerSkillsFromPackage. If the latter fails, the existing
// compensation deletes the agent_templates row + agent_skills rows. Without
// this module, the disk dir + the mounted WayFlow route would stay live —
// invisible to anyone but the WayFlow runtime, which would happily serve a
// detached agent whose DB has been wiped.
//
// This module supplies the matching disk + runtime cleanup steps. Both
// operations are best-effort; the original skill-registration error
// continues to propagate.

import path from "node:path";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { resolveAgentInstallDir } from "./agent-install-path";
import { triggerWayflowReload } from "./wayflow-reload-client";

const PACKAGE_NAME_RE = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

/**
 * Delete `<agentInstallDir>/<vendor>/<slug>/` if the packageName parses and
 * the resolved target is contained in agentInstallDir.
 *
 * No-op (and log) on un-parseable packageName; the regex is a path-safety
 * gate identical to materializeAgentPackageToDisk's.
 */
export async function rmDirForRolledBackInstall(packageName: string): Promise<void> {
  const match = PACKAGE_NAME_RE.exec(packageName);
  if (!match) {
    console.warn(
      `[extension-handler-rollback] packageName ${JSON.stringify(packageName)} doesn't match strict @vendor/slug — skipping disk cleanup`,
    );
    return;
  }
  const [, vendor, slug] = match;
  const agentsRoot = path.resolve(resolveAgentInstallDir());
  const targetDir = path.resolve(agentsRoot, vendor, slug);
  if (
    !targetDir.startsWith(agentsRoot + path.sep) &&
    targetDir !== agentsRoot
  ) {
    throw new Error(
      `extension-handler-rollback: refusing to delete ${targetDir} (escapes ${agentsRoot})`,
    );
  }
  await rm(targetDir, { recursive: true, force: true });
}

/**
 * Trigger a WayFlow reload after a rollback so the runtime unmounts the
 * orphan route. Errors are swallowed — the original skill-registration
 * error has higher priority for the caller.
 */
export async function triggerReloadAfterRollback(): Promise<void> {
  try {
    const result = await triggerWayflowReload();
    if (!result.ok) {
      console.warn(
        `[extension-handler-rollback] post-rollback reload returned ok:false reason=${result.reason}`,
      );
    }
  } catch (err) {
    console.warn(
      "[extension-handler-rollback] post-rollback reload threw (best-effort):",
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Strict disk delete + verified reload for the purge saga.
//
// Unlike rmDirForRolledBackInstall + triggerReloadAfterRollback (both
// best-effort / swallow failures), the purge saga must own this and raise
// on any failure: a swallowed disk/reload failure would be a silent half-done.
// Path-safety is identical to rmDirForRolledBackInstall. Returns whether the
// dir was present at start (recorded so the saga never restores a dir that
// never existed — e.g. the already-removed-from-source extensions).
// `reload:false` skips the reload (skill/connector kinds where it's
// irrelevant); agent kind passes true and reloads even when the dir was already
// absent, to drop any stale mount.
// ---------------------------------------------------------------------------
/**
 * Cheap presence check the purge saga calls before the strict disk delete, so
 * `dirPresentAtStart` is known independently of whether strictPurgeExtensionDir
 * later throws on rm or reload failure. Path-safety is identical to
 * strictPurgeExtensionDir.
 */
export function extensionDirPresent(packageName: string): boolean {
  const match = PACKAGE_NAME_RE.exec(packageName);
  if (!match) return false;
  const [, vendor, slug] = match;
  const agentsRoot = path.resolve(resolveAgentInstallDir());
  const targetDir = path.resolve(agentsRoot, vendor, slug);
  if (
    !targetDir.startsWith(agentsRoot + path.sep) &&
    targetDir !== agentsRoot
  ) {
    return false;
  }
  return existsSync(targetDir);
}

export async function strictPurgeExtensionDir(
  packageName: string,
  options: { reload: boolean },
): Promise<{ dirPresentAtStart: boolean }> {
  const match = PACKAGE_NAME_RE.exec(packageName);
  if (!match) {
    throw new Error(
      `strictPurgeExtensionDir: packageName ${JSON.stringify(packageName)} doesn't match strict @vendor/slug — refusing`,
    );
  }
  const [, vendor, slug] = match;
  const agentsRoot = path.resolve(resolveAgentInstallDir());
  const targetDir = path.resolve(agentsRoot, vendor, slug);
  if (
    !targetDir.startsWith(agentsRoot + path.sep) &&
    targetDir !== agentsRoot
  ) {
    throw new Error(
      `strictPurgeExtensionDir: refusing to delete ${targetDir} (escapes ${agentsRoot})`,
    );
  }

  const dirPresentAtStart = existsSync(targetDir);
  if (dirPresentAtStart) {
    await rm(targetDir, { recursive: true, force: true });
    if (existsSync(targetDir)) {
      throw new Error(
        `strictPurgeExtensionDir: ${targetDir} still present after rm — disk delete unverified`,
      );
    }
  }

  if (options.reload) {
    const result = await triggerWayflowReload();
    if (!result.ok) {
      throw new Error(
        `strictPurgeExtensionDir: WayFlow reload failed (reason=${result.reason}) — refusing to report disk purge complete`,
      );
    }
    const relevant = result.report.failed.filter(
      (f) =>
        f.label === packageName ||
        f.label === slug ||
        f.label.includes(slug),
    );
    if (relevant.length > 0) {
      throw new Error(
        `strictPurgeExtensionDir: WayFlow reload reported failure for ${packageName}: ` +
          relevant.map((f) => `${f.label}(${f.kind}): ${f.error}`).join("; "),
      );
    }
  }

  return { dirPresentAtStart };
}

/**
 * Restore the extension dir from a quarantined tarball. This is the saga's only
 * rollback primitive and is used only when disk was deleted and a later
 * pre-Verdaccio step failed. No-op when dirPresentAtStart was false.
 */
export async function restoreExtensionDirFromTarball(input: {
  packageName: string;
  tarballPath: string;
}): Promise<void> {
  const match = PACKAGE_NAME_RE.exec(input.packageName);
  if (!match) {
    throw new Error(
      `restoreExtensionDirFromTarball: bad packageName ${JSON.stringify(input.packageName)}`,
    );
  }
  const [, vendor, slug] = match;
  const agentsRoot = path.resolve(resolveAgentInstallDir());
  const targetDir = path.resolve(agentsRoot, vendor, slug);
  if (
    !targetDir.startsWith(agentsRoot + path.sep) &&
    targetDir !== agentsRoot
  ) {
    throw new Error(
      `restoreExtensionDirFromTarball: refusing to write ${targetDir} (escapes ${agentsRoot})`,
    );
  }
  const { mkdir } = await import("node:fs/promises");
  const { x: tarExtract } = await import("tar");
  await mkdir(targetDir, { recursive: true });
  // npm tarballs wrap content in a top-level "package/" dir — strip it.
  await tarExtract({ file: input.tarballPath, cwd: targetDir, strip: 1 });
  // Rollback must verify the reload; a swallowed ok:false would leave WayFlow
  // still serving the purged runtime state while the dir is back on disk. Use
  // the same strict semantics as strictPurgeExtensionDir and raise so the
  // caller can report restore as failed rather than falsely claim a clean
  // rollback.
  const reload = await triggerWayflowReload();
  if (!reload.ok) {
    throw new Error(
      `restoreExtensionDirFromTarball: dir re-extracted but WayFlow reload failed ` +
        `(reason=${reload.reason}) — runtime state unverified after rollback`,
    );
  }
  // ok:true can still carry a report.failed entry for this package when remount
  // failed. That must not be reported as a clean restore. Use the same
  // relevant-failed check as strictPurgeExtensionDir.
  const relevant = reload.report.failed.filter(
    (f) => f.label === input.packageName || f.label === slug || f.label.includes(slug),
  );
  if (relevant.length > 0) {
    throw new Error(
      `restoreExtensionDirFromTarball: dir re-extracted but WayFlow failed to ` +
        `remount ${input.packageName}: ` +
        relevant.map((f) => `${f.label}(${f.kind}): ${f.error}`).join("; "),
    );
  }
}
