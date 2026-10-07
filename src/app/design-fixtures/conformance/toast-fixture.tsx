"use client";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import { CONFORMANCE_TOAST_ID, CONFORMANCE_TOAST_MESSAGE } from "./toast-fixture-data";

/** The product's global Toaster draws this; no controls or outcomes are imitated. */
export function ToastConformanceFixture() {
  return (
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
  );
}
