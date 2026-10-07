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
import {
  WORKSPACE_CATALOG_WORDS,
  type CatalogSurface,
  type ScopeCatalogSource,
} from "@/lib/dashboards/installed-catalog-contract";
import {
  addInstalledCatalogDashboardAction,
  addWorkspaceCatalogDashboardAction,
} from "@/lib/dashboards/installed-catalog-actions";
import {
  listInstalledCatalogTemplates,
  listWorkspaceCatalogTemplates,
  type WorkspaceCatalogMembership,
} from "@/lib/dashboards/installed-catalog-read";

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

/**
 * The WORKSPACE catalog section (cinatra#2811, item 4), or `null` when the
 * federation yields nothing.
 *
 * The same two load-bearing steps as the tenant builder above, with one
 * difference: there is no scope to bind. The workspace read is a federation over
 * the viewer's member organizations, and the write re-resolves those
 * memberships from the live session itself, so the action takes ONLY the opaque
 * template handle and no bound descriptor exists to replay.
 *
 * It renders the SAME `ScopeCatalogSection` the tenant tabs render, and hands it
 * the amended drawing's words for THIS surface (`WORKSPACE_CATALOG_WORDS`,
 * §IX.1's third section): the drawn heading, the drawn helper line, and a row
 * note naming the package and the kind it contributes. The tenant builder above
 * hands none, so the tenant tabs keep the words they landed with.
 */
export async function buildWorkspaceCatalogNode(args: {
  readonly userId: string;
  readonly memberships: readonly WorkspaceCatalogMembership[];
}): Promise<ReactElement | null> {
  if (!args.userId || args.memberships.length === 0) return null;
  const templates = await listWorkspaceCatalogTemplates({
    userId: args.userId,
    memberships: args.memberships,
  });
  if (templates.length === 0) return null;
  const source: ScopeCatalogSource = { add: addWorkspaceCatalogDashboardAction };
  return (
    <ScopeCatalogSection
      templates={templates}
      source={source}
      words={WORKSPACE_CATALOG_WORDS}
    />
  );
}
