import type { Metadata } from "next";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { PermissionsAuthPage } from "@cinatra-ai/permissions/pages";

export const metadata: Metadata = { title: "Permissions" };

export const dynamicParams = false;

export async function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export default function PermissionsAuthRoutePage(
  props: Parameters<typeof PermissionsAuthPage>[0],
) {
  return <PermissionsAuthPage {...props} />;
}
