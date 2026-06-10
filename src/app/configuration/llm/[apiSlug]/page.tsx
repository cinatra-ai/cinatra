import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { renderAPIPluginPage } from "@/app/plugins-registry";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";

export const metadata: Metadata = { title: "LLM Setup" };

type SettingsAPIPluginRoutePageProps = {
  params: Promise<{ apiSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildRedirectTarget(pathname: string, paramsObject: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(paramsObject)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
}

export default async function SettingsAPIPluginRoutePage({ params, searchParams }: SettingsAPIPluginRoutePageProps) {
  const { apiSlug } = await params;
  const resolvedSearchParams = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));

  if (apiSlug === "initial-setup") {
    redirect(buildRedirectTarget("/setup/ai", resolvedSearchParams));
  }

  if (apiSlug === "drupal") {
    // Manifest-resolved dispatch href (same target the legacy /connectors/drupal
    // mount redirects to — this skips the double hop).
    const href = getConnectorSetupHref("drupal-mcp-connector");
    if (!href) notFound();
    redirect(href);
  }

  if (apiSlug === "openai-skills") {
    redirect("/configuration/skills?tab=shell");
  }

  return await renderAPIPluginPage(apiSlug, { searchParams });
}
