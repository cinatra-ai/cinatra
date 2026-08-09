"use client";

// THE MODEL STEP'S ONE FORM (cinatra#2502 item E) — the client half of S5's
// typed setup channel (cinatra#2390), widened from "the key save" to "the whole
// step".
//
// The step used to carry two buttons: a Save that persisted the credential
// through a TYPED non-redirecting action, and a Continue that ran the S3
// commit saga and redirected. Design spec `specs/app-setup.html` §I allows one:
// "submitting Continue is what persists the step's input, validates it, and
// moves the wizard forward … it does not ask the operator to press two buttons
// in order." So this island wraps the WHOLE step — key field, consent control
// and Continue — around one typed action.
//
// What survives from S5, unchanged: the action's result is the only error
// transport for the save and consent legs. Nothing rides the URL, the wizard's
// codes-only flash channel is untouched, and the message rendered is always the
// SERVER-sanitized one.
//
// What §I adds: the failure is reported INLINE on the field, not only as a
// transient toast. Both carry the same one server string — the toast is the
// channel S5 proved, the inline region is what the spec asks for and what an
// operator who missed the toast can still read.
//
// The route is refreshed only when the action reports it CLEARED an earlier
// run's durable failure record: the alert that record produced is still painted
// and is now false, and two answers to one question is exactly what item E's
// "one honest state" forbids. It is not refreshed otherwise — re-rendering the
// server component empties the uncontrolled key field, and throwing away what
// the operator just typed to fix nothing is a worse trade than a stale-free
// screen is worth.

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import type { SetupModelStepResult } from "@/app/setup/model/readiness-state";

export type SetupModelStepFormState = SetupModelStepResult | null;

export type SetupModelStepFormAction = (
  prevState: SetupModelStepFormState,
  formData: FormData,
) => Promise<SetupModelStepResult>;

/**
 * The step's ONE primary action. Split into its own component so
 * `useFormStatus()` can read the enclosing form — it reports the pending state
 * of the nearest ancestor <form> in the REACT tree, which a hook called in the
 * component that renders the form itself would miss.
 */
function ContinueButton() {
  const { pending } = useFormStatus();
  return (
    <div className="flex justify-end">
      <Button type="submit" disabled={pending} data-testid="setup-ai-continue">
        Continue
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

export function SetupModelStepForm({
  action,
  className,
  children,
  testId,
}: {
  action: SetupModelStepFormAction;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState<SetupModelStepFormState, FormData>(action, null);
  // Toast once per RESULT ARRIVAL, not once per render: `useActionState`
  // returns the same object reference until the next submit resolves.
  const lastState = useRef<SetupModelStepFormState>(null);
  useEffect(() => {
    if (state === null || state === lastState.current) return;
    lastState.current = state;
    if (state.ok) return; // a successful run redirects; nothing to render here
    toast.error(state.sanitizedMessage);
    if (state.clearedStandingFailure) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className={className} data-testid={testId}>
      {children}
      {state && !state.ok ? (
        <p
          role="alert"
          data-testid="setup-model-step-error"
          className="text-sm font-medium text-destructive"
        >
          {state.sanitizedMessage}
        </p>
      ) : null}
      <ContinueButton />
    </form>
  );
}
