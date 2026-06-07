import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireSkillsPluginPages } from "@/app/plugins-registry";
import {
  AgentDataPage,
  AgentExecutionPage,
  AgentRunsPage,
  AgentsPage,
  NewAgentPage,
} from "@cinatra-ai/agents/pages";
import { ConnectorsPage } from "@cinatra-ai/connectors/pages";
import {
  PermissionsAuthPage,
  generatePermissionsAuthStaticParams,
} from "@cinatra-ai/permissions/pages";

export type SkillsPluginSearchPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export type SkillsPluginParamsPageProps<TParams extends Record<string, string>> = {
  params: Promise<TParams>;
};

async function renderSkillsPluginPage<
  TPage extends keyof Awaited<ReturnType<typeof requireSkillsPluginPages>>,
  TProps,
>(page: TPage, props: TProps) {
  const pages = await requireSkillsPluginPages();
  const Page = pages[page] as (props: TProps) => ReactNode | Promise<ReactNode>;
  return Page(props);
}

export async function SkillsPageMount(props: SkillsPluginSearchPageProps) {
  return renderSkillsPluginPage("SkillsPage", props);
}

export async function SkillDetailPageMount(props: SkillsPluginParamsPageProps<{ skillId: string }>) {
  return renderSkillsPluginPage("SkillDetailPage", props);
}

export async function CreateFromSkillPageMount(props: SkillsPluginParamsPageProps<{ skillId: string }>) {
  return renderSkillsPluginPage("CreateFromSkillPage", props);
}

export async function NewSkillPageMount(props: SkillsPluginSearchPageProps) {
  return renderSkillsPluginPage("NewSkillPage", props);
}

export async function EditSkillPageMount(
  props: SkillsPluginParamsPageProps<{ skillId: string }> & {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  },
) {
  return renderSkillsPluginPage("EditSkillPage", props);
}

export type SkillsCatchAllRouteProps = {
  params: Promise<{ slug?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function SkillsCatchAllRoute({ params, searchParams }: SkillsCatchAllRouteProps) {
  const { slug = [] } = await params;
  const normalizedSlug = slug.map((segment) => decodeURIComponent(segment));

  if (normalizedSlug.length === 0) {
    return SkillsPageMount({ searchParams });
  }

  // The "new" branch MUST run before the single-segment detail branch — a bare
  // `/skills/new` would otherwise resolve to SkillDetailPage with skillId="new".
  if (normalizedSlug.length === 1 && normalizedSlug[0] === "new") {
    return NewSkillPageMount({ searchParams });
  }

  if (normalizedSlug.length === 1) {
    return SkillDetailPageMount({ params: Promise.resolve({ skillId: normalizedSlug[0] }) });
  }

  if (normalizedSlug.length === 2 && normalizedSlug[1] === "edit") {
    return EditSkillPageMount({
      params: Promise.resolve({ skillId: normalizedSlug[0] }),
      searchParams,
    });
  }

  if (normalizedSlug.length === 2 && normalizedSlug[1] === "create") {
    return CreateFromSkillPageMount({ params: Promise.resolve({ skillId: normalizedSlug[0] }) });
  }

  notFound();
}

// CRM browse + detail routes (accounts / contacts / lists) are owned by
// Twenty CRM and have no cinatra-side surface. The previous /entities/*
// and /lists/* routes + their PageMount exports were deleted; reach
// CRM data programmatically through the `crm_*` MCP primitives.
// `/accounts/[path]` is unrelated — that is the user-account
// administration UI (better-auth), intentionally untouched.

export async function AgentsPageMount(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return AgentsPage(props);
}

export function NewAgentPageMount() {
  return NewAgentPage();
}

export async function AgentDataPageMount(props: {
  params: Promise<{ agentId: string }>;
}) {
  return AgentDataPage(props);
}

export async function AgentExecutionPageMount(props: {
  params: Promise<{ agentId: string }>;
}) {
  return AgentExecutionPage(props);
}

export async function AgentRunsPageMount(props: {
  params: Promise<{ agentId: string }>;
}) {
  return AgentRunsPage(props);
}

export async function ConnectorsPageMount(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return ConnectorsPage(props);
}

export function generatePermissionsAuthRouteStaticParams() {
  return generatePermissionsAuthStaticParams();
}

export async function PermissionsAuthPageMount(props: {
  params: Promise<{ path: string }>;
}) {
  return PermissionsAuthPage(props);
}
