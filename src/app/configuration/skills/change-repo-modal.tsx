"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNotify } from "@/context/notification-context";
import { saveGitHubRepoFromSkillsAction } from "./actions";

type Repository = {
  id: number;
  fullName: string;
  visibility: "public" | "private";
};

type ChangeRepoModalProps = {
  repositories: Repository[];
  currentRepo?: string;
};

export function ChangeRepoButton({ repositories, currentRepo }: ChangeRepoModalProps) {
  const [open, setOpen] = useState(false);
  const { addNotification } = useNotify();
  const router = useRouter();

  async function handleSubmit(formData: FormData) {
    try {
      await saveGitHubRepoFromSkillsAction(formData);
      addNotification({
        title: "GitHub repository saved",
        body: "Skill repository selection has been updated.",
        kind: "success",
      });
      setOpen(false);
      router.refresh();
    } catch (error) {
      addNotification({
        title: "Repository save failed",
        body: error instanceof Error ? error.message : "Unable to save the GitHub repository.",
        kind: "error",
      });
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Change repo
      </Button>

      <AppDialog
        open={open}
        onOpenChange={setOpen}
        title="Change repository"
        description="Select the GitHub repository Cinatra should use for skill package sync."
      >
        <form action={handleSubmit} className="grid gap-4">
          {repositories.length > 0 ? (
            <Field>
              <FieldLabel>Repository</FieldLabel>
              <Select name="repositoryFullName" defaultValue={currentRepo ?? ""}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a repository…" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName} ({repo.visibility})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="rounded-control border border-dashed border-line bg-surface-muted/70 px-4 py-4 text-sm text-muted-foreground">
              No repositories found for the current connection. Reconnect GitHub and refresh.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit">Save repository</Button>
          </DialogFooter>
        </form>
      </AppDialog>
    </>
  );
}
