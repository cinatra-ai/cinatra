"use client";

import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import { uninstallConfirmMessage } from "./uninstall-confirm-message";
// cinatra#1061: the removal returned-refusal contract, shared with the connector
// removal surface. A server-action RETURN survives Next.js production (a THROWN
// one is masked), so the dependents/system message reaches the user here.
import {
  removalFailureCopy,
  type RemovalActionResult,
} from "@cinatra-ai/extensions/removal-failure";

type ButtonVariant = ComponentProps<typeof Button>["variant"];
type ButtonSize = ComponentProps<typeof Button>["size"];

// Local copy of the Next redirect-sentinel predicate (see the extensions
// `is-redirect-error` module): a successful uninstall server action calls
// `redirect()`, which THROWS a NEXT_REDIRECT sentinel; a client wrapper that
// awaits the action inside try/catch must re-throw it so Next.js navigates
// instead of showing a false error toast on success.
function isRedirectError(error: unknown): boolean {
  return (
    typeof (error as { digest?: unknown })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

type RegistryUninstallFormProps = {
  // Bound server action (packageName/templateId baked in). Redirects on success,
  // RETURNS the classified removal refusal on failure (cinatra#1061).
  action: () => void | Promise<RemovalActionResult | void>;
  packageTitle: string;
  /**
   * cinatra#1061 req 4: package names of ACTIVE dependents that require this
   * agent — named in the confirm prompt and shown as a pre-submit preview, from
   * the SAME predicate the removal gate refuses on so the two never disagree.
   */
  dependents?: string[];
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

export function RegistryUninstallForm({
  action,
  packageTitle,
  dependents,
  variant = "destructive",
  size,
  className = "ml-auto",
}: RegistryUninstallFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const hasDependents = Array.isArray(dependents) && dependents.length > 0;

  async function handleClick() {
    if (!window.confirm(uninstallConfirmMessage(packageTitle, dependents))) return;
    setError(null);
    setPending(true);
    try {
      const result = await action();
      // A returned value always means failure (success redirect()s). Show the
      // reason-mapped copy — which NAMES the blocking dependents.
      if (result && result.ok === false) {
        const copy = removalFailureCopy(result, "uninstall", packageTitle);
        setError(copy);
        toast.error(copy);
      }
    } catch (err) {
      if (isRedirectError(err)) throw err; // success — let Next.js navigate.
      const copy = removalFailureCopy({ ok: false, reason: "error" }, "uninstall", packageTitle);
      setError(copy);
      toast.error(copy);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`flex flex-col items-end gap-1.5 ${className}`}>
      {hasDependents ? (
        <p
          data-slot="uninstall-dependents-preview"
          className="max-w-xs text-right text-xs text-muted-foreground"
        >
          Required by {dependents!.join(", ")} — uninstall or archive{" "}
          {dependents!.length === 1 ? "it" : "them"} first.
        </p>
      ) : null}
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={pending}
        onClick={handleClick}
      >
        Uninstall
      </Button>
      {error ? (
        <p
          data-slot="uninstall-error"
          role="alert"
          className="max-w-xs text-right text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
