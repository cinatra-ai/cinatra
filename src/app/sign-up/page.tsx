import type { Metadata } from "next";
import { PermissionsAuthPage } from "@cinatra-ai/permissions/pages";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage({
  searchParams,
}: {
  // cinatra#2359 — forward `?next=` through to PermissionsAuthPage so a
  // successful sign-up returns the caller to the page they were headed to.
  searchParams: Promise<{ next?: string }>;
}) {
  return <PermissionsAuthPage params={Promise.resolve({ path: "sign-up" })} searchParams={searchParams} />;
}
