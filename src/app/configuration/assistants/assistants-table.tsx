"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { AssistantAdminRow } from "@/lib/assistant-admin-registry";
import { toast } from "@/lib/cinatra-toast";
import { renameAssistantTagAction } from "./actions";

// ---------------------------------------------------------------------------
// Owner ruling 2026-07-24 (groganz): this surface shows ONE mutable tag per
// assistant (the resolving handle) as an ALWAYS-editable text field — a literal
// "@" is rendered immediately in front of, and OUTSIDE, the field, and the field's
// value carries NO "@". Its Save and Reset controls are ALWAYS VISIBLE (disabled
// while the field is clean). There is NO per-assistant access/audience control or
// copy on this page — access is configured on the respective extension's own
// settings surface, so duplicating it here is removed. There are also NO metadata
// badges, NO pause ("Active") switch, and NO delete button on this page.
// Collisions and failures surface as @-prefixed TOASTS.
//
// (The audience SUBSTRATE — `replaceAssistantAudienceGrants` + the
// `assistant_audience` reads in the admin/enforcement registries and their tests —
// is untouched; only this page's audience control and its now-orphaned page-level
// server action were removed, mirroring the earlier Active/Delete removals.)
//
// Design grounding (always-visible Save/Reset): the design-system specs' pattern
// for a persistent action that has nothing to act on is to keep it RENDERED and
// DISABLED, not to hide it (e.g. the connector "Disconnect is disabled until the
// connector is connected — there is nothing to disconnect otherwise", and the
// extension detail's persistent-but-disabled Activate / Archive / Publish action
// rows). So the tag's Save + Reset stay rendered at all times and are disabled
// while the field is clean (nothing to save / nothing to reset). The field itself
// mirrors the standard labelled text field (label + input + helper copy —
// app-components §"Input"); the design-system specs carry no prefix-adorned field
// pattern, so the literal "@" is added as a leading inline adornment outside the
// input. Enter in the field also submits.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Top-level surface
// ---------------------------------------------------------------------------

export function AssistantsTable({ rows }: { rows: AssistantAdminRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assistants registered yet.</p>
      ) : (
        rows.map((row) => <AssistantCard key={row.assistantUserId} row={row} />)
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-assistant card
// ---------------------------------------------------------------------------

function AssistantCard({ row }: { row: AssistantAdminRow }) {
  return (
    <section className="rounded-card border border-line bg-surface-strong/40 p-5">
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold text-foreground">{row.displayName}</span>
      </div>

      <Separator className="my-4" />

      {/* Tag — the ONE resolving handle, as an always-editable text field with a
          literal "@" rendered OUTSIDE the field (the value carries no "@"). ----- */}
      <TagField row={row} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tag field — the single resolving handle, ALWAYS editable (owner rulings
// 2026-07-23 / 2026-07-24 (groganz)). The literal "@" is a leading adornment
// OUTSIDE the input; the input's value never contains it (the rename action
// normalizes the token and echoes back exactly what the store persisted so the
// field re-syncs). The Save + Reset controls are ALWAYS VISIBLE and are disabled
// while the field is clean (nothing to save / reset); Enter in the field also
// submits. Collisions and validation failures surface as @-prefixed TOASTS.
// ---------------------------------------------------------------------------

function TagField({ row }: { row: AssistantAdminRow }) {
  const router = useRouter();
  const persisted = row.handle ?? "";
  const [value, setValue] = useState(persisted);
  const [pending, startSave] = useTransition();
  const inputId = `tag-${row.assistantUserId}`;

  const trimmed = value.trim();
  const dirty = trimmed !== persisted;

  function submit() {
    if (!dirty || !trimmed) return;
    startSave(async () => {
      try {
        const res = await renameAssistantTagAction({
          assistantUserId: row.assistantUserId,
          tag: value,
        });
        if (res.ok) {
          // Re-sync the field to exactly what the store now holds (the normalized
          // token), then refresh so every surface reads the new resolving tag.
          if (res.tag) setValue(res.tag);
          toast.success("Tag updated.");
          router.refresh();
        } else {
          toast.error(res.error);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="text-xs font-semibold text-foreground">
        Tag
      </label>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {/* The literal "@" — OUTSIDE the field; the value never contains it. */}
          <span aria-hidden className="font-mono text-sm text-muted-foreground select-none">
            @
          </span>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={pending}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 w-48 font-mono text-sm"
            aria-label="Assistant tag"
          />
        </div>
        {/* Save + Reset are ALWAYS rendered; disabled while the field is clean
            (design-system persistent-action-disabled-until-actionable pattern). */}
        <Button type="submit" size="sm" variant="outline" disabled={pending || !dirty || !trimmed}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || !dirty}
          onClick={() => setValue(persisted)}
        >
          Reset
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The tag people type in chat to @-mention this assistant — e.g. @wordpress. Change it any
        time.
      </p>
    </form>
  );
}
