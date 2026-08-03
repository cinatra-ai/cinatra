import type { Metadata } from "next";
import { PermissionsAuthPage } from "@cinatra-ai/permissions/pages";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({
  searchParams,
}: {
  // cinatra#2359 — forward `?next=` through to PermissionsAuthPage so a
  // successful sign-in returns the caller to the page they were headed to.
  searchParams: Promise<{ next?: string }>;
}) {
  return <PermissionsAuthPage params={Promise.resolve({ path: "sign-in" })} searchParams={searchParams} />;
}
