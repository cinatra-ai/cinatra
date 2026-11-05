"use client";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import {
  CONFORMANCE_DEFAULT_TOAST_ID,
  CONFORMANCE_DEFAULT_TOAST_MESSAGE,
  CONFORMANCE_TOAST_ID,
  CONFORMANCE_TOAST_MESSAGE,
} from "./toast-fixture-data";

/** The product's global Toaster draws this; no controls or outcomes are imitated. */
export function ToastConformanceFixture() {
  return (
    // The kit's press reads at most 400 controls, and this page draws more, so
    // the grade's press names this one part of the page.
    <section aria-label="Toast conformance" className="flex flex-col gap-8">
      <Button
        variant="outline"
        data-testid="show-conformance-toast"
        onClick={() => toast.error(CONFORMANCE_TOAST_MESSAGE, {
          id: CONFORMANCE_TOAST_ID,
          // A reader dismisses it; clock expiry cannot substitute for Close.
          duration: Infinity,
        })}
      >
        Show conformance toast
      </Button>
      {/* The application's one untyped call is the auth provider's fallback branch
          (src/app/providers.tsx). better-auth-ui 3.4.0 sends that provider only
          error and success, so no page reaches the branch, and the drawn default
          toast is raised here for the independent grade (cinatra#4291). */}
      <Button
        variant="outline"
        data-testid="show-conformance-default-toast"
        onClick={() => toast(CONFORMANCE_DEFAULT_TOAST_MESSAGE, {
          id: CONFORMANCE_DEFAULT_TOAST_ID,
          duration: Infinity,
        })}
      >
        Show conformance default toast
      </Button>
    </section>
  );
}
