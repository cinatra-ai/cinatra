import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getDevExtensionsSettings } from "@/lib/dev-extensions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SaveDevExtensionsForm } from "./save-development-form";

// Extensions tab on /configuration/development.
//
// Lets a developer running a Cinatra dev instance set an optional npm scope
// override used at publish time. The actual registry authority lives at
// registry.cinatra.ai: the admin must have run
// `grant-vendor-delegation.sh <override> <instanceNamespace>` so the dev's
// existing npm token has publish rights on the vendor scope. In production
// mode this tab is read-only and the override is hard-ignored at publish time.

export function ExtensionsTabContent({ isDevMode }: { isDevMode: boolean }) {
  const identity = readInstanceIdentity();
  const settings = getDevExtensionsSettings();
  const instanceNamespace = identity?.instanceNamespace ?? null;
  const overrideActive = isDevMode && settings.publishScopeOverride != null;

  return (
    <div className="flex flex-col gap-4">
      {!isDevMode && (
        <div className="rounded-control border border-line bg-surface-muted p-4 text-sm leading-6 text-muted-foreground">
          Publish scope override is only used in development mode. In production, extensions
          publish under the instance namespace and any stored override is ignored. The form
          below is read-only.
        </div>
      )}

      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Publish scope override</CardTitle>
          <CardDescription className="leading-6">
            In development mode, route <code>npm publish</code> under a different vendor
            scope so multiple developers can publish to a shared scope on{" "}
            <code>registry.cinatra.ai</code>. Requires a registry-side delegation grant
            (see below).
          </CardDescription>
        </CardHeader>

        <CardContent className="pb-2">
          <div className="rounded-control border border-line bg-surface-muted p-3 text-sm leading-6">
            <div>
              <span className="text-muted-foreground">This instance: </span>
              <code>{instanceNamespace ? `@${instanceNamespace}` : "(not configured — visit /setup/name)"}</code>
            </div>
            <div>
              <span className="text-muted-foreground">Publish scope override: </span>
              {overrideActive ? (
                <code>{`@${settings.publishScopeOverride}`}</code>
              ) : (
                <span className="text-muted-foreground">(none — publishes use this instance&apos;s scope)</span>
              )}
            </div>
          </div>
        </CardContent>

        <SaveDevExtensionsForm>
          <CardContent className="pb-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="publishScopeOverride">Override</FieldLabel>
                <Input
                  id="publishScopeOverride"
                  name="publishScopeOverride"
                  type="text"
                  defaultValue={settings.publishScopeOverride ?? ""}
                  placeholder="acme-corp"
                  autoComplete="off"
                  spellCheck={false}
                  className="max-w-sm"
                  disabled={!isDevMode}
                />
                <FieldContent>
                  <FieldDescription>
                    Bare scope name (no <code>@</code>, lowercase, hyphens allowed). Leave
                    empty to publish under this instance&apos;s scope.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              disabled={!isDevMode}
              title={!isDevMode ? "Publish scope override can only be changed in development mode" : undefined}
            >
              Save publish scope override
            </Button>
          </CardFooter>
        </SaveDevExtensionsForm>
      </Card>

      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>How delegation works</CardTitle>
          <CardDescription className="leading-6">
            The override only takes effect server-side after the registry admin grants
            this instance publish rights on the target scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm leading-6 text-muted-foreground">
          <ol className="ml-4 list-decimal space-y-2">
            <li>
              Identify the target vendor scope (e.g. <code>acme-corp</code>) and confirm a
              tenant for it exists on <code>registry.cinatra.ai</code>.
            </li>
            <li>
              Ask the registry admin to run, on the registry server:
              <pre className="mt-2 rounded-control border border-line bg-surface-muted p-2 text-xs">
                grant-vendor-delegation.sh &lt;vendor-scope&gt; {instanceNamespace ?? "<your-instance-namespace>"}
              </pre>
            </li>
            <li>
              Enter the vendor scope above and save. From then on, extensions published
              from this instance land under <code>@&lt;override&gt;/&lt;package&gt;</code>.
            </li>
            <li>
              To stop publishing under the delegated scope, clear the field and save —
              or ask the admin to run <code>revoke-vendor-delegation.sh</code>.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
