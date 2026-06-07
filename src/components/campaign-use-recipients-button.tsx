"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";

export function CampaignUseRecipientsButton({
  action,
  campaignId,
  redirectTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  campaignId: string;
  redirectTo: string;
}) {
  const hiddenSubmitRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <Button
        type="button"
        onClick={() => hiddenSubmitRef.current?.click()}
        className="h-auto rounded-control border border-primary bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-surface-strong hover:text-foreground"
      >
        Use recipients
      </Button>
      <form action={action}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <Button ref={hiddenSubmitRef} type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </>
  );
}
