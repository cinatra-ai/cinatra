"use client";

// SETUP CONNECTION-FORM ISLAND (cinatra#2390, epic #2385 S5).
//
// The client half of the typed setup error channel: wraps a provider
// credential form around a TYPED server action (`useActionState`) instead of a
// redirecting one, and surfaces the outcome as a TOAST — `toast.error` with
// the SERVER-sanitized message on failure, `toast.success` on a save. The
// action's result is the ONLY error transport: nothing rides the URL, and the
// wizard's codes-only flash channel is untouched.
//
// On success the island refreshes the route so the surrounding server
// components re-derive their state (saved-key placeholder, readiness, the
// wizard rail) from the store the save just wrote.

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";
import type { SetupConnectionSaveResult } from "@/lib/setup-provider-connection-writer";

export type SetupConnectionFormState = SetupConnectionSaveResult | null;

export type SetupConnectionFormAction = (
  prevState: SetupConnectionFormState,
  formData: FormData,
) => Promise<SetupConnectionSaveResult>;

export function SetupProviderConnectionForm({
  action,
  successMessage,
  className,
  children,
  testId,
}: {
  action: SetupConnectionFormAction;
  /** The static success toast copy (e.g. "OpenAI connection saved."). */
  successMessage: string;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState<SetupConnectionFormState, FormData>(
    action,
    null,
  );
  // Toast once per RESULT ARRIVAL, not once per render: `useActionState`
  // returns the same object reference until the next submit resolves.
  const lastState = useRef<SetupConnectionFormState>(null);
  useEffect(() => {
    if (state === null || state === lastState.current) return;
    lastState.current = state;
    if (!state.ok) {
      toast.error(state.sanitizedMessage);
      return;
    }
    if (state.code === "saved-degraded" && state.sanitizedMessage) {
      toast.warning(state.sanitizedMessage);
    } else {
      toast.success(successMessage);
    }
    router.refresh();
  }, [state, successMessage, router]);

  return (
    <form action={formAction} className={className} data-testid={testId}>
      {children}
    </form>
  );
}
