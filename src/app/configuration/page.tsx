import type { Metadata } from "next";
import Link from "next/link";
import {
  Code2,
  TriangleAlert,
} from "lucide-react";

import { domainIcons } from "@/components/domain-icons";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdminSession } from "@/lib/auth-session";
import { readInstanceIdentity } from "@/lib/instance-identity-store";

export const metadata: Metadata = { title: "Configuration" };

const administrationSections = [
  {
    title: "Environment",
    description: "Runtime mode, instance identity, and registry connections.",
    href: "/configuration/environment",
    icon: domainIcons.environment,
    links: [
      { label: "Mode", href: "/configuration/environment" },
      { label: "Instance", href: "/configuration/environment?tab=instance" },
      { label: "Registries", href: "/configuration/environment?tab=registries" },
    ],
  },
  {
    // Titled "AI Providers" (not "LLM") so a first-time user looking for where
    // to set their OpenAI API key finds it without knowing it's modeled as a
    // connector (#501). The OpenAI key form is linked directly.
    title: "AI Providers",
    description: "Set your OpenAI (or other AI provider) API key and model defaults.",
    href: "/configuration/llm",
    icon: domainIcons.llm,
    links: [
      { label: "OpenAI API key", href: "/configuration/llm?modal=openai" },
      { label: "Model defaults", href: "/configuration/llm" },
      { label: "OpenAI API skills", href: "/configuration/llm/openai-skills" },
    ],
  },
  {
    title: "MCP",
    description: "MCP server endpoints, OAuth clients, and access checks.",
    href: "/configuration/mcp",
    icon: domainIcons.mcp,
    links: [
      { label: "Server", href: "/configuration/mcp" },
      { label: "Clients", href: "/configuration/permissions?tab=mcp" },
    ],
  },
  {
    title: "Artifacts",
    description:
      "The type definitions your artifact extensions declare, the stored objects across them, and object-change-set restore.",
    href: "/configuration/artifacts",
    icon: domainIcons.artifacts,
    links: [
      { label: "Type definitions", href: "/configuration/artifacts" },
      { label: "Stored objects", href: "/configuration/artifacts?tab=objects" },
      { label: "Restore objects", href: "/configuration/artifacts?tab=restore" },
      { label: "Review policy", href: "/configuration/artifacts?tab=review-policy" },
    ],
  },
  {
    title: "Extensions",
    description: "Installed and archived extensions for this workspace.",
    href: "/configuration/extensions",
    icon: domainIcons.extensions,
    links: [
      { label: "Installed", href: "/configuration/extensions" },
      { label: "Archived", href: "/configuration/extensions?tab=archived" },
      { label: "Upload", href: "/configuration/extensions/upload" },
    ],
  },
  {
    // Inbound webhooks are extension-authored (declared via cinatra.webhooks);
    // this moved out of the left sidebar into Configuration (cinatra#696). The
    // card title + "Manage" CTA both target the registry, so the inner link
    // points at the authoring guide rather than re-linking the registry.
    title: "Webhooks",
    description:
      "Inbound webhooks declared by extensions, served by the generic webhook facility.",
    href: "/configuration/webhooks",
    icon: domainIcons.webhooks,
    links: [
      {
        label: "Authoring guide",
        href: "https://github.com/cinatra-ai/cinatra/blob/main/docs/internals/workflows/webhooks/authoring-inbound-webhooks.md",
      },
    ],
  },
  {
    title: "Marketplace",
    description: "Browse registry packages and install extensions.",
    href: "/configuration/marketplace",
    icon: domainIcons.marketplace,
    links: [
      { label: "Browse marketplace", href: "/configuration/marketplace" },
      { label: "Connect registry", href: "/configuration/environment?tab=registries" },
    ],
  },
  {
    title: "Skills",
    description: "Installed skill packages, matching, and sync settings.",
    href: "/configuration/skills",
    icon: domainIcons.skills,
    links: [
      { label: "Packages", href: "/configuration/skills" },
      { label: "Matches", href: "/configuration/skills?tab=matches" },
    ],
  },
  {
    title: "Permissions",
    description: "Users, roles, MCP access, and A2A service accounts.",
    href: "/configuration/permissions",
    icon: domainIcons.administration,
    links: [
      { label: "Users", href: "/configuration/permissions?tab=users" },
      { label: "Roles", href: "/configuration/permissions?tab=roles" },
      { label: "MCP", href: "/configuration/permissions?tab=mcp" },
      { label: "A2A", href: "/configuration/permissions?tab=a2a" },
    ],
  },
  {
    // platform access-control knobs.
    title: "Access Control",
    description: "Single-organization mode and durable audit-log retention.",
    href: "/configuration/access-control",
    icon: domainIcons.administration,
    links: [
      { label: "Organization mode", href: "/configuration/access-control" },
      { label: "Audit retention", href: "/configuration/access-control" },
    ],
  },
  {
    title: "Workflows",
    description: "Pending approvals now live in the unified Notifications surface.",
    href: "/notifications",
    icon: domainIcons.workflows,
    links: [
      // Approvals moved into /notifications in the E8 cutover (cinatra#1558) —
      // the standalone /configuration/approvals page + its ?tab machinery were
      // retired. The "All workflows" browse link was removed earlier
      // (cinatra#609); workflow overview/tracking lives in Plane.
      { label: "Approvals", href: "/notifications" },
    ],
  },
  {
    title: "Agents",
    description: "Started agents, run surfaces, and approval reviews.",
    href: "/agents",
    icon: domainIcons.agents,
    links: [
      { label: "Approvals", href: "/notifications" },
      { label: "A2A servers", href: "/connectors/a2a-server" },
    ],
  },
  {
    title: "Assistants",
    description: "Assistant identities and widget-facing assistant endpoints.",
    href: "/configuration/assistants",
    icon: domainIcons.assistants,
    links: [
      { label: "Assistants", href: "/configuration/assistants" },
      { label: "Drupal widget", href: "/connectors/cinatra-ai/drupal-assistant-connector/setup" },
      { label: "WordPress widget", href: "/connectors/cinatra-ai/wordpress-assistant-connector/setup" },
    ],
  },
  {
    title: "Workspace",
    description: "Workspace overview and membership administration.",
    href: "/configuration/workspace",
    icon: domainIcons.workspace,
    links: [
      { label: "Overview", href: "/configuration/workspace" },
      { label: "Members", href: "/configuration/workspace/members" },
    ],
  },
  {
    // exec-plane S1b (cinatra#2138): where the sandbox models run commands in
    // lives, what it may reach, and whether it is actually up.
    title: "Execution",
    description:
      "Where sandbox commands run, what they may reach on the network, and whether the sandbox is up.",
    href: "/configuration/execution",
    icon: domainIcons.environment,
    links: [
      { label: "Mode and network", href: "/configuration/execution" },
      { label: "Health", href: "/configuration/execution?tab=health" },
    ],
  },
  {
    title: "Telemetry",
    description: "Provider logging and operational visibility settings.",
    href: "/configuration/telemetry",
    icon: domainIcons.telemetry,
    links: [
      // The "Telemetry" inner link was removed (cinatra#697) — it duplicated
      // the card title + "Manage" CTA. Logs remains as the one distinct target.
      { label: "Logs", href: "/configuration/telemetry?tab=logs" },
    ],
  },
  {
    // The artifact-lifecycle interception ops queues (cinatra#2047 D-4/D-7): the
    // two states S0 declared "ops-surfaced" but nothing read — a dead-lettered
    // resume (a review decision that never released its run) and a TTL-expired
    // continuation park (an effect the policy never resolved).
    title: "Lifecycle operations",
    description: "Stuck review releases and effects the lifecycle policy never resolved.",
    href: "/configuration/lifecycle-operations",
    icon: domainIcons.telemetry,
    links: [
      { label: "Stuck review releases", href: "/configuration/lifecycle-operations" },
      { label: "Blocked effects", href: "/configuration/lifecycle-operations" },
    ],
  },
  {
    title: "Development",
    description: "Development-only tools, public base URL, logging, and troubleshooting controls.",
    href: "/configuration/development",
    icon: Code2,
    links: [
      { label: "Development", href: "/configuration/development" },
      { label: "Email", href: "/configuration/development?tab=email" },
      { label: "Public base URL", href: "/configuration/development?tab=tunnel" },
    ],
  },
];

