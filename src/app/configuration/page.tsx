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
    title: "LLM",
    description: "Model defaults and LLM integration settings.",
    href: "/configuration/llm",
    icon: domainIcons.llm,
    links: [
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
    description: "Installed skill packages, shell tooling, matching, and sync settings.",
    href: "/configuration/skills",
    icon: domainIcons.skills,
    links: [
      { label: "Packages", href: "/configuration/skills" },
      { label: "Shell", href: "/configuration/skills?tab=shell" },
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
    description: "Pending approvals and workflow management surfaces.",
    href: "/configuration/approvals",
    icon: domainIcons.workflows,
    links: [
      { label: "Approvals", href: "/configuration/approvals" },
      { label: "All workflows", href: "/workflows" },
    ],
  },
  {
    title: "Agents",
    description: "Started agents, run surfaces, and approval reviews.",
    href: "/agents",
    icon: domainIcons.agents,
    links: [
      { label: "Approvals", href: "/configuration/approvals?tab=agents" },
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
    title: "Telemetry",
    description: "Provider logging and operational visibility settings.",
    href: "/configuration/telemetry",
    icon: domainIcons.telemetry,
    links: [
      { label: "Telemetry", href: "/configuration/telemetry" },
      { label: "Logs", href: "/configuration/telemetry?tab=logs" },
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
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-card border border-line bg-surface-muted text-muted-foreground">
                      <section.icon />
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
