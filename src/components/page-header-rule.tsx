"use client";

import { Separator } from "@/components/ui/separator";

/**
 * Etched paired-line section divider rendered beneath `<PageHeader>` when
 * `divider` is true. Extracted into its own `"use client"` file so PageHeader
 * itself stays a server component — `<Separator>` is `"use client"` and
 * inlining it would drag every PageHeader call site (~70 imports across
 * `src/app/`) onto a client boundary unnecessarily.
 *
 * `mt-6` (24px) breathing room separates the rule from the header
 * description; the parent PageHeader's existing `mb-6` then keeps the
 * visual rhythm to the content area below.
 */
export function PageHeaderRule() {
  return <Separator major decorative className="mt-6" />;
}
