import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";

export const metadata: Metadata = { title: "OpenAI Skills" };

export default function SettingsOpenAISkillsPage() {
  // The local-shell / sandboxed-executor policy now lives on the OpenAI
  // connector's own schema-config setup surface (its configSchema carries the
  // shell fields) — not the retired skills shell-tab placeholder. Resolve the
  // connector's setup href from the manifest.
  const href = getConnectorSetupHref("openai-connector");
  if (!href) notFound();
  redirect(href);
}
