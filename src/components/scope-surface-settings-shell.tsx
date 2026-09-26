// The RESOLVING settings shell (cinatra#2809, per-scope surfaces S3), filled
// by the assignment epic (cinatra#2814, per-scope assignment S2).
//
// #2809 pins the settings HREF contract (the card's Settings button targets
// `<scope-base>/agents/<vendor>/<packageName>/settings`, and the assistants
// analog) and mounts a route that RESOLVES at that address. The assignment
// epic fills the shell in place rather than moving it: the frame (the trail
// this page publishes, the page landmark) stays #2809's, and the body is the
// per-scope assignment page, whose model the route resolved on the server
// before this shell renders. A package the reader does not reach at this
// scope never gets here: the route answers not found instead.

import { CrumbContributions } from "@/components/crumb-contributions";
import { Main } from "@/components/layout/main";
import { ScopeAssignmentPage } from "@/components/scope-assignment/scope-assignment-page";
import type { ScopeAssignmentPageModel } from "@/lib/scope-assignment/scope-assignment-page.server";
import {
  scopeSurfaceCrumbEntries,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

export type ScopeSurfaceSettingsSubject = {
  /** Which tree this settings surface belongs to. */
  kind: "agent" | "assistant";
  /** The package the settings are FOR, exactly as the address spells it. */
  packageName: string;
};

export function ScopeSurfaceSettingsShell({
  scope,
  scopeTitle,
  subject,
  page,
}: {
  scope: ScopeSurfaceRef;
  /**
   * The scope's own name, resolved by the route behind that scope's read gate
   * (cinatra#2809 fix leg 2). `null` where the reader may not be told it, and
   * the crumb then falls back to the id's first eight characters plus an
   * ellipsis — the drawing's genuinely-unavailable arm, which is NOT what this
   * page used to show while the name was sitting resolved one level up.
   */
  scopeTitle?: string | null;
  subject: ScopeSurfaceSettingsSubject;
  /** The assignment page the route resolved for this reader (cinatra#2814). */
  page: ScopeAssignmentPageModel;
}) {
  const tab = subject.kind === "agent" ? "agents" : "assistants";
  return (
    <Main className="min-h-screen">
      {/* The trail above this page is the SCOPE and its tab — published from
          here, after the route's own gate, exactly as every scope surface
          publishes what it resolved, and through the same road they all use.
          The leaf ("Settings") is named by the route's own last segment; the
          entry this shell used to publish for it targeted `<base>/<tab>/
          settings`, a path no route answers on, so it named nothing. */}
      <CrumbContributions entries={scopeSurfaceCrumbEntries(scope, tab, scopeTitle ?? undefined)} />
      <ScopeAssignmentPage model={page} />
    </Main>
  );
}
