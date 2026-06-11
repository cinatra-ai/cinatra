import "server-only";

// Manifest-driven resolution of the chat widget/wizard catalog (#34 /
// IOC-39..41). The set of widget-bearing extensions is the generated manifest's
// GENERATED_CHAT_WIDGET_MODULES / GENERATED_CHAT_WIDGET_MANIFEST_MODULES maps
// (literal dynamic-import maps emitted by
// scripts/extensions/generate-extension-manifest.mjs), gated by the SAME
// archived-row tombstone lifecycle gate the StaticBundleLoader applies — the
// host names no widget extension anywhere.
//
// TWO load paths, deliberately split:
//   - resolveChatWidgetManifests(): loads ONLY the pure-data manifest modules
//     (src/widgets/manifest.ts — no React in the graph). Safe in ANY server
//     bundle, including route handlers (the chat runner's wizard-manifest
//     registry).
//   - resolveChatWidgetCatalog(): additionally loads the component modules
//     (src/widgets/index.ts — "use client" graph). RSC consumers ONLY (the
//     chat mount); component values arrive as React client references and are
//     passed to the client ChatPage as props.
//
// Export discovery is STRUCTURAL (shape-checked against the WidgetDefinition[]
// / WidgetManifest contracts), not name-based — extensions keep their own
// export names, and re-exports (which a source-regex would miss) work. Exactly
// one matching export per module; zero or several FAIL LOUDLY (owner decision:
// no benign fallback), mirroring the generator's one-factory ambiguity rule.
//
// LIFECYCLE SCOPE (mirrors gateStaticRecordsToLiveRows, the #99 strict
// allow-list): a widget package WITH a serverEntry is live only when its
// effective canonical status is "active" (boot seeds a lifecycle anchor row
// for every bundled serverEntry package, so "no row" reads as retired —
// archive and hard uninstall converge on the widgets disappearing at the
// next resolution). A widget package WITHOUT a serverEntry is not
// lifecycle-seeded and passes through ungated, exactly like the loader —
// the chat surface and serverEntry activation can never disagree.

import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";
import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions";
import {
  GENERATED_CHAT_WIDGET_MODULES,
  GENERATED_CHAT_WIDGET_MANIFEST_MODULES,
  STATIC_EXTENSION_MANIFEST,
} from "@/lib/generated/extensions.server";
import { gateStaticRecordsToLiveRows } from "@/lib/static-bundle-loader";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

export type ChatWidgetCatalog = {
  widgets: WidgetDefinition[];
  manifests: WidgetManifest[];
};

// React client references (what a "use client" component import yields inside
// a server bundle) are objects tagged with this well-known symbol; in plain
// Node evaluation (vitest, workspace eval) the same export is the actual
// component function. Both are renderable from the client after the RSC prop
// handoff — anything else is not a component and fails the shape check.
const REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");

function isRenderableComponentValue(v: unknown): boolean {
  if (typeof v === "function") return true;
  if (v !== null && typeof v === "object") {
    return (v as { $$typeof?: unknown }).$$typeof === REACT_CLIENT_REFERENCE;
  }
  return false;
}

// Shape guards are DEFENSIVE about property access: a client-reference proxy
// may throw on arbitrary property reads, and a non-matching export must be
// skipped, never crash discovery.
function isWidgetManifestShaped(v: unknown): v is WidgetManifest {
  try {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const rec = v as Record<string, unknown>;
    return (
      typeof rec.id === "string" &&
      rec.id.length > 0 &&
      typeof rec.description === "string" &&
      !("component" in rec)
    );
  } catch {
    return false;
  }
}

function isWidgetDefinitionArrayShaped(v: unknown): v is WidgetDefinition[] {
  try {
    if (!Array.isArray(v)) return false;
    return v.every((w) => {
      if (w === null || typeof w !== "object") return false;
      const rec = w as Record<string, unknown>;
      return (
        typeof rec.id === "string" &&
        rec.id.length > 0 &&
        typeof rec.label === "string" &&
        isRenderableComponentValue(rec.component)
      );
    });
  } catch {
    return false;
  }
}

