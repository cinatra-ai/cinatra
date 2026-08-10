import "server-only";
/**
 * The ONE call site every entity landing uses to build concept B's catalog node
 * (cinatra#2474 PR4) — the node that fills the slot PR3 left in the unified
 * Add-dashboard popup.
 *
 * Four landings need the identical sequence (take the read, render the section,
 * collapse an empty result to `null`), and the collapse is load-bearing rather
 * than cosmetic: `null` is what keeps an empty catalog from raising a popup that
 * holds nothing (see `ScopeCatalogSection`'s header and the toolbar's
 * `offersUnifiedAdd`). Putting it in one place means no landing can forget it.
 *
 * NOT a `"use server"` module: this is a render-time helper, never a server
 * action. PR4 exposes no client-callable seam at all.
 */
import type { ReactElement } from "react";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { CatalogSurface } from "@/lib/dashboards/installed-catalog-contract";
import { listInstalledCatalogTemplates } from "@/lib/dashboards/installed-catalog-read";

import { ScopeCatalogSection } from "./scope-catalog-section";

/**
 * The catalog section for `surface`, or `null` when the actor is absent or the
 * read yields nothing (no rows, a refusal, or a failure — all indistinguishable
 * to the popup, all correctly rendering no section).
 */
export async function buildScopeCatalogNode(args: {
  readonly actor: ActorContext | null | undefined;
  readonly surface: CatalogSurface;
}): Promise<ReactElement | null> {
  if (!args.actor) return null;
  const templates = await listInstalledCatalogTemplates({
    actor: args.actor,
    surface: args.surface,
  });
  if (templates.length === 0) return null;
  return <ScopeCatalogSection templates={templates} />;
}
