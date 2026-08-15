import { RegistryCatalogScreen } from "@cinatra-ai/extensions/screens";

import { InstanceSetupRequiredCard } from "@/components/instance-setup-required-card";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { readInstanceIdentity } from "@/lib/instance-identity-store";

/**
 * On an unconfigured host, `loadInstalledCardRows` (inside
 * `RegistryCatalogScreen`) awaits `loadVerdaccioConfigForReads()` unguarded,
 * which throws `InstanceNamespaceNotConfiguredError` — a hard 500 (cinatra#2753).
 *
 * Mirrors the SAME check the Environment → Registries tab uses
 * (`RegistriesTabContent` in ../environment/page.tsx) to handle the identical
 * condition gracefully: read the instance identity FIRST and short-circuit to
 * the shared setup-required card before anything that would throw is ever
 * called, rather than try/catching the thrown error after the fact.
 */
export default async function ExtensionsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = readInstanceIdentity();

  if (!identity || !identity.instanceNamespace) {
    return (
      <Main className="min-h-screen">
        <PageHeader
          title="Extensions"
          description="Manage installed agents, skills, connectors, and artifacts."
          divider={false}
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          {/* Called directly (not `<InstanceSetupRequiredCard />`) so its
              element tree stays inline for the render-tree-walking test
              helpers used across this codebase's server-component tests
              (e.g. src/app/configuration/instance/__tests__/page.test.tsx),
              rather than hidden behind an unexpanded component boundary. */}
          {InstanceSetupRequiredCard()}
        </PageContent>
      </Main>
    );
  }

  return <RegistryCatalogScreen searchParams={searchParams} />;
}
