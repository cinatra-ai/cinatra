"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { adminClient, organizationClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const mcpAuthClient = createAuthClient({
  baseURL:
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000",
  plugins: [
    usernameClient(),
    adminClient(),
    organizationClient(),
    oauthProviderClient(),
  ],
});

export function McpAuthUiProvider(props: { children: ReactNode }) {
  const router = useRouter();

  return (
    <AuthUIProvider
      authClient={mcpAuthClient}
      changeEmail
      credentials={{
        confirmPassword: true,
        forgotPassword: false,
        passwordValidation: {
          minLength: 7,
        },
        username: true,
        usernameRequired: true,
      }}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => {
        router.refresh();
      }}
      Link={Link}
    >
      {props.children}
    </AuthUIProvider>
  );
}
