import "server-only";
/**
 * The ONE call site every entity landing uses to build concept B's catalog node
 * (cinatra#2474 PR4) — the node that fills the slot PR3 left in the unified
 * Add-dashboard popup.
 *
 * Four landings need the identical sequence (take the read, bind the write to the
 * SAME server-derived surface, render the section, collapse an empty result to
 * `null`), and two of those steps are load-bearing rather than cosmetic:
 *
 *   - the COLLAPSE — `null` is what keeps an empty catalog from raising a popup
 *     that holds nothing (see `ScopeCatalogSection`'s header and the toolbar's
 *     `offersUnifiedAdd`);
 *   - the BINDING (cinatra#2474 PR5) — the instantiate action is bound HERE, to
 *     the very descriptor the read was taken for, so the read's scope and the
 *     write's scope are the same value by construction and the browser never
 *     authors either. Next encrypts bound arguments, so the surface does not
 *     cross to the client in a readable or forgeable form.
 *
 * Putting both in one place means no landing can forget either, and none can
 * pass the write a scope it did not read.
 *
 * NOT a `"use server"` module: this is a render-time helper. The action it binds
 * is the only client-callable seam concept B has.
 */
import type { ReactElement } from "react";

import type { ActorContext } from "@/lib/authz/actor-context";
import type {
  CatalogSurface,
  ScopeCatalogSource,
} from "@/lib/dashboards/installed-catalog-contract";
import { addInstalledCatalogDashboardAction } from "@/lib/dashboards/installed-catalog-actions";
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
  // The write, bound to the SAME server-derived descriptor the read used. The
  // client supplies only a template handle; the action re-authorizes from the
  // live session and re-derives the destination itself, so this binding is
  // capability minimization, never the authorization.
  const source: ScopeCatalogSource = {
    add: addInstalledCatalogDashboardAction.bind(null, args.surface),
  };
  return <ScopeCatalogSection templates={templates} source={source} />;
}
