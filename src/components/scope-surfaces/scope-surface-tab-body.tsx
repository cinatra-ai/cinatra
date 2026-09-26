/**
 * WHAT A WIRED SCOPE TAB HANDS THE SHELL (cinatra#3707).
 *
 * The maintainer decided on 2026-09-26 that a wired tab whose read answered
 * with no rows draws its own empty-state sentence, and that "This tab is not
 * ready yet" stays for a tab that has no route. The Assistants and Agents tabs
 * are wired on all five scope bases, so their ten routes owe the shell three
 * different bodies, and this is the one place that rule is written:
 *
 *   the read listed rows          -> the tab's own list
 *   the read answered, no rows    -> the tab's own empty reading
 *   the read could not be taken   -> no body, and the shell keeps the
 *                                    placeholder, which claims nothing about
 *                                    the scope
 *
 * The Artifacts and Skills tabs reach the same end through their own tab
 * components, which take the read themselves. These two take theirs in the
 * route, so the decision sits here rather than in ten copies.
 */
import type { ReactNode } from "react";

import { ScopeSurfaceTabEmpty } from "@/components/scope-surface-page";
import type { ScopeSurfaceTab } from "@/lib/scope-surfaces";

export function scopeSurfaceTabBody<Row>(
  tab: ScopeSurfaceTab,
  answer: { readonly rows: readonly Row[]; readonly read: boolean },
  list: (rows: readonly Row[]) => ReactNode,
): ReactNode | undefined {
  // No read, no statement. The shell then draws its own condition.
  if (!answer.read) return undefined;
  if (answer.rows.length === 0) return <ScopeSurfaceTabEmpty tab={tab} read />;
  return list(answer.rows);
}
