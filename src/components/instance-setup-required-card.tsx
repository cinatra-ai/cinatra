import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Setup-required affordance for a surface that needs a configured instance
 * namespace to render its content. Extracted (cinatra#2753) from the
 * Environment → Registries tab (src/app/configuration/environment/page.tsx),
 * which was the ONLY surface handling the unconfigured-namespace condition
 * gracefully — the Extensions page instead let the same condition
 * (`InstanceNamespaceNotConfiguredError`, thrown by `loadVerdaccioConfigForReads`
 * inside `loadInstalledCardRows`) propagate into a hard 500.
 *
 * Kept deliberately un-parameterized: both surfaces route the SAME "Open
 * instance administration" CTA back to the same instance-setup tab, and the
 * issue's acceptance criterion is that both render the identical card, not a
 * per-surface variant.
 */
export function InstanceSetupRequiredCard() {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Setup required</CardTitle>
        <CardDescription className="max-w-2xl leading-6">
          Complete instance setup before configuring registry connections. The instance namespace is set during initial
          setup and is required for both local and remote registries.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href="/configuration/environment?tab=instance">Open instance administration</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
