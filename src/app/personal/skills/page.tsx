import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Skills" };

// The header keeps naming the ENTITY on every tab: the ratified drawing makes
// this an entity page and the tab a tab OF it, so the tab's own name is carried
// by the strip, not by the heading. The name comes from the page's own gated
// read; a reader who may not be told it sees the scope's kind noun instead.
//
// The Skills tab of the personal scope (cinatra#2807, per-scope surfaces
// S1). This scope is named by the drawing itself, so the shell reads nothing
// about it at all; the tab's contents and their authorization arrive with the
// slice that fills this tab.
export default async function PersonalSkillsPage() {
  await requireAuthSession();
  return (
    <ScopeSurfacePage scope={{ kind: "personal" }} tab="skills" title="Personal" />
  );
}
