import type { Metadata } from "next";
import { PermissionsAuthPage } from "@cinatra-ai/permissions/pages";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return <PermissionsAuthPage params={Promise.resolve({ path: "sign-in" })} />;
}
