import { requireAuthSession } from "@/lib/auth-session";
import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";
import { readChatThreadsFromDatabase } from "@/lib/database";
import { eq } from "drizzle-orm";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { notFound } from "next/navigation";

type Props = { params: Promise<{ userId: string }> };

export default async function UserProfilePage({ params }: Props) {
  const [session, { userId }] = await Promise.all([requireAuthSession(), params]);

  const [profileUser] = await betterAuthDb
    .select()
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);

  if (!profileUser) notFound();

  const allThreads = readChatThreadsFromDatabase();
  const sharedThreads = allThreads
    .filter((t) => {
      const owner = t.ownerUserId as string | undefined;
      return owner === userId;
    })
    .slice(0, 5);

  const initials = (profileUser.name ?? profileUser.email ?? "?")
    .split(" ")
    .map((p: string) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const currentUserId = session.user.id;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={profileUser.name ?? profileUser.email ?? userId}
        description={profileUser.email ?? undefined}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <div className="soft-panel flex flex-col gap-6 p-6">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              {profileUser.image && <AvatarImage src={profileUser.image} alt={profileUser.name ?? ""} />}
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-1">
              <span className="text-lg font-semibold text-foreground">{profileUser.name}</span>
              {profileUser.username && (
                <span className="text-sm text-muted-foreground">@{profileUser.username}</span>
              )}
              <div className="flex items-center gap-2">
                {profileUser.role && (
                  <Badge variant="secondary">{profileUser.role}</Badge>
                )}
                {profileUser.userType && (
                  <Badge variant="outline">{profileUser.userType}</Badge>
                )}
              </div>
            </div>
          </div>

          {userId !== currentUserId && (
            <div>
              <Button asChild>
                <Link href={`/chat?mention=${encodeURIComponent(profileUser.username ?? profileUser.name ?? "")}`}>
                  Chat now
                </Link>
              </Button>
            </div>
          )}
        </div>

        {sharedThreads.length > 0 && (
          <div className="soft-panel flex flex-col gap-3 p-6">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Recent Conversations</h2>
            <ul className="flex flex-col gap-2">
              {sharedThreads.map((t) => (
                <li key={t.id as string}>
                  <Link
                    href={`/chat/${t.id as string}`}
                    className="flex flex-col rounded-md px-3 py-2 transition hover:bg-surface-muted"
                  >
                    <span className="text-sm text-foreground">{(t.title as string) || "Untitled"}</span>
                    <span className="text-xs text-muted-foreground">{t.updatedAt as string}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PageContent>
    </Main>
  );
}
