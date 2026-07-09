"use client";

// ---------------------------------------------------------------------------
// Permissions control for the per-extension Settings page (design §V):
// "Who can access this extension?" — the install-time single-select access
// picker (project · team · organization scopes), reused verbatim. Editing
// persists the extension's access policy through the sanctioned server action
// (saveExtensionAccessPolicy); the server write is the authority.
//
// Scoped to the kinds whose access identity is the canonical install row
// (connector / artifact / workflow — the identity install + enforcement both
// key on). Agent / skill access lives on their own dedicated surfaces (the
// shared multi-scope picker unifies them separately); this control is not
// mounted for those kinds.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  AccessComboboxHierarchical,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";

export function ExtensionAccessControl({
  initialValue,
  scopes,
  save,
}: {
  initialValue: string;
  scopes: AvailableScopes;
  /** Bound server action: persists the picked visibility; returns the outcome. */
  save: (value: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [pending, startSave] = useTransition();
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const dirty = value !== initialValue;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="extension-access-picker" className="text-sm text-foreground">
        Who can access this extension?
      </label>
      <AccessComboboxHierarchical
        id="extension-access-picker"
        value={value}
        onChange={(next) => {
          setValue(next);
          setStatus(null);
        }}
        scopes={scopes}
      />
      {(dirty || status) && (
        <div className="flex items-center gap-3">
          {dirty && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={pending}
              className="h-auto p-0"
              onClick={() =>
                startSave(async () => {
                  const result = await save(value);
                  if (result.ok) {
                    setStatus({ tone: "ok", text: "Access saved." });
                    router.refresh();
                  } else {
                    setStatus({
                      tone: "error",
                      text:
                        result.error === "scope_locked_by_connector"
                          ? "This connector locks access to a fixed scope."
                          : "Could not save access. Try again.",
                    });
                  }
                })
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          )}
          {status && (
            <span
              className={
                status.tone === "ok"
                  ? "text-xs text-muted-foreground"
                  : "text-xs text-destructive"
              }
            >
              {status.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
