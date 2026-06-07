"use client";

// PORT-05 artifact-edit-text portlet. Inline markdown edit via the canonical
// ref-swap: the action authors a NEW artifact then swaps the parent object's
// pointer (refSwapPrimitive). The new content is the ONLY trusted client input;
// projectId/postId/extension/MIME are derived server-side from the gated parent
// object. Only `blog_post_update` is a live refSwapPrimitive this phase.
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editArtifactTextAction } from "@/lib/dashboards/portlet-actions";
import type { PortletComponentProps } from "./types";

export function ArtifactEditTextPortlet({ config, inputs }: PortletComponentProps) {
  const parentObjectField = typeof config.parentObjectField === "string" ? config.parentObjectField : "";
  const refSwapPrimitive = typeof config.refSwapPrimitive === "string" ? config.refSwapPrimitive : "";
  const parentObjectId = typeof inputs.parentObjectId === "string" ? inputs.parentObjectId : null;

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  if (!parentObjectField || !refSwapPrimitive) {
    return <p className="text-sm text-muted-foreground">Misconfigured: missing refSwap config.</p>;
  }
  if (!parentObjectId) {
    return <p className="text-sm text-muted-foreground">Select an item to edit its content.</p>;
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    start(async () => {
      const res = await editArtifactTextAction({
        parentObjectId: parentObjectId!,
        parentObjectField,
        refSwapPrimitive,
        title,
        content,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Artifact title" />
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={8}
        placeholder="Content (markdown)…"
        aria-label="Artifact content"
        className="text-sm"
      />
      <div className="flex items-center justify-between gap-3">
        <Button type="button" onClick={handleSave} disabled={pending || !content.trim()}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
