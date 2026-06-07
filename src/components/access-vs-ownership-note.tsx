import { ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * (RBAC-UI-01) — access-vs-ownership clarity.
 *
 * A reusable, Google-Drive-style explainer that resource creation + sharing
 * surfaces render to disambiguate the two concepts:
 *   - OWNERSHIP — which scope (user / team / organization / workspace) the
 *     resource belongs to. Fixed at creation; drives the billing + lifecycle.
 *   - ACCESS — which principals can read / write / admin it, granted on top
 *     of ownership (project_access grants, role grants).
 *
 * Drop it into the PageContent of a permissions / sharing surface above the
 * grant controls. Uses the shadcn Alert primitive + semantic tokens only.
 */
export function AccessVsOwnershipNote() {
  return (
    <Alert>
      <ShieldCheck data-icon="inline-start" />
      <AlertTitle>Ownership and access are separate</AlertTitle>
      <AlertDescription>
        <span className="font-medium text-foreground">Ownership</span> is the scope this resource
        belongs to — set once at creation and unchanged here.{" "}
        <span className="font-medium text-foreground">Access</span> is who can see or change it,
        granted on top of ownership below. Removing an access grant never changes who owns the
        resource.
      </AlertDescription>
    </Alert>
  );
}
