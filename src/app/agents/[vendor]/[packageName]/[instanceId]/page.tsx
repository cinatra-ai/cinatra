import type { Metadata } from "next";
import type React from "react";
import { notFound } from "next/navigation";
import { resolveAgentInstanceMetadata } from "@/lib/agent-instance-tab-title";

// THE TAB MIRRORS THE TRAIL (cinatra#2934, fix leg 9). The static title this
// route used to export was re-applied over the mirrored one on every live-poll
// re-render, so the derivation moved to the server, behind one helper every
// id-bearing route under the run shares.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vendor, packageName, instanceId } = await params;
  return resolveAgentInstanceMetadata({ vendor, packageName, instanceId });
}

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgentPackageInstancePage({ params, searchParams }: Props) {
  const { vendor, packageName, instanceId } = await params;
  const agentId = `${vendor}/${packageName}`;
  const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
  const screens = await resolveAgentScreensWithA2AFallback(agentId);
  if (!screens) notFound();
  if (!("instanceSetup" in screens) || !screens.instanceSetup) notFound();
  return (screens.instanceSetup as (props: { agentId: string; instanceId: string; searchParams?: typeof searchParams }) => Promise<React.ReactNode>)({ agentId, instanceId, searchParams });
}
