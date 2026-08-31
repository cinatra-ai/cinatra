import type { Metadata } from "next";

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Assistants" };

// The Assistants tab of the personal scope (cinatra#2807, per-scope surfaces
// S1). The shell reads nothing about the scope, so an authenticated viewer is
// the whole gate here; the per-scope read and its authorization arrive with the
// slice that fills this tab.
export default async function PersonalAssistantsPage() {
  await requireAuthSession();
  return <ScopeSurfacePage scope={{ kind: "personal" }} tab="assistants" />;
}
