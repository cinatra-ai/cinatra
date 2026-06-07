import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Gmail" };

type SettingsGmailPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildRedirectTarget(paramsObject: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(paramsObject)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return `/configuration/llm/gmail${params.toString() ? `?${params.toString()}` : ""}`;
}

export default async function SettingsGmailPage({ searchParams }: SettingsGmailPageProps) {
  const resolvedSearchParams = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  redirect(buildRedirectTarget(resolvedSearchParams));
}
