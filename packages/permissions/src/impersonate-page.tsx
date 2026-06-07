import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";
import { UserImpersonationPanel } from "./user-impersonation-panel";

export default async function ImpersonatePage() {
  const session = await requireAdminSession();
  const requestHeaders = await headers();
  const listedUsers = await auth.api
    .listUsers({
      headers: requestHeaders,
      query: {
        limit: 200,
        sortBy: "createdAt",
        sortDirection: "desc",
      },
    })
    .catch(() => ({ users: [] }));

  const users = (listedUsers?.users ?? []).map((user) => {
    const email = user.email ?? "";
    const isAssistant = email.endsWith("@system.local") || !("role" in user && user.role != null);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      username: "username" in user && typeof user.username === "string" ? user.username : null,
      image: user.image,
      role: "role" in user && typeof user.role === "string" ? user.role : null,
      isAssistant,
    };
  });

  return (
    <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <UserImpersonationPanel currentUserId={session.user.id} users={users} />
      </div>
    </main>
  );
}
