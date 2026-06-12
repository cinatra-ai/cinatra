"use client";

import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";

// HITL renderer for @cinatra-ai/blog-wordpress-publish-agent.
// Shows the operator the WordPress admin URL of the created draft and
// lets them confirm (leave the draft in place) or reject (delete the
// draft from WordPress via deleteInWordPress: true).

// Condition: registered from the manifest binding (kind
// "wordpress-draft-confirm") with strict ID matching — see
// register-default-renderers.ts.

type DraftConfirmValue = {
  wordpressDraftId: string;
  wordpressAdminUrl: string;
  wordpressInstanceId?: string;
};

function toDraftConfirmValue(value: unknown): DraftConfirmValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      wordpressDraftId:
        typeof v.wordpressDraftId === "string" ? v.wordpressDraftId : "",
      wordpressAdminUrl:
        typeof v.wordpressAdminUrl === "string" ? v.wordpressAdminUrl : "",
      wordpressInstanceId:
        typeof v.wordpressInstanceId === "string"
          ? v.wordpressInstanceId
          : undefined,
    };
  }
  return { wordpressDraftId: "", wordpressAdminUrl: "" };
}

export function BlogWordpressDraftConfirmRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const v = useMemo(() => toDraftConfirmValue(value), [value]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Gate Confirm/Reject on a non-empty wordpressDraftId.
  // If the renderer mounts before the agent has wired the draftId through
  // the field-snapshot, emitting `{ approved, wordpressDraftId: "" }` would
  // silently no-op the publish/delete primitive. Keep the buttons disabled
  // until the identifier arrives.
  const hasDraftId = v.wordpressDraftId.trim() !== "";
  const buttonsDisabled = disabled === true || !hasDraftId;

  const handleConfirm = () => {
    if (!hasDraftId) return;
    onChangeRef.current({
      approved: true,
      wordpressDraftId: v.wordpressDraftId,
    });
  };

  const handleReject = () => {
    if (!hasDraftId) return;
    onChangeRef.current({
      approved: false,
      wordpressDraftId: v.wordpressDraftId,
    });
  };

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Confirm WordPress draft</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-foreground">
          A WordPress draft has been created. Review it in WordPress admin, then
          confirm to leave it in place (you publish from WP), or reject to
          delete it from WordPress.
        </p>
        {v.wordpressAdminUrl && (
          <p>
            <a
              href={v.wordpressAdminUrl}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline-offset-4 hover:underline"
            >
              Open WordPress draft →
            </a>
          </p>
        )}
        {v.wordpressInstanceId && (
          <p className="text-muted-foreground">
            Instance: {v.wordpressInstanceId}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleReject}
          disabled={buttonsDisabled}
          type="button"
        >
          Reject &amp; delete from WordPress
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={buttonsDisabled}
          type="button"
        >
          Confirm
        </Button>
      </CardFooter>
    </Card>
  );
}
