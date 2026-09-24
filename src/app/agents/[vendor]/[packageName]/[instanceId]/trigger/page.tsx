import type { Metadata } from "next";
import type React from "react";
import { notFound } from "next/navigation";

import { readAgentInstanceIdFromSegment } from "@/lib/agent-url";

export const metadata: Metadata = { title: "Agent" };

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgentPackageInstanceTriggerPage({ params, searchParams }: Props) {
  const { vendor, packageName, instanceId: instanceIdSegment } = await params;
  // cinatra#3080 — the router hands this segment over still percent-encoded.
  // A repair run's id carries a colon, so the raw segment is no run's id and
  // the screen answered 404 for a run that was right there. Every ordinary run
  // id is a uuid and reads back byte-identical.
  const instanceId = readAgentInstanceIdFromSegment(instanceIdSegment);
  const agentId = `${vendor}/${packageName}`;
  const { resolveAgentScreensWithA2AFallback } = await import("@/app/plugins-registry");
  const screens = await resolveAgentScreensWithA2AFallback(agentId);
  if (!screens) notFound();
  if (!("instanceTrigger" in screens) || !screens.instanceTrigger) notFound();
  return (screens.instanceTrigger as (props: { agentId: string; instanceId: string; searchParams?: typeof searchParams }) => Promise<React.ReactNode>)({ agentId, instanceId, searchParams });
}
