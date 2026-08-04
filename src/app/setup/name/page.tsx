// -----------------------------------------------------------------------------
// Setup wizard step 1: instance identity capture page.
//
// /setup/vendor-name returns a Next.js 404 (no redirect, no alias).
//
// The CINATRA_ENCRYPTION_KEY pre-check alert lives in /setup/key (wizard step 0).
// By the time the operator reaches this page, the wizard guarantees the key is
// set.
//
// Copy and field ordering:
//   - Heading and two-paragraph body copy (the second paragraph is mode-aware
//     marketplace-participation copy — see getNetworkParticipationCopy)
//   - "Instance display name" field ABOVE the namespace field; typing here
//     live-derives the namespace field until the operator edits it directly
//     (see ./instance-namespace-input.tsx, cinatra#2387)
//   - Honest, four-state mutability Alert above the namespace field (see
//     getNamespaceMutabilityCopy in @/lib/instance-identity-copy — shared
//     with the /configuration/environment administration copy so the two
//     surfaces cannot drift into inconsistent claims)
//   - Namespace field relabeled "Instance namespace"
//
// Interactive elements use src/components/ui/* and semantic tokens only; no raw
// Tailwind palette values.
// -----------------------------------------------------------------------------

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";

import {
  InstanceDisplayNameInput,
  InstanceNamespaceInput,
  NamespaceValidationProvider,
  SubmitContinueButton,
} from "./instance-namespace-input";
import { saveInstanceIdentityAction } from "./actions";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getApprovedInstanceNamespaces } from "@/lib/instance-namespace/approved-list";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
import { getSetupNameDefaults } from "@/lib/setup-defaults";
import { requireAuthSession } from "@/lib/auth-session";
import {
  getNamespaceMutabilityCopy,
  getNetworkParticipationCopy,
  isMarketplaceManagedInstance,
} from "@/lib/instance-identity-copy";

export const metadata: Metadata = { title: "Setup: Name" };

type SetupNamePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SetupNamePage({ searchParams }: SetupNamePageProps) {
  await requireAuthSession();
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const errorMessage = pickSearchParam(resolvedSearchParams.error);
  const stay = pickSearchParam(resolvedSearchParams.stay) === "1";

  const identity = readInstanceIdentity();

  // In dev mode, pre-fill the form from hostname + git branch. No-op when an
  // identity already exists (the destructured fallback uses identity?.* first).
  // Empty string in production.
  const devDefaults = identity ? null : getSetupNameDefaults();

  // If identity is already set and there's no error to surface, hop the
  // operator forward to the next incomplete step. name is step 1;
  // once its `ready` flag flips true we're past this surface.
  if (identity?.instanceNamespace && !errorMessage && !stay) {
    const steps = await getSetupWizardSteps();
    const next = getFirstIncompleteStep(steps);
    if (!next || next.id !== "name") {
      redirect(next?.href ?? "/setup");
    }
  }

  const isMarketplaceManaged = isMarketplaceManagedInstance();

  return (
    <NamespaceValidationProvider
      initialValue={identity?.instanceNamespace ?? devDefaults?.instanceNamespace ?? ""}
      initialDisplayName={identity?.instanceDisplayName ?? devDefaults?.instanceDisplayName ?? ""}
      // A saved identity's namespace is a real decision (persisted, possibly
      // hand-edited) — start detached so re-visiting this step never silently
      // overwrites it. A dev-mode default (cinatra#2418 review) is a
      // machine-generated suggestion nobody has chosen yet — start it linked
      // so editing the display name still re-derives the namespace below.
      initiallyDetached={Boolean(identity?.instanceNamespace)}
      approvedExactNames={getApprovedInstanceNamespaces()}
    >
    <div className="flex flex-col gap-6">
      {/* Errors are surfaced as a toast by the codes-only <SearchParamToast>
          island in the setup layout (reads the ?error=<code> redirect param and
          maps it to a static message). The `errorMessage` var is still read
          above to suppress the auto-advance redirect when an error is present. */}

      <div>
        <p className="text-base font-semibold text-foreground">Name your Cinatra instance</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Define how this Cinatra instance is identified. Its display name is shown in
          user-facing places, while its namespace is used in technical references.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {getNetworkParticipationCopy(isMarketplaceManaged)}
        </p>
      </div>

      {identity?.instanceNamespace ? (
        <Alert>
          <AlertTitle>Instance identity saved</AlertTitle>
          <AlertDescription>
            Your instance display name and namespace have been configured.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
        <form id="instance-name-form" action={saveInstanceIdentityAction} className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="instance-display-name">Instance display name</FieldLabel>
            <InstanceDisplayNameInput
              defaultValue={identity?.instanceDisplayName ?? devDefaults?.instanceDisplayName ?? ""}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Human-readable name shown wherever this Cinatra instance is referenced. Typing here
              auto-fills the namespace below until you edit it directly.
            </span>
          </Field>

          <Field>
            <FieldLabel>Instance namespace</FieldLabel>
            <Alert variant="info">
              <AlertDescription>{getNamespaceMutabilityCopy(isMarketplaceManaged)}</AlertDescription>
            </Alert>
            <InstanceNamespaceInput
              defaultValue={identity?.instanceNamespace ?? devDefaults?.instanceNamespace ?? ""}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Machine-readable name used to uniquely identify this instance. Lowercase letters,
              digits, and hyphens only; 2–39 characters.
            </span>
          </Field>

          {/* Continue button stays inside the form so useFormStatus() can read
              its pending lifecycle. SubmitContinueButton composes the
              namespace-validity gate with the form-pending gate and renders
              <Spinner> during pending. */}
          <div className="flex justify-end mt-2">
            <SubmitContinueButton />
          </div>
        </form>
      </section>
    </div>
    </NamespaceValidationProvider>
  );
}
