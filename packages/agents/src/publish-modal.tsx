"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  PublishDestinationPicker,
  type PublishDestination,
} from "@cinatra-ai/extensions/components/publish-destination-picker";

// ---------------------------------------------------------------------------
// PublishModal
//
// This component is the authoritative chat-publish dialog for publishing agent
// packages from a chat surface. It integrates PublishDestinationPicker and is
// exported from @cinatra-ai/agents, but no caller currently mounts
// <PublishModal> in the codebase.
//
// The /chat publish flow that would mount this modal has not been rebuilt, so
// this surface is currently unreachable through the live UI.
//
// DO NOT delete - this is the intended mount point once /chat regains a publish
// entry point.
// ---------------------------------------------------------------------------

export type PublishModalProps = {
  templateId: string;
  defaultTitle?: string;
  publishAction: (formData: FormData) => Promise<void>;
  /** Passed from parent RSC which reads loadDeploymentRegistryConfig() server-side. */
  privateDestinationConfigured?: boolean;
};

export function PublishModal({
  templateId,
  defaultTitle,
  publishAction,
  privateDestinationConfigured = false,
}: PublishModalProps) {
  const [open, setOpen] = useState(false);
  // Default to "private" when private destination is configured.
  const [destination, setDestination] = useState<PublishDestination>(
    privateDestinationConfigured ? "private" : "public",
  );

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-sm"
      >
        <Upload className="h-4 w-4" />
        Publish to Registry
      </Button>

      <AppDialog
        open={open}
        onOpenChange={setOpen}
        title="Publish Agent Package"
        description="Local saves stay drafts until you publish a versioned package to the registry."
        maxWidth="max-w-md"
      >
        <form action={publishAction} className="flex flex-col gap-4 pt-2">
          <Input type="hidden" name="templateId" value={templateId} />
          {/* Destination value is threaded into form data so the server action
              can resolve the publish destination before publishing. */}
          <Input type="hidden" name="destination" value={destination} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pub-semver">Version</Label>
            <Input
              id="pub-semver"
              name="semver"
              required
              pattern="^\d+\.\d+\.\d+$"
              placeholder="1.0.0"
            />
            <p className="text-xs text-muted-foreground">
              Semantic version for this release (e.g. 1.0.0).
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pub-title">Title</Label>
            <Input
              id="pub-title"
              name="title"
              required
              defaultValue={defaultTitle}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pub-description">Description (optional)</Label>
            <Textarea
              id="pub-description"
              name="description"
              rows={3}
              placeholder="Describe what this agent does"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pub-changelog">What&apos;s new in this version (optional)</Label>
            <Textarea
              id="pub-changelog"
              name="changelog"
              rows={3}
              placeholder="Describe changes in this release"
            />
          </div>

          {/* Publish destination picker, last step before submit. */}
          <Separator className="my-1" />
          <PublishDestinationPicker
            value={destination}
            onValueChange={setDestination}
            privateDestinationConfigured={privateDestinationConfigured}
            idPrefix="publish-modal"
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Publish to Registry</Button>
          </div>
        </form>
      </AppDialog>
    </>
  );
}
