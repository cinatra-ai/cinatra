import "server-only";

// Manifest-driven resolution of the chat RENDERABLE-VIEW catalog
// (cinatra#1626, epic #1620 S9/M4 — "artifact extensions own their UI").
//
// The set of extension-provided chat renderable-view components is the
// generated `GENERATED_CHAT_VIEWS` map (a literal dynamic-import map keyed by
// wire `viewType`, emitted by
// scripts/extensions/generate-extension-manifest.mjs from each extension's
// `cinatra.views` block), run through the SAME lifecycle gate the chat-widget
// catalog + StaticBundleLoader apply — the host names no view extension
// anywhere (the `chart` viewType resolves to `@cinatra-ai/chart-artifact` only
// through this generated map).
//
// Gate posture (identical to the chat-widget catalog, deliberately): a view
// package WITH a serverEntry is served only when its effective canonical status
// is active (its anchor row is boot-seeded, so archive/uninstall hides it at the
// next resolution); a view package WITHOUT a serverEntry is NOT lifecycle-seeded
// and passes through ungated, exactly like the loader. `@cinatra-ai/chart-artifact`
// is a REQUIRED extension with no serverEntry — it is always live and the gate is
// a no-op for it; the gate matters for any future OPTIONAL, serverEntry-bearing
// view extension.
//
// This is the RSC-side counterpart of the client `MessageChartEmbeds`
// dispatch: it loads the "use client" view component modules (yielding React
// client references inside the server bundle) and hands the resolved
// {viewType → Component} map to the client `ChatPage` through props, exactly
// like resolveChatWidgetCatalog does for widgets. An absent/degraded module or
// a non-live package simply omits that viewType — the client dispatch then
// renders `RenderableViewFallback` (never a blank).

import type { ComponentType } from "react";

import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions";
import { GENERATED_CHAT_VIEWS } from "@/lib/generated/chat-views";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { gateStaticRecordsToLiveRows } from "@/lib/static-bundle-loader";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

/** The props a resolved chat renderable-view component receives (the host-owned
 * payload for the wire `viewType`). Structural — the component is an extension
 * client reference bound to whatever payload the host serializes. */
export type ChatRenderableViewComponent = ComponentType<{
  view: { viewType: string };
}>;

/** viewType → resolved extension component (React client reference). */
export type ChatViewCatalog = Record<string, ChatRenderableViewComponent>;

// React client references (what a "use client" component import yields inside a
// server bundle) are objects tagged with this well-known symbol; in plain Node
// evaluation (vitest, workspace eval) the same export is the actual component
// function. Both are renderable from the client after the RSC prop handoff.
const REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference");

function isRenderableComponentValue(v: unknown): boolean {
  if (typeof v === "function") return true;
  if (v !== null && typeof v === "object") {
    try {
      return (v as { $$typeof?: unknown }).$$typeof === REACT_CLIENT_REFERENCE;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The live (non-archived) viewType entries. FAIL-OPEN on a status read that
 * throws (DB unavailable) — every bundled view package is included, mirroring
 * the chat-widget catalog / StaticBundleLoader activation posture so the chat
 * surface and serverEntry activation can never disagree about liveness for
 * lack of a database.
 */
async function liveChatViewTypes(): Promise<string[]> {
  const all = Object.keys(GENERATED_CHAT_VIEWS)
    .sort()
    .map((viewType) => {
      const packageName = GENERATED_CHAT_VIEWS[viewType].packageName;
      return {
        viewType,
        packageName,
        // The package's REAL serverEntry selects the gate branch: serverEntry
        // packages get the strict active|locked allow-list (boot-seeded anchor
        // rows); entry-less packages pass through, mirroring the loader.
        serverEntry: STATIC_EXTENSION_MANIFEST[packageName]?.serverEntry ?? null,
      };
    });
  try {
    const statusByPackage = await readEffectiveStatusByPackageNames(
      all.map((r) => r.packageName),
    );
    const gated = gateStaticRecordsToLiveRows(all, statusByPackage);
    if (gated.skipped.length > 0) {
      console.info(
        `[chat-views-catalog] skipping ${gated.skipped.length} non-live (archived or row-less) ` +
          `view package(s): ${gated.skipped.join(", ")}`,
      );
    }
    // gateStaticRecordsToLiveRows preserves the input records (generic T) —
    // recover each active record's viewType.
    return gated.active.map((r) => r.viewType);
  } catch (err) {
    console.warn(
      "[chat-views-catalog] canonical status read failed — including all bundled " +
        "view packages (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return all.map((r) => r.viewType);
  }
}

/**
 * Resolve the live chat renderable-view catalog. Loads each live viewType's
 * component module (RSC consumers ONLY — the module graph includes "use client"
 * components; the resolved values are React client references passed to the
 * client ChatPage as props). A degraded (absent post-build) or malformed module
 * omits that viewType — the client dispatch floors to RenderableViewFallback.
 * Lifecycle status is re-read per call so an archive is reflected on the next
 * chat page load with no host edit.
 */
export async function resolveChatViewCatalog(): Promise<ChatViewCatalog> {
  const viewTypes = await liveChatViewTypes();
  const entries = await Promise.all(
    viewTypes.map(async (viewType) => {
      const ns = await GENERATED_CHAT_VIEWS[viewType].load();
      if (isDegradedExtensionLoad(ns)) {
        console.warn(
          `[chat-views-catalog] view module for "${viewType}" is absent post-build — ` +
            `skipping (${ns.reason})`,
        );
        return null;
      }
      const component = (ns as { default?: unknown }).default;
      if (!isRenderableComponentValue(component)) {
        console.warn(
          `[chat-views-catalog] view module for "${viewType}" has no renderable default export — skipping`,
        );
        return null;
      }
      return [viewType, component as ChatRenderableViewComponent] as const;
    }),
  );
  const catalog: ChatViewCatalog = {};
  for (const e of entries) {
    if (e) catalog[e[0]] = e[1];
  }
  return catalog;
}
