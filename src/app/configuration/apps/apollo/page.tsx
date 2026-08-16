import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAdminSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Apollo" };

type SettingsApolloRedirectPageProps = {
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
  return `/configuration/llm/apollo${params.toString() ? `?${params.toString()}` : ""}`;
}

export default async function SettingsApolloRedirectPage({ searchParams }: SettingsApolloRedirectPageProps) {
  // Platform-admin only (cinatra#2700, epic #2699): a `/configuration` redirect
  // shim is a route of its own, so it carries the gate rather than leaning on
  // the destination's.
  await requireAdminSession();
  const resolvedSearchParams = await (searchParams ?? Promise.resolve({}));
  redirect(buildRedirectTarget(resolvedSearchParams));
}
