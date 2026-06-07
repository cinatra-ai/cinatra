import type { Metadata } from "next";
import type React from "react";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Agent" };

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgentPackageInstanceResultsPage({ params, searchParams }: Props) {
  const { vendor, packageName, instanceId } = await params;
  const agentId = `${vendor}/${packageName}`;
  const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
  const screens = await resolveAgentScreensWithA2AFallback(agentId);
  if (!screens) notFound();
  if (!("instanceResults" in screens) || !screens.instanceResults) notFound();
  return (screens.instanceResults as (props: { agentId: string; instanceId: string; searchParams?: typeof searchParams }) => Promise<React.ReactNode>)({ agentId, instanceId, searchParams });
}