export default async function AdministrationPage() {
  await requireAdminSession();
  const identity = readInstanceIdentity();
  const publicRegistryNeedsAttention = identity?.registries?.remote?.status !== "connected";

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Configuration"
        description="Workspace controls for platform configuration, access, extensions, and operations."
      />
      <PageContent className="pb-8">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {administrationSections.map((section) => (
            <Card key={section.title} className="border-line bg-surface backdrop-blur-none">
              <CardHeader>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-control border border-line bg-surface-strong text-foreground">
                      <section.icon className="size-5" />
                    </div>
                    <CardTitle>{section.title}</CardTitle>
                  </div>
                  <CardDescription className="leading-6">{section.description}</CardDescription>
                </div>
                <CardAction>
                  <Button asChild variant="outline" size="sm">
                    <Link href={section.href}>Manage</Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  {section.links.map((link) => {
                    const needsAttention =
                      publicRegistryNeedsAttention &&
                      link.href === "/configuration/environment?tab=registries";

                    return (
                      <Link
                        key={`${section.title}-${link.label}`}
                        href={link.href}
                        className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-primary transition hover:bg-surface-muted hover:text-primary"
                      >
                        {needsAttention ? (
                          <TriangleAlert className="text-warning" aria-label="Needs attention" />
                        ) : null}
                        <span>{link.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </PageContent>
    </Main>
  );
}
