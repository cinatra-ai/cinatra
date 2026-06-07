import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { AgentBuilderImportScreen } from "@cinatra-ai/agents/screens";

export const metadata: Metadata = { title: "Upload Extension" };

export default async function UploadPage() {
  await requireAdminSession();
  return <AgentBuilderImportScreen />;
}
