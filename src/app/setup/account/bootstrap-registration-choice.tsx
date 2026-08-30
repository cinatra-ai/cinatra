// -----------------------------------------------------------------------------
// First-account step — the registration choice, wrapped around the sign-up form.
//
// The instance is closed unless the operator says otherwise, so this control
// starts OFF and is an opt-in: turning it on is what opens the door to everyone
// else. The answer is taken the moment it is given, which keeps it independent
// of the sign-up form's own submit (that form is a shared component and owns
// its own submission), and it can be changed at any time afterwards on the
// access-control screen.
//
// Nothing is written to the instance while the answer is given: it waits in
// this browser and is applied to the instance with the admin account this step
// creates (src/lib/bootstrap-registration-choice.ts). `initialOpen` is that
// held answer read back on the server, so a reload shows what the operator
// actually said rather than a fresh OFF.
//
// Leaving the control alone holds nothing at all — an instance with no recorded
// answer is closed, so silence and an explicit "no" mean the same thing.
//
// `data-registration-open` mirrors the control's state onto the wrapper so the
// step's rendered state is readable without reaching into the switch's
// internals.
// -----------------------------------------------------------------------------
"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";

import { recordBootstrapRegistrationChoiceAction } from "./actions";

export function BootstrapRegistrationChoice({
  children,
  initialOpen = false,
}: {
  children: ReactNode;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen === true);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function choose(next: boolean) {
    const previous = open;
    setOpen(next);
    setFailed(false);
    startTransition(async () => {
      try {
        await recordBootstrapRegistrationChoiceAction(next);
      } catch {
        // The answer was not taken; put the control back and say so, so it
        // never claims an instance is open when nothing was recorded.
        setOpen(previous);
        setFailed(true);
      }
    });
  }

  return (
    <div
      className="grid gap-5"
      data-testid="bootstrap-registration-choice"
      data-registration-open={open ? "true" : "false"}
    >
      <Field orientation="horizontal">
        <div className="grid gap-1">
          <FieldLabel htmlFor="bootstrap-allow-signups">
            Let anyone create an account
          </FieldLabel>
          <FieldDescription id="bootstrap-allow-signups-description">
            Only people you invite can join, unless you turn this on. You can change it later
            under Access control.
          </FieldDescription>
          {failed ? (
            <p className="text-sm text-destructive" data-testid="bootstrap-registration-choice-error">
              That was not saved. The instance stays closed. Try again.
            </p>
          ) : null}
        </div>
        <Switch
          id="bootstrap-allow-signups"
          aria-describedby="bootstrap-allow-signups-description"
          checked={open}
          disabled={pending}
          onCheckedChange={choose}
        />
      </Field>
      {children}
    </div>
  );
}