function exactlyOne<T>(
  ns: Record<string, unknown>,
  matches: (v: unknown) => v is T,
  what: string,
  context: string,
): T {
  const hits = Object.entries(ns).filter(([, v]) => matches(v));
  if (hits.length !== 1) {
    const names = hits.map(([k]) => k).join(", ");
    throw new Error(
      `[chat-widget-catalog] ${context}: expected exactly one ${what} export, ` +
        `found ${hits.length}${hits.length > 0 ? ` (${names})` : ""}`,
    );
  }
  return hits[0][1] as T;
}

/** Exactly one WidgetDefinition[] export from a widgets component module. */
export function pickChatWidgetDefinitions(
  ns: Record<string, unknown>,
  context: string,
): WidgetDefinition[] {
  return exactlyOne(ns, isWidgetDefinitionArrayShaped, "WidgetDefinition[]", context);
}

/** Exactly one WidgetManifest export from a widgets manifest module. */
export function pickChatWidgetManifest(
  ns: Record<string, unknown>,
  context: string,
): WidgetManifest {
  return exactlyOne(ns, isWidgetManifestShaped, "WidgetManifest", context);
}

/**
 * Catalog invariants, asserted on every resolution (FAIL LOUDLY — a broken
 * widget surface must never ship silently): unique widget ids and manifest ids
 * across packages, and every wizard step must reference a widget its OWN
 * package defines (a wizard advancing into a widget that cannot render is a
 * packaging defect, not a runtime condition). Pure + exported for tests.
 */
export function assertChatWidgetCatalogInvariants(
  packages: Array<{
    packageName: string;
    widgets: WidgetDefinition[];
    manifest: WidgetManifest;
  }>,
): void {
  const widgetIdOwner = new Map<string, string>();
  const manifestIdOwner = new Map<string, string>();
  for (const pkg of packages) {
    const prevManifestOwner = manifestIdOwner.get(pkg.manifest.id);
    if (prevManifestOwner) {
      throw new Error(
        `[chat-widget-catalog] duplicate widget-manifest id "${pkg.manifest.id}" ` +
          `(${prevManifestOwner} and ${pkg.packageName})`,
      );
    }
    manifestIdOwner.set(pkg.manifest.id, pkg.packageName);

    const ownIds = new Set<string>();
    for (const w of pkg.widgets) {
      const prevOwner = widgetIdOwner.get(w.id);
      if (prevOwner) {
        throw new Error(
          `[chat-widget-catalog] duplicate widget id "${w.id}" ` +
            `(${prevOwner} and ${pkg.packageName})`,
        );
      }
      widgetIdOwner.set(w.id, pkg.packageName);
      ownIds.add(w.id);
    }

    for (const step of pkg.manifest.wizard?.steps ?? []) {
      if (!ownIds.has(step.widgetId)) {
        throw new Error(
          `[chat-widget-catalog] ${pkg.packageName}: wizard step references ` +
            `unknown widget id "${step.widgetId}"`,
        );
      }
    }
  }
}

/**
 * The live (non-archived) widget-bearing package names. FAIL-OPEN on a status
 * read that throws (DB unavailable) — every bundled widget package is
 * included, mirroring the StaticBundleLoader's activation posture so the chat
 * surface and serverEntry activation can never disagree about liveness for
 * lack of a database.
 */
