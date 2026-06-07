import type { Metadata } from "next";
import { PermissionsAuthPage } from "@cinatra-ai/permissions/pages";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage() {
  return <PermissionsAuthPage params={Promise.resolve({ path: "sign-up" })} />;
}
