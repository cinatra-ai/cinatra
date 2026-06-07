import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "OpenAI Skills" };

export default function SettingsOpenAISkillsPage() {
  redirect("/configuration/skills?tab=shell");
}
