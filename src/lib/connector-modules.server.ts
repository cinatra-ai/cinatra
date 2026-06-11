import "server-only";

// Manifest-driven resolution of a bundled connector's server module (the
// package root: status/config/action exports). The literal import map is
// generated into the extension manifest by
// scripts/extensions/generate-extension-manifest.mjs, so the host resolves a
// connector module by SLUG and never names a connector package.
//
// Callers describe the exports they consume with a local structural type —
// that export shape is the host↔connector data contract for the surface, not
// package-name coupling.

import { GENERATED_CONNECTOR_ENTRY_MODULES } from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

/**
 * Whether the manifest carries an entry-module loader for this connector slug.
 */
export function hasConnectorModule(slug: string): boolean {
  return slug in GENERATED_CONNECTOR_ENTRY_MODULES;
}

/**
 * Load a bundled connector's root server module by slug, or `null` when the
 * manifest has no entry-module loader for the slug (connector not bundled in
 * this image). A BROKEN present module still fails loudly, exactly like the
 * static import it replaces — but a `guardedOptional` entry whose target
 * module is ABSENT post-build (marketplace uninstall) resolves the
 * standardized degraded result and degrades to the same `null` as "not
 * bundled in this image" (cinatra#7).
 */
export async function loadConnectorModule<T>(slug: string): Promise<T | null> {
  const entry = GENERATED_CONNECTOR_ENTRY_MODULES[slug];
  if (!entry) return null;
  const ns = await entry.load();
  if (isDegradedExtensionLoad(ns)) {
    console.warn(
      `[connector-modules] bundled entry module for "${slug}" is absent post-build — ` +
        `degrading to "not bundled" (${ns.reason})`,
    );
    return null;
  }
  return ns as T;
}

/**
 * Strict variant — throws when the slug has no bundled entry module. Use on
 * surfaces that cannot render without the connector (legacy mounts).
 */
export async function requireConnectorModule<T>(slug: string): Promise<T> {
  const mod = await loadConnectorModule<T>(slug);
  if (mod === null) {
    throw new Error(`No bundled entry module for connector slug: ${slug}`);
  }
  return mod;
}
