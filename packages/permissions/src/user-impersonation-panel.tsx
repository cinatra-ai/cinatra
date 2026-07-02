"use client";

import { useMemo, useState, useTransition } from "react";
import { Bot, User } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ImpersonationUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  username?: string | null;
  image?: string | null;
  role?: string | null;
  isAssistant?: boolean;
};

function formatRole(role?: string | null) {
  if (!role) {
    return "User";
  }

  return role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.charAt(0).toUpperCase() + value.slice(1))
    .join(", ");
}

function matchesQuery(user: ImpersonationUser, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [user.name, user.email, user.username, user.role]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

export function UserImpersonationPanel(props: {
  currentUserId: string;
  users: ImpersonationUser[];
}) {
  const [query, setQuery] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filteredUsers = useMemo(
    () => props.users.filter((user) => matchesQuery(user, query)),
    [props.users, query],
  );

  function handleImpersonate(userId: string) {
    setErrorMessage(null);
    setPendingUserId(userId);

    startTransition(async () => {
      try {
        const result = await authClient.admin.impersonateUser({
          userId,
        });

        if (result.error) {
          setErrorMessage(result.error.message || "Unable to start impersonation.");
          setPendingUserId(null);
          return;
        }

        // Full navigation so the session is re-initialised immediately.
        window.location.href = "/";
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to start impersonation.");
        setPendingUserId(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:gap-6">
        <Label className="flex w-full max-w-sm shrink-0 flex-col gap-2 text-sm font-medium text-foreground">
          Find a user
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, email, username, or role"
            className="h-11 rounded-control border border-line bg-surface-strong px-3 text-sm text-foreground outline-none transition focus:border-border"
          />
        </Label>
        <p className="text-sm leading-6 text-muted-foreground">
          Platform admins can temporarily sign in as another user to troubleshoot access, review the UI from that
          user&apos;s perspective, or verify permissions. Your original admin session stays available so
          you can stop impersonating later.
        </p>
      </div>

      {errorMessage ? (
        <div className="rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-control border border-line">
        <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] gap-4 border-b border-line bg-surface-muted px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
          <span>User</span>
          <span>Platform role</span>
          <span>Action</span>
        </div>

        <div className="divide-y divide-line">
          {filteredUsers.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No users match this search.</div>
          ) : (
            filteredUsers.map((user) => {
              const isCurrentUser = user.id === props.currentUserId;
              const isRowPending = isPending && pendingUserId === user.id;

              return (
                <div key={user.id} className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] md:items-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted-foreground" title={user.isAssistant ? "AI assistant" : "Human user"}>
                      {user.isAssistant ? <Bot className="h-4 w-4 text-info" /> : <User className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {user.name?.trim() || user.username?.trim() || user.email?.trim() || "Unnamed user"}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {user.email?.trim() || user.username?.trim() || user.id}
                      </p>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {user.isAssistant ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-xs font-medium text-info">
                        <Bot className="h-3 w-3" /> Assistant
                      </span>
                    ) : (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        user.role === "admin"
                          ? "bg-info/10 text-info"
                          : "bg-surface-muted text-muted-foreground"
                      }`}>
                        {formatRole(user.role)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-start md:justify-end">
                    <Button
                      type="button"
                      onClick={() => handleImpersonate(user.id)}
                      disabled={isCurrentUser || isRowPending || !!user.isAssistant}
                      className="inline-flex min-w-[11rem] items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/80 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted-foreground"
                    >
                      {isCurrentUser ? "Current admin" : isRowPending ? "Starting..." : user.isAssistant ? "Not impersonable" : "Impersonate user"}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
