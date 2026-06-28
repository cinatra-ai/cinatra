"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";

// HITL renderer for @cinatra-ai/blog-linkedin-publish-agent.
// Shows the generated LinkedIn post draft to the operator. Operator can
// approve (with or without edits), reject, or cancel. Edits are persisted
// via blog_post_publish_linkedin_update BEFORE the publish primitive runs
// (see SKILL.md Step 6).

// Condition: registered from the manifest binding (kind
// "linkedin-draft-review") with strict ID matching — see
// register-default-renderers.ts.

type DraftReviewValue = {
  linkedinDraftId: string;
  content: string;
  linkedinAccountName?: string;
  destinationName?: string;
  destinationType?: string;
  blogPostUrl?: string;
};

function toDraftReviewValue(value: unknown): DraftReviewValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      linkedinDraftId:
        typeof v.linkedinDraftId === "string" ? v.linkedinDraftId : "",
      content: typeof v.content === "string" ? v.content : "",
      linkedinAccountName:
        typeof v.linkedinAccountName === "string"
          ? v.linkedinAccountName
          : undefined,
      destinationName:
        typeof v.destinationName === "string" ? v.destinationName : undefined,
      destinationType:
        typeof v.destinationType === "string" ? v.destinationType : undefined,
      blogPostUrl:
        typeof v.blogPostUrl === "string" ? v.blogPostUrl : undefined,
    };
  }
  return { linkedinDraftId: "", content: "" };
}

export function BlogLinkedinDraftReviewRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const v = useMemo(() => toDraftReviewValue(value), [value]);
  const [content, setContent] = useState<string>(v.content);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Gate Approve/Reject on a non-empty linkedinDraftId.
  // The renderer mounts as soon as the interrupt fires; if the LLM/agent has
  // not yet wired the draftId into the field-snapshot (mount race) we could
  // emit `{ approved, linkedinDraftId: "" }` which silently no-ops the
  // publish primitive. Better to keep the buttons disabled until the
  // identifier arrives.
  const hasDraftId = v.linkedinDraftId.trim() !== "";
  const buttonsDisabled = disabled === true || !hasDraftId;
  const approveDisabled = buttonsDisabled || content.trim() === "";

  const handleApprove = () => {
    if (content.trim() === "" || !hasDraftId) return;
    onChangeRef.current({
      approved: true,
      linkedinDraftId: v.linkedinDraftId,
      content,
    });
  };

  const handleReject = () => {
    if (!hasDraftId) return;
    onChangeRef.current({
      approved: false,
      linkedinDraftId: v.linkedinDraftId,
    });
  };

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Review LinkedIn post draft</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(v.linkedinAccountName || v.destinationName || v.destinationType) && (
          <div className="grid gap-1 text-sm text-muted-foreground">
            {v.linkedinAccountName && (
              <p>
                <span className="text-foreground">Account:</span>{" "}
                {v.linkedinAccountName}
              </p>
            )}
            {v.destinationName && (
              <p>
                <span className="text-foreground">
                  Destination ({v.destinationType ?? "member"}):
                </span>{" "}
                {v.destinationName}
              </p>
            )}
            {v.blogPostUrl && (
              <p>
                <span className="text-foreground">Blog post:</span>{" "}
                <Link
                  href={v.blogPostUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-4 hover:underline"
                >
                  {v.blogPostUrl}
                </Link>
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="blog-linkedin-draft-content">
            LinkedIn post content
          </Label>
          <Textarea
            id="blog-linkedin-draft-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            disabled={disabled === true}
          />
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleReject}
          disabled={buttonsDisabled}
          type="button"
        >
          Reject
        </Button>
        <Button
          onClick={handleApprove}
          disabled={approveDisabled}
          type="button"
        >
          Approve &amp; publish
        </Button>
      </CardFooter>
    </Card>
  );
}
