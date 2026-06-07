import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Apps" };

export default function SettingsAppsPage() {
  redirect("/configuration/llm");
}
