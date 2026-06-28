// -----------------------------------------------------------------------------
// RenameConfirmation client component.
//
// Wraps the post-freeze rename flow in a shadcn Dialog confirmation modal
// containing the confirmation copy. The form action is gated behind the
// Confirm button — the operator must explicitly type the new name and
// click Confirm before the form submits.
//
// Validator invariants:
//   - The client uses the shared namespace validator so the reserved-substring
//     policy and canonicalization rules match the server. Uppercase input that
//     the server canonicalizes and accepts must not leave Confirm disabled.
//   - This file now imports `validateInstanceNamespace` from the same
//     barrel as the wizard client island and the three server actions.
//     Confirm is gated on `result.ok`. Inline error copy mirrors the
//     wizard's NamespaceErrorMessage pattern (verbatim reserved-substring
//     copy, with a clickable contact link).
//   - Native HTML `pattern=` stays as defense-in-depth using a hardcoded
//     literal — this is the same pattern the wizard input uses, and
//     single-export-site.test.ts excludes the HTML-attribute form by
//     design (the bare-string JS form is the dangerous false-negative).
//
// FORM-DATA TRAP FIX:
//   - The form contains EXACTLY ONE submit-eligible field bound to the
//     vendor-name slot — a hidden input bound to the modal's controlled
//     state. That hidden input carries the NEW vendor name into formData.
//   - The visible "Current vendor name" element is a span, NOT an
//     input element. It contributes nothing to formData.
//   - The dialog's typing input has NO name= attribute — it only updates
//     client state. On Confirm, formRef.current?.requestSubmit() submits
//     the parent form, which carries the hidden input as the sole
//     instanceNamespace field.
//
// Result: server action receives FormData = { instanceNamespace: <newName> }.
// No collision with the disabled-input-doesn't-submit gotcha; no two
// fields named instanceNamespace.
// -----------------------------------------------------------------------------

"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  validateInstanceNamespace,
  NAMESPACE_FORMAT_REGEX_SOURCE,
  type NamespaceValidationError,
} from "@/lib/instance-namespace";

type Props = {
  currentInstanceNamespace: string;
  renameAction: (formData: FormData) => Promise<void>;
};

