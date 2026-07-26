"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Eye, Pencil, Trash2, UserRoundCog } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { deleteUserAction } from "./actions";

export function UserActions(props: {
  userId: string;
  currentUserId: string;
  canImpersonate: boolean;
}) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isCurrentUser = props.userId === props.currentUserId;
  const userHref = `/users/${props.userId}`;

  function impersonate() {
    setErrorMessage(null);
    startTransition(async () => {
      const result = await authClient.admin.impersonateUser({ userId: props.userId });
      if (result.error) {
        setErrorMessage(result.error.message || "Unable to impersonate user.");
        return;
      }
      window.location.href = "/";
    });
  }

  // Deletion goes through the result-returning server action so a REFUSAL (the
  // extension-owned / builtin / self guards, cinatra#1880 W5 AC#3) renders its
  // directing message inline — a thrown Server Action error is digest-masked in
  // production. The server action is the enforcement point; this only surfaces
  // the message it returns.
  function handleDelete() {
    setErrorMessage(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("userId", props.userId);
      try {
        const result = await deleteUserAction(fd);
        if (!result.ok) {
          setErrorMessage(result.error);
          return;
        }
        router.refresh();
      } catch {
        setErrorMessage("Could not delete the user. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button asChild variant="ghost" size="icon" title="View user">
          <Link href={userHref}>
            <Eye data-icon="icon" />
            <span className="sr-only">View user</span>
          </Link>
        </Button>
        <Button asChild variant="ghost" size="icon" title="Edit user">
          <Link href={userHref}>
            <Pencil data-icon="icon" />
            <span className="sr-only">Edit user</span>
          </Link>
        </Button>
        {props.canImpersonate ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Impersonate user"
            disabled={isPending}
            onClick={impersonate}
          >
            <UserRoundCog data-icon="icon" />
            <span className="sr-only">Impersonate user</span>
          </Button>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Delete user"
              disabled={isCurrentUser}
            >
              <Trash2 data-icon="icon" />
              <span className="sr-only">Delete user</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this user?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the user account and active sessions. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction type="button" disabled={isPending} onClick={handleDelete}>
                Delete user
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {errorMessage ? (
        <p className="max-w-64 text-right text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}
