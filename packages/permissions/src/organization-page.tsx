import { OrganizationView } from "@daveyplate/better-auth-ui";
import { organizationViewPaths } from "@daveyplate/better-auth-ui/server";
import { requireAdminSession } from "@/lib/auth-session";
import { Card, CardContent } from "@/components/ui/card";

export function generateStaticParams() {
  return Object.values(organizationViewPaths).map((path) => ({ path }));
}

export default async function PermissionsOrganizationPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  await requireAdminSession();
  const { path } = await params;

  return (
    <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardContent className="p-6">
            <div className="mb-6">
              <p className="section-kicker">Permissions</p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">
                Workspace administration
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Manage workspace details, members, invitations, and related access controls.
              </p>
            </div>
            <OrganizationView path={path} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
