import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createSkillsPrimitiveHandlers } from "../handlers";

export type DeterministicSkillsClient = ReturnType<typeof createDeterministicSkillsClient>;

export function createDeterministicSkillsClient(input: {
  actor: PrimitiveActorContext;
  transport?: PrimitiveTransport;
}) {
  const transport =
    input.transport ??
    createInProcessPrimitiveTransport(createSkillsPrimitiveHandlers());

  function invoke<TOutput>(primitiveName: string, primitiveInput: unknown) {
    return invokePrimitive<unknown, TOutput>(transport, {
      primitiveName,
      input: primitiveInput,
      actor: input.actor,
      mode: "deterministic",
    });
  }

  return {
    catalog: {
      list: () => invoke("skills_catalog_list", {}),
    },
    installed: {
      get: (skillId: string) =>
        invoke<{
          id: string;
          name: string;
          slug: string;
          description: string;
          packageId: string;
          packageName: string;
          packageSlug: string;
          content: string;
          body: string;
          usedBy: string[];
          sourcePath?: string;
          level?: string;
        } | null>("skills_installed_get", { skillId }),
      list: (cursor?: string) =>
        invoke<{
          items: Array<{
            id: string;
            name: string;
            slug: string;
            description: string;
            packageId: string;
            packageName: string;
            packageSlug: string;
            sourceUrl?: string;
            usedBy: string[];
            sourcePath?: string;
            basedOnSkillId?: string;
            level?: string;
            scope?: string;
          }>;
          total: number;
          nextCursor?: string;
        }>("skills_installed_list", { cursor }),
      resolveForAgent: (input: { agentId: string; customSkillId?: string }) =>
        invoke<{ skillIds: string[]; customSkillContent?: string }>(
          "skills_installed_resolve_for_agent",
          input,
        ),
    },
    personal: {
      list: () =>
        invoke<Array<{
          id: string;
          name: string;
          description?: string;
          content: string;
          agentId: string;
          ownerUserId: string;
        }>>("skills_personal_list", {}),
      listForAgent: (agentId: string, ownerUserId?: string) =>
        invoke<Array<{
          id: string;
          name: string;
          description: string;
          content: string;
          agentId: string;
          ownerUserId: string;
        }>>("skills_personal_list_for_agent", { agentId, ...(ownerUserId ? { ownerUserId } : {}) }),
      get: (skillId: string, ownerUserId?: string) =>
        invoke("skills_personal_get", { skillId, ...(ownerUserId ? { ownerUserId } : {}) }),
      upsert: (input: {
        agentId: string;
        name: string;
        description?: string;
        content: string;
        ownerUserId?: string;
      }) => invoke("skills_personal_upsert", input),
      delete: (skillId: string, ownerUserId?: string) =>
        invoke<{ ok: true }>("skills_personal_delete", { skillId, ...(ownerUserId ? { ownerUserId } : {}) }),
    },
    personalSkill: {
      createOrUpdate: (input: {
        agentId: string;
        promptEntries: Array<{ kind: string; prompt: string }>;
        skillName: string;
        existingSkillId?: string;
        connection?: {
          apiKey?: string;
          organizationId?: string;
          projectId?: string;
        };
      }) => invoke<{ id: string; name: string }>("skills_personal_skill_create_or_update", input),
    },
    packages: {
      list: () =>
        invoke<Array<{
          packageId: string;
          name: string;
          slug: string;
          description: string;
          sourceUrl?: string;
          repositoryUrl?: string;
          license?: string;
          authors?: string[];
          level?: string;
          skillCount: number;
          readmeContent?: string;
          licenseText?: string;
          skills: Array<{
            id: string;
            name: string;
            slug: string;
            description: string;
            content: string;
            sourcePath?: string;
            usedBy: string[];
          }>;
        }>>("skills_packages_list", {}),
      installFromGitHub: (repoRef: string, connectionId?: string) =>
        invoke("skills_packages_install_from_github", { repoRef, ...(connectionId ? { connectionId } : {}) }),
      uninstall: (packageId: string) =>
        invoke<{ ok: boolean }>("skills_packages_uninstall", { packageId }),
    },
    library: {
      list: (input?: { level?: string; query?: string }) =>
        invoke("skills_library_list", input ?? {}),
    },
  };
}
