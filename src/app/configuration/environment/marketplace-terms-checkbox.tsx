"use client";

import Link from "next/link";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * Terms-acceptance checkbox for the marketplace vendor RegisterForm.
 *
 * Extracted into its own client component because the parent
 * `MarketplacePublishCard` is a server component, while the shadcn
 * `<Checkbox>` (Radix) needs a client boundary. The wrapping `<label>` and
 * `<span>` preserve the original multi-line text flow (the shadcn `<Label>`
 * defaults `flex items-center leading-none font-semibold`, which would
 * collapse and re-weight this wrapping sentence). Renders the same
 * `name="termsAccepted"` + `required` form contract and external terms link
 * as the previous raw `<input type="checkbox">`, so the plain HTML form
 * submitted to `requestMarketplacePublishAction` is unchanged.
 */
export function MarketplaceTermsCheckbox() {
  return (
    <label className="flex items-start gap-2 text-xs text-foreground">
      <Checkbox name="termsAccepted" required className="mt-0.5" />
      <span>
        I have read and accept the{" "}
        <Link
          href="https://marketplace.cinatra.ai/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          Cinatra Marketplace Vendor Terms of Service
        </Link>
        .
      </span>
    </label>
  );
}
