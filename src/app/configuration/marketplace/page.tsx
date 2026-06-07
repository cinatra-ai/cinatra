import { requireAdminSession } from "@/lib/auth-session";
import { ExtensionsMarketplaceScreen } from "@cinatra-ai/extensions/screens";
import { loadMarketplaceBrowse } from "@/lib/marketplace-browse";

// Browse is sourced from the storefront's anonymous public catalog; install +
// vendor/admin features stay credential-backed. Browse never sends a bearer.
export default async function ExtensionsMarketplacePage() {
  await requireAdminSession();

  const result = await loadMarketplaceBrowse();
  return (
    <ExtensionsMarketplaceScreen
      cards={result.cards}
      registryConnected={result.registryConnected}
    />
  );
}