async function liveChatWidgetPackages(): Promise<string[]> {
  const all = Object.keys(GENERATED_CHAT_WIDGET_MODULES)
    .sort()
    .map((packageName) => ({
      packageName,
      // The package's REAL serverEntry (from the generated manifest) selects
      // the gate branch: serverEntry packages get the strict active|locked
      // allow-list (their anchor rows are boot-seeded); entry-less packages
      // are not lifecycle-seeded and pass through, mirroring the loader.
      serverEntry: STATIC_EXTENSION_MANIFEST[packageName]?.serverEntry ?? null,
    }));
  try {
    const statusByPackage = await readEffectiveStatusByPackageNames(
      all.map((r) => r.packageName),
    );
    const gated = gateStaticRecordsToLiveRows(all, statusByPackage);
    if (gated.skipped.length > 0) {
      console.info(
        `[chat-widget-catalog] skipping ${gated.skipped.length} non-live (archived or row-less) ` +
          `widget package(s): ${gated.skipped.join(", ")}`,
      );
    }
    return gated.active.map((r) => r.packageName);
  } catch (err) {
    console.warn(
      "[chat-widget-catalog] canonical status read failed — including all bundled " +
        "widget packages (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return all.map((r) => r.packageName);
  }
}

/**
 * The live widget MANIFESTS (pure data). Route-handler safe — only the
 * manifest modules are imported. No caching beyond the module cache: lifecycle
 * status is re-read per call so an archive is reflected on the next chat turn.
 */
export async function resolveChatWidgetManifests(): Promise<WidgetManifest[]> {
  const packageNames = await liveChatWidgetPackages();
  const loaded = await Promise.all(
    packageNames.map(async (packageName) => {
      const ns = await GENERATED_CHAT_WIDGET_MANIFEST_MODULES[packageName].load();
      if (isDegradedExtensionLoad(ns)) {
        // cinatra#7: an absent optional widget package degrades to "no
        // widgets from this package" per entry (loud warn), never a crashed
        // chat surface.
        console.warn(
          `[chat-widget-catalog] widget manifest module for "${packageName}" is absent post-build — ` +
            `skipping (${ns.reason})`,
        );
        return null;
      }
      return {
        packageName,
        manifest: pickChatWidgetManifest(
          ns as Record<string, unknown>,
          `${packageName} widgets/manifest`,
        ),
      };
    }),
  );
  const present = loaded.filter((p): p is NonNullable<typeof p> => p !== null);
  const seen = new Map<string, string>();
  for (const { packageName, manifest } of present) {
    const prev = seen.get(manifest.id);
    if (prev) {
      throw new Error(
        `[chat-widget-catalog] duplicate widget-manifest id "${manifest.id}" (${prev} and ${packageName})`,
      );
    }
    seen.set(manifest.id, packageName);
  }
  return present.map((p) => p.manifest);
}

/**
 * The full live catalog: widget definitions (component values are React client
 * references) + manifests. RSC consumers ONLY — the chat mount resolves this
 * per request and passes it to the client ChatPage as props.
 */
export async function resolveChatWidgetCatalog(): Promise<ChatWidgetCatalog> {
  const packageNames = await liveChatWidgetPackages();
  const loaded = await Promise.all(
    packageNames.map(async (packageName) => {
      const [widgetNs, manifestNs] = await Promise.all([
        GENERATED_CHAT_WIDGET_MODULES[packageName].load(),
        GENERATED_CHAT_WIDGET_MANIFEST_MODULES[packageName].load(),
      ]);
      if (isDegradedExtensionLoad(widgetNs) || isDegradedExtensionLoad(manifestNs)) {
        // cinatra#7: absent optional widget package — degrade per entry.
        const degraded = isDegradedExtensionLoad(widgetNs) ? widgetNs : (manifestNs as never);
        console.warn(
          `[chat-widget-catalog] widget module(s) for "${packageName}" are absent post-build — ` +
            `skipping (${(degraded as { reason: string }).reason})`,
        );
        return null;
      }
      return {
        packageName,
        widgets: pickChatWidgetDefinitions(
          widgetNs as Record<string, unknown>,
          `${packageName} widgets`,
        ),
        manifest: pickChatWidgetManifest(
          manifestNs as Record<string, unknown>,
          `${packageName} widgets/manifest`,
        ),
      };
    }),
  );
  const packages = loaded.filter((p): p is NonNullable<typeof p> => p !== null);
  assertChatWidgetCatalogInvariants(packages);
  return {
    widgets: packages.flatMap((p) => p.widgets),
    manifests: packages.map((p) => p.manifest),
  };
}
