import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAdminSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Apps" };

export default async function SettingsAppsPage() {
  // Platform-admin only (cinatra#2700, epic #2699): a `/configuration` redirect
  // shim is a route of its own, so it carries the gate rather than leaning on
  // the destination's.
  await requireAdminSession();
  redirect("/configuration/llm");
}