export function RenameConfirmation({
  currentInstanceNamespace,
  renameAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [hasBlurred, setHasBlurred] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Single shared validator. The validator canonicalizes (trim → lowercase)
  // before the regex test, so uppercase input the server would canonicalize
  // and accept does not see a stuck-disabled Confirm button. The validator
  // also enforces the reserved-substring policy.
  const result = useMemo(() => validateInstanceNamespace(pendingName), [pendingName]);
  const isValidNew = result.ok;

  // Same UX gate as the wizard island: pre-blur quiet, lazy then eager.
  const showError = hasBlurred && !result.ok;
  const showPreview =
    hasBlurred && result.ok && result.canonical !== pendingName && result.canonical !== "";

  const newScopePreview = result.ok && result.canonical
    ? result.canonical
    : pendingName.trim() || "<new>";

  return (
    <form ref={formRef} action={renameAction} className="mt-4 grid gap-3">
      {/* Visible READ-ONLY label of the current vendor name. NO name=
          attribute — this element does NOT submit. */}
      <div className="grid gap-2">
        <span className="text-sm font-medium text-foreground">
          Current vendor name
        </span>
        <span className="rounded-control border border-line bg-surface-muted px-3 py-2 text-sm text-foreground">
          {currentInstanceNamespace}
        </span>
      </div>
      {/* The ONLY form field named instanceNamespace — carries the new value
          out of the modal into the server action. */}
      <Input type="hidden" name="instanceNamespace" value={pendingName} />
      <div className="flex gap-3">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button">Rename vendor</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm rename</DialogTitle>
              <DialogDescription>
                Renaming will register a new scope. Extensions already
                published under @{currentInstanceNamespace}/&lt;...&gt; will remain
                on the registry but you cannot publish updates to them
                anymore. Anyone with @{currentInstanceNamespace}/&lt;...&gt;
                installed continues to use those exact versions. New
                extensions you publish will use @{newScopePreview}/&lt;...&gt;.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel>New vendor name</FieldLabel>
              {/* No name= attribute — this input is for typing only.
                  Its value flows through pendingName into the hidden
                  input above. Native HTML pattern stays as defense-in-depth. */}
              <Input
                value={pendingName}
                onChange={(e) => setPendingName(e.target.value)}
                onBlur={() => setHasBlurred(true)}
                pattern={NAMESPACE_FORMAT_REGEX_SOURCE}
                aria-invalid={showError}
                minLength={2}
                maxLength={39}
                required
                autoFocus
              />
              {showError ? (
                <NamespaceErrorMessage
                  error={
                    (result as { ok: false; canonical: string; error: NamespaceValidationError })
                      .error
                  }
                />
              ) : null}
              {showPreview ? (
                <span className="mt-1 text-xs font-normal text-muted-foreground">
                  Will be saved as: <code>{result.canonical}</code>
                </span>
              ) : null}
            </Field>
            <DialogFooter>
              <CancelButton onClick={() => setOpen(false)} />
              <ConfirmButton
                disabled={!isValidNew}
                onClick={() => {
                  formRef.current?.requestSubmit();
                }}
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------
// ConfirmButton — inner client component that reads useFormStatus().
// useFormStatus reads the NEAREST ancestor <form> in the React tree, which
// means we must call it from a CHILD of the form, not the component that renders
// the form itself. Even though Radix portals DialogContent's DOM out of the
// form, React-tree ancestry is preserved, so useFormStatus() correctly tracks
// the parent form's pending lifecycle.
// -----------------------------------------------------------------------------

function ConfirmButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="button"
      disabled={disabled || pending}
      onClick={onClick}
    >
      {pending ? <Spinner /> : null}
      Confirm
    </Button>
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  const { pending } = useFormStatus();
  return (
    <Button type="button" variant="ghost" disabled={pending} onClick={onClick}>
      Cancel
    </Button>
  );
}

// -----------------------------------------------------------------------------
// NamespaceErrorMessage — renders the structured payload as user-facing copy.
//
// Mirrors the same component in the wizard client island
// (src/app/setup/name/instance-namespace-input.tsx). Kept as a local helper
// here rather than lifted to a shared client module: the verbatim copy is
// already locked to the structured payload (channel + href flow through
// from the validator), and the only render-layer difference between the two
// surfaces is JSX styling, which is identical anyway.
// -----------------------------------------------------------------------------

function NamespaceErrorMessage({ error }: { error: NamespaceValidationError }) {
  if (error.code === "required") {
    return (
      <span role="alert" className="mt-1 text-xs font-normal text-destructive">
        Instance namespace is required.
      </span>
    );
  }
  if (error.code === "format") {
    return (
      <span role="alert" className="mt-1 text-xs font-normal text-destructive">
        Use only lowercase letters (a–z), digits (0–9), and hyphens. Must start with a letter or
        digit and be 2–39 characters long.
      </span>
    );
  }
  // error.code === "reserved" — verbatim reserved-substring policy copy.
  return (
    <span role="alert" className="mt-1 text-xs font-normal text-destructive">
      Instance namespace &quot;{error.canonical}&quot; contains the reserved substring &quot;
      {error.reservedSubstring}&quot; and is restricted. Names containing &quot;
      {error.reservedSubstring}&quot; are reserved for Cinatra.ai-affiliated instances and require
      pre-registration. To request approval,{" "}
      {error.contact.href ? (
        <Link
          href={error.contact.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-destructive underline hover:text-destructive/80"
        >
          {error.contact.channel}
        </Link>
      ) : (
        <span className="underline">{error.contact.channel}</span>
      )}
      .
    </span>
  );
}
