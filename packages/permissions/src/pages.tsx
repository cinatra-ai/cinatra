import { redirect } from "next/navigation";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { AuthView, SignUpForm } from "@/components/auth-view-client";
import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";

export function generatePermissionsAuthStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export async function PermissionsAuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const [{ path }, session, hasUsers] = await Promise.all([params, getAuthSession(), hasAnyBetterAuthUsers()]);

  if (session && path !== "sign-out") {
    redirect("/");
  }

  const showBootstrapRegistration = !hasUsers && path !== "sign-out";

  return (
    <Main className="flex min-h-screen items-start justify-center pt-10">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-8 flex items-center">
          <BrandMark size={30} />
        </div>
        {showBootstrapRegistration ? (
          <div className="grid gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Setup</p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Create the first account</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                This workspace has no Better Auth users yet. The first account registered here becomes the initial full-access admin automatically.
              </p>
            </div>
            <SignUpForm localization={{}} />
          </div>
        ) : (
          <AuthView path={path} />
        )}
      </div>
    </Main>
  );
}
