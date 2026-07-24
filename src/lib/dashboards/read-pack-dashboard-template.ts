import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

// Read a `kind:"artifact"` pack's `form:"dashboard"` template + its sidecar
// config off disk (cinatra#1896 Scope 2 install→materialize trigger). The
// generated `STATIC_EXTENSION_MANIFEST` carries the pack's `sourceDir` but NOT its
// `artifact.templates` array nor the `cinatra/dashboard.json` content (the
// dashboard body deliberately stays in the shipped sidecar), so the trigger reads
// them here at runtime. Fully DEGRADE-WITH-DIAGNOSTIC: any missing/unreadable/
// malformed file yields `null` (no dashboard template) — never throws, so one bad
// pack never aborts the reconcile.

/** The extensions install root convention (`<cwd>/extensions/...`), matching
 *  `sourceDir` (e.g. `extensions/cinatra-ai/web-analytics-dashboard-artifact`). */
function packDir(sourceDir: string): string {
  // `sourceDir` is repo-root-relative; resolve against the process cwd (the
  // deployed/dev convention shared by required-in-prod / purge-deps).
  return path.resolve(process.cwd(), sourceDir);
}

type ArtifactTemplateEntry = {
  id?: unknown;
  form?: unknown;
  path?: unknown;
  default?: unknown;
};

/** Locate the pack's manifest `cinatra.artifact.templates[]` entry with
 *  `form:"dashboard"` (preferring the `default:true` one) and return its `path`
 *  + the pack's `displayName`, or `null` when the pack ships no dashboard template
 *  / the manifest is unreadable. */
function readDashboardTemplateEntry(
  sourceDir: string,
): { templatePath: string; displayName?: string } | null {
  let manifest: {
    displayName?: unknown;
    cinatra?: { displayName?: unknown; artifact?: { templates?: unknown } };
  };
  try {
    const raw = readFileSync(path.join(packDir(sourceDir), "package.json"), "utf-8");
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return null; // pack not on disk / unreadable package.json
  }
  const templates = manifest.cinatra?.artifact?.templates;
  if (!Array.isArray(templates)) return null;
  const dashboardTemplates = (templates as ArtifactTemplateEntry[]).filter(
    (t) => t && t.form === "dashboard" && typeof t.path === "string" && t.path.length > 0,
  );
  if (dashboardTemplates.length === 0) return null;
  const chosen =
    dashboardTemplates.find((t) => t.default === true) ?? dashboardTemplates[0];
  const displayName =
    typeof manifest.cinatra?.displayName === "string"
      ? manifest.cinatra.displayName
      : typeof manifest.displayName === "string"
        ? manifest.displayName
        : undefined;
  return {
    templatePath: chosen.path as string,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/** True iff the pack at `sourceDir` ships a `form:"dashboard"` template (cheap
 *  candidate-org probe — reads only the manifest, not the sidecar body). */
export function packShipsDashboardTemplate(_packageName: string, sourceDir: string): boolean {
  return readDashboardTemplateEntry(sourceDir) !== null;
}

/** Read the pack's dashboard template: its parsed `cinatra/dashboard.json` config
 *  + an optional display name. `null` when the pack ships no dashboard template or
 *  any file is missing/unreadable/malformed (validation of the config itself is the
 *  materializer's job — it throws `DashboardConfigInvalidError` on a bad body). */
export function readPackDashboardTemplate(
  packageName: string,
  sourceDir: string,
): { config: unknown; name?: string } | null {
  const entry = readDashboardTemplateEntry(sourceDir);
  if (!entry) return null;

  // Resolve the sidecar path WITHIN the pack dir; reject a traversal that would
  // escape it (defense-in-depth against a manifest `path` like `../../etc/...`).
  const dir = packDir(sourceDir);
  const resolved = path.resolve(dir, entry.templatePath);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    console.warn(
      `[dashboards/materialize] ${packageName}: dashboard template path "${entry.templatePath}" ` +
        `escapes the pack dir — skipped.`,
    );
    return null;
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (err) {
    console.warn(
      `[dashboards/materialize] ${packageName}: dashboard template sidecar "${entry.templatePath}" ` +
        `is missing/unreadable/malformed — skipped:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const displayName = entry.displayName;
  return {
    config,
    ...(displayName !== undefined ? { name: `${displayName} dashboard` } : {}),
  };
}
